"""
거주자·비거주자 판정 엔진 (스펙 1.2).

국적만으로 판정하지 않는다. 판정이 불명확하면 하나로 단정하지 말고
거주자/비거주자/이중거주 세 갈래의 병렬 평가를 만들어 각 경우의 과세범위를
따로 계산하도록 한다.

주의: 여기 구현된 183일 기준 등은 소득세법 §1의2의 일반 원칙을 반영한 휴리스틱이며,
실제 판정은 조세조약·구체적 사실관계에 따라 달라질 수 있어 항상 세무사 확인이
필요하다 (treaty_review_required 플래그 참고).
"""
from __future__ import annotations

from datetime import date
from enum import Enum
from typing import Optional

from pydantic import BaseModel

from app.models.person import AssessmentFactor, ResidencyStatus, TaxResidencyAssessment


class LocationBasis(str, Enum):
    KR = "KR"
    FOREIGN = "foreign"
    MIXED = "mixed"
    NONE = "none"


class ResidencyFactors(BaseModel):
    """스펙 1.2가 열거한 입력 요소."""
    has_domestic_address: Optional[bool] = None
    has_domestic_dwelling_place: Optional[bool] = None       # 국내 거소
    annual_domestic_days: Optional[int] = None                # 연간 국내 체류일수
    occupation_location: LocationBasis = LocationBasis.NONE
    spouse_children_location: LocationBasis = LocationBasis.NONE
    primary_living_relations_in_kr: Optional[bool] = None     # 주된 생활관계
    asset_location: LocationBasis = LocationBasis.NONE
    income_source_location: LocationBasis = LocationBasis.NONE
    has_foreign_permanent_residency_or_visa: Optional[bool] = None
    departure_purpose: Optional[str] = None
    planned_stay_duration_days: Optional[int] = None
    plans_to_return_to_kr: Optional[bool] = None
    as_of_date: date


DOMESTIC_DAYS_RESIDENT_THRESHOLD = 183  # 소득세법 §1의2 일반 원칙


def determine_tax_residency(f: ResidencyFactors) -> TaxResidencyAssessment:
    decisive: list[AssessmentFactor] = []
    conflicting: list[AssessmentFactor] = []
    missing: list[str] = []

    resident_points = 0
    non_resident_points = 0

    if f.annual_domestic_days is None:
        missing.append("연간 국내 체류일수")
    elif f.annual_domestic_days >= DOMESTIC_DAYS_RESIDENT_THRESHOLD:
        resident_points += 2
        decisive.append(AssessmentFactor(
            factor="연간 국내 체류일수", detail=f"{f.annual_domestic_days}일 (183일 이상)",
            weight="supports_resident",
        ))
    else:
        non_resident_points += 1
        conflicting.append(AssessmentFactor(
            factor="연간 국내 체류일수", detail=f"{f.annual_domestic_days}일 (183일 미만)",
            weight="supports_non_resident",
        ))

    if f.has_domestic_address is None:
        missing.append("국내 주소 존재 여부")
    elif f.has_domestic_address:
        resident_points += 2
        decisive.append(AssessmentFactor(factor="국내 주소", detail="있음", weight="supports_resident"))
    else:
        non_resident_points += 1

    if f.primary_living_relations_in_kr is None:
        missing.append("주된 생활관계 소재")
    elif f.primary_living_relations_in_kr:
        resident_points += 2
        decisive.append(AssessmentFactor(factor="주된 생활관계", detail="국내", weight="supports_resident"))
    else:
        non_resident_points += 2
        conflicting.append(AssessmentFactor(factor="주된 생활관계", detail="국외", weight="supports_non_resident"))

    if f.spouse_children_location == LocationBasis.FOREIGN:
        non_resident_points += 1
        conflicting.append(AssessmentFactor(
            factor="배우자·미성년 자녀 거주지", detail="국외", weight="supports_non_resident",
        ))
    elif f.spouse_children_location == LocationBasis.KR:
        resident_points += 1
        decisive.append(AssessmentFactor(factor="배우자·미성년 자녀 거주지", detail="국내", weight="supports_resident"))

    if f.occupation_location == LocationBasis.FOREIGN:
        non_resident_points += 1
    elif f.occupation_location == LocationBasis.KR:
        resident_points += 1

    if f.has_foreign_permanent_residency_or_visa:
        non_resident_points += 1
        conflicting.append(AssessmentFactor(
            factor="해외 영주권·체류자격", detail="보유", weight="supports_non_resident",
        ))

    if f.plans_to_return_to_kr is True:
        resident_points += 1
    elif f.plans_to_return_to_kr is False:
        non_resident_points += 1

    total_signal = resident_points + non_resident_points
    has_conflict = resident_points > 0 and non_resident_points > 0 and abs(resident_points - non_resident_points) <= 2

    if total_signal == 0 or len(missing) >= 3:
        status = ResidencyStatus.UNDETERMINED
        confidence = 0.2
    elif has_conflict:
        status = ResidencyStatus.DUAL_RESIDENCY_RISK
        confidence = 0.4
    elif resident_points > non_resident_points:
        status = ResidencyStatus.KR_RESIDENT
        confidence = min(0.95, 0.5 + resident_points * 0.08)
    else:
        status = ResidencyStatus.KR_NON_RESIDENT
        confidence = min(0.95, 0.5 + non_resident_points * 0.08)

    treaty_review_required = status == ResidencyStatus.DUAL_RESIDENCY_RISK or (
        f.has_foreign_permanent_residency_or_visa is True and f.asset_location != LocationBasis.KR
    )

    return TaxResidencyAssessment(
        status=status,
        as_of_date=f.as_of_date,
        confidence=confidence,
        decisive_factors=decisive,
        conflicting_factors=conflicting,
        missing_evidence=missing,
        treaty_review_required=treaty_review_required,
    )


def generate_parallel_residency_scenarios(f: ResidencyFactors) -> list[TaxResidencyAssessment]:
    """판정이 불명확할 때, 확정하지 말고 3개 병렬 가정을 만든다 (스펙 1.2).

    시나리오 엔진(Phase 3)은 이 세 갈래 각각에 대해 별도로 과세범위·공제·
    신고의무·납세의무자를 계산해야 한다.
    """
    base = determine_tax_residency(f)
    if base.status not in (ResidencyStatus.UNDETERMINED, ResidencyStatus.DUAL_RESIDENCY_RISK):
        return [base]

    return [
        TaxResidencyAssessment(
            status=ResidencyStatus.KR_RESIDENT,
            as_of_date=f.as_of_date, confidence=0.33,
            decisive_factors=base.decisive_factors,
            conflicting_factors=base.conflicting_factors,
            missing_evidence=base.missing_evidence,
            treaty_review_required=False,
        ),
        TaxResidencyAssessment(
            status=ResidencyStatus.KR_NON_RESIDENT,
            as_of_date=f.as_of_date, confidence=0.33,
            decisive_factors=base.decisive_factors,
            conflicting_factors=base.conflicting_factors,
            missing_evidence=base.missing_evidence,
            treaty_review_required=False,
        ),
        TaxResidencyAssessment(
            status=ResidencyStatus.DUAL_RESIDENCY_RISK,
            as_of_date=f.as_of_date, confidence=0.34,
            decisive_factors=base.decisive_factors,
            conflicting_factors=base.conflicting_factors,
            missing_evidence=base.missing_evidence,
            treaty_review_required=True,
        ),
    ]
