"""
DB 리포지토리 — ORM ↔ Pydantic 변환을 여기서만 담당한다.
엔진 코드(app/engines/*)는 이 파일을 몰라도 되고, DB 유무와 무관하게 동작한다
(YAML 로더가 기본 경로이며, DB는 영속화·조회 최적화를 위한 추가 계층이다).
"""
from __future__ import annotations

from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import LegalRuleVersionORM, ScenarioORM
from app.engines.rules.rule_loader import RULE_TABLES_DIR, load_all_rules
from app.models.legal_rule import LegalRuleVersion
from app.models.scenario import Scenario


def _rule_to_orm_kwargs(rule: LegalRuleVersion) -> dict:
    return dict(
        rule_id=rule.rule_id,
        jurisdiction=rule.jurisdiction,
        tax_type=rule.tax_type,
        rule_name=rule.rule_name,
        effective_from=rule.effective_from,
        effective_to=rule.effective_to,
        legal_basis=[c.model_dump(mode="json") for c in rule.legal_basis],
        parameters=rule.parameters,
        status=rule.status.value,
        reviewed_at=rule.reviewed_at,
        reviewed_by=rule.reviewed_by,
    )


def upsert_legal_rule_version(session: Session, rule: LegalRuleVersion) -> LegalRuleVersionORM:
    existing = session.get(LegalRuleVersionORM, rule.rule_id)
    kwargs = _rule_to_orm_kwargs(rule)
    if existing is None:
        row = LegalRuleVersionORM(**kwargs)
        session.add(row)
    else:
        for k, v in kwargs.items():
            setattr(existing, k, v)
        row = existing
    return row


def seed_rule_tables_from_yaml(session: Session, rule_tables_dir: Path = RULE_TABLES_DIR) -> int:
    """rule_tables/*.yaml을 읽어 DB에 upsert한다. YAML이 진실의 원천(source of truth)이고
    DB는 그 스냅샷 + 조회 캐시 역할이다."""
    rules = load_all_rules(rule_tables_dir)
    for rule in rules:
        upsert_legal_rule_version(session, rule)
    session.commit()
    return len(rules)


def _orm_to_rule(row: LegalRuleVersionORM) -> LegalRuleVersion:
    return LegalRuleVersion(
        rule_id=row.rule_id, jurisdiction=row.jurisdiction, tax_type=row.tax_type,
        rule_name=row.rule_name, effective_from=row.effective_from, effective_to=row.effective_to,
        legal_basis=row.legal_basis, parameters=row.parameters, status=row.status,
        reviewed_at=row.reviewed_at, reviewed_by=row.reviewed_by,
    )


def load_all_rules_from_db(session: Session, tax_type: str | None = None) -> list[LegalRuleVersion]:
    stmt = select(LegalRuleVersionORM)
    if tax_type:
        stmt = stmt.where(LegalRuleVersionORM.tax_type == tax_type)
    rows = session.execute(stmt).scalars().all()
    return [_orm_to_rule(r) for r in rows]


def save_scenario(session: Session, scenario: Scenario) -> ScenarioORM:
    row = ScenarioORM(
        id=scenario.id,
        name=scenario.name,
        objective_type=scenario.objective_type.value,
        events=[e.model_dump(mode="json") for e in scenario.events],
        assumptions=[a.model_dump(mode="json") for a in scenario.assumptions],
        legal_rule_version_ids=scenario.legal_rule_version_ids,
        annual_states=[s.model_dump(mode="json") for s in scenario.annual_states],
        feasibility_score=scenario.feasibility_score.model_dump(mode="json") if scenario.feasibility_score else None,
        tax_review_risk=scenario.tax_review_risk.model_dump(mode="json") if scenario.tax_review_risk else None,
        documentation_score=scenario.documentation_score.model_dump(mode="json") if scenario.documentation_score else None,
        liquidity_risk=scenario.liquidity_risk.model_dump(mode="json") if scenario.liquidity_risk else None,
        leverage_risk=scenario.leverage_risk.model_dump(mode="json") if scenario.leverage_risk else None,
        family_governance_risk=scenario.family_governance_risk.model_dump(mode="json") if scenario.family_governance_risk else None,
        rejected=scenario.rejected,
        rejection_reasons=scenario.rejection_reasons,
    )
    session.merge(row)
    session.commit()
    return row


def get_scenario(session: Session, scenario_id: str) -> Scenario | None:
    row = session.get(ScenarioORM, scenario_id)
    if row is None:
        return None
    return Scenario(
        id=row.id, name=row.name, objective_type=row.objective_type,
        events=row.events, assumptions=row.assumptions,
        legal_rule_version_ids=row.legal_rule_version_ids, annual_states=row.annual_states,
        feasibility_score=row.feasibility_score, tax_review_risk=row.tax_review_risk,
        documentation_score=row.documentation_score, liquidity_risk=row.liquidity_risk,
        leverage_risk=row.leverage_risk, family_governance_risk=row.family_governance_risk,
        rejected=row.rejected, rejection_reasons=row.rejection_reasons,
    )
