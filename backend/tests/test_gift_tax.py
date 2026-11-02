"""
증여세 규칙 엔진 테스트 — 기존 KYN(Next.js) lib/tax.ts의 calcGiftTax()와
동일한 산식(병합과세표준 - 이전분 세액, 세대생략 할증, 신고세액공제 3%)을
따르는지 수치로 교차검증한다.
"""
from datetime import date

import pytest

from app.engines.rules.gift_tax import GiftTaxInput, compute_gift_tax
from app.models.legal_rule import ValueStatus

AS_OF = date(2026, 1, 1)


def test_simple_child_gift_bracket_1():
    result = compute_gift_tax(GiftTaxInput(
        gift_amount=1.0, relation="자녀", recipient_is_adult=True, as_of=AS_OF,
    ))
    assert result.deduction_applied == pytest.approx(0.5)
    assert result.taxable_base_merged == pytest.approx(0.5)
    assert result.tax_before_surcharge == pytest.approx(0.05)
    assert result.final_tax == pytest.approx(0.0485, abs=1e-4)
    assert result.status == ValueStatus.REQUIRES_EXPERT  # rule_tables 모두 pending_review


def test_child_gift_bracket_2():
    result = compute_gift_tax(GiftTaxInput(
        gift_amount=3.0, relation="자녀", recipient_is_adult=True, as_of=AS_OF,
    ))
    assert result.tax_before_surcharge == pytest.approx(0.40, abs=1e-6)
    assert result.final_tax == pytest.approx(0.388, abs=1e-4)


def test_generation_skip_adult_uses_general_surcharge():
    result = compute_gift_tax(GiftTaxInput(
        gift_amount=3.0, relation="손자녀", recipient_is_adult=True,
        is_generation_skip=True, as_of=AS_OF,
    ))
    assert result.generation_skip_surcharge == pytest.approx(0.12, abs=1e-6)
    assert result.final_tax == pytest.approx(0.5044, abs=1e-4)


def test_generation_skip_minor_over_threshold_uses_40pct_surcharge():
    result = compute_gift_tax(GiftTaxInput(
        gift_amount=25.0, relation="손자녀", recipient_is_adult=False,
        is_generation_skip=True, as_of=AS_OF,
    ))
    # merged_base = 25 - 0.2 = 24.8 → bracket4: 24.8*0.40 - 2.40 = 7.52
    assert result.tax_before_surcharge == pytest.approx(7.52, abs=1e-6)
    # total_gift(25) > 20 & minor → 40% surcharge
    assert result.generation_skip_surcharge == pytest.approx(3.008, abs=1e-6)
    assert result.final_tax == pytest.approx(10.21216, abs=1e-4)


def test_prior_gifts_10yr_merged_and_deducted_once():
    result = compute_gift_tax(GiftTaxInput(
        gift_amount=1.0, relation="자녀", recipient_is_adult=True,
        prior_gifts_10yr=0.5, as_of=AS_OF,
    ))
    assert result.taxable_base_merged == pytest.approx(1.0, abs=1e-6)
    assert result.tax_before_surcharge == pytest.approx(0.10, abs=1e-6)
    assert result.final_tax == pytest.approx(0.097, abs=1e-4)


def test_unrecognized_relation_falls_back_to_other_with_warning():
    result = compute_gift_tax(GiftTaxInput(
        gift_amount=1.0, relation="이상한관계", as_of=AS_OF,
    ))
    assert result.deduction_applied == pytest.approx(0.1)
    assert any("인식하지 못해" in w for w in result.warnings)


def test_legal_basis_is_populated():
    result = compute_gift_tax(GiftTaxInput(gift_amount=1.0, relation="자녀", as_of=AS_OF))
    statutes = {c.statute for c in result.legal_basis}
    assert "상속세및증여세법" in statutes
    assert len(result.rule_ids_used) == 4
