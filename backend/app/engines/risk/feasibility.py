"""
실현 가능성 점수 엔진 (스펙 6장).

이 점수는 "투자수익성"이 아니라 "이 시나리오가 실제 이 가족 조건에서
계획대로 실행될 수 있는가"를 0~100으로 평가한다. F1~F10을 독립적으로 계산한 뒤
가중합하고, 6.13의 하드 탈락조건은 가중합과 무관하게 우선 적용한다.

기존 KYN(Next.js) 버그: SCENARIO_PLANS에 `feasibilityPct: 85` 같은 값이
시나리오 타입별로 하드코딩되어 있어 실제 자금조달 가능 여부와 완전히
분리되어 있었다. 이 엔진은 그 문제를 구조적으로 없앤다 — 점수는 항상
아래 실제 입력값에서 계산되며, 별도로 하드코딩할 자리가 없다.
"""
from __future__ import annotations

from decimal import Decimal
from enum import Enum

from pydantic import BaseModel, Field

# ── 가중치 (스펙 6.2) ────────────────────────────────────────────

WEIGHTS: dict[str, float] = {
    "F1": 0.15,  # 초기자금 충족도
    "F2": 0.15,  # 지속 현금흐름 충족도
    "F3": 0.15,  # 채무상환 가능성
    "F4": 0.10,  # 금융기관 승인 가능성
    "F5": 0.10,  # 법적·세무적 실행 명확성
    "F6": 0.10,  # 문서·증빙 준비 가능성
    "F7": 0.05,  # 일정 실행 가능성
    "F8": 0.05,  # 가족 동의 및 거버넌스
    "F9": 0.05,  # 운영 복잡도 감당 가능성
    "F10": 0.10, # 스트레스 상황 생존 가능성
}
assert abs(sum(WEIGHTS.values()) - 1.0) < 1e-9


def _clamp(v: float, lo: float = 0.0, hi: float = 100.0) -> float:
    return max(lo, min(hi, v))


# ── F1 초기자금 충족도 ───────────────────────────────────────────

class FundingSourceCertainty(str, Enum):
    CONFIRMED = "confirmed"                # 사전승인 완료 — 100%
    BANK_POSITIVE = "bank_positive"         # 은행 상담 긍정 — 70%
    COLLATERAL_ESTIMATE = "collateral_estimate"  # 담보가치상 추정 — 40%
    USER_EXPECTATION = "user_expectation"   # 단순 사용자 기대 — 10%
    CASH_ON_HAND = "cash_on_hand"           # 이미 보유한 확정 현금 — 100%


_CERTAINTY_WEIGHT: dict[FundingSourceCertainty, float] = {
    FundingSourceCertainty.CONFIRMED: 1.0,
    FundingSourceCertainty.CASH_ON_HAND: 1.0,
    FundingSourceCertainty.BANK_POSITIVE: 0.7,
    FundingSourceCertainty.COLLATERAL_ESTIMATE: 0.4,
    FundingSourceCertainty.USER_EXPECTATION: 0.1,
}


class FundingSource(BaseModel):
    label: str
    amount: Decimal
    certainty: FundingSourceCertainty

    @property
    def effective_amount(self) -> Decimal:
        return self.amount * Decimal(str(_CERTAINTY_WEIGHT[self.certainty]))


class InitialFundingInput(BaseModel):
    need: Decimal  # 취득세+증여세즉납+양도세지원+법인출자금+대출부대비용+감정평가비+등기법무세무비+투자자기자본+초기수선비+최소예비금
    sources: list[FundingSource] = Field(default_factory=list)

    @property
    def available(self) -> Decimal:
        return sum((s.effective_amount for s in self.sources), Decimal("0"))

    @property
    def coverage_ratio(self) -> float:
        if self.need <= 0:
            return 999.0
        return float(self.available / self.need)


def score_f1_initial_funding(inp: InitialFundingInput) -> tuple[float, list[str]]:
    ratio = inp.coverage_ratio
    drivers: list[str] = []
    if ratio >= 1.20:
        score = 100.0
    elif ratio >= 1.00:
        score = 80 + (ratio - 1.00) / 0.20 * 19
    elif ratio >= 0.90:
        score = 60 + (ratio - 0.90) / 0.10 * 19
    elif ratio >= 0.75:
        score = 30 + (ratio - 0.75) / 0.15 * 29
    else:
        score = max(0.0, ratio / 0.75 * 29)
        drivers.append(
            f"초기 필요자금 {inp.need}억 대비 확정도 가중 가용자금이 "
            f"{inp.available}억으로 {ratio*100:.0f}%만 충족됩니다."
        )
    return _clamp(score), drivers


