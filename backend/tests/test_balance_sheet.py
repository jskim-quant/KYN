from datetime import date
from decimal import Decimal

import pytest

from app.engines.balance_sheet.engine import (
    build_family_balance_sheet,
    categorize_asset,
    categorize_debt,
    compute_annual_cashflow,
    compute_metrics,
)
from app.models.asset import Asset, AssetType
from app.models.balance_sheet import AnnualExpenseInput, AnnualIncomeInput, AssetCategory, LiabilityCategory
from app.models.debt import Debt, DebtPurpose, LenderType, MortgageRegistration, RateType, RepaymentType


def _asset(asset_type: AssetType, value: float, ownership_ratio: float = 1.0) -> Asset:
    a = Asset(
        id=f"a-{asset_type.value}", owner_id="p1", asset_type=asset_type,
        acquisition_date=date(2015, 1, 1), acquisition_cost=Decimal("1"),
        ownership_ratio=ownership_ratio,
    )
    a.valuation.user_estimate = Decimal(str(value))
    return a


def _mortgage_debt(principal: float) -> Debt:
    return Debt(
        id="d1", borrower_id="p1", lender_type=LenderType.BANK,
        principal=Decimal(str(principal)), outstanding_principal=Decimal(str(principal)),
        interest_rate=0.045, rate_type=RateType.FIXED, maturity_date=date(2035, 1, 1),
        repayment_type=RepaymentType.AMORTIZING, purpose=DebtPurpose.ACQUISITION,
        mortgage_registrations=[MortgageRegistration(
            collateral_asset_id="a-HOUSE", max_claim_amount=Decimal(str(principal * 1.2)),
            registered_date=date(2015, 1, 1),
        )],
    )


def test_categorize_asset_maps_real_estate():
    assert categorize_asset(_asset(AssetType.HOUSE, 10)) == AssetCategory.REAL_ESTATE
    assert categorize_asset(_asset(AssetType.CASH, 10)) == AssetCategory.CASH
    assert categorize_asset(_asset(AssetType.UNLISTED_SHARE, 10)) == AssetCategory.BUSINESS_EQUITY
    assert categorize_asset(_asset(AssetType.LISTED_SHARE, 10)) == AssetCategory.EQUITY


def test_categorize_debt_mortgage_vs_loan_vs_tax():
    assert categorize_debt(_mortgage_debt(4)) == LiabilityCategory.MORTGAGE
    plain_loan = Debt(
        id="d2", borrower_id="p1", lender_type=LenderType.BANK,
        principal=Decimal("1"), outstanding_principal=Decimal("1"), interest_rate=0.05,
        maturity_date=date(2030, 1, 1), purpose=DebtPurpose.LIVING_EXPENSE,
    )
    assert categorize_debt(plain_loan) == LiabilityCategory.LOANS
    tax_loan = Debt(
        id="d3", borrower_id="p1", lender_type=LenderType.BANK,
        principal=Decimal("1"), outstanding_principal=Decimal("1"), interest_rate=0.05,
        maturity_date=date(2030, 1, 1), purpose=DebtPurpose.TAX_PAYMENT,
    )
    assert categorize_debt(tax_loan) == LiabilityCategory.TAX_LIABILITIES


def test_build_family_balance_sheet_aggregates_by_category():
    assets = [_asset(AssetType.HOUSE, 20), _asset(AssetType.CASH, 5), _asset(AssetType.LISTED_SHARE, 3)]
    debts = [_mortgage_debt(4)]
    bs = build_family_balance_sheet(assets, debts, as_of="2026-01-01")
    assert bs.assets_by_category[AssetCategory.REAL_ESTATE] == Decimal("20")
    assert bs.total_assets == Decimal("28")
    assert bs.total_liabilities == Decimal("4")
    assert bs.net_worth == Decimal("24")


def test_ownership_ratio_scales_asset_value():
    bs = build_family_balance_sheet([_asset(AssetType.HOUSE, 20, ownership_ratio=0.5)], [], as_of="2026-01-01")
    assert bs.total_assets == Decimal("10")


def test_metrics_ltv_and_liquid_ratio():
    assets = [_asset(AssetType.HOUSE, 20), _asset(AssetType.CASH, 5)]
    debts = [_mortgage_debt(8)]
    bs = build_family_balance_sheet(assets, debts, as_of="2026-01-01")
    m = compute_metrics(bs)
    assert m.ltv == pytest.approx(8 / 20)
    assert m.liquid_asset_ratio == pytest.approx(5 / 25)
    assert m.debt_to_equity == pytest.approx(8 / 17)


def test_metrics_debt_service_and_interest_coverage():
    bs = build_family_balance_sheet([_asset(AssetType.HOUSE, 20)], [_mortgage_debt(8)], as_of="2026-01-01")
    m = compute_metrics(
        bs, annual_total_income=Decimal("2"),
        annual_debt_service=Decimal("0.5"), annual_interest_expense=Decimal("0.36"),
    )
    assert m.debt_service_ratio == pytest.approx(0.25)
    assert m.interest_coverage == pytest.approx(2 / 0.36)


def test_metrics_handle_zero_net_worth_and_no_real_estate():
    bs = build_family_balance_sheet([_asset(AssetType.CASH, 5)], [_mortgage_debt(5)], as_of="2026-01-01")
    m = compute_metrics(bs)
    assert m.debt_to_equity is None  # net_worth == 0
    assert m.ltv is None  # no real estate


def test_asset_concentration_identifies_dominant_category():
    assets = [_asset(AssetType.HOUSE, 18), _asset(AssetType.CASH, 2)]
    bs = build_family_balance_sheet(assets, [], as_of="2026-01-01")
    m = compute_metrics(bs)
    assert m.concentration_category == AssetCategory.REAL_ESTATE
    assert m.asset_concentration == pytest.approx(0.9)


def test_annual_cashflow_computation():
    income = AnnualIncomeInput(salary=Decimal("1"), rental_income=Decimal("0.5"))
    expense = AnnualExpenseInput(living_expense=Decimal("0.4"), interest_expense=Decimal("0.2"), principal_repayment=Decimal("0.3"))
    result = compute_annual_cashflow(1, income, expense)
    assert result.net_cashflow == Decimal("0.6")   # 1.5 - 0.9
    assert result.free_cash_flow == Decimal("0.9")  # 0.6 + 0.3
