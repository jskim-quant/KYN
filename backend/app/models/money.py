"""
금액 타입 — 부동소수점 대신 Decimal을 사용한다.

단위: 억 원 (KRW 100,000,000). 프론트엔드 표시 형식과 맞추기 위해 억 단위를 기본으로 하되,
내부 세액 계산은 항상 Decimal로 수행해 반올림 오차가 누적되지 않도록 한다.
"""
from __future__ import annotations

from decimal import ROUND_HALF_UP, Decimal
from typing import Union

# 억 원 단위 Decimal. 소수점 4자리까지 보존 (계산 중간값), 표시 시 반올림은 표시 레이어에서.
Money = Decimal

ZERO: Money = Decimal("0")


def money(value: Union[str, int, float, Decimal]) -> Money:
    """float 입력을 안전하게 Decimal로 변환한다. float은 문자열을 경유해 정밀도 손실을 막는다."""
    if isinstance(value, Decimal):
        return value
    if isinstance(value, float):
        return Decimal(str(value))
    return Decimal(value)


def round_money(value: Money, digits: int = 2) -> Money:
    quant = Decimal("1").scaleb(-digits)
    return value.quantize(quant, rounding=ROUND_HALF_UP)
