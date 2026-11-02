"""
부채·근저당·담보 모델 (스펙 1.4).

근저당 설정액과 실제 대출원금을 구분한다 — 근저당이 있다는 사실만으로
실제 채무가 존재한다고 판정하지 않는다 (feasibility/tax_review_risk 엔진에서 사용).
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal
from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field


class LenderType(str, Enum):
    BANK = "BANK"
    FAMILY = "FAMILY"
    CORPORATION = "CORPORATION"
    THIRD_PARTY = "THIRD_PARTY"


class RateType(str, Enum):
    FIXED = "FIXED"
    FLOATING = "FLOATING"


class RepaymentType(str, Enum):
    BULLET = "BULLET"
    AMORTIZING = "AMORTIZING"
    EQUAL_PRINCIPAL = "EQUAL_PRINCIPAL"
    EQUAL_PAYMENT = "EQUAL_PAYMENT"
    CUSTOM = "CUSTOM"


class DebtPurpose(str, Enum):
    ACQUISITION = "ACQUISITION"
    TAX_PAYMENT = "TAX_PAYMENT"
    EDUCATION = "EDUCATION"
    LIVING_EXPENSE = "LIVING_EXPENSE"
    BUSINESS = "BUSINESS"
    REFINANCING = "REFINANCING"
    OTHER = "OTHER"


class MortgageRegistration(BaseModel):
    """근저당권 설정 — 채권최고액과 실제 원금을 분리 관리."""
    collateral_asset_id: str
    max_claim_amount: Decimal   # 채권최고액 (통상 원금의 120~130%)
    priority_rank: int = 1      # 1순위, 2순위 ...
    registered_date: date


class PaymentRecord(BaseModel):
    payment_date: date
    amount: Decimal
    method: str = "bank_transfer"  # "bank_transfer" | "cash" | "offset" | ...
    matches_contract_schedule: bool = True


class Debt(BaseModel):
    id: str
    borrower_id: str
    lender_type: LenderType
    lender_id: Optional[str] = None

    principal: Decimal
    outstanding_principal: Decimal
    interest_rate: float  # 연율, 0.046 = 4.6%
    rate_type: RateType = RateType.FIXED
    maturity_date: date
    repayment_type: RepaymentType = RepaymentType.BULLET

    purpose: DebtPurpose = DebtPurpose.OTHER

    collateral_ids: list[str] = Field(default_factory=list)
    mortgage_registrations: list[MortgageRegistration] = Field(default_factory=list)
    contract_exists: bool = False
    notarized: bool = False
    actual_transfers_verified: bool = False
    interest_payments: list[PaymentRecord] = Field(default_factory=list)
    principal_payments: list[PaymentRecord] = Field(default_factory=list)

    debt_service_source: Optional[str] = None
    borrower_repayment_capacity: Decimal = Decimal("0")

    @property
    def annual_interest(self) -> Decimal:
        return self.outstanding_principal * Decimal(str(self.interest_rate))

    @property
    def is_family_loan(self) -> bool:
        return self.lender_type == LenderType.FAMILY

    @property
    def has_verified_cash_flow(self) -> bool:
        """계약만 있고 실제 지급이 없는 채무를 걸러내는 핵심 플래그."""
        return self.contract_exists and self.actual_transfers_verified
