"""
1단계(자산별 수증자 배정)를 실제 계산에 반영하는 3단계 평가 엔진 (스펙 요청:
"일반 배정 + 지분 쪼개기 + 유동성/미래가치" 3단계 순차 평가).

Stage 1 (원안 그대로): 사용자가 배정한 그대로(공동배정 자산은 균등분할) 증여세 계산.
Stage 2 (지분 조정안): 공동배정된 자산의 지분율만, 정해진 폭(기본 ±20%p) 안에서
    조정해 전체 증여세 합계를 낮추는 조합을 지역 탐색. 수증자 자체는 바꾸지 않는다
    — "가족간 비중을 완전히 바꾸지 않는 선"이라는 요구사항을 max_split_shift_pct로 구현.
Stage 3 (유동성 · 미래가치): 자산별 유동성 점수(증여세 재원으로 쓰기 좋은지) +
    미래가치 상승에 따른 담보대출 여력 증가분을 투영. 세금 증가분은 별도
    /calc/gift-tax 반복 호출로 프런트에서 계산 가능하므로 여기서는 재원조달
    관점(유동성·대출여력)만 담당한다.

주의: Stage 2는 전역 최적화가 아니라 자산별 지역 탐색이다. 여러 공동배정 자산에
걸친 진짜 전역 최적은 조합이 커질 수 있어 이후 단계에서 필요시 확장한다.
"""
from __future__ import annotations

from datetime import date

from pydantic import BaseModel, Field

from app.engines.rules.gift_tax import GiftTaxInput, compute_gift_tax
from app.engines.rules.rule_loader import RULE_TABLES_DIR, load_all_rules

LIQUIDITY_SCORE: dict[str, float] = {
    "CASH": 1.0,
    "BONDS": 0.85,
    "EQUITY": 0.6,
    "BUSINESS_EQUITY": 0.3,
    "REAL_ESTATE": 0.15,
    "OTHER": 0.3,
}


class AssignedAsset(BaseModel):
    asset_id: str
    label: str
    value: float                    # 억
    category: str = "OTHER"         # AssetCategory 문자열 (CASH/BONDS/EQUITY/REAL_ESTATE/BUSINESS_EQUITY/OTHER)
    growth_rate_pct: float = 2.0    # 연 기대상승률
    loan_amount: float = 0.0
    max_ltv_pct: float = 70.0
    recipient_ids: list[str]        # 배정된 수증자 (2명 이상이면 균등분할이 기본값)
    # 자산별 유동성 (1=즉시 현금화 ~ 5=매각 매우 어려움). 부동산은 입지 편차가 커서
    # (강남 등 핵심지 vs 지방) category 기본값 대신 이 값이 있으면 우선 사용한다.
    liquidity_score_1to5: float | None = None


def _liquidity_score(asset: "AssignedAsset") -> float:
    if asset.liquidity_score_1to5 is not None:
        # 1(즉시 현금화)~5(매각 매우 어려움) → 0~1 (높을수록 유동적)로 변환
        clamped = max(1.0, min(5.0, asset.liquidity_score_1to5))
        return (5.0 - clamped) / 4.0
    return LIQUIDITY_SCORE.get(asset.category, 0.3)


class AssignmentRecipient(BaseModel):
    person_id: str
    name: str
    relation: str
    is_adult: bool = True
    is_generation_skip: bool = False
    prior_gifts_10yr: float = 0.0


class MyAssignmentRequest(BaseModel):
    assets: list[AssignedAsset]
    recipients: list[AssignmentRecipient]
    as_of: date
    projection_years: list[int] = Field(default_factory=lambda: [0, 5, 10])
    max_split_shift_pct: float = 20.0  # Stage 2 지분 조정 최대 폭 (자산 내 %p)


class RecipientBreakdown(BaseModel):
    person_id: str
    name: str
    relation: str
    total_gift_value: float
    gift_tax: float


class AssignmentStage(BaseModel):
    label: str
    splits: dict[str, dict[str, float]]  # asset_id -> {recipient_id: pct(0~100)}
    recipients: list[RecipientBreakdown]
    total_gift_value: float
    total_gift_tax: float


class LiquidityNote(BaseModel):
    asset_id: str
    label: str
    category: str
    liquidity_score: float
    recommended_for_tax_funding: bool
    note: str


class FutureProjection(BaseModel):
    asset_id: str
    label: str
    year: int
    projected_value: float
    ltv_borrowing_capacity: float
    additional_borrowing_vs_year0: float


class MyAssignmentResult(BaseModel):
    stage1: AssignmentStage
    stage2: AssignmentStage
    stage2_saving_vs_stage1: float
    stage3_liquidity: list[LiquidityNote]
    stage3_future: list[FutureProjection]
    stage3_note: str


def _recipient_map(recipients: list[AssignmentRecipient]) -> dict[str, AssignmentRecipient]:
    return {r.person_id: r for r in recipients}