# ── F2 지속 현금흐름 충족도 ──────────────────────────────────────

class AnnualCashState(BaseModel):
    year: int
    ending_cash_balance: Decimal
    covered_by_alternative_funding: bool = False  # 그 해 부족분을 메울 확정 이벤트가 있는지


class CashflowInput(BaseModel):
    reserve_target: Decimal
    annual_states: list[AnnualCashState]


def score_f2_cashflow(inp: CashflowInput) -> tuple[float, list[str], bool, list[str]]:
    """returns (score, drivers, hard_fail, hard_fail_reasons)"""
    drivers: list[str] = []
    hard_fail_reasons: list[str] = []

    negative_years = [
        s for s in inp.annual_states
        if s.ending_cash_balance < 0 and not s.covered_by_alternative_funding
    ]
    if negative_years:
        years = ", ".join(str(s.year) for s in negative_years)
        hard_fail_reasons.append(
            f"{years}년차 현금잔액이 음수이며 대체 자금조달 이벤트가 없습니다."
        )

    below_reserve = [s for s in inp.annual_states if 0 <= s.ending_cash_balance < inp.reserve_target]
    if below_reserve:
        drivers.append(f"{len(below_reserve)}개 연도에서 예비금 목표 이하로 하락합니다.")

    if not inp.annual_states:
        return 0.0, ["현금흐름 데이터가 없습니다."], True, ["현금흐름 시뮬레이션 데이터 없음"]

    min_balance = min(s.ending_cash_balance for s in inp.annual_states)
    if inp.reserve_target > 0:
        ratio = float(min_balance / inp.reserve_target)
        score = _clamp(50 + ratio * 50)
    else:
        score = 100.0 if min_balance >= 0 else 0.0

    hard_fail = len(negative_years) > 0
    return score, drivers, hard_fail, hard_fail_reasons


# ── F3 채무상환 가능성 ───────────────────────────────────────────

class DebtServiceInput(BaseModel):
    dscr: float | None = None   # 채무상환 전 가용현금흐름 / 연간 원리금상환액
    icr: float | None = None    # 이자·세전 가용현금흐름 / 연간 이자비용
    ltv: float | None = None    # 담보채무 / 인정 담보가치 (0~1)
    includes_family_loans: bool = True  # 가족간 대여도 상환부담에 포함했는지


def _band_score(value: float | None, good: float, ok: float, bad: float, higher_is_better: bool) -> float | None:
    if value is None:
        return None
    if higher_is_better:
        if value >= good:
            return 100.0
        if value >= ok:
            return 60 + (value - ok) / (good - ok) * 39
        if value >= bad:
            return 20 + (value - bad) / (ok - bad) * 39
        return _clamp(value / bad * 19) if bad > 0 else 0.0
    else:
        if value <= good:
            return 100.0
        if value <= ok:
            return 60 + (ok - value) / (ok - good) * 39
        if value <= bad:
            return 20 + (bad - value) / (bad - ok) * 39
        return 0.0


def score_f3_debt_service(inp: DebtServiceInput) -> tuple[float, list[str]]:
    drivers: list[str] = []
    sub_scores = []

    dscr_score = _band_score(inp.dscr, good=1.5, ok=1.2, bad=1.0, higher_is_better=True)
    if dscr_score is not None:
        sub_scores.append(dscr_score)
        if dscr_score < 60:
            drivers.append(f"DSCR {inp.dscr:.2f}로 상환여력이 빠듯합니다 (기준 1.2 이상 권장).")

    icr_score = _band_score(inp.icr, good=3.0, ok=2.0, bad=1.0, higher_is_better=True)
    if icr_score is not None:
        sub_scores.append(icr_score)

    ltv_score = _band_score(inp.ltv, good=0.4, ok=0.6, bad=0.8, higher_is_better=False)
    if ltv_score is not None:
        sub_scores.append(ltv_score)
        if ltv_score < 60:
            drivers.append(f"LTV {inp.ltv*100:.0f}%로 담보여력이 낮습니다.")

    if not inp.includes_family_loans:
        drivers.append("가족간 대여 상환부담이 DSCR 계산에 반영되지 않았습니다 — 과대평가 위험.")

    if not sub_scores:
        return 50.0, ["채무상환 지표(DSCR/ICR/LTV)가 입력되지 않아 중립값을 사용했습니다."]

    return _clamp(sum(sub_scores) / len(sub_scores)), drivers


