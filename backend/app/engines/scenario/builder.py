"""
시나리오 빌더 (스펙 5장의 MVP 부분집합).

즉시 분산증여 시나리오 하나를 실제로 조립해 규칙 엔진 → 시나리오 엔진 →
리스크 엔진(F1~F10, T1~T12)까지 전체 파이프라인이 실제로 연결됨을 증명한다.
다른 시나리오 유형(안정형/현금흐름형/레버리지형/법인성장형 등)은 이 빌더와
동일한 패턴으로 다음 단계에서 확장한다.
"""
from __future__ import annotations

import uuid
from datetime import date
from typing import NamedTuple

from app.engines.risk.feasibility import (
    AnnualCashState, CashflowInput, DebtServiceInput, FeasibilityInput,
    FundingSource, FundingSourceCertainty, HardFailChecklist, InitialFundingInput,
    compute_feasibility,
)
from app.engines.risk.tax_review_risk import (
    AmountMaterialityInput, CircularFlowInput, ContractCashflowMismatchInput,
    CorpPersonalMixingInput, DebtSubstanceInput, FundingSourceLegitimacyInput,
    NonResidentUncertaintyInput, RelatedPartyInput, TaxReviewRiskInput,
    TimingConcentrationInput, ValuationUncertaintyInput, compute_tax_review_risk,
)
from app.engines.scenario.transaction_atoms import ImmediateGiftAtomInput, immediate_gift_atom
from app.models.scenario import AnnualFinancialState, Scenario, ScenarioObjective


class GiftRecipient(NamedTuple):
    person_id: str
    relation: str
    gift_amount: float
    is_adult: bool = True


