"""
거래 원자 (스펙 3장의 대표 부분집합).

스펙 3장은 150개 이상의 거래 유형을 나열하지만, 한 번에 전부 구현하는 것은
비현실적이다 (스펙 13번 "한 번에 모든 코드를 무리하게 작성하지 마라"와도 배치된다).
지금까지 9개 원자를 구현했고, 나머지는 `docs/ARCHITECTURE.md`의 다음 단계 목록에 남긴다:
  - 즉시 증여 (immediate_gift_atom)
  - 부담부증여 (burdened_gift_atom) — 채무 승계 부분은 CGT, 순증여분은 증여세
  - 가족 간 대여 (family_loan_atom)
  - 가족 간 매매/저가양수 (related_party_sale_atom)
  - 제3자 매매 (market_sale_atom)
  - 채무 인수·승계 (debt_assumption_atom)
  - 교환 (exchange_atom) — 양 당사자를 독립적 양도·취득으로 모델링 (스펙 4.4)
  - 현물출자 (corp_capital_contribution_atom) — 법인 취득세율 적용
  - 법정상속 (statutory_inheritance_atom)
"""
from __future__ import annotations

from datetime import date

from pydantic import BaseModel

from app.engines.rules.acquisition_tax import AcquisitionKind, AcquisitionTaxInput, compute_acquisition_tax
from app.engines.rules.capital_gains_tax import CGTInput, compute_cgt
from app.engines.rules.gift_tax import GiftTaxInput, compute_gift_tax
from app.engines.rules.inheritance_tax import HeirInput, InheritanceTaxInput, compute_inheritance_tax
from app.models.scenario import CashTransfer, OwnershipChange, RequiredDocument, ScenarioEvent, TaxResult


class ImmediateGiftAtomInput(BaseModel):
    donor_id: str
    recipient_id: str
    relation: str
    gift_amount: float
    recipient_is_adult: bool = True
    is_generation_skip: bool = False
    prior_gifts_10yr: float = 0.0
    event_date: date
    cash_transfer_verified: bool = False


def immediate_gift_atom(inp: ImmediateGiftAtomInput) -> ScenarioEvent:
    gift_result = compute_gift_tax(GiftTaxInput(
        gift_amount=inp.gift_amount, relation=inp.relation,
        recipient_is_adult=inp.recipient_is_adult, is_generation_skip=inp.is_generation_skip,
        prior_gifts_10yr=inp.prior_gifts_10yr, as_of=inp.event_date,
    ))
    return ScenarioEvent(
        event_date=inp.event_date,
        transaction_type="immediate_gift",
        parties=[inp.donor_id, inp.recipient_id],
        cash_transfers=[CashTransfer(
            from_person_id=inp.donor_id, to_person_id=inp.recipient_id,
            amount=inp.gift_amount, transfer_date=inp.event_date,
            verified=inp.cash_transfer_verified,
        )],
        tax_consequences=[TaxResult(
            tax_type="gift", amount=gift_result.final_tax,
            rule_id=",".join(gift_result.rule_ids_used), status=gift_result.status.value,
        )],
        required_documents=[RequiredDocument(document_type="증여계약서")],
    )


class BurdenedGiftAtomInput(BaseModel):
    donor_id: str
    recipient_id: str
    relation: str
    market_value: float
    acquisition_cost: float
    acquisition_date: date
    asset_type: str
    debt_assumed: float
    recipient_is_adult: bool = True
    event_date: date
    recipient_can_prove_repayment: bool = False


