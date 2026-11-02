"""
레버리지·자본순환 모델 (새 스펙 Phase 3).
"""
from __future__ import annotations

from decimal import Decimal
from enum import Enum

from pydantic import BaseModel, Field


class RateType(str, Enum):
    FIXED = "FIXED"
    FLOATING = "FLOATING"


class AmortizationType(str, Enum):
    INTEREST_ONLY = "INTEREST_ONLY"
    AMORTIZING = "AMORTIZING"


class DebtStructure(BaseModel):
    rate_type: RateType = RateType.FIXED
    interest_rate_pct: float          # 연 이자율 (0.045 = 4.5%)
    amortization: AmortizationType = AmortizationType.INTEREST_ONLY
    maturity_years: int = 30


class LeverageScenarioInput(BaseModel):
    asset_value: Decimal
    equity_ratio: float = Field(ge=0, le=1)   # 자기자본 비율 (0.2 = 20% Equity / 80% Debt)
    annual_income_yield_pct: float             # 임대수익률/배당수익률 등 (자산가치 대비 %)
    annual_appreciation_pct: float              # 기대 자산가치 성장률
    debt: DebtStructure


class LeverageScenarioResult(BaseModel):
    equity_ratio: float
    debt_ratio: float
    equity_amount: Decimal
    loan_amount: Decimal
    ltv: float
    annual_income: Decimal
    annual_interest: Decimal
    annual_principal: Decimal
    annual_debt_service: Decimal
    annual_cashflow_to_equity: Decimal
    annual_appreciation_value: Decimal
    cash_on_cash_roe: float | None      # 현금흐름만 기준 자기자본 수익률
    total_roe: float | None             # 현금흐름 + 자산가치 상승 포함 자기자본 수익률
    interest_burden: float | None       # 이자 / 자산소득 (소득으로 이자를 얼마나 감당하는지)
    dscr: float | None                  # 자산소득 / 총 원리금상환액


class DownsideStressResult(BaseModel):
    asset_value_shock_pct: float        # 예: -0.25 = 자산가치 25% 하락
    stressed_asset_value: Decimal
    loan_amount_unchanged: Decimal
    stressed_ltv: float | None
    stressed_equity_value: Decimal
    equity_wiped_out: bool              # 스트레스 후 자기자본이 0 이하 (사실상 깡통)
    equity_loss_pct: float | None       # 최초 자기자본 대비 손실률


class LeverageLevelComparison(BaseModel):
    scenario: LeverageScenarioResult
    downside: DownsideStressResult


class CapitalRecyclingInput(BaseModel):
    existing_asset_value: Decimal
    existing_debt: Decimal
    existing_income_yield_pct: float
    refinance_target_ltv: float = Field(ge=0, le=1)   # 기존 자산 재감정 후 목표 LTV
    new_asset_equity_ratio: float = Field(ge=0, le=1)  # 신규 자산 매입 시 자기자본 비율
    new_asset_income_yield_pct: float
    new_asset_appreciation_pct: float
    interest_rate_pct: float


class CapitalRecyclingResult(BaseModel):
    additional_borrowing: Decimal        # 기존 자산에서 추가로 뽑아낸 대출금
    existing_total_debt_after: Decimal
    existing_ltv_after: float | None
    new_asset_price: Decimal             # 추출한 현금을 자기자본으로 써서 매입 가능한 신규자산 가격
    new_asset_debt: Decimal
    combined_total_assets: Decimal
    combined_total_debt: Decimal
    combined_net_worth: Decimal
    net_worth_unchanged_at_t0: bool      # 순환 시점(t=0) 순자산이 그대로인지 (원장 불변식 검증)
    combined_annual_income: Decimal
    combined_annual_interest: Decimal
    combined_annual_cashflow: Decimal
    combined_ltv: float | None
