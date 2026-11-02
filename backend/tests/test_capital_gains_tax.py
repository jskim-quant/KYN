from datetime import date

import pytest

from app.engines.rules.capital_gains_tax import CGTInput, compute_cgt

AS_OF = date(2026, 1, 1)


def test_no_gain_returns_zero():
    result = compute_cgt(CGTInput(
        current_value=5.0, acquisition_cost=6.0, acquisition_date=date(2020, 1, 1),
        asset_type="주거용부동산", as_of=AS_OF,
    ))
    assert result.tax == 0.0
    assert result.exempt is True


def test_one_house_exemption_under_limit():
    result = compute_cgt(CGTInput(
        current_value=10.0, acquisition_cost=3.0, acquisition_date=date(2015, 1, 1),
        asset_type="주거용부동산", is_one_house_one_family=True, as_of=AS_OF,
    ))
    assert result.exempt is True
    assert result.tax == 0.0


def test_one_house_exemption_over_limit_partial_taxation():
    result = compute_cgt(CGTInput(
        current_value=20.0, acquisition_cost=5.0, acquisition_date=date(2010, 1, 1),  # 16년 보유
        asset_type="주거용부동산", is_one_house_one_family=True, as_of=AS_OF,
    ))
    assert result.exempt is False
    assert result.long_term_holding_deduction_rate == pytest.approx(0.80)
    assert result.tax > 0


def test_short_term_under_1yr_flat_50pct():
    result = compute_cgt(CGTInput(
        current_value=5.0, acquisition_cost=4.0, acquisition_date=date(2025, 6, 1),
        asset_type="토지", as_of=AS_OF,
    ))
    # gain=1.0, lthd=0 (3년 미만), taxable = 1.0-0.025=0.975, ×50%
    assert result.tax == pytest.approx(0.975 * 0.50, abs=1e-4)


def test_long_term_holding_over_15yr_uses_30pct_deduction():
    result = compute_cgt(CGTInput(
        current_value=20.0, acquisition_cost=5.0, acquisition_date=date(2005, 1, 1),  # 21년
        asset_type="상업용부동산", as_of=AS_OF,
    ))
    assert result.long_term_holding_deduction_rate == pytest.approx(0.30)


def test_financial_asset_uses_income_tax_brackets_directly():
    result = compute_cgt(CGTInput(
        current_value=10.0, acquisition_cost=5.0, acquisition_date=date(2020, 1, 1),
        asset_type="금융자산", as_of=AS_OF,
    ))
    assert result.long_term_holding_deduction_rate == 0.0
    assert "소득세율" in result.note