def burdened_gift_atom(inp: BurdenedGiftAtomInput) -> ScenarioEvent:
    net_gift_value = max(0.0, inp.market_value - inp.debt_assumed)
    gift_result = compute_gift_tax(GiftTaxInput(
        gift_amount=net_gift_value, relation=inp.relation,
        recipient_is_adult=inp.recipient_is_adult, as_of=inp.event_date,
    ))
    debt_ratio = inp.debt_assumed / inp.market_value if inp.market_value > 0 else 0.0
    cgt_result = compute_cgt(CGTInput(
        current_value=inp.debt_assumed, acquisition_cost=inp.acquisition_cost * debt_ratio,
        acquisition_date=inp.acquisition_date, asset_type=inp.asset_type, as_of=inp.event_date,
    ))

    warnings = []
    if not inp.recipient_can_prove_repayment:
        warnings.append("수증자의 채무 상환능력이 증빙되지 않아 채무 인수가 인정되지 않을 위험이 있습니다.")

    return ScenarioEvent(
        event_date=inp.event_date,
        transaction_type="burdened_gift",
        parties=[inp.donor_id, inp.recipient_id],
        debt_changes=[],
        tax_consequences=[
            TaxResult(tax_type="gift", amount=gift_result.final_tax,
                      rule_id=",".join(gift_result.rule_ids_used), status=gift_result.status.value),
            TaxResult(tax_type="cgt", amount=cgt_result.tax, rule_id=",".join(cgt_result.rule_ids_used),
                      status=cgt_result.status.value),
        ],
        required_documents=[
            RequiredDocument(document_type="부담부증여계약서"),
            RequiredDocument(document_type="채무인수동의서"),
        ],
        warnings=warnings,
    )


class FamilyLoanAtomInput(BaseModel):
    lender_id: str
    borrower_id: str
    principal: float
    has_maturity_date: bool
    interest_rate: float
    event_date: date


def family_loan_atom(inp: FamilyLoanAtomInput) -> ScenarioEvent:
    return ScenarioEvent(
        event_date=inp.event_date,
        transaction_type="family_loan",
        parties=[inp.lender_id, inp.borrower_id],
        cash_transfers=[CashTransfer(
            from_person_id=inp.lender_id, to_person_id=inp.borrower_id,
            amount=inp.principal, transfer_date=inp.event_date, verified=False,
        )],
        required_documents=[RequiredDocument(document_type="차용증")],
        prerequisites=[],
    )


# ── 저가양수·특수관계인 매매 (스펙 3.2, 4.2) ─────────────────────
# 시가-거래가 차이가 30%(또는 절대금액 기준)를 넘으면 저가양수 증여의제 위험
# (상증세법 §35) — 정확한 절대금액 기준은 이 세션에서 검증된 rule_table이 없어
# ASSUMED로 표시하고 세무사 확인을 요구한다.
RELATED_PARTY_DISCOUNT_RATE_THRESHOLD = 0.30


class RelatedPartySaleAtomInput(BaseModel):
    seller_id: str
    buyer_id: str
    market_value: float
    sale_price: float
    acquisition_cost: float
    acquisition_date: date
    asset_type: str
    is_related_party: bool = True
    event_date: date
    price_actually_paid: bool = False


def related_party_sale_atom(inp: RelatedPartySaleAtomInput) -> ScenarioEvent:
    cgt_result = compute_cgt(CGTInput(
        current_value=inp.sale_price, acquisition_cost=inp.acquisition_cost,
        acquisition_date=inp.acquisition_date, asset_type=inp.asset_type, as_of=inp.event_date,
    ))
    discount_ratio = (
        (inp.market_value - inp.sale_price) / inp.market_value if inp.market_value > 0 else 0.0
    )
    warnings = []
    if inp.is_related_party and discount_ratio > RELATED_PARTY_DISCOUNT_RATE_THRESHOLD:
        warnings.append(
            f"시가 대비 {discount_ratio*100:.0f}% 저가 매매 — 상증세법 §35 저가양수 증여의제 위험 "
            f"(정확한 절대금액 기준은 세무사 확인 필요, ASSUMED)"
        )
    if not inp.price_actually_paid:
        warnings.append("매매대금 실제 지급이 확인되지 않아 명의신탁·형식적 매매로 재구성될 위험이 있습니다.")

    return ScenarioEvent(
        event_date=inp.event_date,
        transaction_type="related_party_sale",
        parties=[inp.seller_id, inp.buyer_id],
        cash_transfers=[CashTransfer(
            from_person_id=inp.buyer_id, to_person_id=inp.seller_id,
            amount=inp.sale_price, transfer_date=inp.event_date, verified=inp.price_actually_paid,
        )],
        ownership_changes=[OwnershipChange(asset_id="", from_owner_id=inp.seller_id, to_owner_id=inp.buyer_id, ratio_transferred=1.0)],
        tax_consequences=[TaxResult(tax_type="cgt", amount=cgt_result.tax,
                                     rule_id=",".join(cgt_result.rule_ids_used), status=cgt_result.status.value)],
        required_documents=[RequiredDocument(document_type="매매계약서")],
        warnings=warnings,
    )


