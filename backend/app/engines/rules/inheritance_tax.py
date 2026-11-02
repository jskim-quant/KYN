"""
상속세 규칙 엔진. 누진세율 구간은 gift_tax.yaml의 표를 공유 참조한다
(상증세법 §26 상속세 세율을 §56에서 증여세가 준용하는 구조와 반대로,
여기서는 이미 로드된 동일 테이블을 재사용한다).
"""
from __future__ import annotations

from datetime import date
from typing import Optional

from pydantic import BaseModel, Field

from app.engines.rules.bracket_calc import parse_brackets, progressive_tax
from app.engines.rules.rule_loader import RULE_TABLES_DIR, get_active_rule, load_all_rules
from app.models.legal_rule import LegalCitation, ValueStatus


class HeirInput(BaseModel):
    relation: str    # "배우자" | "자녀" | ...
    age: int = 30


class InheritanceTaxInput(BaseModel):
    total_estate: float                  # 억 원
    heirs: list[HeirInput] = Field(default_factory=list)
    prior_gifts_10yr: float = 0.0
    prior_gift_tax_paid: float = 0.0      # 상증세법 §28 기납부세액공제
    financial_assets: float = 0.0
    as_of: date


class InheritanceTaxResult(BaseModel):
    taxable_base: float
    deductions: dict[str, float]
    total_deduction: float
    gross_tax: float
    after_gift_credit: float
    voluntary_filing_credit: float
    final_tax: float
    status: ValueStatus
    legal_basis: list[LegalCitation]
    rule_ids_used: list[str]
    warnings: list[str]


def compute_inheritance_tax(inp: InheritanceTaxInput, rules: Optional[list] = None) -> InheritanceTaxResult:
    rules = rules if rules is not None else load_all_rules(RULE_TABLES_DIR)
    warnings: list[str] = []

    bracket_rule = get_active_rule(rules, "gift", "증여세_상속세_누진세율_구간", inp.as_of, allow_pending_review=True)
    personal_rule = get_active_rule(rules, "inheritance", "인적공제", inp.as_of, allow_pending_review=True)
    spousal_rule = get_active_rule(rules, "inheritance", "배우자공제", inp.as_of, allow_pending_review=True)
    financial_rule = get_active_rule(rules, "inheritance", "금융재산공제", inp.as_of, allow_pending_review=True)
    credit_rule = get_active_rule(rules, "gift", "신고세액공제", inp.as_of, allow_pending_review=True)

    used_rules = [bracket_rule, personal_rule, spousal_rule, financial_rule, credit_rule]
    if any(r.status.value == "pending_review" for r in used_rules):
        warnings.append("이 계산에 사용된 세율·공제 규칙 중 일부가 아직 세무사 검토로 확정되지 않았습니다.")
        result_status = ValueStatus.REQUIRES_EXPERT
    else:
        result_status = ValueStatus.CALCULATED

    has_spouse = any(h.relation == "배우자" for h in inp.heirs)
    children = [h for h in inp.heirs if h.relation == "자녀"]
    elderly_others = [h for h in inp.heirs if h.age >= 65 and h.relation != "배우자"]

    p = personal_rule.parameters
    deductions: dict[str, float] = {}
    deductions["기초공제"] = p["basic_deduction"]
    deductions["자녀공제"] = len(children) * p["child_deduction_each"]
    deductions["미성년공제"] = sum(
        max(0, 19 - c.age) * p["minor_deduction_per_remaining_year"] for c in children if c.age < 19
    )
    deductions["연로자공제"] = len(elderly_others) * p["elderly_deduction_each"]

    personal_total = sum(deductions.values())
    lump_sum = p["lump_sum_deduction"]
    base_deduction = max(personal_total, lump_sum)
    if lump_sum > personal_total:
        deductions["일괄공제_추가"] = lump_sum - personal_total

    if has_spouse:
        sp = spousal_rule.parameters
        spouse_deduction = min(sp["max_deduction"], max(sp["min_deduction"], inp.total_estate * sp["actual_share_rate"]))
        deductions["배우자공제"] = spouse_deduction

    if inp.financial_assets > 0:
        fp = financial_rule.parameters
        deductions["금융재산공제"] = min(fp["max_deduction"], max(fp["min_deduction"], inp.financial_assets * fp["rate"]))

    total_deduction = base_deduction + deductions.get("배우자공제", 0) + deductions.get("금융재산공제", 0)

    taxable_base = max(0.0, inp.total_estate + inp.prior_gifts_10yr - total_deduction)
    brackets = parse_brackets(bracket_rule.parameters, count=5)
    gross_tax = progressive_tax(taxable_base, brackets)

    after_gift_credit = max(0.0, gross_tax - min(inp.prior_gift_tax_paid, gross_tax))

    credit_rate = credit_rule.parameters["credit_rate"]
    filing_credit = after_gift_credit * credit_rate
    final_tax = max(0.0, after_gift_credit - filing_credit)

    legal_basis = [c for r in used_rules for c in r.legal_basis]

    return InheritanceTaxResult(
        taxable_base=taxable_base,
        deductions=deductions,
        total_deduction=total_deduction,
        gross_tax=gross_tax,
        after_gift_credit=after_gift_credit,
        voluntary_filing_credit=filing_credit,
        final_tax=final_tax,
        status=result_status,
        legal_basis=legal_basis,
        rule_ids_used=[r.rule_id for r in used_rules],
        warnings=warnings,
    )
