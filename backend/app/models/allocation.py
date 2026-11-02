"""
자산배분 모델 (새 스펙 Phase 4).

핵심: 개별 유가증권이 아니라 "가족 전체 대차대조표"를 하나의 포트폴리오로 다룬다
(부동산·법인지분·현금까지 포함) — 단순 Markowitz 유가증권 배분이 아니다.
"""
from __future__ import annotations

from pydantic import BaseModel, Field

from app.models.balance_sheet import AssetCategory


class AssetClassAssumption(BaseModel):
    category: AssetCategory
    expected_return_pct: float      # 연 기대수익률 (가치상승분, 소득수익 제외)
    volatility_pct: float           # 연 변동성 (표준편차)
    income_yield_pct: float = 0.0   # 임대수익률/배당수익률 등 소득수익
    liquidity_score: float = Field(ge=0, le=1, default=0.5)  # 1=현금성, 0=완전비유동
    tax_treatment: str = ""         # 간단 설명 (예: "양도세 6~45%, 장특공 최대30%")


class CorrelationPair(BaseModel):
    category_a: AssetCategory
    category_b: AssetCategory
    correlation: float = Field(ge=-1, le=1)


class PortfolioAllocationInput(BaseModel):
    weights: dict[AssetCategory, float]              # 자산군별 비중 (합 1.0)
    assumptions: list[AssetClassAssumption]
    correlations: list[CorrelationPair] = Field(default_factory=list)
    debt_to_equity: float | None = None               # 레버리지 조정 수익률 계산용
    cost_of_debt_pct: float | None = None


class PortfolioAllocationResult(BaseModel):
    expected_return_pct: float          # 자산가치 상승 기준 (소득 제외)
    expected_total_return_pct: float    # 가치상승 + 소득수익 합산
    volatility_pct: float
    income_yield_pct: float
    liquidity_score: float
    concentration: float                 # 최대 비중 자산군
    concentration_category: AssetCategory | None
    leverage_adjusted_return_pct: float | None  # 부채효과 반영 자기자본 기대수익률
    sharpe_like_ratio: float | None      # (기대총수익 - 무위험수익) / 변동성 근사치 (무위험수익 미제공 시 0으로 가정)


class MarginalPurchaseInput(BaseModel):
    current_total_assets: float
    current_weights: dict[AssetCategory, float]
    new_asset_category: AssetCategory
    new_asset_value: float
    assumptions: list[AssetClassAssumption]
    correlations: list[CorrelationPair] = Field(default_factory=list)


class MarginalPurchaseResult(BaseModel):
    before: PortfolioAllocationResult
    after: PortfolioAllocationResult
    return_delta_pct: float
    volatility_delta_pct: float
    liquidity_delta: float
    concentration_delta: float
    diversification_improved: bool   # 변동성이 낮아졌으면 True (단순 판단)
