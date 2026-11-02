"""
가족 구성원 및 거주자/비거주자 판정 모델 (스펙 1.1, 1.2).
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal
from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field


class ResidencePeriod(BaseModel):
    country: str
    start_date: date
    end_date: Optional[date] = None
    days_present: Optional[int] = None
    purpose: Optional[str] = None  # 유학, 주재원, 이민 등


class ResidencyStatus(str, Enum):
    KR_RESIDENT = "KR_RESIDENT"
    KR_NON_RESIDENT = "KR_NON_RESIDENT"
    DUAL_RESIDENCY_RISK = "DUAL_RESIDENCY_RISK"
    UNDETERMINED = "UNDETERMINED"


class AssessmentFactor(BaseModel):
    factor: str
    detail: str
    weight: str = "neutral"  # "supports_resident" | "supports_non_resident" | "neutral"


class TaxResidencyAssessment(BaseModel):
    status: ResidencyStatus
    as_of_date: date
    confidence: float = Field(ge=0, le=1)
    decisive_factors: list[AssessmentFactor] = Field(default_factory=list)
    conflicting_factors: list[AssessmentFactor] = Field(default_factory=list)
    missing_evidence: list[str] = Field(default_factory=list)
    treaty_review_required: bool = False


class FamilyRelationship(BaseModel):
    related_person_id: str
    relation_type: str  # "spouse" | "child" | "parent" | "grandchild" | "sibling" | ...


class LifeEvent(BaseModel):
    event_type: str  # "marriage" | "childbirth" | "retirement" | "relocation" | ...
    expected_date: Optional[date] = None
    note: Optional[str] = None


class CreditProfile(BaseModel):
    existing_debt_total: Decimal = Decimal("0")
    annual_debt_service: Decimal = Decimal("0")
    credit_grade: Optional[str] = None
    bank_pre_approved_amount: Optional[Decimal] = None


class Person(BaseModel):
    id: str
    name: str
    birth_date: date
    death_date: Optional[date] = None

    nationality: list[str] = Field(default_factory=list)
    residence_countries: list[ResidencePeriod] = Field(default_factory=list)
    tax_residency: Optional[TaxResidencyAssessment] = None

    relationship_to_others: list[FamilyRelationship] = Field(default_factory=list)
    marital_status: Optional[str] = None
    spouse_id: Optional[str] = None
    children_ids: list[str] = Field(default_factory=list)

    occupation: Optional[str] = None
    employment_income: Decimal = Decimal("0")
    business_income: Decimal = Decimal("0")
    rental_income: Decimal = Decimal("0")
    interest_income: Decimal = Decimal("0")
    dividend_income: Decimal = Decimal("0")
    pension_income: Decimal = Decimal("0")
    other_income: Decimal = Decimal("0")

    annual_living_expense: Decimal = Decimal("0")
    education_expense: Decimal = Decimal("0")
    medical_expense: Decimal = Decimal("0")

    available_cash: Decimal = Decimal("0")
    emergency_reserve_target: Decimal = Decimal("0")

    credit_profile: Optional[CreditProfile] = None
    expected_life_events: list[LifeEvent] = Field(default_factory=list)

    @property
    def total_annual_income(self) -> Decimal:
        return (
            self.employment_income + self.business_income + self.rental_income
            + self.interest_income + self.dividend_income + self.pension_income
            + self.other_income
        )

    @property
    def total_annual_expense(self) -> Decimal:
        return self.annual_living_expense + self.education_expense + self.medical_expense
