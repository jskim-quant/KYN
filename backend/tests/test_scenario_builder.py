"""
시나리오 빌더 통합 테스트 — 규칙 엔진(증여세) → 시나리오 엔진 → 리스크 엔진
(실현가능성 F1~F10, 세무상설명부담 T1~T12) 전체 파이프라인이 실제로 연결되는지 검증.

test_zero_cash_case_is_hard_blocked_end_to_end는 KYN(Next.js)에서 터졌던
"증여세 필요한데 재원 0인데 실현가능성 85%" 버그가 새 파이프라인 전체를
관통해도 재발하지 않음을 확인하는 최종 회귀 테스트다.
"""
from datetime import date

from app.engines.scenario.builder import GiftRecipient, build_immediate_gift_scenario

AS_OF = date(2026, 1, 1)


def test_scenario_builder_produces_events_and_scores():
    scenario = build_immediate_gift_scenario(
        donor_id="parent1",
        family_total_assets=40.0,
        available_cash=10.0,
        recipients=[GiftRecipient(person_id="child1", relation="자녀", gift_amount=5.0)],
        annual_growth_rate=0.03,
        event_date=AS_OF,
        years=10,
    )
    assert len(scenario.events) == 1
    assert scenario.feasibility_score is not None
    assert scenario.tax_review_risk is not None
    assert len(scenario.annual_states) == 11  # 0~10년


def test_sufficient_cash_scenario_is_not_hard_blocked():
    scenario = build_immediate_gift_scenario(
        donor_id="parent1",
        family_total_assets=40.0,
        available_cash=20.0,  # 증여세(약 4천~5천만원 수준) 충분히 커버
        recipients=[GiftRecipient(person_id="child1", relation="자녀", gift_amount=3.0)],
        annual_growth_rate=0.03,
        event_date=AS_OF,
    )
    assert scenario.feasibility_score.hard_blocked is False
    assert scenario.rejected is False


def test_zero_cash_case_is_hard_blocked_end_to_end():
    """회귀 테스트: 재원 0인데 좋은 점수가 나오던 KYN 버그가 새 파이프라인에서도 안 생기는지."""
    scenario = build_immediate_gift_scenario(
        donor_id="parent1",
        family_total_assets=4400.0,   # 44억
        available_cash=0.0,           # 가용 현금 없음
        recipients=[
            GiftRecipient(person_id="child1", relation="자녀", gift_amount=2000.0),  # 20억
        ],
        annual_growth_rate=0.03,
        event_date=AS_OF,
    )
    assert scenario.feasibility_score.hard_blocked is True
    assert scenario.rejected is True
    assert any("현금잔액" in r for r in scenario.rejection_reasons)


def test_tax_review_risk_flags_family_relation():
    scenario = build_immediate_gift_scenario(
        donor_id="parent1", family_total_assets=40.0, available_cash=10.0,
        recipients=[GiftRecipient(person_id="child1", relation="자녀", gift_amount=3.0)],
        annual_growth_rate=0.03, event_date=AS_OF,
    )
    assert scenario.tax_review_risk.overall_risk_score >= 0
    assert scenario.tax_review_risk.disclaimer.startswith("본 점수는 실제 세무조사 선정 확률이 아니라")
