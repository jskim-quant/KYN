"""
가족 통합 대차대조표 엔진 (새 스펙 Phase 2).

기존 Asset/Debt 리스트를 받아 자산군별로 집계하고, Net Worth / D-E / LTV /
Liquid Asset Ratio / Debt Service Ratio / Interest Coverage / Asset Concentration을
계산한다. 세금·시나리오 계산은 하지 않는다 — 그건 engines/rules, engines/scenario 몫이고,
여기는 "현재 상태를 하나의 재무제표로 요약"하는 것만 담당한다 (스펙 0.1 계층 분리 원칙).
"""
from __future__ import annotations

from decimal import Decimal

from app.models.asset import Asset, AssetType
from app.models.balance_sheet import (
    AnnualCashflowResult,
    AnnualExpenseInput,
    AnnualIncomeInput,
    AssetCategory,
    BalanceSheetMetrics,
    FamilyBalanceSheet,
    LiabilityCategory,
)
from app.models.debt import Debt, DebtPurpose

_ASSET_TYPE_TO_CATEGORY: dict[AssetType, AssetCategory] = {
    AssetType.CASH: AssetCategory.CASH,
    AssetType.DEPOSIT: AssetCategory.CASH,
    AssetType.SECURITY: AssetCategory.BONDS,
    AssetType.LAND: AssetCategory.REAL_ESTATE,
    AssetType.HOUSE: AssetCategory.REAL_ESTATE,
    AssetType.COMMERCIAL_BUILDING: AssetCategory.REAL_ESTATE,
    AssetType.OFFICETEL: AssetCategory.REAL_ESTATE,
    AssetType.FACTORY: AssetCategory.REAL_ESTATE,
    AssetType.FARMLAND: AssetCategory.REAL_ESTATE,
    AssetType.FOREST: AssetCategory.REAL_ESTATE,
    AssetType.REDEVELOPMENT_RIGHT: AssetCategory.REAL_ESTATE,
    AssetType.UNLISTED_SHARE: AssetCategory.BUSINESS_EQUITY,
    AssetType.LISTED_SHARE: AssetCategory.EQUITY,
    AssetType.CORPORATE_SHARE: AssetCategory.BUSINESS_EQUITY,
    AssetType.INSURANCE: AssetCategory.OTHER,
    AssetType.RECEIVABLE: AssetCategory.OTHER,
    AssetType.INTELLECTUAL_PROPERTY: AssetCategory.OTHER,
    AssetType.OTHER: AssetCategory.OTHER,
}


def categorize_asset(asset: Asset) -> AssetCategory:
    return _ASSET_TYPE_TO_CATEGORY.get(asset.asset_type, AssetCategory.OTHER)


def categorize_debt(debt: Debt) -> LiabilityCategory:
    if debt.purpose == DebtPurpose.TAX_PAYMENT:
        return LiabilityCategory.TAX_LIABILITIES
    if debt.mortgage_registrations:
        return LiabilityCategory.MORTGAGE
    return LiabilityCategory.LOANS


def build_family_balance_sheet(assets: list[Asset], debts: list[Debt], as_of: str) -> FamilyBalanceSheet:
    assets_by_category: dict[AssetCategory, Decimal] = {}
    for a in assets:
        cat = categorize_asset(a)
        value = a.current_market_value * Decimal(str(a.ownership_ratio))
        assets_by_category[cat] = assets_by_category.get(cat, Decimal("0")) + value

    liabilities_by_category: dict[LiabilityCategory, Decimal] = {}
    for d in debts:
        cat = categorize_debt(d)
        liabilities_by_category[cat] = liabilities_by_category.get(cat, Decimal("0")) + d.outstanding_principal

    return FamilyBalanceSheet(
        as_of=as_of,
        assets_by_category=assets_by_category,
        liabilities_by_category=liabilities_by_category,
    )


def compute_metrics(
    bs: FamilyBalanceSheet,
    annual_total_income: Decimal | None = None,
    annual_debt_service: Decimal | None = None,
    annual_interest_expense: Decimal | None = None,
) -> BalanceSheetMetrics:
    total_assets = bs.total_assets
    total_liabilities = bs.total_liabilities
    net_worth = bs.net_worth

    real_estate_value = bs.assets_by_category.get(AssetCategory.REAL_ESTATE, Decimal("0"))
    mortgage_debt = bs.liabilities_by_category.get(LiabilityCategory.MORTGAGE, Decimal("0"))
    cash_value = bs.assets_by_category.get(AssetCategory.CASH, Decimal("0"))

    debt_to_equity = float(total_liabilities / net_worth) if net_worth > 0 else None
    ltv = float(mortgage_debt / real_estate_value) if real_estate_value > 0 else None
    liquid_asset_ratio = float(cash_value / total_assets) if total_assets > 0 else 0.0

    debt_service_ratio = None
    if annual_debt_service is not None and annual_total_income and annual_total_income > 0:
        debt_service_ratio = float(annual_debt_service / annual_total_income)

    interest_coverage = None
    if annual_interest_expense is not None and annual_interest_expense > 0 and annual_total_income is not None:
        interest_coverage = float(annual_total_income / annual_interest_expense)

    concentration_category = None
    asset_concentration = 0.0
    if total_assets > 0 and bs.assets_by_category:
        concentration_category, max_value = max(bs.assets_by_category.items(), key=lambda kv: kv[1])
        asset_concentration = float(max_value / total_assets)

    return BalanceSheetMetrics(
        net_worth=net_worth,
        debt_to_equity=debt_to_equity,
        ltv=ltv,
        liquid_asset_ratio=liquid_asset_ratio,
        debt_service_ratio=debt_service_ratio,
        interest_coverage=interest_coverage,
        asset_concentration=asset_concentration,
        concentration_category=concentration_category,
    )


def compute_annual_cashflow(
    year: int, income: AnnualIncomeInput, expense: AnnualExpenseInput,
) -> AnnualCashflowResult:
    net_cashflow = income.total - expense.total
    free_cash_flow = net_cashflow + expense.principal_repayment
    return AnnualCashflowResult(
        year=year, income=income, expense=expense,
        net_cashflow=net_cashflow, free_cash_flow=free_cash_flow,
    )