def build_immediate_gift_scenario(
    donor_id: str,
    family_total_assets: float,
    available_cash: float,
    recipients: list[GiftRecipient],
    annual_growth_rate: float,
    event_date: date,
    years: int = 10,
    family_loan_amount: float = 0.0,
    bank_loan_amount: float = 0.0,
    bank_loan_annual_interest: float = 0.0,
    corp_conversion_amount: float = 0.0,
    foundation_amount: float = 0.0,
) -> Scenario:
    events = []
    total_gift_tax = 0.0
    total_gifted = 0.0

    for r in recipients:
        event = immediate_gift_atom(ImmediateGiftAtomInput(
            donor_id=donor_id, recipient_id=r.person_id, relation=r.relation,
            gift_amount=r.gift_amount, recipient_is_adult=r.is_adult, event_date=event_date,
        ))
        events.append(event)
        total_gifted += r.gift_amount
        total_gift_tax += sum(float(t.amount) for t in event.tax_consequences if t.tax_type == "gift")

    total_debt = family_loan_amount + bank_loan_amount
    total_funding_pool = available_cash + family_loan_amount + bank_loan_amount
    remaining_assets = max(0.0, family_total_assets - total_gifted)
    cash_after_gift_tax = total_funding_pool - total_gift_tax
    annual_debt_service = bank_loan_annual_interest  # 가족간 차용 상환액은 별도 확정 전까지 미반영

    annual_states: list[AnnualFinancialState] = []
    cash_balance = cash_after_gift_tax
    for year in range(0, years + 1):
        asset_value = remaining_assets * ((1 + annual_growth_rate) ** year)
        if year > 0:
            cash_balance -= annual_debt_service
        annual_states.append(AnnualFinancialState(
            year=year,
            total_assets=asset_value,
            total_debt=total_debt,
            net_worth=asset_value + cash_balance - total_debt,
            net_cashflow=(-total_gift_tax if year == 0 else 0.0) - (annual_debt_service if year > 0 else 0.0),
            ending_cash_balance=cash_balance,
            cumulative_tax_paid=total_gift_tax,
            below_reserve_target=cash_balance < 0,
        ))

    # ── 리스크 엔진 연결: 실현 가능성 ──
    # 대출로 조달하는 재원을 보유 현금과 동일한 확실성(CASH_ON_HAND)으로 계산하던 버그를
    # 수정 — 재원 종류별로 확실성 가중치를 다르게 적용해야 증여 비중/재원 구성이
    # 바뀔 때 점수도 실제로 움직인다.
    funding_sources = [
        FundingSource(
            label="수증자 보유 현금", amount=available_cash,
            certainty=FundingSourceCertainty.CASH_ON_HAND,
        ),
    ]
    if family_loan_amount > 0:
        funding_sources.append(FundingSource(
            label="가족간 차용", amount=family_loan_amount,
            certainty=FundingSourceCertainty.USER_EXPECTATION,  # 계약서·실제 이체 확인 전까지 낮게
        ))
    if bank_loan_amount > 0:
        funding_sources.append(FundingSource(
            label="담보대출", amount=bank_loan_amount,
            certainty=FundingSourceCertainty.COLLATERAL_ESTIMATE,  # 은행 사전승인 전까지 담보가치 추정 취급
        ))

    feasibility_input = FeasibilityInput(
        initial_funding=InitialFundingInput(
            need=total_gift_tax,
            sources=funding_sources,
        ),
        cashflow=CashflowInput(
            reserve_target=1.0,
            annual_states=[
                AnnualCashState(year=s.year, ending_cash_balance=s.ending_cash_balance)
                for s in annual_states
            ],
        ),
        debt_service=DebtServiceInput(
            icr=(available_cash / bank_loan_annual_interest) if bank_loan_annual_interest > 0 else None,
            includes_family_loans=family_loan_amount == 0,
        ),
        hard_fail_checklist=HardFailChecklist(
            relies_on_sham_debt=False,
        ),
    )
    feasibility_result = compute_feasibility(feasibility_input)

    # ── 리스크 엔진 연결: 세무상 설명부담 ──
    tax_review_input = TaxReviewRiskInput(
        t1=RelatedPartyInput(is_related_party=True, relation_category="lineal",
                              repeated_transaction_count=len(recipients)),
        t2=ValuationUncertaintyInput(),
        t3=FundingSourceLegitimacyInput(
            acquisition_amount=total_gifted,
            verified_reported_gift=total_gifted,
        ),
        t4=ContractCashflowMismatchInput(),
        t5=DebtSubstanceInput(is_family_loan=family_loan_amount > 0),
        t6=CircularFlowInput(),
        t7=CorpPersonalMixingInput(),
        t8=[],
        t9=TimingConcentrationInput(
            multiple_family_transactions_short_period=(
                (family_loan_amount > 0 or bank_loan_amount > 0)
                and (corp_conversion_amount > 0 or foundation_amount > 0)
            ),
        ),
        t10=NonResidentUncertaintyInput(),
        t12=AmountMaterialityInput(
            transaction_amount=total_gifted + family_loan_amount + bank_loan_amount
            + corp_conversion_amount + foundation_amount,
            family_net_worth=family_total_assets,
        ),
    )
    tax_review_result = compute_tax_review_risk(tax_review_input)

    return Scenario(
        id=f"immediate-gift-{uuid.uuid4().hex[:8]}",
        name="즉시 분산증여",
        objective_type=ScenarioObjective.TAX_SAVING,
        events=events,
        legal_rule_version_ids=list({
            rid for e in events for t in e.tax_consequences for rid in t.rule_id.split(",") if rid
        }),
        annual_states=annual_states,
        feasibility_score={
            "total_score": feasibility_result["total_score"],
            "grade": feasibility_result["grade"],
            "components": feasibility_result["components"],
            "top_constraints": feasibility_result["top_constraints"],
            "improvement_actions": feasibility_result["improvement_actions"],
            "hard_blocked": feasibility_result["hard_blocked"],
            "hard_block_reasons": feasibility_result["hard_block_reasons"],
        },
        tax_review_risk={
            "overall_risk_score": tax_review_result["overall_risk_score"],
            "grade": tax_review_result["grade"],
            "risk_type_scores": tax_review_result["risk_type_scores"],
            "drivers": tax_review_result["drivers"],
            "mitigations": tax_review_result["mitigations"],
            "disclaimer": tax_review_result["disclaimer"],
        },
        rejected=feasibility_result["hard_blocked"],
        rejection_reasons=feasibility_result["hard_block_reasons"],
    )
