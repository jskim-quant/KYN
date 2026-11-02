"""
레버리지·자본순환 엔진 (새 스펙 Phase 3).

핵심 질문: "자기자본을 얼마나 넣고 부채를 얼마나 쓸 것인가?"

1. compute_leverage_scenario — 자기자본비율 하나에 대한 ROE/현금흐름/LTV/이자부담 계산
2. compute_downside_stress — 자산가치 하락 시 자기자본 훼손(깡통전세식 손실) 계산
3. compare_leverage_levels — 20/40/60/80% 자기자본 등 여러 수준을 한 번에 비교
4. simulate_capital_recycling — 기존자산 담보 → 차입 → 신규자산 매입 순환 구조
"""
from __future__ import annotations

from decimal import Decimal

from app.models.leverage import (
    AmortizationType,
    CapitalRecyclingInput,
    CapitalRecyclingResult,
    DownsideStressResult,
    LeverageLevelComparison,
    LeverageScenarioInput,
    LeverageScenarioResult,
)

# 스펙이 예시로 든 자기자본 비율 4단계
STANDARD_EQUITY_RATIOS: list[float] = [0.20, 0.40, 0.60, 0.80]


def _level_payment(principal: Decimal, rate_pct: float, years: int) -> Decimal:
    """원리금균등상환 연간 납입액. rate=0이면 단순 균등분할."""
    r = Decimal(str(rate_pct))
    if r == 0 or years <= 0:
        return principal / years if years > 0 else Decimal("0")
    n = years
    one_plus_r_n = (1 + r) ** n
    return principal * r * one_plus_r_n / (one_plus_r_n - 1)


def compute_leverage_scenario(inp: LeverageScenarioInput) -> LeverageScenarioResult:
    equity_amount = inp.asset_value * Decimal(str(inp.equity_ratio))
    loan_amount = inp.asset_value - equity_amount
    debt_ratio = 1 - inp.equity_ratio
    ltv = float(loan_amount / inp.asset_value) if inp.asset_value > 0 else 0.0

    annual_income = inp.asset_value * Decimal(str(inp.annual_income_yield_pct))
    annual_interest = loan_amount * Decimal(str(inp.debt.interest_rate_pct))

    if inp.debt.amortization == AmortizationType.AMORTIZING and loan_amount > 0:
        payment = _level_payment(loan_amount, inp.debt.interest_rate_pct, inp.debt.maturity_years)
        annual_principal = max(Decimal("0"), payment - annual_interest)
    else:
        annual_principal = Decimal("0")

    annual_debt_service = annual_interest + annual_principal
    annual_cashflow_to_equity = annual_income - annual_debt_service
    annual_appreciation_value = inp.asset_value * Decimal(str(inp.annual_appreciation_pct))

    cash_on_cash_roe = float(annual_cashflow_to_equity / equity_amount) if equity_amount > 0 else None
    total_roe = (
        float((annual_cashflow_to_equity + annual_appreciation_value) / equity_amount)
        if equity_amount > 0 else None
    )
    interest_burden = float(annual_interest / annual_income) if annual_income > 0 else None
    dscr = float(annual_income / annual_debt_service) if annual_debt_service > 0 else None

    return LeverageScenarioResult(
        equity_ratio=inp.equity_ratio, debt_ratio=debt_ratio,
        equity_amount=equity_amount, loan_amount=loan_amount, ltv=ltv,
        annual_income=annual_income, annual_interest=annual_interest,
        annual_principal=annual_principal, annual_debt_service=annual_debt_service,
        annual_cashflow_to_equity=annual_cashflow_to_equity,
        annual_appreciation_value=annual_appreciation_value,
        cash_on_cash_roe=cash_on_cash_roe, total_roe=total_roe,
        interest_burden=interest_burden, dscr=dscr,
    )


def compute_downside_stress(
    inp: LeverageScenarioInput, asset_value_shock_pct: float,
) -> DownsideStressResult:
    """자산가치가 shock_pct(예: -0.25)만큼 변동했을 때 자기자본 훼손을 계산한다.
    부채는 자산가치와 무관하게 그대로 남는다는 것이 레버리지 하방 리스크의 핵심이다."""
    equity_amount = inp.asset_value * Decimal(str(inp.equity_ratio))
    loan_amount = inp.asset_value - equity_amount

    stressed_value = inp.asset_value * (1 + Decimal(str(asset_value_shock_pct)))
    stressed_equity = stressed_value - loan_amount
    stressed_ltv = float(loan_amount / stressed_value) if stressed_value > 0 else None
    wiped_out = stressed_equity <= 0
    equity_loss_pct = (
        float((equity_amount - stressed_equity) / equity_amount) if equity_amount > 0 else None
    )

    return DownsideStressResult(
        asset_value_shock_pct=asset_value_shock_pct,
        stressed_asset_value=stressed_value,
        loan_amount_unchanged=loan_amount,
        stressed_ltv=stressed_ltv,
        stressed_equity_value=stressed_equity,
        equity_wiped_out=wiped_out,
        equity_loss_pct=equity_loss_pct,
    )


