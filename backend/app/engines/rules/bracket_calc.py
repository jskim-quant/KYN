"""
누진세 구간 계산 공용 유틸 — 증여세·상속세·양도세(종합소득세 준용) 규칙 엔진이
공유한다. 세율 테이블은 항상 rule_tables/*.yaml에서 읽은 파라미터로 구성한다.
"""
from __future__ import annotations

from typing import NamedTuple, Optional


class Bracket(NamedTuple):
    upto: Optional[float]  # None = 최상위 구간 (상한 없음)
    rate: float
    base_deduction: float  # 누진공제액


def parse_brackets(params: dict, count: int) -> list[Bracket]:
    brackets = []
    for i in range(1, count + 1):
        rate = params[f"bracket_{i}_rate"]
        base = params[f"bracket_{i}_base"]
        upto = params.get(f"bracket_{i}_upto")  # 마지막 구간은 upto 없음
        brackets.append(Bracket(upto=upto, rate=rate, base_deduction=base))
    return brackets


def progressive_tax(base: float, brackets: list[Bracket]) -> float:
    if base <= 0:
        return 0.0
    for b in brackets:
        if b.upto is None or base <= b.upto:
            return base * b.rate - b.base_deduction
    # 방어적 fallback — brackets 마지막 항목이 항상 upto=None이어야 함
    last = brackets[-1]
    return base * last.rate - last.base_deduction
