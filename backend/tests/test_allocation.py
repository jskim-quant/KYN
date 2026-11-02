import pytest

from app.engines.allocation.engine import (
    compute_marginal_purchase_effect,
    compute_portfolio_metrics,
    weights_from_balance_sheet,
)
from app.models.allocation import (
    AssetClassAssumption,
    CorrelationPair,
    MarginalPurchaseInput,
    PortfolioAllocationInput,
)
from app.models.balance_sheet import AssetCategory, FamilyBalanceSheet
from decimal import Decimal


ASSUMPTIONS = [
    AssetClassAssumption(category=AssetCategory.REAL_ESTATE, expected_return_pct=0.03,
                          volatility_pct=0.10, income_yield_pct=0.02, liquidity_score=0.1),
    AssetClassAssumption(category=AssetCategory.EQUITY, expected_return_pct=0.07,
                          volatility_pct=0.18, income_yield_pct=0.015, liquidity_score=0.9),
    AssetClassAssumption(category=AssetCategory.CASH, expected_return_pct=0.0,
                          volatility_pct=0.0, income_yield_pct=0.03, liquidity_score=1.0),
    AssetClassAssumption(category=AssetCategory.BONDS, expected_return_pct=0.02,
                          volatility_pct=0.05, income_yield_pct=0.04, liquidity_score=0.7),
]


def test_weights_from_balance_sheet_normalizes():
    bs = FamilyBalanceSheet(
        as_of="2026-01-01",
        assets_by_category={AssetCategory.REAL_ESTATE: Decimal("30"), AssetCategory.CASH: Decimal("10")},
    )
    weights = weights_from_balance_sheet(bs)
    assert weights[AssetCategory.REAL_ESTATE] == pytest.approx(0.75)
    assert weights[AssetCategory.CASH] == pytest.approx(0.25)


def test_weights_from_empty_balance_sheet():
    bs = FamilyBalanceSheet(as_of="2026-01-01")
    assert weights_from_balance_sheet(bs) == {}


def test_portfolio_expected_return_is_weighted_average():
    weights = {AssetCategory.REAL_ESTATE: 0.6, AssetCategory.CASH: 0.4}
    result = compute_portfolio_metrics(PortfolioAllocationInput(weights=weights, assumptions=ASSUMPTIONS))
    assert result.expected_return_pct == pytest.approx(0.6 * 0.03 + 0.4 * 0.0)
    assert result.income_yield_pct == pytest.approx(0.6 * 0.02 + 0.4 * 0.03)


def test_single_asset_class_volatility_equals_its_own():
    weights = {AssetCategory.EQUITY: 1.0}
    result = compute_portfolio_metrics(PortfolioAllocationInput(weights=weights, assumptions=ASSUMPTIONS))
    assert result.volatility_pct == pytest.approx(0.18)


def test_diversification_with_zero_correlation_reduces_volatility_below_weighted_average():
    weights = {AssetCategory.REAL_ESTATE: 0.5, AssetCategory.EQUITY: 0.5}
    result = compute_portfolio_metrics(PortfolioAllocationInput(weights=weights, assumptions=ASSUMPTIONS))
    weighted_avg_vol = 0.5 * 0.10 + 0.5 * 0.18
    assert result.volatility_pct < weighted_avg_vol  # 무상관 가정 시 분산효과로 단순 가중평균보다 낮아야 함


def test_perfect_correlation_equals_weighted_average_volatility():
    weights = {AssetCategory.REAL_ESTATE: 0.5, AssetCategory.EQUITY: 0.5}
    corr = [CorrelationPair(category_a=AssetCategory.REAL_ESTATE, category_b=AssetCategory.EQUITY, correlation=1.0)]
    result = compute_portfolio_metrics(PortfolioAllocationInput(weights=weights, assumptions=ASSUMPTIONS, correlations=corr))
    weighted_avg_vol = 0.5 * 0.10 + 0.5 * 0.18
    assert result.volatility_pct == pytest.approx(weighted_avg_vol, abs=1e-9)


def test_concentration_identifies_dominant_class():
    weights = {AssetCategory.REAL_ESTATE: 0.9, AssetCategory.CASH: 0.1}
    result = compute_portfolio_metrics(PortfolioAllocationInput(weights=weights, assumptions=ASSUMPTIONS))
    assert result.concentration_category == AssetCategory.REAL_ESTATE
    assert result.concentration == pytest.approx(0.9)


def test_leverage_adjusted_return_amplifies_when_return_exceeds_debt_cost():
    weights = {AssetCategory.REAL_ESTATE: 1.0}
    result = compute_portfolio_metrics(PortfolioAllocationInput(
        weights=weights, assumptions=ASSUMPTIONS, debt_to_equity=1.0, cost_of_debt_pct=0.02,
    ))
    unlevered = result.expected_total_return_pct  # 0.05
    # R_e = R_a + (R_a - R_d)*D/E = 0.05 + (0.05-0.02)*1 = 0.08
    assert result.leverage_adjusted_return_pct == pytest.approx(0.08)
    assert result.leverage_adjusted_return_pct > unlevered


def test_marginal_purchase_of_uncorrelated_asset_can_improve_diversification():
    current_weights = {AssetCategory.REAL_ESTATE: 1.0}
    inp = MarginalPurchaseInput(
        current_total_assets=39.0, current_weights=current_weights,
        new_asset_category=AssetCategory.CASH, new_asset_value=5.0,
        assumptions=ASSUMPTIONS,
    )
    result = compute_marginal_purchase_effect(inp)
    assert result.after.volatility_pct < result.before.volatility_pct
    assert result.diversification_improved is True
    assert result.concentration_delta < 0  # 집중도(부동산 100%)가 낮아져야 함


def test_marginal_purchase_return_moves_toward_new_asset_return():
    current_weights = {AssetCategory.CASH: 1.0}  # expected_return 0%
    inp = MarginalPurchaseInput(
        current_total_assets=40.0, current_weights=current_weights,
        new_asset_category=AssetCategory.EQUITY, new_asset_value=10.0,  # expected_return 7%
        assumptions=ASSUMPTIONS,
    )
    result = compute_marginal_purchase_effect(inp)
    # 전액 현금(0%)에서 주식 10/50=20%를 섞었으니 기대수익은 0%보다 커야 하고 7%보다는 작아야 함
    assert 0.0 < result.after.expected_return_pct < 0.07
    assert result.return_delta_pct > 0
