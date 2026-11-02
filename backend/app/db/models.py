"""
SQLAlchemy ORM 모델.

법령 버전 테이블은 정규화된 컬럼(effective_from 등)으로 조회 성능을 확보하고,
중첩 구조(legal_basis, parameters)는 JSONB로 저장한다. 시나리오는 이번 단계에서
아직 거래원자별 정규화 스키마를 만들지 않고 JSONB로 저장한다 — 원자 종류가
늘어나 스키마가 안정화되면 Phase 4에서 정규화한다 (docs/ARCHITECTURE.md 참고).
"""
from __future__ import annotations

import uuid
from datetime import date, datetime, timezone

from sqlalchemy import Boolean, Date, DateTime, String
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column
from sqlalchemy.types import JSON, TypeDecorator


class Base(DeclarativeBase):
    pass


class JSONVariant(TypeDecorator):
    """Postgres에서는 JSONB, 테스트용 SQLite에서는 JSON으로 동작하는 호환 타입."""
    impl = JSON
    cache_ok = True

    def load_dialect_impl(self, dialect):
        if dialect.name == "postgresql":
            return dialect.type_descriptor(JSONB())
        return dialect.type_descriptor(JSON())


def _uuid() -> str:
    return str(uuid.uuid4())


class LegalRuleVersionORM(Base):
    __tablename__ = "legal_rule_versions"

    rule_id: Mapped[str] = mapped_column(String, primary_key=True)
    jurisdiction: Mapped[str] = mapped_column(String, default="KR")
    tax_type: Mapped[str] = mapped_column(String, index=True)
    rule_name: Mapped[str] = mapped_column(String, index=True)
    effective_from: Mapped[date] = mapped_column(Date)
    effective_to: Mapped[date | None] = mapped_column(Date, nullable=True)
    legal_basis: Mapped[list] = mapped_column(JSONVariant, default=list)
    parameters: Mapped[dict] = mapped_column(JSONVariant, default=dict)
    status: Mapped[str] = mapped_column(String, default="pending_review")
    reviewed_at: Mapped[date | None] = mapped_column(Date, nullable=True)
    reviewed_by: Mapped[str | None] = mapped_column(String, nullable=True)


class ScenarioORM(Base):
    __tablename__ = "scenarios"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(String)
    objective_type: Mapped[str] = mapped_column(String, index=True)

    events: Mapped[list] = mapped_column(JSONVariant, default=list)
    assumptions: Mapped[list] = mapped_column(JSONVariant, default=list)
    legal_rule_version_ids: Mapped[list] = mapped_column(JSONVariant, default=list)
    annual_states: Mapped[list] = mapped_column(JSONVariant, default=list)

    feasibility_score: Mapped[dict | None] = mapped_column(JSONVariant, nullable=True)
    tax_review_risk: Mapped[dict | None] = mapped_column(JSONVariant, nullable=True)
    documentation_score: Mapped[dict | None] = mapped_column(JSONVariant, nullable=True)
    liquidity_risk: Mapped[dict | None] = mapped_column(JSONVariant, nullable=True)
    leverage_risk: Mapped[dict | None] = mapped_column(JSONVariant, nullable=True)
    family_governance_risk: Mapped[dict | None] = mapped_column(JSONVariant, nullable=True)

    rejected: Mapped[bool] = mapped_column(Boolean, default=False)
    rejection_reasons: Mapped[list] = mapped_column(JSONVariant, default=list)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=lambda: datetime.now(timezone.utc))
