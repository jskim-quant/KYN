"""
증여세 규칙 엔진 — 법령 버전 테이블(rule_tables/gift_tax.yaml)만 참조하고
세율·공제를 코드에 하드코딩하지 않는다.

계산 순서 (상증세법 §47, §53, §57, §69):
  1. 10년 내 동일인 증여 합산
  2. 관계별 공제 차감
  3. 누진세율 적용 (병합 과세표준 세액 - 이전 증여분 세액 = 이번 산출세액)
  4. 세대생략 할증 (해당 시)
  5. 신고세액공제 3% 차감
"""
from __future__ import annotations

from datetime import date
from typing import Optional

from pydantic import BaseModel

from app.models.legal_rule import LegalCitation, ValueStatus
from app.engines.rules.bracket_calc import parse_brackets, progressive_tax
from app.engines.rules.rule_loader import RULE_TABLES_DIR, get_active_rule, load_all_rules

_RELATION_DEDUCTION_KEY = {
    "spouse": "spouse", "배우자": "spouse",
    "child": "child", "자녀": "child",
    "grandchild": "grandchild", "손자녀": "grandchild",
    "daughter_in_law": "daughter_in_law", "며느리": "daughter_in_law",
    "son_in_law": "son_in_law", "사위": "son_in_law",
    "parent": "parent", "부모": "parent",
    "grandparent": "grandparent", "조부모": "grandparent",
    "sibling": "sibling", "형제": "sibling",
    "uncle_aunt": "uncle_aunt", "삼촌": "uncle_aunt", "고모": "uncle_aunt",
    "other": "other", "기타": "other",
}


class GiftTaxInput(BaseModel):
    gift_amount: float           # 억 원
    relation: str                # 위 _RELATION_DEDUCTION_KEY의 키 (한글/영문 모두 허용)
    recipient_is_adult: bool = True
    is_generation_skip: bool = False
    prior_gifts_10yr: float = 0.0
    as_of: date


def _bracket_tax_progressive(base: float, p: dict) -> float:
    return progressive_tax(base, parse_brackets(p, count=5))


class GiftTaxResult(BaseModel):
    gift_amount: float
    deduction_applied: float
    taxable_base_merged: float
    tax_before_surcharge: float
    generation_skip_surcharge: float
    tax_after_surcharge: float
    voluntary_filing_credit: float
    final_tax: float
    status: ValueStatus
    legal_basis: list[LegalCitation]
    rule_ids_used: list[str]
    warnings: list[str]


def compute_gift_tax(inp: GiftTaxInput, rules: Optional[list] = None) -> GiftTaxResult:
    rules = rules if rules is not None else load_all_rules(RULE_TABLES_DIR)
    warnings: list[str] = []

    bracket_rule = get_active_rule(rules, "gift", "증여세_상속세_누진세율_구간", inp.as_of, allow_pending_review=True)
    deduction_rule = get_active_rule(rules, "gift", "관계별_10년_증여공제_한도", inp.as_of, allow_pending_review=True)
    surcharge_rule = get_active_rule(rules, "gift", "세대생략_증여_할증", inp.as_of, allow_pending_review=True)
    credit_rule = get_active_rule(rules, "gift", "신고세액공제", inp.as_of, allow_pending_review=True)

    used_rules = [bracket_rule, deduction_rule, surcharge_rule, credit_rule]
    if any(r.status.value == "pending_review" for r in used_rules):
        warnings.append("이 계산에 사용된 세율·공제 규칙 중 일부가 아직 세무사 검토로 확정되지 않았습니다 (status=pending_review).")
        result_status = ValueStatus.REQUIRES_EXPERT
    else:
        result_status = ValueStatus.CALCULATED

    relation_key = _RELATION_DEDUCTION_KEY.get(inp.relation)
    if relation_key is None:
        relation_key = "other"
        warnings.append(f"관계 '{inp.relation}'을 인식하지 못해 '기타' 공제를 적용했습니다.")

    p_ded = deduction_rule.parameters
    if relation_key == "child":
        deduction = p_ded["child_adult"] if inp.recipient_is_adult else p_ded["child_minor"]
    elif relation_key == "grandchild":
        deduction = p_ded["grandchild_adult"] if inp.recipient_is_adult else p_ded["grandchild_minor"]
    else:
        deduction = p_ded.get(relation_key, p_ded["other"])

    p_brk = bracket_rule.parameters
    merged_base = max(0.0, inp.gift_amount + inp.prior_gifts_10yr - deduction)
    prior_base = max(0.0, inp.prior_gifts_10yr - deduction)

    tax_on_merged = _bracket_tax_progressive(merged_base, p_brk)
    tax_on_prior = _bracket_tax_progressive(prior_base, p_brk)
    tax_before_surcharge = max(0.0, tax_on_merged - tax_on_prior)

    p_sur = surcharge_rule.parameters
    surcharge_amount = 0.0
    if inp.is_generation_skip:
        total_gift_amount = inp.gift_amount + inp.prior_gifts_10yr
        multiplier = (
            p_sur["minor_over_threshold_surcharge_multiplier"]
            if (not inp.recipient_is_adult and total_gift_amount > p_sur["minor_threshold_amount"])
            else p_sur["general_surcharge_multiplier"]
        )
        surcharge_amount = tax_before_surcharge * (multiplier - 1)

    tax_after_surcharge = tax_before_surcharge + surcharge_amount

    credit_rate = credit_rule.parameters["credit_rate"]
    filing_credit = tax_after_surcharge * credit_rate
    final_tax = max(0.0, tax_after_surcharge - filing_credit)

    legal_basis = [c for r in used_rules for c in r.legal_basis]

    return GiftTaxResult(
        gift_amount=inp.gift_amount,
        deduction_applied=deduction,
        taxable_base_merged=merged_base,
        tax_before_surcharge=tax_before_surcharge,
        generation_skip_surcharge=surcharge_amount,
        tax_after_surcharge=tax_after_surcharge,
        voluntary_filing_credit=filing_credit,
        final_tax=final_tax,
        status=result_status,
        legal_basis=legal_basis,
        rule_ids_used=[r.rule_id for r in used_rules],
        warnings=warnings,
    )