# ── 제3자 매매 (일반 유동화) ─────────────────────────────────────

class MarketSaleAtomInput(BaseModel):
    seller_id: str
    market_value: float
    acquisition_cost: float
    acquisition_date: date
    asset_type: str
    is_one_house_one_family: bool = False
    event_date: date


def market_sale_atom(inp: MarketSaleAtomInput) -> ScenarioEvent:
    cgt_result = compute_cgt(CGTInput(
        current_value=inp.market_value, acquisition_cost=inp.acquisition_cost,
        acquisition_date=inp.acquisition_date, asset_type=inp.asset_type,
        is_one_house_one_family=inp.is_one_house_one_family, as_of=inp.event_date,
    ))
    return ScenarioEvent(
        event_date=inp.event_date,
        transaction_type="market_sale",
        parties=[inp.seller_id],
        tax_consequences=[TaxResult(tax_type="cgt", amount=cgt_result.tax,
                                     rule_id=",".join(cgt_result.rule_ids_used), status=cgt_result.status.value)],
        required_documents=[RequiredDocument(document_type="매매계약서")],
    )


# ── 채무 인수·승계 ───────────────────────────────────────────────

class DebtAssumptionAtomInput(BaseModel):
    original_debtor_id: str
    new_debtor_id: str
    debt_amount: float
    lender_approval_obtained: bool = False
    event_date: date


def debt_assumption_atom(inp: DebtAssumptionAtomInput) -> ScenarioEvent:
    warnings = []
    if not inp.lender_approval_obtained:
        warnings.append("채권자(은행)의 채무자 변경 승인이 확인되지 않았습니다.")
    return ScenarioEvent(
        event_date=inp.event_date,
        transaction_type="debt_assumption",
        parties=[inp.original_debtor_id, inp.new_debtor_id],
        required_documents=[RequiredDocument(document_type="채무인수동의서")],
        warnings=warnings,
    )


# ── 교환 (스펙 4.4) — 양 당사자를 독립적 양도·취득으로 모델링 ────

class ExchangeAtomInput(BaseModel):
    party_a_id: str
    party_a_asset_value: float
    party_a_acquisition_cost: float
    party_a_acquisition_date: date
    party_a_asset_type: str
    party_b_id: str
    party_b_asset_value: float
    party_b_acquisition_cost: float
    party_b_acquisition_date: date
    party_b_asset_type: str
    cash_settlement_by_b_to_a: float = 0.0
    event_date: date


