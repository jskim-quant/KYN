"""
세무상 설명부담 엔진 테스트.

test_spec_example_case는 스펙 7.18 예시(가족대여 상환능력 없음 + 순환현금흐름 +
평가가액 충돌 → overallRiskScore≈72, "높음")를 근사 재현하는 회귀 테스트다.
"""
from app.engines.risk.tax_review_risk import (
    AmountMaterialityInput,
    CircularFlowInput,
    ContractCashflowMismatchInput,
    CorpPersonalMixingInput,
    DebtSubstanceInput,
    DirectionalTransfer,
    EconomicRationalityInput,
    FundingSourceLegitimacyInput,
    NonResidentUncertaintyInput,
    RelatedPartyInput,
    TaxReviewRiskInput,
    TimingConcentrationInput,
    ValuationUncertaintyInput,
    compute_tax_review_risk,
    detect_circular_flows,
    score_t1_related_party,
    score_t5_debt_substance,
    score_t11_economic_rationality,
)


def test_t1_no_related_party_scores_zero():
    score, drivers = score_t1_related_party(RelatedPartyInput(is_related_party=False))
    assert score == 0.0
    assert drivers == []


def test_t1_related_party_alone_is_moderate_not_extreme():
    """스펙 7.4: 특수관계라는 사실만으로 고위험을 주지 않는다."""
    score, _ = score_t1_related_party(RelatedPartyInput(is_related_party=True, relation_category="lineal"))
    assert 20 <= score <= 50


def test_t5_family_loan_no_maturity_no_income_high_risk():
    inp = DebtSubstanceInput(
        is_family_loan=True,
        has_maturity_date=False,
        borrower_has_income_or_assets_or_future_income=False,
        interest_actually_paid=False,
    )
    score, drivers = score_t5_debt_substance(inp)
    assert score >= 60
    assert any("상환능력" in d for d in drivers)


def test_t5_non_family_loan_scores_zero():
    score, drivers = score_t5_debt_substance(DebtSubstanceInput(is_family_loan=False))
    assert score == 0.0


def test_detect_circular_flow_direct_reverse():
    transfers = [
        DirectionalTransfer(id="1", party_from="parent", party_to="grandparent", amount=5000, date_offset_days=0),
        DirectionalTransfer(id="2", party_from="grandparent", party_to="grandchild", amount=5000, date_offset_days=10),
    ]
    flags = detect_circular_flows(transfers)
    assert len(flags) == 1
    assert "CIRCULAR_FLOW_FLAG" in flags[0]


def test_detect_circular_flow_ignores_unrelated_transfers():
    transfers = [
        DirectionalTransfer(id="1", party_from="parent", party_to="child", amount=5000, date_offset_days=0),
        DirectionalTransfer(id="2", party_from="child", party_to="other_child", amount=100, date_offset_days=5),
    ]
    flags = detect_circular_flows(transfers)
    assert flags == []


def test_t11_all_favorable_scores_zero():
    score, drivers = score_t11_economic_rationality(EconomicRationalityInput())
    assert score == 0.0
    assert drivers == []


def test_t11_no_economic_purpose_flagged():
    inp = EconomicRationalityInput(
        has_non_tax_economic_purpose=False,
        cashflow_improves_after_transaction=False,
        simpler_alternative_available_but_not_chosen_for_no_reason=True,
    )
    score, drivers = score_t11_economic_rationality(inp)
    assert score >= 30
    assert drivers


def _spec_example_input() -> TaxReviewRiskInput:
    """스펙 7.18 예시를 구성 요소로 재현: 학생 손자 무이자 차용(상환능력 없음) +
    부모→할아버지 이자, 할아버지→손자 유사금액 대여(순환흐름) + 은행감정가 vs
    신고가액 충돌."""
    return TaxReviewRiskInput(
        t1=RelatedPartyInput(is_related_party=True, relation_category="grandparent_grandchild"),
        t2=ValuationUncertaintyInput(bank_vs_tax_valuation_gap_large=True),
        t3=FundingSourceLegitimacyInput(
            acquisition_amount=200_000_000,
            verified_substantive_family_loan=200_000_000,
            acquirer_is_student_or_no_income=True,
        ),
        t4=ContractCashflowMismatchInput(),
        t5=DebtSubstanceInput(
            is_family_loan=True,
            has_maturity_date=True,
            borrower_has_income_or_assets_or_future_income=False,
        ),
        t6=CircularFlowInput(transfers=[
            DirectionalTransfer(id="1", party_from="parent", party_to="grandparent", amount=5_000_000, date_offset_days=0),
            DirectionalTransfer(id="2", party_from="grandparent", party_to="grandchild", amount=5_000_000, date_offset_days=15),
        ]),
        t7=CorpPersonalMixingInput(),
        t8=[],
        t9=TimingConcentrationInput(),
        t10=NonResidentUncertaintyInput(),
        t11=EconomicRationalityInput(),
        t12=AmountMaterialityInput(
            transaction_amount=200_000_000, family_net_worth=4_400_000_000,
            acquirer_annual_income=0,
        ),
    )


def test_spec_example_case_lands_in_high_band():
    result = compute_tax_review_risk(_spec_example_input())
    assert result["grade"] in ("주의", "높음", "매우 높음")
    assert 40 <= result["overall_risk_score"] <= 100
    assert any("상환능력" in d for d in result["drivers"])
    assert any("CIRCULAR_FLOW_FLAG" in d for d in result["drivers"])
    assert result["disclaimer"].startswith("본 점수는 실제 세무조사 선정 확률이 아니라")


def test_clean_transaction_scores_low():
    inp = TaxReviewRiskInput(
        t1=RelatedPartyInput(is_related_party=False),
        t3=FundingSourceLegitimacyInput(acquisition_amount=100_000_000, verified_own_funds=100_000_000),
        t12=AmountMaterialityInput(transaction_amount=100_000_000, family_net_worth=4_000_000_000),
    )
    result = compute_tax_review_risk(inp)
    assert result["overall_risk_score"] < 30
    assert result["grade"] in ("낮음", "관리 가능")
