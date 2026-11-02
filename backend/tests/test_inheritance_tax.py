from datetime import date

import pytest

from app.engines.rules.inheritance_tax import HeirInput, InheritanceTaxInput, compute_inheritance_tax

AS_OF = date(2026, 1, 1)


def test_lump_sum_deduction_used_when_personal_total_lower():
    # 배우자 없음, 자녀 1명(성년) → 인적공제합계 2.5억 < 일괄공제 5억 → 5억 적용
    result = compute_inheritance_tax(InheritanceTaxInput(
        total_estate=10.0, heirs=[HeirInput(relation="자녀", age=30)], as_of=AS_OF,
    ))
    assert result.total_deduction == pytest.approx(5.0)
    assert result.taxable_base == pytest.approx(5.0)


def test_spousal_deduction_capped_at_30():
    result = compute_inheritance_tax(InheritanceTaxInput(
        total_estate=100.0,
        heirs=[HeirInput(relation="배우자", age=60), HeirInput(relation="자녀", age=30)],
        as_of=AS_OF,
    ))
    assert result.deductions["배우자공제"] == pytest.approx(30.0)


def test_spousal_deduction_floor_at_5():
    result = compute_inheritance_tax(InheritanceTaxInput(
        total_estate=5.0,
        heirs=[HeirInput(relation="배우자", age=60)],
        as_of=AS_OF,
    ))
    assert result.deductions["배우자공제"] == pytest.approx(5.0)


def test_minor_deduction_scales_with_remaining_years():
    result = compute_inheritance_tax(InheritanceTaxInput(
        total_estate=10.0,
        heirs=[HeirInput(relation="자녀", age=10)],  # 잔여 9년
        as_of=AS_OF,
    ))
    assert result.deductions["미성년공제"] == pytest.approx(0.9)


def test_prior_gift_tax_credit_reduces_final_tax():
    no_credit = compute_inheritance_tax(InheritanceTaxInput(total_estate=20.0, as_of=AS_OF))
    with_credit = compute_inheritance_tax(InheritanceTaxInput(
        total_estate=20.0, prior_gift_tax_paid=0.5, as_of=AS_OF,
    ))
    assert with_credit.final_tax < no_credit.final_tax