def exchange_atom(inp: ExchangeAtomInput) -> ScenarioEvent:
    a_cgt = compute_cgt(CGTInput(
        current_value=inp.party_a_asset_value, acquisition_cost=inp.party_a_acquisition_cost,
        acquisition_date=inp.party_a_acquisition_date, asset_type=inp.party_a_asset_type, as_of=inp.event_date,
    ))
    b_cgt = compute_cgt(CGTInput(
        current_value=inp.party_b_asset_value, acquisition_cost=inp.party_b_acquisition_cost,
        acquisition_date=inp.party_b_acquisition_date, asset_type=inp.party_b_asset_type, as_of=inp.event_date,
    ))
    value_gap = abs(inp.party_a_asset_value - inp.party_b_asset_value)
    warnings = []
    if value_gap > 0 and inp.cash_settlement_by_b_to_a < value_gap * 0.9:
        warnings.append("자산 가치 차액만큼 차액 정산이 이뤄지지 않아 불균등 교환에 따른 이익 이전 위험이 있습니다.")

    return ScenarioEvent(
        event_date=inp.event_date,
        transaction_type="exchange",
        parties=[inp.party_a_id, inp.party_b_id],
        cash_transfers=[CashTransfer(
            from_person_id=inp.party_b_id, to_person_id=inp.party_a_id,
            amount=inp.cash_settlement_by_b_to_a, transfer_date=inp.event_date,
        )] if inp.cash_settlement_by_b_to_a > 0 else [],
        tax_consequences=[
            TaxResult(tax_type="cgt", amount=a_cgt.tax, rule_id=",".join(a_cgt.rule_ids_used), status=a_cgt.status.value),
            TaxResult(tax_type="cgt", amount=b_cgt.tax, rule_id=",".join(b_cgt.rule_ids_used), status=b_cgt.status.value),
        ],
        required_documents=[RequiredDocument(document_type="교환계약서")],
        warnings=warnings,
    )


# ── 현물출자 (법인 설립·증자) ─────────────────────────────────────

class CorpCapitalContributionAtomInput(BaseModel):
    contributor_id: str
    corp_id: str
    asset_value: float
    asset_type: str
    event_date: date


def corp_capital_contribution_atom(inp: CorpCapitalContributionAtomInput) -> ScenarioEvent:
    acq_result = compute_acquisition_tax(AcquisitionTaxInput(
        value=inp.asset_value, asset_type=inp.asset_type, is_corp=True,
        acquisition_kind=AcquisitionKind.PURCHASE, as_of=inp.event_date,
    ))
    return ScenarioEvent(
        event_date=inp.event_date,
        transaction_type="corp_capital_contribution",
        parties=[inp.contributor_id, inp.corp_id],
        ownership_changes=[OwnershipChange(asset_id="", from_owner_id=inp.contributor_id, to_owner_id=inp.corp_id, ratio_transferred=1.0)],
        tax_consequences=[TaxResult(tax_type="acquisition", amount=acq_result.tax,
                                     rule_id=",".join(acq_result.rule_ids_used), status=acq_result.status.value)],
        required_documents=[
            RequiredDocument(document_type="현물출자계약서"),
            RequiredDocument(document_type="검사인선임보고서"),
        ],
    )


# ── 법정상속 ─────────────────────────────────────────────────────

class StatutoryInheritanceAtomInput(BaseModel):
    decedent_id: str
    total_estate: float
    heirs: list[HeirInput]
    heir_ids: list[str]
    prior_gifts_10yr: float = 0.0
    prior_gift_tax_paid: float = 0.0
    financial_assets: float = 0.0
    event_date: date


def statutory_inheritance_atom(inp: StatutoryInheritanceAtomInput) -> ScenarioEvent:
    result = compute_inheritance_tax(InheritanceTaxInput(
        total_estate=inp.total_estate, heirs=inp.heirs,
        prior_gifts_10yr=inp.prior_gifts_10yr, prior_gift_tax_paid=inp.prior_gift_tax_paid,
        financial_assets=inp.financial_assets, as_of=inp.event_date,
    ))
    return ScenarioEvent(
        event_date=inp.event_date,
        transaction_type="statutory_inheritance",
        parties=[inp.decedent_id, *inp.heir_ids],
        tax_consequences=[TaxResult(tax_type="inheritance", amount=result.final_tax,
                                     rule_id=",".join(result.rule_ids_used), status=result.status.value)],
        required_documents=[RequiredDocument(document_type="상속재산분할협의서")],
    )