# ── F4 금융기관 승인 가능성 ──────────────────────────────────────

class BankApprovalGrade(str, Enum):
    CONFIRMED = "CONFIRMED"
    HIGHLY_PLAUSIBLE = "HIGHLY_PLAUSIBLE"
    PLAUSIBLE = "PLAUSIBLE"
    UNCERTAIN = "UNCERTAIN"
    UNLIKELY = "UNLIKELY"
    INELIGIBLE = "INELIGIBLE"


_BANK_GRADE_SCORE: dict[BankApprovalGrade, float] = {
    BankApprovalGrade.CONFIRMED: 100.0,
    BankApprovalGrade.HIGHLY_PLAUSIBLE: 85.0,
    BankApprovalGrade.PLAUSIBLE: 65.0,
    BankApprovalGrade.UNCERTAIN: 45.0,
    BankApprovalGrade.UNLIKELY: 20.0,
    BankApprovalGrade.INELIGIBLE: 0.0,
}


def score_f4_bank_approval(grade: BankApprovalGrade | None) -> tuple[float, list[str]]:
    if grade is None:
        return 50.0, ["금융기관 승인 가능성이 평가되지 않았습니다."]
    score = _BANK_GRADE_SCORE[grade]
    drivers = [] if score >= 65 else [f"금융기관 승인 등급이 {grade.value}입니다."]
    return score, drivers


# ── F5 법적·세무적 실행 명확성 ───────────────────────────────────

class LegalUncertainty(BaseModel):
    description: str
    importance: int = Field(ge=1, le=3)  # 1=경미, 2=중요, 3=핵심


def score_f5_legal_clarity(items: list[LegalUncertainty]) -> tuple[float, list[str]]:
    penalty = sum(i.importance * 15 for i in items)
    drivers = [i.description for i in items if i.importance >= 2]
    return _clamp(100 - penalty), drivers


# ── F6 문서·증빙 준비 가능성 ─────────────────────────────────────

_DOC_STATE_LEVEL: dict[str, int] = {
    "missing": 0, "draft": 1, "signed": 2, "notarized": 3,
    "executed": 4, "filed": 5, "archived": 6,
}


class RequiredDocumentState(BaseModel):
    document_type: str
    state: str = "missing"


def score_f6_documentation(docs: list[RequiredDocumentState]) -> tuple[float, list[str]]:
    if not docs:
        return 100.0, []
    levels = [_DOC_STATE_LEVEL.get(d.state, 0) for d in docs]
    avg = sum(levels) / len(levels) / 6 * 100
    missing = [d.document_type for d in docs if d.state == "missing"]
    drivers = [f"미준비 문서: {', '.join(missing)}"] if missing else []
    return _clamp(avg), drivers


# ── F7 일정 실행 가능성 ──────────────────────────────────────────

class ScheduleCheckItem(BaseModel):
    event_description: str
    event_date_ok: bool           # 신고기한/승인기간/거주자변경일 등과 충돌 없는지
    prerequisite_satisfied_before_event: bool  # 선행조건이 거래일 이전에 충족되는지


def score_f7_timeline(items: list[ScheduleCheckItem]) -> tuple[float, list[str], bool, list[str]]:
    violations = [i for i in items if not i.prerequisite_satisfied_before_event]
    date_conflicts = [i for i in items if not i.event_date_ok]
    drivers = [f"선행조건 미충족: {i.event_description}" for i in violations]
    drivers += [f"일정 충돌: {i.event_description}" for i in date_conflicts]

    hard_fail = len(violations) > 0
    hard_fail_reasons = [f"선행조건보다 거래일이 빠릅니다: {i.event_description}" for i in violations]

    penalty = len(violations) * 50 + len(date_conflicts) * 20
    return _clamp(100 - penalty), drivers, hard_fail, hard_fail_reasons


# ── F8 가족 동의 및 거버넌스 ─────────────────────────────────────

class ConsentItem(BaseModel):
    party: str
    required: bool = True
    obtained: bool = False


def score_f8_governance(consents: list[ConsentItem]) -> tuple[float, list[str], bool]:
    required = [c for c in consents if c.required]
    if not required:
        return 100.0, [], False
    missing = [c for c in required if not c.obtained]
    score = (len(required) - len(missing)) / len(required) * 100
    drivers = [f"{c.party} 동의 미확인" for c in missing]
    is_conditional = len(missing) > 0
    return _clamp(score), drivers, is_conditional


