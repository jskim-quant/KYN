"""
가족 통합 대차대조표 모델 (Family Balance Sheet — 새 스펙 Phase 2).

기존 Asset/Debt 모델(자산 1건 단위)을 가족 전체 관점으로 집계한다.
"""
from __future__ import annotations

from decimal import Decimal
from enum import Enum

from pydantic import BaseModel, Field


class AssetCategory(str, Enum):
    REAL_ESTATE = "REAL_ESTATE"
    EQUITY = "EQUITY"
    BONDS = "BONDS"
    CASH = "CASH"
    BUSINESS_EQUITY = "BUSINESS_EQUITY"
    OTHER = "OTHER"


class LiabilityCategory(str, Enum):
    MORTGAGE = "MORTGAGE"
    LOANS = "LOANS"
    TAX_LIABILITIES = "TAX_LIABILITIES"


class FamilyBalanceSheet(BaseModel):
    as_of: str  # ISO date
    assets_by_category: dict[AssetCategory, Decimal] = Field(default_factory=dict)
    liabilities_by_category: dict[LiabilityCategory, Decimal] = Field(default_factory=dict)

    @property
    def total_assets(self) -> Decimal:
        return sum(self.assets_by_category.values(), Decimal("0"))

    @property
    def total_liabilities(self) -> Decimal:
        return sum(self.liabilities_by_category.values(), Decimal("0"))

    @property
    def net_worth(self) -> Decimal:
        return self.total_assets - self.total_liabilities


class BalanceSheetMetrics(BaseModel):
    net_worth: Decimal
    debt_to_equity: float | None       # total_liabilities / net_worth
    ltv: float | None                   # 부동산 담보부채 / 부동산 가치
    liquid_asset_ratio: float           # 현금성자산 / 총자산
    debt_service_ratio: float | None    # 연간 원리금상환액 / 연간 총소득
    interest_coverage: float | None     # 연간 총소득 / 연간 이자비용
    asset_concentration: float          # 최대 단일 자산군 비중 (0~1) — 단순화된 집중도 지표
    concentration_category: AssetCategory | None


class AnnualIncomeInput(BaseModel):
    salary: Decimal = Decimal("0")
    rental_income: Decimal = Decimal("0")
    dividends: Decimal = Decimal("0")
    interest_income: Decimal = Decimal("0")
    business_income: Decimal = Decimal("0")

    @property
    def total(self) -> Decimal:
        return self.salary + self.rental_income + self.dividends + self.interest_income + self.business_income


class AnnualExpenseInput(BaseModel):
    living_expense: Decimal = Decimal("0")
    interest_expense: Decimal = Decimal("0")
    principal_repayment: Decimal = Decimal("0")
    tax: Decimal = Decimal("0")
    maintenance: Decimal = Decimal("0")

    @property
    def total(self) -> Decimal:
        return (self.living_expense + self.interest_expense + self.principal_repayment
                + self.tax + self.maintenance)


class AnnualCashflowResult(BaseModel):
    year: int
    income: AnnualIncomeInput
    expense: AnnualExpenseInput
    net_cashflow: Decimal        # income.total - expense.total (모든 지출 반영 후 최종 현금 증감)
    free_cash_flow: Decimal      # net_cashflow + principal_repayment (의무적 원금상환 전 가용 현금 — 상환 여력 지표)
