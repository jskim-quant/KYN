"""
양도소득세 규칙 엔진 — 기존 KYN lib/tax.ts calcCapitalGainsTax()/calcIncomeTax()에서 이전.
"""
from __future__ import annotations

from datetime import date
from typing import Optional

from pydantic import BaseModel

from app.engines.rules.bracket_calc import parse_brackets, progressive_tax
from app.engines.rules.rule_loader import RULE_TABLES_DIR, get_active_rule, load_all_rules
from app.models.legal_rule import LegalCitation, ValueStatus

REAL_ESTATE_TYPES = {"상업용부동산", "주거용부동산", "토지"}


class CGTInput(BaseModel):
    current_value: float
    acquisition_cost: float
    acquisition_date: date
    asset_type: str
    is_one_house_one_family: bool = False
    as_of: date


class CGTResult(BaseModel):
    gain: float
    holding_years: int
    exempt: bool
    long_term_holding_deduction_rate: float
    taxable_gain: float
    tax: float
    status: ValueStatus
    legal_basis: list[LegalCitation]
    rule_ids_used: list[str]
    warnings: list[str]
    note: str = ""


def _income_tax(taxable: float, income_rule) -> float:
    brackets = parse_brackets(income_rule.parameters, count=8)
    return progressive_tax(taxable, brackets)


def compute_cgt(inp: CGTInput, rules: Optional[list] = None) -> CGTResult:
    rules = rules if rules is not None else load_all_rules(RULE_TABLES_DIR)
    warnings: list[str] = []

    income_rule = get_active_rule(rules, "cgt", "종합소득세_누진세율_구간", inp.as_of, allow_pending_review=True)
    lthd_rule = get_active_rule(rules, "cgt", "장기보유특별공제_일반", inp.as_of, allow_pending_review=True)
    one_house_rule = get_active_rule(rules, "cgt", "1세대1주택_비과세", inp.as_of, allow_pending_review=True)
    short_term_rule = get_active_rule(rules, "cgt", "단기보유_중과세율", inp.as_of, allow_pending_review=True)

    used_rules = [income_rule, lthd_rule, one_house_rule, short_term_rule]
    if any(r.status.value == "pending_review" for r in used_rules):
        warnings.append("이 계산에 사용된 세율·공제 규칙 중 일부가 아직 세무사 검토로 확정되지 않았습니다.")
        result_status = ValueStatus.REQUIRES_EXPERT
    else:
        result_status = ValueStatus.CALCULATED

    gain = max(0.0, inp.current_value - inp.acquisition_cost)
    years = max(0, (inp.as_of - inp.acquisition_date).days // 365)

    if gain <= 0:
        return CGTResult(
            gain=0.0, holding_years=years, exempt=True, long_term_holding_deduction_rate=0.0,
            taxable_gain=0.0, tax=0.0, status=result_status, legal_basis=[],
            rule_ids_used=[r.rule_id for r in used_rules], warnings=warnings, note="양도차익 없음",
        )

    legal_basis = [c for r in used_rules for c in r.legal_basis]

    if inp.is_one_house_one_family and inp.asset_type == "주거용부동산" and years >= 2:
        oh = one_house_rule.parameters
        if inp.current_value <= oh["exempt_limit"]:
            return CGTResult(
                gain=gain, holding_years=years, exempt=True, long_term_holding_deduction_rate=0.0,
                taxable_gain=0.0, tax=0.0, status=result_status, legal_basis=legal_basis,
                rule_ids_used=[r.rule_id for r in used_rules], warnings=warnings,
                note=f"1세대1주택 비과세 (양도가액 {oh['exempt_limit']}억 이하)",
            )
        taxable_ratio = (inp.current_value - oh["exempt_limit"]) / inp.current_value
        partial_gain = gain * taxable_ratio
        lthd_rate = oh["lthd_10yr_rate"] if years >= 10 else oh["lthd_5yr_rate"] if years >= 5 else oh["lthd_below_5yr_rate"]
        taxable_gain = max(0.0, partial_gain * (1 - lthd_rate) - oh["basic_deduction"])
        tax = _income_tax(taxable_gain, income_rule)
        return CGTResult(
            gain=gain, holding_years=years, exempt=False, long_term_holding_deduction_rate=lthd_rate,
            taxable_gain=taxable_gain, tax=tax, status=result_status, legal_basis=legal_basis,
            rule_ids_used=[r.rule_id for r in used_rules], warnings=warnings,
            note="1세대1주택 초과분 안분과세",
        )

    lthd_rate = 0.0
    if inp.asset_type in REAL_ESTATE_TYPES:
        lp = lthd_rule.parameters
        if years >= 15:
            lthd_rate = lp["years_15_rate"]
        elif years >= 10:
            lthd_rate = lp["years_10_rate"]
        elif years >= 5:
            lthd_rate = lp["years_5_rate"]
        elif years >= 3:
            lthd_rate = lp["years_3_rate"]

    deducted_gain = gain * (1 - lthd_rate)
    basic_deduction = one_house_rule.parameters["basic_deduction"]  # 250만원, 공통
    taxable_gain = max(0.0, deducted_gain - basic_deduction)

    if inp.asset_type == "금융자산":
        tax = _income_tax(taxable_gain, income_rule)
        return CGTResult(
            gain=gain, holding_years=years, exempt=False, long_term_holding_deduction_rate=0.0,
            taxable_gain=taxable_gain, tax=tax, status=result_status, legal_basis=legal_basis,
            rule_ids_used=[r.rule_id for r in used_rules], warnings=warnings, note="금융투자소득세 폐지 → 소득세율 준용",
        )

    st = short_term_rule.parameters
    if years < 1:
        tax = taxable_gain * st["under_1yr_rate"]
        note = "1년 미만 단기 세율"
    elif years < 2:
        tax = taxable_gain * st["under_2yr_rate"]
        note = "2년 미만 단기 세율"
    else:
        tax = _income_tax(taxable_gain, income_rule)
        note = "2년 이상 기본세율"

    return CGTResult(
        gain=gain, holding_years=years, exempt=False, long_term_holding_deduction_rate=lthd_rate,
        taxable_gain=taxable_gain, tax=tax, status=result_status, legal_basis=legal_basis,
        rule_ids_used=[r.rule_id for r in used_rules], warnings=warnings, note=note,
    )
