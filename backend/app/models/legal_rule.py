"""
법령 버전 테이블 — 세율·공제·한도를 코드에 하드코딩하지 않기 위한 스키마.

실제 값은 backend/app/rule_tables/*.yaml에 저장하고, 이 모델로 로드·검증한다.
"""
from __future__ import annotations

from datetime import date
from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field


class RuleStatus(str, Enum):
    CONFIRMED = "confirmed"
    PENDING_REVIEW = "pending_review"
    DEPRECATED = "deprecated"


class LegalCitation(BaseModel):
    """조문 인용. 법 이름 + 조/항/호, 그리고 확인 가능한 출처."""
    statute: str            # 예: "상속세및증여세법"
    article: str            # 예: "§60"
    clause: Optional[str] = None
    source_url: Optional[str] = None
    note: Optional[str] = None


class LegalRuleVersion(BaseModel):
    rule_id: str
    jurisdiction: str = "KR"
    tax_type: str            # "inheritance" | "gift" | "cgt" | "acquisition" | "income" | "corporate"
    rule_name: str
    effective_from: date
    effective_to: Optional[date] = None
    legal_basis: list[LegalCitation] = Field(default_factory=list)
    parameters: dict[str, float | str | bool | list[str]] = Field(default_factory=dict)
    status: RuleStatus = RuleStatus.PENDING_REVIEW
    reviewed_at: Optional[date] = None
    reviewed_by: Optional[str] = None

    def is_active_on(self, as_of: date) -> bool:
        if as_of < self.effective_from:
            return False
        if self.effective_to is not None and as_of > self.effective_to:
            return False
        return True


class ValueStatus(str, Enum):
    """모든 계산 결과에 붙는 신뢰도 표시. 확정 자문과 시뮬레이션을 구분한다."""
    CALCULATED = "CALCULATED"              # 법령 테이블에 따라 계산됨
    ESTIMATED = "ESTIMATED"                # 시장가치·금리 등 추정값 사용
    ASSUMED = "ASSUMED"                    # 사용자 또는 시스템 가정
    REQUIRES_DOCUMENT = "REQUIRES_DOCUMENT" # 증빙 확인 필요
    REQUIRES_EXPERT = "REQUIRES_EXPERT"    # 세무사·변호사·감정평가사 확인 필요
    NOT_IMPLEMENTED = "NOT_IMPLEMENTED"    # 규칙 미구현


class ValuedResult(BaseModel):
    """계산 결과 하나에 대한 표준 래퍼 — 값 + 신뢰도 상태 + 근거."""
    value: float
    status: ValueStatus
    as_of: date
    legal_basis: list[LegalCitation] = Field(default_factory=list)
    valuation_method: Optional[str] = None
    input_sources: list[str] = Field(default_factory=list)
    note: Optional[str] = None
