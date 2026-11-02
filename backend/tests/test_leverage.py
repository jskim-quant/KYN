from decimal import Decimal

import pytest

from app.engines.leverage.engine import (
    STANDARD_EQUITY_RATIOS,
    compare_leverage_levels,
    compute_downside_stress,
    compute_leverage_scenario,
    simulate_capital_recycling,
)
from app.models.leverage import (
    AmortizationType,
    CapitalRecyclingInput,
    DebtStructure,
    LeverageScenarioInput,
    RateType,
)


def _base_input(equity_ratio=0.4, amortization=AmortizationType.INTEREST_ONLY) -> LeverageScenarioInput:
    return LeverageScenarioInput(
        asset_value=Decimal("10"),
        equity_ratio=equity_ratio,
        annual_income_yield_pct=0.04,
        annual_appreciation_pct=0.03,
        debt=DebtStructure(rate_type=RateType.FIXED, interest_rate_pct=0.045,
                            amortization=amortization, maturity_years=30),
    )


def test_higher_equity_ratio_means_lower_ltv_and_loan():
    low_equity = compute_leverage_scenario(_base_input(equity_ratio=0.2))
    high_equity = compute_leverage_scenario(_base_input(equity_ratio=0.8))
    assert low_equity.ltv > high_equity.ltv
    assert low_equity.loan_amount > high_equity.loan_amount


def test_interest_only_cashflow_and_roe():
    result = compute_leverage_scenario(_base_input(equity_ratio=0.4))
    # asset=10, equity=4, loan=6, income=10*0.04=0.4, interest=6*0.045=0.27
    assert result.annual_income == pytest.approx(Decimal("0.4"))
    assert result.annual_interest == pytest.approx(Decimal("0.27"))
    assert result.annual_principal == Decimal("0")
    assert result.annual_cashflow_to_equity == pytest.approx(Decimal("0.13"))
    assert result.cash_on_cash_roe == pytest.approx(0.13 / 4)
    # total_roe = (cashflow + appreciation) / equity = (0.13 + 10*0.03) / 4
    assert result.total_roe == pytest.approx((0.13 + 0.3) / 4)


def test_amortizing_loan_has_positive_principal_and_lower_cashflow_than_interest_only():
    interest_only = compute_leverage_scenario(_base_input(amortization=AmortizationType.INTEREST_ONLY))
    amortizing = compute_leverage_scenario(_base_input(amortization=AmortizationType.AMORTIZING))
    assert amortizing.annual_principal > 0
    assert amortizing.annual_debt_service > interest_only.annual_debt_service
    assert amortizing.annual_cashflow_to_equity < interest_only.annual_cashflow_to_equity


def test_dscr_and_interest_burden():
    result = compute_leverage_scenario(_base_input(equity_ratio=0.4))
    assert result.interest_burden == pytest.approx(0.27 / 0.4)
    assert result.dscr == pytest.approx(0.4 / 0.27)


def test_zero_equity_edge_case_returns_none_roe():
    result = compute_leverage_scenario(_base_input(equity_ratio=0.0))
    assert result.equity_amount == Decimal("0")
    assert result.cash_on_cash_roe is None
    assert result.total_roe is None


def test_downside_stress_wipes_out_low_equity_position():
    low_equity_input = _base_input(equity_ratio=0.2)  # equity=2, loan=8
    stress = compute_downside_stress(low_equity_input, asset_value_shock_pct=-0.25)
    # stressed value = 10*0.75=7.5, loan stays 8 → equity = 7.5-8 = -0.5 → wiped out
    assert stress.equity_wiped_out is True
    assert stress.stressed_equity_value < 0


def test_downside_stress_survives_high_equity_position():
    high_equity_input = _base_input(equity_ratio=0.8)  # equity=8, loan=2
    stress = compute_downside_stress(high_equity_input, asset_value_shock_pct=-0.25)
    # stressed value = 7.5, loan=2 → equity = 5.5 > 0
    assert stress.equity_wiped_out is False
    assert stress.stressed_equity_value == pytest.approx(Decimal("5.5"))


def test_compare_leverage_levels_uses_standard_ratios_by_default():
    comparisons = compare_leverage_levels(_base_input())
    assert [c.scenario.equity_ratio for c in comparisons] == STANDARD_EQUITY_RATIOS
    # 레버리지가 높을수록(자기자본비율 낮을수록) 하방 스트레스에서 손실률이 커야 함
    loss_pcts = [c.downside.equity_loss_pct for c in comparisons]
    assert loss_pcts[0] > loss_pcts[-1]


def test_capital_recycling_preserves_net_worth_at_t0():
    inp = CapitalRecyclingInput(
        existing_asset_value=Decimal("20"), existing_debt=Decimal("0"),
        existing_income_yield_pct=0.03, refinance_target_ltv=0.4,
        new_asset_equity_ratio=0.4, new_asset_income_yield_pct=0.04,
        new_asset_appreciation_pct=0.03, interest_rate_pct=0.045,
    )
    result = simulate_capital_recycling(inp)
    assert result.net_worth_unchanged_at_t0 is True
    assert result.additional_borrowing == pytest.approx(Decimal("8"))  # 20*0.4 - 0
    assert result.new_asset_price == pytest.approx(Decimal("20"))       # 8 / 0.4
    assert result.new_asset_debt == pytest.approx(Decimal("12"))        # 20 - 8


def test_capital_recycling_no_extractable_cash_when_already_at_target_ltv():
    inp = CapitalRecyclingInput(
        existing_asset_value=Decimal("20"), existing_debt=Decimal("10"),  # 이미 LTV 50%
        existing_income_yield_pct=0.03, refinance_target_ltv=0.4,          # 목표가 더 낮음
        new_asset_equity_ratio=0.4, new_asset_income_yield_pct=0.04,
        new_asset_appreciation_pct=0.03, interest_rate_pct=0.045,
    )
    result = simulate_capital_recycling(inp)
    assert result.additional_borrowing == Decimal("0")
    assert result.new_asset_price == Decimal("0")
