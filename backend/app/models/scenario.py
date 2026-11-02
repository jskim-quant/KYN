"""
시나리오·거래 원자·연도별 재무상태 모델 (스펙 3, 5.2, 9).
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal
from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field


class ScenarioObjective(str, Enum):
    BASELINE = "BASELINE"
    STABLE = "STABLE"                # 안정형
    CASHFLOW = "CASHFLOW"            # 현금흐름형
    TAX_SAVING = "TAX_SAVING"        # 절세형
    LEVERAGE = "LEVERAGE"            # 레버리지형
    CORPORATE_GROWTH = "CORPORATE_GROWTH"  # 법인성장형
    LIQUIDATION = "LIQUIDATION"      # 유동화형
    NON_RESIDENT_STRATEGY = "NON_RESIDENT_STRATEGY"  # 비거주자 대응형


class CashTransfer(BaseModel):
    from_person_id: Optional[str] = None
    to_person_id: Optional[str] = None
    amount: Decimal
    transfer_date: date
    verified: bool = False  # 실제 계좌이체 확인 여부


class DebtChange(BaseModel):
    debt_id: str
    change_type: str  # "originate" | "assume" | "repay" | "forgive" | "refinance"
    amount: Decimal


class OwnershipChange(BaseModel):
    asset_id: str
    from_owner_id: Optional[str] = None
    to_owner_id: str
    ratio_transferred: float = Field(ge=0, le=1)


class TaxResult(BaseModel):
    tax_type: str
    amount: Decimal
    rule_id: str  # LegalRuleVersion.rule_id 참조
    status: str   # ValueStatus 값


class RequiredDocument(BaseModel):
    document_type: str
    state: str = "missing"  # "missing" | "draft" | "signed" | "notarized" | "executed" | "filed" | "archived"


class Prerequisite(BaseModel):
    description: str
    satisfied: bool = False


class ScenarioEvent(BaseModel):
    event_date: date
    transaction_type: str
    parties: list[str] = Field(default_factory=list)
    assets: list[str] = Field(default_factory=list)
    cash_transfers: list[CashTransfer] = Field(default_factory=list)
    debt_changes: list[DebtChange] = Field(default_factory=list)
    ownership_changes: list[OwnershipChange] = Field(default_factory=list)
    tax_consequences: list[TaxResult] = Field(default_factory=list)
    required_documents: list[RequiredDocument] = Field(default_factory=list)
    prerequisites: list[Prerequisite] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)


class ScenarioAssumption(BaseModel):
    key: str
    value: str
    confidence: float = Field(default=0.5, ge=0, le=1)


class AnnualFinancialState(BaseModel):
    year: int
    total_assets: Decimal
    total_debt: Decimal
    net_worth: Decimal
    net_cashflow: Decimal
    ending_cash_balance: Decimal
    cumulative_tax_paid: Decimal
    below_reserve_target: bool = False


# 아래 세 점수 모델은 engines/risk 쪽 산출물을 담는 컨테이너.
# 실제 산식은 backend/app/engines/risk/feasibility.py 등에서 구현.

class RiskScore(BaseModel):
    score: float = Field(ge=0, le=100)
    grade: str
    drivers: list[str] = Field(default_factory=list)


class FeasibilityComponents(BaseModel):
    initial_funding: float
    ongoing_cash_flow: float
    debt_service: float
    bank_approval: float
    legal_clarity: float
    documentation: float
    timeline: float
    family_governance: float
    operational_complexity: float
    stress_survival: float


class FeasibilityScore(BaseModel):
    total_score: float = Field(ge=0, le=100)
    grade: str
    components: FeasibilityComponents
    top_constraints: list[str] = Field(default_factory=list)
    improvement_actions: list[str] = Field(default_factory=list)
    hard_blocked: bool = False
    hard_block_reasons: list[str] = Field(default_factory=list)


class DocumentationScore(BaseModel):
    score: float = Field(ge=0, le=100)
    missing_documents: list[str] = Field(default_factory=list)


class TaxReviewRiskScore(BaseModel):
    overall_risk_score: float = Field(ge=0, le=100)
    grade: str
    risk_type_scores: dict[str, float] = Field(default_factory=dict)
    drivers: list[str] = Field(default_factory=list)
    mitigations: list[str] = Field(default_factory=list)
    disclaimer: str = (
        "본 점수는 실제 세무조사 선정 확률이 아니라 거래의 소명 부담과 "
        "증빙 취약성을 나타내는 내부 휴리스틱입니다."
    )


class Scenario(BaseModel):
    id: str
    name: str
    objective_type: ScenarioObjective
    events: list[ScenarioEvent] = Field(default_factory=list)
    assumptions: list[ScenarioAssumption] = Field(default_factory=list)
    legal_rule_version_ids: list[str] = Field(default_factory=list)

    annual_states: list[AnnualFinancialState] = Field(default_factory=list)

    feasibility_score: Optional[FeasibilityScore] = None
    tax_review_risk: Optional[TaxReviewRiskScore] = None
    documentation_score: Optional[DocumentationScore] = None
    liquidity_risk: Optional[RiskScore] = None
    leverage_risk: Optional[RiskScore] = None
    family_governance_risk: Optional[RiskScore] = None

    rejected: bool = False
    rejection_reasons: list[str] = Field(default_factory=list)