def compare_leverage_levels(
    base_input: LeverageScenarioInput,
    equity_ratios: list[float] | None = None,
    downside_shock_pct: float = -0.25,
) -> list[LeverageLevelComparison]:
    """"어느 leverage부터 위험이 급격히 증가하는가"를 보기 위해 여러 자기자본비율을
    동일 조건(자산가치·수익률·금리)에서 비교한다."""
    ratios = equity_ratios or STANDARD_EQUITY_RATIOS
    results = []
    for ratio in ratios:
        inp = base_input.model_copy(update={"equity_ratio": ratio})
        scenario = compute_leverage_scenario(inp)
        downside = compute_downside_stress(inp, downside_shock_pct)
        results.append(LeverageLevelComparison(scenario=scenario, downside=downside))
    return results


def simulate_capital_recycling(inp: CapitalRecyclingInput) -> CapitalRecyclingResult:
    """기존 자산 담보 → 추가 차입 → 신규 자산 매입 → 재투자 순환 구조.

    t=0 시점에는 자산이 늘어난 만큼 부채도 늘어날 뿐, 가족 전체 순자산은 변하지 않는다
    (스펙 0.1 "가족 내부 거래는 순자산을 임의로 증가시키지 않는다" 원장 불변식과 동일 원리 —
    여기서는 자산-부채 관계이지 가족간 거래는 아니지만 같은 검증을 적용한다).
    순자산 증가는 이후 실제 현금흐름·자산가치 상승이 누적되어야 발생한다.
    """
    target_debt = inp.existing_asset_value * Decimal(str(inp.refinance_target_ltv))
    additional_borrowing = max(Decimal("0"), target_debt - inp.existing_debt)
    existing_total_debt_after = inp.existing_debt + additional_borrowing
    existing_ltv_after = (
        float(existing_total_debt_after / inp.existing_asset_value)
        if inp.existing_asset_value > 0 else None
    )

    new_asset_equity = additional_borrowing
    new_asset_price = (
        new_asset_equity / Decimal(str(inp.new_asset_equity_ratio))
        if inp.new_asset_equity_ratio > 0 else Decimal("0")
    )
    new_asset_debt = new_asset_price - new_asset_equity

    combined_total_assets = inp.existing_asset_value + new_asset_price
    combined_total_debt = existing_total_debt_after + new_asset_debt
    combined_net_worth = combined_total_assets - combined_total_debt
    original_net_worth = inp.existing_asset_value - inp.existing_debt
    net_worth_unchanged = abs(combined_net_worth - original_net_worth) < Decimal("0.0001")

    existing_income = inp.existing_asset_value * Decimal(str(inp.existing_income_yield_pct))
    new_income = new_asset_price * Decimal(str(inp.new_asset_income_yield_pct))
    combined_annual_income = existing_income + new_income

    existing_interest = existing_total_debt_after * Decimal(str(inp.interest_rate_pct))
    new_interest = new_asset_debt * Decimal(str(inp.interest_rate_pct))
    combined_annual_interest = existing_interest + new_interest
    combined_annual_cashflow = combined_annual_income - combined_annual_interest

    combined_ltv = (
        float(combined_total_debt / combined_total_assets) if combined_total_assets > 0 else None
    )

    return CapitalRecyclingResult(
        additional_borrowing=additional_borrowing,
        existing_total_debt_after=existing_total_debt_after,
        existing_ltv_after=existing_ltv_after,
        new_asset_price=new_asset_price,
        new_asset_debt=new_asset_debt,
        combined_total_assets=combined_total_assets,
        combined_total_debt=combined_total_debt,
        combined_net_worth=combined_net_worth,
        net_worth_unchanged_at_t0=net_worth_unchanged,
        combined_annual_income=combined_annual_income,
        combined_annual_interest=combined_annual_interest,
        combined_annual_cashflow=combined_annual_cashflow,
        combined_ltv=combined_ltv,
    )