# ── F9 운영 복잡도 감당 가능성 ───────────────────────────────────

class OperationalComplexityInput(BaseModel):
    num_corporations: int = 0
    num_real_estate: int = 0
    num_family_loans: int = 0
    num_countries: int = 1
    num_currencies: int = 1
    num_annual_filings: int = 0
    num_related_party_transactions: int = 0
    user_capacity_index: float = 50.0  # 0~100, 사용자가 감당 가능하다고 본 관리역량 수준


def score_f9_complexity(inp: OperationalComplexityInput) -> tuple[float, list[str]]:
    complexity_index = (
        inp.num_corporations * 8 + inp.num_real_estate * 3 + inp.num_family_loans * 5
        + (inp.num_countries - 1) * 10 + (inp.num_currencies - 1) * 5
        + inp.num_annual_filings * 2 + inp.num_related_party_transactions * 4
    )
    excess = max(0.0, complexity_index - inp.user_capacity_index)
    drivers = []
    if excess > 0:
        drivers.append(f"복잡도 지수 {complexity_index:.0f}가 관리역량 {inp.user_capacity_index:.0f}를 초과합니다.")
    return _clamp(100 - excess * 3), drivers


# ── F10 스트레스 생존 가능성 ─────────────────────────────────────

class StressTestResult(BaseModel):
    stress_name: str  # "금리+1%p", "부동산가치-20%" 등
    survives: bool
    detail: str | None = None


def score_f10_stress(results: list[StressTestResult]) -> tuple[float, list[str]]:
    if not results:
        return 50.0, ["스트레스 테스트가 수행되지 않았습니다."]
    survived = sum(1 for r in results if r.survives)
    failed = [r for r in results if not r.survives]
    drivers = [f"{r.stress_name} 스트레스에서 생존 실패" + (f" ({r.detail})" if r.detail else "") for r in failed]
    return _clamp(survived / len(results) * 100), drivers


# ── 하드 탈락조건 (스펙 6.13) ────────────────────────────────────

class HardFailChecklist(BaseModel):
    legally_impossible_transaction: bool = False
    required_party_consent_missing: bool = False
    no_way_to_close_initial_funding_gap: bool = False
    loan_required_but_bank_ineligible: bool = False
    no_tax_payment_funding: bool = False
    relies_on_sham_debt: bool = False
    relies_on_paper_only_sale_without_real_payment: bool = False
    burdened_gift_recipient_does_not_bear_debt: bool = False
    simulated_cash_balance_goes_negative_without_backup: bool = False
    ownership_or_lien_priority_blocks_transaction: bool = False
    non_resident_required_filing_or_remittance_path_not_implemented: bool = False
    required_legal_rule_unconfirmed: bool = False

    def reasons(self) -> list[str]:
        labels = {
            "legally_impossible_transaction": "법적으로 불가능한 거래",
            "required_party_consent_missing": "필수 당사자의 동의 없음",
            "no_way_to_close_initial_funding_gap": "초기 현금 부족을 해결할 방법 없음",
            "loan_required_but_bank_ineligible": "대출이 필수인데 금융기관 기준상 불가능",
            "no_tax_payment_funding": "세금 납부재원이 없음",
            "relies_on_sham_debt": "명백한 허위채무를 전제로 함",
            "relies_on_paper_only_sale_without_real_payment": "실제 지급 없는 형식상 매매를 전제로 함",
            "burdened_gift_recipient_does_not_bear_debt": "수증자가 채무를 부담하지 않는 부담부증여",
            "simulated_cash_balance_goes_negative_without_backup": "시뮬레이션 중 현금잔액이 음수이고 대체조달 없음",
            "ownership_or_lien_priority_blocks_transaction": "소유권·담보권 순위상 거래 불가능",
            "non_resident_required_filing_or_remittance_path_not_implemented": "비거주자 관련 필수 신고·송금 경로가 구현되지 않음",
            "required_legal_rule_unconfirmed": "필수 법령 규칙이 미확인 상태",
        }
        return [label for field, label in labels.items() if getattr(self, field)]


# ── 종합 ─────────────────────────────────────────────────────────

