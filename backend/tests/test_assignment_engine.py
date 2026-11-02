"""
1단계(자산별 수증자 배정) → 실제 증여세 계산까지 이어지는 3단계 평가 엔진 테스트.
"""
from datetime import date

from app.engines.scenario.assignment import (
    AssignedAsset, AssignmentRecipient, MyAssignmentRequest, evaluate_my_assignment,
)

AS_OF = date(2026, 1, 1)


def _two_child_request(**overrides) -> MyAssignmentRequest:
    defaults = dict(
        assets=[
            AssignedAsset(
                asset_id="a1", label="상가", value=12.0, category="REAL_ESTATE",
                growth_rate_pct=2.0, loan_amount=2.0, max_ltv_pct=70.0,
                recipient_ids=["c1"],
            ),
            AssignedAsset(
                asset_id="a2", label="아파트", value=8.0, category="REAL_ESTATE",
                growth_rate_pct=3.0, recipient_ids=["c1", "c2"],
            ),
            AssignedAsset(
                asset_id="a3", label="예금", value=3.0, category="CASH",
                growth_rate_pct=1.0, recipient_ids=["c2"],
            ),
        ],
        recipients=[
            AssignmentRecipient(person_id="c1", name="첫째", relation="자녀"),
            AssignmentRecipient(person_id="c2", name="둘째", relation="자녀"),
        ],
        as_of=AS_OF,
    )
    defaults.update(overrides)
    return MyAssignmentRequest(**defaults)


def test_stage1_reflects_actual_asset_assignment_not_generic_template():
    result = evaluate_my_assignment(_two_child_request())
    totals = {r.person_id: r.total_gift_value for r in result.stage1.recipients}
    # 상가(12) + 아파트 절반(4) = 16, 예금(3) + 아파트 절반(4) = 7
    assert abs(totals["c1"] - 16.0) < 1e-6
    assert abs(totals["c2"] - 7.0) < 1e-6
    assert result.stage1.total_gift_tax > 0


def test_stage2_never_moves_recipients_only_splits_within_bound():
    req = _two_child_request(max_split_shift_pct=20.0)
    result = evaluate_my_assignment(req)
    # 지분 조정안도 같은 자산엔 같은 수증자 집합만 있어야 한다 (재배정 금지)
    for asset_id, split in result.stage2.splits.items():
        stage1_recipients = set(result.stage1.splits[asset_id].keys())
        assert set(split.keys()) == stage1_recipients
        # 폭 제한: 균등분할 대비 ±max_split_shift_pct 이내
        n = len(split)
        base = 100.0 / n
        for pct in split.values():
            assert abs(pct - base) <= 20.0 + 1e-6


def test_stage2_saving_is_non_negative():
    result = evaluate_my_assignment(_two_child_request())
    assert result.stage2_saving_vs_stage1 >= 0
    assert result.stage2.total_gift_tax <= result.stage1.total_gift_tax + 1e-9


def test_stage3_liquidity_flags_cash_over_real_estate():
    result = evaluate_my_assignment(_two_child_request())
    by_id = {n.asset_id: n for n in result.stage3_liquidity}
    assert by_id["a3"].recommended_for_tax_funding is True   # 예금
    assert by_id["a1"].recommended_for_tax_funding is False  # 상가


def test_stage3_future_projection_grows_ltv_capacity_with_value():
    result = evaluate_my_assignment(_two_child_request(projection_years=[0, 10]))
    a1_rows = sorted((p for p in result.stage3_future if p.asset_id == "a1"), key=lambda p: p.year)
    assert a1_rows[0].year == 0
    assert a1_rows[-1].year == 10
    assert a1_rows[-1].projected_value > a1_rows[0].projected_value
    assert a1_rows[-1].ltv_borrowing_capacity >= a1_rows[0].ltv_borrowing_capacity
    assert a1_rows[-1].additional_borrowing_vs_year0 > 0


def test_single_recipient_asset_has_no_split_options():
    result = evaluate_my_assignment(_two_child_request())
    assert result.stage1.splits["a1"] == {"c1": 100.0}
    assert result.stage2.splits["a1"] == {"c1": 100.0}


def test_per_asset_liquidity_override_beats_category_default():
    # a1은 REAL_ESTATE 카테고리라 기본값으로는 비유동(0.15) 취급되지만,
    # 강남 핵심지처럼 실제로는 매각이 쉬운 경우를 liquidity_score_1to5=1로 표현.
    req = _two_child_request()
    req.assets[0].liquidity_score_1to5 = 1  # 상가(a1) — 즉시 현금화 가능으로 재정의
    result = evaluate_my_assignment(req)
    by_id = {n.asset_id: n for n in result.stage3_liquidity}
    assert by_id["a1"].liquidity_score == 1.0
    assert by_id["a1"].recommended_for_tax_funding is True

    # 오버라이드 없는 다른 REAL_ESTATE 자산은 여전히 카테고리 기본값(비유동)
    req2 = _two_child_request()
    req2.assets[1].category = "REAL_ESTATE"
    result2 = evaluate_my_assignment(req2)
    by_id2 = {n.asset_id: n for n in result2.stage3_liquidity}
    assert by_id2["a2"].liquidity_score < 0.6
    assert by_id2["a2"].recommended_for_tax_funding is False
