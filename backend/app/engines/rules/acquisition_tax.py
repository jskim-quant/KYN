"""
취득세 규칙 엔진 — 기존 KYN lib/tax.ts calcAcquisitionTax()에서 이전.
"""
from __future__ import annotations

from datetime import date
from enum import Enum
from typing import Optional

from pydantic import BaseModel

from app.engines.rules.rule_loader import RULE_TABLES_DIR, get_active_rule, load_all_rules
from app.models.legal_rule import LegalCitation, ValueStatus

_TAXABLE_TYPES = {"상업용부동산", "주거용부동산", "토지", "농지", "임야", "오피스텔"}
_RESIDENTIAL_TYPES = {"주거용부동산", "오피스텔"}


class AcquisitionKind(str, Enum):
    PURCHASE = "purchase"
    GIFT = "gift"
    INHERITANCE = "inheritance"


class AcquisitionTaxInput(BaseModel):
    value: float
    asset_type: str
    is_corp: bool = False
    is_multi_house: bool = False
    acquisition_kind: AcquisitionKind = AcquisitionKind.PURCHASE
    as_of: date


class AcquisitionTaxResult(BaseModel):
    tax: float
    rate_applied: float
    status: ValueStatus
    legal_basis: list[LegalCitation]
    rule_ids_used: list[str]
    note: str = ""


def compute_acquisition_tax(inp: AcquisitionTaxInput, rules: Optional[list] = None) -> AcquisitionTaxResult:
    rules = rules if rules is not None else load_all_rules(RULE_TABLES_DIR)

    general_rule = get_active_rule(rules, "acquisition", "취득세_유형별_세율", inp.as_of, allow_pending_review=True)
    gift_rule = get_active_rule(rules, "acquisition", "무상취득_취득세율", inp.as_of, allow_pending_review=True)
    used_rules = [general_rule, gift_rule]
    result_status = (
        ValueStatus.REQUIRES_EXPERT
        if any(r.status.value == "pending_review" for r in used_rules)
        else ValueStatus.CALCULATED
    )
    legal_basis = [c for r in used_rules for c in r.legal_basis]

    if inp.asset_type not in _TAXABLE_TYPES:
        return AcquisitionTaxResult(
            tax=0.0, rate_applied=0.0, status=result_status, legal_basis=legal_basis,
            rule_ids_used=[r.rule_id for r in used_rules], note="취득세 과세대상 자산유형 아님",
        )

    g = gift_rule.parameters
    is_residential = inp.asset_type in _RESIDENTIAL_TYPES

    if inp.acquisition_kind == AcquisitionKind.INHERITANCE:
        rate = g["inheritance_residential"] if is_residential else g["inheritance_other"]
        return AcquisitionTaxResult(
            tax=inp.value * rate, rate_applied=rate, status=result_status, legal_basis=legal_basis,
            rule_ids_used=[r.rule_id for r in used_rules], note="상속취득",
        )

    if inp.acquisition_kind == AcquisitionKind.GIFT:
        rate = (
            g["gift_residential_corp_or_multi_house"]
            if (is_residential and (inp.is_corp or inp.is_multi_house))
            else g["gift_residential_general"]
        )
        return AcquisitionTaxResult(
            tax=inp.value * rate, rate_applied=rate, status=result_status, legal_basis=legal_basis,
            rule_ids_used=[r.rule_id for r in used_rules], note="증여취득",
        )

    p = general_rule.parameters
    if inp.is_corp:
        rate = p["corp_residential"] if is_residential else p["corp_commercial_or_land"]
        return AcquisitionTaxResult(
            tax=inp.value * rate, rate_applied=rate, status=result_status, legal_basis=legal_basis,
            rule_ids_used=[r.rule_id for r in used_rules], note="법인 취득",
        )

    if is_residential:
        if inp.is_multi_house:
            rate = p["residential_multi_house"]
        elif inp.value <= 6:
            rate = p["residential_under_6"]
        elif inp.value <= 9:
            rate = p["residential_under_9"]
        else:
            rate = p["residential_over_9"]
        return AcquisitionTaxResult(
            tax=inp.value * rate, rate_applied=rate, status=result_status, legal_basis=legal_basis,
            rule_ids_used=[r.rule_id for r in used_rules], note="개인 주거용 매매취득",
        )

    if inp.asset_type == "농지":
        rate = p["farmland"]
    else:
        rate = p["commercial_or_land_default"]
    return AcquisitionTaxResult(
        tax=inp.value * rate, rate_applied=rate, status=result_status, legal_basis=legal_basis,
        rule_ids_used=[r.rule_id for r in used_rules], note="개인 매매취득 (상업용·토지·농지)",
    )
