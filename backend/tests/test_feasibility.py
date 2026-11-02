"""
실현 가능성 엔진 테스트.

핵심 회귀 테스트: 기존 KYN(Next.js)에서 터진 버그 재현 케이스 —
"증여세 11.9억 필요한데 가용재원 0인데 실현가능성 85%로 표시" —
이 엔진에서는 절대 발생할 수 없음을 검증한다 (test_zero_funding_case_is_blocked_not_85_percent).
"""
from decimal import Decimal

from app.engines.risk.feasibility import (
    AnnualCashState,
    BankApprovalGrade,
    CashflowInput,
    ConsentItem,
    DebtServiceInput,
    FeasibilityInput,
    FundingSource,
    FundingSourceCertainty,
    HardFailChecklist,
    InitialFundingInput,
    LegalUncertainty,
    OperationalComplexityInput,
    RequiredDocumentState,
    ScheduleCheckItem,
    StressTestResult,
    compute_feasibility,
    score_f1_initial_funding,
    score_f2_cashflow,
    score_f3_debt_service,
    score_f4_bank_approval,
    score_f7_timeline,
    score_f8_governance,
)


def test_f1_full_coverage_scores_100():
    inp = InitialFundingInput(
        need=Decimal("10"),
        sources=[FundingSource(label="현금", amount=Decimal("12"), certainty=FundingSourceCertainty.CASH_ON_HAND)],
    )
    score, drivers = score_f1_initial_funding(inp)
    assert score == 100.0
    assert drivers == []


def test_f1_zero_funding_scores_near_zero():
    inp = InitialFundingInput(need=Decimal("11.9"), sources=[])
    score, drivers = score_f1_initial_funding(inp)
    assert score < 5.0
    assert "11.9" in drivers[0]


def test_f1_uncertain_sources_discounted_by_certainty():
    inp = InitialFundingInput(
        need=Decimal("10"),
        sources=[FundingSource(label="담보대출 추정", amount=Decimal("20"), certainty=FundingSourceCertainty.COLLATERAL_ESTIMATE)],
    )
    # 20억 담보추정 * 40% = 8억 effective, need 10억 -> ratio 0.8 -> 30~59 구간
    score, _ = score_f1_initial_funding(inp)
    assert 30 <= score < 60


def test_f2_negative_balance_without_backup_is_hard_fail():
    inp = CashflowInput(
        reserve_target=Decimal("1"),
        annual_states=[
            AnnualCashState(year=1, ending_cash_balance=Decimal("2")),
            AnnualCashState(year=2, ending_cash_balance=Decimal("-0.5"), covered_by_alternative_funding=False),
        ],
    )
    score, drivers, hard_fail, reasons = score_f2_cashflow(inp)
    assert hard_fail is True
    assert "2년차" in reasons[0]


def test_f2_negative_balance_covered_by_alternative_funding_not_hard_fail():
    inp = CashflowInput(
        reserve_target=Decimal("1"),
        annual_states=[
            AnnualCashState(year=1, ending_cash_balance=Decimal("-0.5"), covered_by_alternative_funding=True),
        ],
    )
    _, _, hard_fail, reasons = score_f2_cashflow(inp)
    assert hard_fail is False
    assert reasons == []


def test_f3_low_dscr_flagged():
    inp = DebtServiceInput(dscr=0.9, includes_family_loans=True)
    score, drivers = score_f3_debt_service(inp)
    assert score < 60
    assert any("DSCR" in d for d in drivers)


def test_f3_family_loans_excluded_flagged_as_warning():
    inp = DebtServiceInput(dscr=1.8, includes_family_loans=False)
    _, drivers = score_f3_debt_service(inp)
    assert any("가족간 대여" in d for d in drivers)


def test_f4_bank_grade_mapping():
    score, _ = score_f4_bank_approval(BankApprovalGrade.CONFIRMED)
    assert score == 100.0
    score, drivers = score_f4_bank_approval(BankApprovalGrade.INELIGIBLE)
    assert score == 0.0
    assert drivers


def test_f7_prerequisite_violation_is_hard_fail():
    items = [
        ScheduleCheckItem(
            event_description="부담부증여 실행",
            event_date_ok=True,
            prerequisite_satisfied_before_event=False,
        )
    ]
    score, drivers, hard_fail, reasons = score_f7_timeline(items)
    assert hard_fail is True
    assert score < 60
    assert "선행조건" in reasons[0]


def test_f8_missing_consent_marks_conditional():
    consents = [ConsentItem(party="배우자", required=True, obtained=False)]
    score, drivers, conditional = score_f8_governance(consents)
    assert conditional is True
    assert score < 100


def test_hard_fail_checklist_sham_debt():
    checklist = HardFailChecklist(relies_on_sham_debt=True)
    reasons = checklist.reasons()
    assert "명백한 허위채무를 전제로 함" in reasons


def _minimal_good_input(**overrides) -> FeasibilityInput:
    base = dict(
        initial_funding=InitialFundingInput(
            need=Decimal("5"),
            sources=[FundingSource(label="현금", amount=Decimal("6"), certainty=FundingSourceCertainty.CASH_ON_HAND)],
        ),
        cashflow=CashflowInput(
            reserve_target=Decimal("1"),
            annual_states=[AnnualCashState(year=y, ending_cash_balance=Decimal("3")) for y in range(1, 11)],
        ),
        debt_service=DebtServiceInput(dscr=1.8, icr=4.0, ltv=0.3),
        bank_approval=BankApprovalGrade.CONFIRMED,
        legal_uncertainties=[],
        documents=[RequiredDocumentState(document_type="증여계약서", state="executed")],
        schedule_items=[ScheduleCheckItem(event_description="증여", event_date_ok=True, prerequisite_satisfied_before_event=True)],
        consents=[ConsentItem(party="본인", required=True, obtained=True)],
        operational_complexity=OperationalComplexityInput(num_real_estate=1, user_capacity_index=60),
        stress_tests=[StressTestResult(stress_name="금리+1%p", survives=True)],
    )
    base.update(overrides)
    return FeasibilityInput(**base)


def test_full_good_scenario_scores_high_and_not_blocked():
    result = compute_feasibility(_minimal_good_input())
    assert result["hard_blocked"] is False
    assert result["total_score"] >= 75
    assert result["grade"] in ("높음", "매우 높음")


def test_zero_funding_case_is_blocked_not_85_percent():
    """회귀 테스트: 즉시 분산증여처럼 증여세 재원이 0인데 85% 뜨던 버그 재현 방지."""
    result = compute_feasibility(_minimal_good_input(
        initial_funding=InitialFundingInput(need=Decimal("11.9"), sources=[]),
        cashflow=CashflowInput(
            reserve_target=Decimal("1"),
            annual_states=[AnnualCashState(year=1, ending_cash_balance=Decimal("-11.9"), covered_by_alternative_funding=False)],
        ),
    ))
    assert result["hard_blocked"] is True
    assert result["total_score"] == 0.0
    assert result["grade"] == "실행 곤란 (하드 탈락)"
    assert any("현금잔액" in r for r in result["hard_block_reasons"])


def test_sham_debt_hard_fail_overrides_good_scores():
    result = compute_feasibility(_minimal_good_input(
        hard_fail_checklist=HardFailChecklist(relies_on_sham_debt=True),
    ))
    assert result["hard_blocked"] is True
    assert result["total_score"] == 0.0
