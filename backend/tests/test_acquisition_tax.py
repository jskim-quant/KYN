from datetime import date

import pytest

from app.engines.rules.acquisition_tax import AcquisitionKind, AcquisitionTaxInput, compute_acquisition_tax

AS_OF = date(2026, 1, 1)


def test_non_taxable_asset_type_returns_zero():
    result = compute_acquisition_tax(AcquisitionTaxInput(value=5.0, asset_type="예금", as_of=AS_OF))
    assert result.tax == 0.0


def test_residential_purchase_under_6():
    result = compute_acquisition_tax(AcquisitionTaxInput(value=5.0, asset_type="주거용부동산", as_of=AS_OF))
    assert result.rate_applied == pytest.approx(0.012)
    assert result.tax == pytest.approx(0.06)


def test_residential_purchase_over_9():
    result = compute_acquisition_tax(AcquisitionTaxInput(value=15.0, asset_type="주거용부동산", as_of=AS_OF))
    assert result.rate_applied == pytest.approx(0.032)


def test_multi_house_surcharge():
    result = compute_acquisition_tax(AcquisitionTaxInput(
        value=10.0, asset_type="주거용부동산", is_multi_house=True, as_of=AS_OF,
    ))
    assert result.rate_applied == pytest.approx(0.082)


def test_corp_residential_surcharge():
    result = compute_acquisition_tax(AcquisitionTaxInput(
        value=10.0, asset_type="주거용부동산", is_corp=True, as_of=AS_OF,
    ))
    assert result.rate_applied == pytest.approx(0.12)


def test_gift_acquisition_general_rate():
    result = compute_acquisition_tax(AcquisitionTaxInput(
        value=10.0, asset_type="주거용부동산", acquisition_kind=AcquisitionKind.GIFT, as_of=AS_OF,
    ))
    assert result.rate_applied == pytest.approx(0.038)


def test_gift_acquisition_corp_or_multi_house_rate():
    result = compute_acquisition_tax(AcquisitionTaxInput(
        value=10.0, asset_type="주거용부동산", acquisition_kind=AcquisitionKind.GIFT,
        is_multi_house=True, as_of=AS_OF,
    ))
    assert result.rate_applied == pytest.approx(0.122)


def test_inheritance_acquisition_residential():
    result = compute_acquisition_tax(AcquisitionTaxInput(
        value=10.0, asset_type="주거용부동산", acquisition_kind=AcquisitionKind.INHERITANCE, as_of=AS_OF,
    ))
    assert result.rate_applied == pytest.approx(0.028)


def test_commercial_land_default_rate():
    result = compute_acquisition_tax(AcquisitionTaxInput(value=10.0, asset_type="토지", as_of=AS_OF))
    assert result.rate_applied == pytest.approx(0.046)
