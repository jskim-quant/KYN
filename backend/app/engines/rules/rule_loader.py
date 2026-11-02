"""
법령 버전 테이블 로더 — backend/app/rule_tables/*.yaml을 LegalRuleVersion으로 읽는다.

세율·공제·한도는 절대 코드에 하드코딩하지 않는다 (스펙 0.2). 규칙 엔진은 이 로더가
반환한 LegalRuleVersion에서만 파라미터를 읽는다.
"""
from __future__ import annotations

import datetime as _dt
from pathlib import Path
from typing import Optional

import yaml

from app.models.legal_rule import LegalCitation, LegalRuleVersion, RuleStatus

RULE_TABLES_DIR = Path(__file__).resolve().parent.parent.parent / "rule_tables"


class RuleNotFoundError(Exception):
    pass


class RuleRequiresReviewError(Exception):
    """status가 pending_review인 규칙을 확정값으로 사용하려 할 때 발생.

    호출자는 이 예외를 잡아 ValueStatus.REQUIRES_EXPERT로 표시하거나,
    allow_pending_review=True로 명시적으로 승인하고 사용해야 한다.
    """


def _parse_date(value) -> Optional[_dt.date]:
    if value is None:
        return None
    if isinstance(value, _dt.date):
        return value
    return _dt.date.fromisoformat(str(value))


def load_rule_file(path: Path) -> list[LegalRuleVersion]:
    with open(path, encoding="utf-8") as f:
        raw = yaml.safe_load(f) or []
    rules = []
    for item in raw:
        legal_basis = [LegalCitation(**c) for c in item.get("legal_basis", [])]
        rules.append(LegalRuleVersion(
            rule_id=item["rule_id"],
            jurisdiction=item.get("jurisdiction", "KR"),
            tax_type=item["tax_type"],
            rule_name=item["rule_name"],
            effective_from=_parse_date(item["effective_from"]),
            effective_to=_parse_date(item.get("effective_to")),
            legal_basis=legal_basis,
            parameters=item.get("parameters", {}),
            status=RuleStatus(item.get("status", "pending_review")),
            reviewed_at=_parse_date(item.get("reviewed_at")),
            reviewed_by=item.get("reviewed_by"),
        ))
    return rules


def load_all_rules(rule_tables_dir: Path = RULE_TABLES_DIR) -> list[LegalRuleVersion]:
    rules: list[LegalRuleVersion] = []
    for path in sorted(rule_tables_dir.glob("*.yaml")):
        rules.extend(load_rule_file(path))
    return rules


def get_active_rule(
    rules: list[LegalRuleVersion],
    tax_type: str,
    rule_name: str,
    as_of: _dt.date,
    allow_pending_review: bool = False,
) -> LegalRuleVersion:
    candidates = [
        r for r in rules
        if r.tax_type == tax_type and r.rule_name == rule_name and r.is_active_on(as_of)
        and r.status != RuleStatus.DEPRECATED
    ]
    if not candidates:
        raise RuleNotFoundError(
            f"{as_of} 기준 활성 규칙 없음: tax_type={tax_type}, rule_name={rule_name}"
        )
    # 여러 버전이 겹치면 effective_from이 가장 최신인 것을 우선한다.
    chosen = max(candidates, key=lambda r: r.effective_from)
    if chosen.status == RuleStatus.PENDING_REVIEW and not allow_pending_review:
        raise RuleRequiresReviewError(
            f"규칙 '{rule_name}'({chosen.rule_id})은 아직 검토 확정(status=confirmed)되지 않았습니다. "
            f"세무사 검토 후 상태를 갱신하거나 allow_pending_review=True로 명시적으로 사용하십시오."
        )
    return chosen
