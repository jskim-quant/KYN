from datetime import date

from app.engines.rules.residency import (
    LocationBasis,
    ResidencyFactors,
    determine_tax_residency,
    generate_parallel_residency_scenarios,
)
from app.models.person import ResidencyStatus


def test_clear_resident_case():
    f = ResidencyFactors(
        has_domestic_address=True,
        annual_domestic_days=300,
        primary_living_relations_in_kr=True,
        spouse_children_location=LocationBasis.KR,
        occupation_location=LocationBasis.KR,
        as_of_date=date(2026, 1, 1),
    )
    result = determine_tax_residency(f)
    assert result.status == ResidencyStatus.KR_RESIDENT
    assert result.confidence > 0.5


def test_clear_non_resident_case():
    f = ResidencyFactors(
        has_domestic_address=False,
        annual_domestic_days=20,
        primary_living_relations_in_kr=False,
        spouse_children_location=LocationBasis.FOREIGN,
        occupation_location=LocationBasis.FOREIGN,
        has_foreign_permanent_residency_or_visa=True,
        plans_to_return_to_kr=False,
        as_of_date=date(2026, 1, 1),
    )
    result = determine_tax_residency(f)
    assert result.status == ResidencyStatus.KR_NON_RESIDENT
    assert result.treaty_review_required is True


def test_missing_data_is_undetermined():
    f = ResidencyFactors(as_of_date=date(2026, 1, 1))
    result = determine_tax_residency(f)
    assert result.status == ResidencyStatus.UNDETERMINED
    assert len(result.missing_evidence) >= 3


def test_undetermined_generates_three_parallel_scenarios():
    f = ResidencyFactors(as_of_date=date(2026, 1, 1))
    scenarios = generate_parallel_residency_scenarios(f)
    statuses = {s.status for s in scenarios}
    assert statuses == {
        ResidencyStatus.KR_RESIDENT,
        ResidencyStatus.KR_NON_RESIDENT,
        ResidencyStatus.DUAL_RESIDENCY_RISK,
    }


def test_study_abroad_child_conflicting_factors_flags_dual_risk_or_undetermined():
    """유학 중인 자녀 — 체류일수는 국외지만 국내 주소·자산은 유지되는 전형적 케이스."""
    f = ResidencyFactors(
        has_domestic_address=True,
        annual_domestic_days=60,
        primary_living_relations_in_kr=None,
        spouse_children_location=LocationBasis.FOREIGN,
        occupation_location=LocationBasis.NONE,
        plans_to_return_to_kr=True,
        as_of_date=date(2026, 1, 1),
    )
    result = determine_tax_residency(f)
    assert result.status in (ResidencyStatus.DUAL_RESIDENCY_RISK, ResidencyStatus.KR_RESIDENT, ResidencyStatus.UNDETERMINED)