class FeasibilityInput(BaseModel):
    initial_funding: InitialFundingInput
    cashflow: CashflowInput
    debt_service: DebtServiceInput
    bank_approval: BankApprovalGrade | None = None
    legal_uncertainties: list[LegalUncertainty] = Field(default_factory=list)
    documents: list[RequiredDocumentState] = Field(default_factory=list)
    schedule_items: list[ScheduleCheckItem] = Field(default_factory=list)
    consents: list[ConsentItem] = Field(default_factory=list)
    operational_complexity: OperationalComplexityInput = Field(default_factory=OperationalComplexityInput)
    stress_tests: list[StressTestResult] = Field(default_factory=list)
    hard_fail_checklist: HardFailChecklist = Field(default_factory=HardFailChecklist)


def _grade(score: float) -> str:
    if score >= 90:
        return "매우 높음"
    if score >= 75:
        return "높음"
    if score >= 60:
        return "조건부 가능"
    if score >= 40:
        return "낮음"
    if score >= 20:
        return "매우 낮음"
    return "실행 곤란"


def compute_feasibility(inp: FeasibilityInput) -> dict:
    f1, d1 = score_f1_initial_funding(inp.initial_funding)
    f2, d2, cf_hard_fail, cf_hard_reasons = score_f2_cashflow(inp.cashflow)
    f3, d3 = score_f3_debt_service(inp.debt_service)
    f4, d4 = score_f4_bank_approval(inp.bank_approval)
    f5, d5 = score_f5_legal_clarity(inp.legal_uncertainties)
    f6, d6 = score_f6_documentation(inp.documents)
    f7, d7, tl_hard_fail, tl_hard_reasons = score_f7_timeline(inp.schedule_items)
    f8, d8, conditional = score_f8_governance(inp.consents)
    f9, d9 = score_f9_complexity(inp.operational_complexity)
    f10, d10 = score_f10_stress(inp.stress_tests)

    components = {
        "initial_funding": f1, "ongoing_cash_flow": f2, "debt_service": f3,
        "bank_approval": f4, "legal_clarity": f5, "documentation": f6,
        "timeline": f7, "family_governance": f8, "operational_complexity": f9,
        "stress_survival": f10,
    }

    # WEIGHTS는 F1~F10 코드로 키가 잡혀 있으므로 components 키(설명적 이름)와 순서로 매핑한다.
    component_order = [
        "initial_funding", "ongoing_cash_flow", "debt_service", "bank_approval",
        "legal_clarity", "documentation", "timeline", "family_governance",
        "operational_complexity", "stress_survival",
    ]
    raw = sum(components[name] * w for name, w in zip(component_order, WEIGHTS.values()))

    hard_fail_reasons = list(inp.hard_fail_checklist.reasons())
    hard_fail_reasons += cf_hard_reasons + tl_hard_reasons
    hard_blocked = bool(hard_fail_reasons)

    all_drivers = d1 + d2 + d3 + d4 + d5 + d6 + d7 + d9 + d10
    if conditional:
        all_drivers = d8 + all_drivers

    total_score = 0.0 if hard_blocked else _clamp(raw)
    grade = "실행 곤란 (하드 탈락)" if hard_blocked else _grade(total_score)

    improvement_actions = _suggest_improvements(components)

    return {
        "total_score": total_score,
        "grade": grade,
        "components": components,
        "top_constraints": all_drivers[:5],
        "improvement_actions": improvement_actions,
        "hard_blocked": hard_blocked,
        "hard_block_reasons": hard_fail_reasons,
        "conditional_on_consent": conditional,
    }


def _suggest_improvements(components: dict[str, float]) -> list[str]:
    suggestions = {
        "initial_funding": "은행 사전승인을 받으면 초기자금 점수가 상승합니다.",
        "ongoing_cash_flow": "대출 원리금 규모를 낮추거나 임대수익 자산 비중을 늘려 현금흐름 여유를 확보하세요.",
        "debt_service": "대출액을 낮추거나 상환기간을 늘려 DSCR을 개선하세요.",
        "bank_approval": "복수 은행에 사전상담을 진행해 승인 가능성을 확인하세요.",
        "legal_clarity": "세무사·변호사 확인이 필요한 항목을 먼저 확정하세요.",
        "documentation": "계약서·차용증 등 핵심 문서를 서명·공증 단계까지 진행하세요.",
        "timeline": "선행조건이 거래일보다 먼저 충족되도록 일정을 재배열하세요.",
        "family_governance": "핵심 거래 당사자의 서면 동의를 먼저 확보하세요.",
        "operational_complexity": "법인·자산·대여 건수를 줄이거나 관리를 위임하세요.",
        "stress_survival": "금리·자산가치 스트레스 시나리오에서 실패하는 항목의 레버리지를 낮추세요.",
    }
    return [msg for key, msg in suggestions.items() if components[key] < 70]