def _compute_stage(
    label: str,
    assets: list[AssignedAsset],
    splits: dict[str, dict[str, float]],
    recipients: list[AssignmentRecipient],
    as_of: date,
    rules: list,
) -> AssignmentStage:
    rmap = _recipient_map(recipients)
    totals: dict[str, float] = {r.person_id: 0.0 for r in recipients}
    for asset in assets:
        for pid, pct in splits.get(asset.asset_id, {}).items():
            totals[pid] = totals.get(pid, 0.0) + asset.value * pct / 100.0

    breakdown: list[RecipientBreakdown] = []
    total_tax = 0.0
    total_value = 0.0
    for pid, amount in totals.items():
        if amount <= 0:
            continue
        r = rmap.get(pid)
        if r is None:
            continue
        result = compute_gift_tax(GiftTaxInput(
            gift_amount=amount, relation=r.relation,
            recipient_is_adult=r.is_adult, is_generation_skip=r.is_generation_skip,
            prior_gifts_10yr=r.prior_gifts_10yr, as_of=as_of,
        ), rules=rules)
        breakdown.append(RecipientBreakdown(
            person_id=pid, name=r.name, relation=r.relation,
            total_gift_value=amount, gift_tax=result.final_tax,
        ))
        total_tax += result.final_tax
        total_value += amount

    return AssignmentStage(
        label=label, splits=splits, recipients=breakdown,
        total_gift_value=total_value, total_gift_tax=total_tax,
    )


def _equal_split(asset: AssignedAsset) -> dict[str, float]:
    n = len(asset.recipient_ids)
    if n == 0:
        return {}
    pct = 100.0 / n
    return {pid: pct for pid in asset.recipient_ids}


def _candidate_splits(asset: AssignedAsset, max_shift: float) -> list[dict[str, float]]:
    n = len(asset.recipient_ids)
    if n < 2:
        return [_equal_split(asset)]
    base = 100.0 / n
    shifts = [max_shift * 0.5, max_shift]
    candidates: list[dict[str, float]] = [_equal_split(asset)]
    if n == 2:
        a, b = asset.recipient_ids
        for s in shifts:
            candidates.append({a: base + s, b: base - s})
            candidates.append({a: base - s, b: base + s})
    else:
        for pid in asset.recipient_ids:
            others = [p for p in asset.recipient_ids if p != pid]
            for s in shifts:
                per_other = s / len(others)
                cand = {p: base - per_other for p in others}
                cand[pid] = base + s
                candidates.append(cand)
    return candidates


def _optimize_stage2(
    assets: list[AssignedAsset],
    stage1_splits: dict[str, dict[str, float]],
    recipients: list[AssignmentRecipient],
    as_of: date,
    max_shift: float,
    rules: list,
) -> dict[str, dict[str, float]]:
    """
    자산별로 독립적으로(지역 탐색) 지분율 후보를 시도해서, 전체 증여세 합계를
    낮추는 후보가 있으면 채택한다. 수증자 자체는 바꾸지 않고, 한 자산 내
    지분율만 max_shift(%p) 폭 안에서만 조정한다.
    """
    current = {k: dict(v) for k, v in stage1_splits.items()}
    for asset in assets:
        if len(asset.recipient_ids) < 2:
            continue
        best_splits = current
        best_tax = _compute_stage("tmp", assets, current, recipients, as_of, rules).total_gift_tax
        for candidate in _candidate_splits(asset, max_shift):
            trial = {k: dict(v) for k, v in current.items()}
            trial[asset.asset_id] = candidate
            trial_tax = _compute_stage("tmp", assets, trial, recipients, as_of, rules).total_gift_tax
            if trial_tax < best_tax - 1e-9:
                best_tax = trial_tax
                best_splits = trial
        current = best_splits
    return current


def evaluate_my_assignment(req: MyAssignmentRequest) -> MyAssignmentResult:
    rules = load_all_rules(RULE_TABLES_DIR)

    stage1_splits = {a.asset_id: _equal_split(a) for a in req.assets}
    stage1 = _compute_stage("원안 그대로", req.assets, stage1_splits, req.recipients, req.as_of, rules)

    stage2_splits = _optimize_stage2(
        req.assets, stage1_splits, req.recipients, req.as_of, req.max_split_shift_pct, rules,
    )
    stage2 = _compute_stage("지분 조정안", req.assets, stage2_splits, req.recipients, req.as_of, rules)

    liquidity_notes = [
        LiquidityNote(
            asset_id=a.asset_id, label=a.label, category=a.category,
            liquidity_score=_liquidity_score(a),
            recommended_for_tax_funding=_liquidity_score(a) >= 0.6,
            note=(
                "현금성/유동자산 — 증여세 재원으로 우선 활용 가능"
                if _liquidity_score(a) >= 0.6
                else "비유동 자산 — 매각·대출 없이는 증여세 재원으로 즉시 쓰기 어려움"
            ),
        )
        for a in req.assets
    ]

    future: list[FutureProjection] = []
    for asset in req.assets:
        capacity_y0 = max(0.0, asset.value * asset.max_ltv_pct / 100.0 - asset.loan_amount)
        for year in req.projection_years:
            projected_value = asset.value * ((1 + asset.growth_rate_pct / 100.0) ** year)
            capacity = max(0.0, projected_value * asset.max_ltv_pct / 100.0 - asset.loan_amount)
            future.append(FutureProjection(
                asset_id=asset.asset_id, label=asset.label, year=year,
                projected_value=projected_value, ltv_borrowing_capacity=capacity,
                additional_borrowing_vs_year0=max(0.0, capacity - capacity_y0),
            ))

    return MyAssignmentResult(
        stage1=stage1, stage2=stage2,
        stage2_saving_vs_stage1=max(0.0, stage1.total_gift_tax - stage2.total_gift_tax),
        stage3_liquidity=liquidity_notes,
        stage3_future=future,
        stage3_note=(
            "미래가치 상승은 증여세 과세표준과 담보대출 여력을 동시에 키운다 — "
            "일찍 증여할수록 세금은 낮아지지만, 늦출수록 대출로 재원을 마련할 여력은 커진다."
        ),
    )
