"""
자산배분 엔진 (새 스펙 Phase 4).

가족 전체 대차대조표(engines/balance_sheet)를 하나의 포트폴리오로 취급해
기대수익·변동성·상관관계·소득수익·유동성·레버리지조정수익을 계산한다.
"""
from __future__ import annotations

import math

from app.models.allocation import (
    AssetClassAssumption,
    MarginalPurchaseInput,
    MarginalPurchaseResult,
    PortfolioAllocationInput,
    PortfolioAllocationResult,
)
from app.models.balance_sheet import AssetCategory, FamilyBalanceSheet


def weights_from_balance_sheet(bs: FamilyBalanceSheet) -> dict[AssetCategory, float]:
    total = bs.total_assets
    if total <= 0:
        return {}
    return {cat: float(value / total) for cat, value in bs.assets_by_category.items()}


def _assumption_map(assumptions: list[AssetClassAssumption]) -> dict[AssetCategory, AssetClassAssumption]:
    return {a.category: a for a in assumptions}


def _correlation(
    correlations: list, cat_a: AssetCategory, cat_b: AssetCategory,
) -> float:
    if cat_a == cat_b:
        return 1.0
    for c in correlations:
        if {c.category_a, c.category_b} == {cat_a, cat_b}:
            return c.correlation
    return 0.0  # 상관관계 미제공 시 무상관 가정 (ASSUMED — 실제 데이터로 교체 권장)


def compute_portfolio_metrics(inp: PortfolioAllocationInput) -> PortfolioAllocationResult:
    amap = _assumption_map(inp.assumptions)
    categories = list(inp.weights.keys())

    expected_return = sum(
        inp.weights[c] * amap[c].expected_return_pct for c in categories if c in amap
    )
    income_yield = sum(
        inp.weights[c] * amap[c].income_yield_pct for c in categories if c in amap
    )
    expected_total_return = expected_return + income_yield

    liquidity_score = sum(
        inp.weights[c] * amap[c].liquidity_score for c in categories if c in amap
    )

    variance = 0.0
    for ca in categories:
        if ca not in amap:
            continue
        for cb in categories:
            if cb not in amap:
                continue
            corr = _correlation(inp.correlations, ca, cb)
            variance += (
                inp.weights[ca] * inp.weights[cb]
                * amap[ca].volatility_pct * amap[cb].volatility_pct * corr
            )
    volatility = math.sqrt(max(0.0, variance))

    concentration_category = None
    concentration = 0.0
    if inp.weights:
        concentration_category, concentration = max(inp.weights.items(), key=lambda kv: kv[1])

    leverage_adjusted_return = None
    if inp.debt_to_equity is not None and inp.cost_of_debt_pct is not None:
        # DuPont/M&M 식 레버리지 효과: R_e = R_a + (R_a - R_d) * D/E
        leverage_adjusted_return = (
            expected_total_return + (expected_total_return - inp.cost_of_debt_pct) * inp.debt_to_equity
        )

    sharpe_like = (expected_total_return / volatility) if volatility > 0 else None

    return PortfolioAllocationResult(
        expected_return_pct=expected_return,
        expected_total_return_pct=expected_total_return,
        volatility_pct=volatility,
        income_yield_pct=income_yield,
        liquidity_score=liquidity_score,
        concentration=concentration,
        concentration_category=concentration_category,
        leverage_adjusted_return_pct=leverage_adjusted_return,
        sharpe_like_ratio=sharpe_like,
    )


def compute_marginal_purchase_effect(inp: MarginalPurchaseInput) -> MarginalPurchaseResult:
    before = compute_portfolio_metrics(PortfolioAllocationInput(
        weights=inp.current_weights, assumptions=inp.assumptions, correlations=inp.correlations,
    ))

    new_total = inp.current_total_assets + inp.new_asset_value
    after_weights: dict[AssetCategory, float] = {}
    for cat, w in inp.current_weights.items():
        after_weights[cat] = (w * inp.current_total_assets) / new_total if new_total > 0 else 0.0
    after_weights[inp.new_asset_category] = (
        after_weights.get(inp.new_asset_category, 0.0) + inp.new_asset_value / new_total
        if new_total > 0 else 0.0
    )

    after = compute_portfolio_metrics(PortfolioAllocationInput(
        weights=after_weights, assumptions=inp.assumptions, correlations=inp.correlations,
    ))

    return MarginalPurchaseResult(
        before=before, after=after,
        return_delta_pct=after.expected_total_return_pct - before.expected_total_return_pct,
        volatility_delta_pct=after.volatility_pct - before.volatility_pct,
        liquidity_delta=after.liquidity_score - before.liquidity_score,
        concentration_delta=after.concentration - before.concentration,
        diversification_improved=after.volatility_pct < before.volatility_pct,
    )
