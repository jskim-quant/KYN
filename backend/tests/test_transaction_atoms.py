from datetime import date

import pytest

from app.engines.rules.inheritance_tax import HeirInput
from app.engines.scenario.transaction_atoms import (
    BurdenedGiftAtomInput,
    CorpCapitalContributionAtomInput,
    DebtAssumptionAtomInput,
    ExchangeAtomInput,
    FamilyLoanAtomInput,
    ImmediateGiftAtomInput,
    MarketSaleAtomInput,
    RelatedPartySaleAtomInput,
    StatutoryInheritanceAtomInput,
    burdened_gift_atom,
    corp_capital_contribution_atom,
    debt_assumption_atom,
    exchange_atom,
    family_loan_atom,
    immediate_gift_atom,
    market_sale_atom,
    related_party_sale_atom,
    statutory_inheritance_atom,
)

AS_OF = date(2026, 1, 1)


def test_immediate_gift_atom_produces_gift_tax_consequence():
    event = immediate_gift_atom(ImmediateGiftAtomInput(
        donor_id="p1", recipient_id="c1", relation="자녀", gift_amount=3.0, event_date=AS_OF,
    ))
    assert event.transaction_type == "immediate_gift"
    assert event.tax_consequences[0].tax_type == "gift"
    assert float(event.tax_consequences[0].amount) == pytest.approx(0.388, abs=1e-3)


def test_burdened_gift_atom_splits_gift_and_cgt():
    event = burdened_gift_atom(BurdenedGiftAtomInput(
        donor_id="grandpa", recipient_id="parent", relation="자녀",
        market_value=20.0, acquisition_cost=5.0, acquisition_date=date(2005, 1, 1),
        asset_type="상업용부동산", debt_assumed=4.0, event_date=AS_OF,
    ))
    tax_types = {t.tax_type for t in event.tax_consequences}
    assert tax_types == {"gift", "cgt"}
    assert any("상환능력" in w for w in event.warnings)


def test_family_loan_atom_requires_contract_document():
    event = family_loan_atom(FamilyLoanAtomInput(
        lender_id="grandpa", borrower_id="grandchild", principal=2.0,
        has_maturity_date=True, interest_rate=0.0, event_date=AS_OF,
    ))
    assert event.required_documents[0].document_type == "차용증"


def test_related_party_sale_flags_underpriced_deal():
    event = related_party_sale_atom(RelatedPartySaleAtomInput(
        seller_id="parent", buyer_id="child", market_value=10.0, sale_price=5.0,
        acquisition_cost=3.0, acquisition_date=date(2015, 1, 1), asset_type="주거용부동산",
        event_date=AS_OF,
    ))
    assert any("저가 매매" in w for w in event.warnings)


def test_related_party_sale_no_flag_when_priced_fairly():
    event = related_party_sale_atom(RelatedPartySaleAtomInput(
        seller_id="parent", buyer_id="child", market_value=10.0, sale_price=9.5,
        acquisition_cost=3.0, acquisition_date=date(2015, 1, 1), asset_type="주거용부동산",
        price_actually_paid=True, event_date=AS_OF,
    ))
    assert not any("저가 매매" in w for w in event.warnings)


def test_market_sale_atom_computes_cgt():
    event = market_sale_atom(MarketSaleAtomInput(
        seller_id="parent", market_value=10.0, acquisition_cost=3.0,
        acquisition_date=date(2010, 1, 1), asset_type="토지", event_date=AS_OF,
    ))
    assert event.tax_consequences[0].tax_type == "cgt"
    assert float(event.tax_consequences[0].amount) > 0


def test_debt_assumption_flags_missing_lender_approval():
    event = debt_assumption_atom(DebtAssumptionAtomInput(
        original_debtor_id="grandpa", new_debtor_id="parent", debt_amount=4.0, event_date=AS_OF,
    ))
    assert any("승인" in w for w in event.warnings)


def test_exchange_atom_flags_uneven_settlement():
    event = exchange_atom(ExchangeAtomInput(
        party_a_id="a", party_a_asset_value=10.0, party_a_acquisition_cost=5.0,
        party_a_acquisition_date=date(2015, 1, 1), party_a_asset_type="토지",
        party_b_id="b", party_b_asset_value=6.0, party_b_acquisition_cost=4.0,
        party_b_acquisition_date=date(2015, 1, 1), party_b_asset_type="토지",
        cash_settlement_by_b_to_a=0.0, event_date=AS_OF,
    ))
    assert any("불균등" in w for w in event.warnings)
    assert len(event.tax_consequences) == 2


def test_corp_capital_contribution_uses_corp_acquisition_rate():
    event = corp_capital_contribution_atom(CorpCapitalContributionAtomInput(
        contributor_id="grandpa", corp_id="corp1", asset_value=10.0,
        asset_type="상업용부동산", event_date=AS_OF,
    ))
    assert event.tax_consequences[0].tax_type == "acquisition"
    assert float(event.tax_consequences[0].amount) == pytest.approx(10.0 * 0.046, abs=1e-6)


def test_statutory_inheritance_atom_computes_inheritance_tax():
    event = statutory_inheritance_atom(StatutoryInheritanceAtomInput(
        decedent_id="grandpa", total_estate=20.0,
        heirs=[HeirInput(relation="배우자", age=60), HeirInput(relation="자녀", age=30)],
        heir_ids=["grandma", "parent"], event_date=AS_OF,
    ))
    assert event.transaction_type == "statutory_inheritance"
    assert event.tax_consequences[0].tax_type == "inheritance"
