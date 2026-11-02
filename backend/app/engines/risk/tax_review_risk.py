"""
세무상 설명부담 점수 엔진 (스펙 7장).

주의: 이 점수는 실제 국세청 조사선정 확률을 예측하지 않는다. 공개 법령·일반적 증빙
원칙·거래의 경제적 실질·입력자료 완성도를 바탕으로 한 내부 휴리스틱이며, 화면 문구에
"조사 확률"이라는 표현을 쓰지 않는다 (스펙 7.1).

세 층 분리 (스펙 7.2):
  A. 거래 부인 위험 (transaction_recharacterization)
  B. 세액 재산정 위험 (valuation_adjustment)
  C. 조사·소명 부담 신호 (documentation_burden)
T1~T12는 먼저 종합 위험점수를 만들고, 이 세 층은 관련 T-요소를 묶은 내부 휴리스틱
집계다 (스펙이 층별 정확한 산식을 명시하지 않아 이 매핑은 설계 선택이며 향후 조정 가능).
"""
from __future__ import annotations

from enum import Enum

from pydantic import BaseModel, Field

# ── 가중치 (스펙 7.3) ────────────────────────────────────────────

WEIGHTS: dict[str, float] = {
    "T1": 0.08, "T2": 0.12, "T3": 0.12, "T4": 0.12, "T5": 0.12,
    "T6": 0.10, "T7": 0.08, "T8": 0.10, "T9": 0.05, "T10": 0.05,
    "T11": 0.04, "T12": 0.02,
}
assert abs(sum(WEIGHTS.values()) - 1.0) < 1e-9


def _clamp(v: float, lo: float = 0.0, hi: float = 100.0) -> float:
    return max(lo, min(hi, v))


# ── T1 특수관계인 거래 강도 ──────────────────────────────────────

class RelatedPartyInput(BaseModel):
    is_related_party: bool = False
    relation_category: str = "none"  # "lineal" | "spouse" | "grandparent_grandchild" | "sibling" | "controlled_corp" | "none"
    repeated_transaction_count: int = 0  # 같은 가족 간 반복 거래 횟수


def score_t1_related_party(inp: RelatedPartyInput) -> tuple[float, list[str]]:
    if not inp.is_related_party:
        return 0.0, []
    base = {"lineal": 35, "spouse": 30, "grandparent_grandchild": 40,
            "sibling": 25, "controlled_corp": 40, "none": 0}.get(inp.relation_category, 30)
    repeat_penalty = min(20, inp.repeated_transaction_count * 5)
    score = _clamp(base + repeat_penalty)
    drivers = [f"특수관계({inp.relation_category}) 거래"] if score > 0 else []
    return score, drivers


# ── T2 시가·평가가액 불확실성 ────────────────────────────────────

class ValuationUncertaintyInput(BaseModel):
    has_comparable_transaction: bool = True
    has_independent_appraisal: bool = False
    multiple_appraisals_differ_significantly: bool = False
    bank_vs_tax_valuation_gap_large: bool = False
    formal_appraisal_around_transaction_date: bool = False  # 대출용 감정평가가 거래 직전/직후 존재
    unlisted_share_valuation: bool = False
    development_or_zoning_change_factor: bool = False
    ignored_nearby_comparable: bool = False
    valuation_date_matches_tax_base_date: bool = True


def score_t2_valuation(inp: ValuationUncertaintyInput) -> tuple[float, list[str]]:
    penalty = 0
    drivers: list[str] = []
    if not inp.has_comparable_transaction:
        penalty += 15
    if inp.multiple_appraisals_differ_significantly:
        penalty += 15
        drivers.append("복수 감정평가액 간 차이가 큽니다.")
    if inp.bank_vs_tax_valuation_gap_large:
        penalty += 20
        drivers.append("은행 평가액과 세무 신고가액의 차이가 큽니다.")
    if inp.formal_appraisal_around_transaction_date:
        penalty += 15
        drivers.append("거래 직전·직후 정식 감정평가가 존재해 시가 재산정 가능성이 있습니다.")
    if inp.unlisted_share_valuation:
        penalty += 10
    if inp.development_or_zoning_change_factor:
        penalty += 10
    if inp.ignored_nearby_comparable:
        penalty += 15
        drivers.append("평가기준일 주변 매매사례가 있으나 반영하지 않았습니다.")
    if not inp.valuation_date_matches_tax_base_date:
        penalty += 10

    # 완화: 독립 감정평가 + 평가기준일 일치
    if inp.has_independent_appraisal:
        penalty -= 15
    return _clamp(penalty), drivers


# ── T3 자금출처 불일치 ───────────────────────────────────────────

class FundingSourceLegitimacyInput(BaseModel):
    acquisition_amount: float
    verified_own_funds: float = 0.0        # 기존 현금+신고소득 축적액
    verified_bank_loan: float = 0.0
    verified_sale_proceeds: float = 0.0
    verified_reported_gift: float = 0.0
    verified_substantive_family_loan: float = 0.0

    acquirer_is_student_or_no_income: bool = False
    repeated_cash_withdrawal_deposit_pattern: bool = False
    unexplained_cash_present: bool = False
    routed_through_third_party_account: bool = False
    donor_funds_cycle_back_as_price: bool = False
    unexplained_overseas_remittance: bool = False

    @property
    def verified_total(self) -> float:
        return (self.verified_own_funds + self.verified_bank_loan + self.verified_sale_proceeds
                + self.verified_reported_gift + self.verified_substantive_family_loan)

    @property
    def unexplained_amount(self) -> float:
        return max(0.0, self.acquisition_amount - self.verified_total)


def score_t3_funding_source(inp: FundingSourceLegitimacyInput) -> tuple[float, list[str]]:
    drivers: list[str] = []
    ratio_unexplained = inp.unexplained_amount / inp.acquisition_amount if inp.acquisition_amount > 0 else 0
    penalty = ratio_unexplained * 60
    if ratio_unexplained > 0.2:
        drivers.append(f"취득자금 중 {ratio_unexplained*100:.0f}%의 출처가 확인되지 않습니다.")
    if inp.acquirer_is_student_or_no_income:
        penalty += 20
        drivers.append("취득자가 학생 또는 무소득자입니다.")
    if inp.repeated_cash_withdrawal_deposit_pattern:
        penalty += 15
    if inp.unexplained_cash_present:
        penalty += 15
    if inp.routed_through_third_party_account:
        penalty += 15
        drivers.append("자금이 제3자 계좌를 경유했습니다.")
    if inp.donor_funds_cycle_back_as_price:
        penalty += 25
        drivers.append("증여자 자금이 매매대금으로 순환됩니다.")
    if inp.unexplained_overseas_remittance:
        penalty += 15
    return _clamp(penalty), drivers


# ── T4 계약과 현금흐름 불일치 ────────────────────────────────────

class ContractCashflowMismatchInput(BaseModel):
    sale_contract_without_real_payment: bool = False
    loan_contract_without_interest_paid: bool = False
    burdened_gift_but_donor_still_pays_debt: bool = False
    corp_owned_but_rent_to_personal_account: bool = False
    ceo_salary_without_actual_work: bool = False


def score_t4_contract_mismatch(inp: ContractCashflowMismatchInput) -> tuple[float, list[str]]:
    checks = {
        "sale_contract_without_real_payment": ("매매계약인데 실제 대금 지급이 없습니다.", 30),
        "loan_contract_without_interest_paid": ("대여계약인데 이자가 지급되지 않습니다.", 25),
        "burdened_gift_but_donor_still_pays_debt": ("부담부증여인데 증여자가 채무를 계속 상환합니다.", 30),
        "corp_owned_but_rent_to_personal_account": ("법인 소유 자산의 임대료가 개인계좌로 귀속됩니다.", 25),
        "ceo_salary_without_actual_work": ("실제 업무 없이 대표 급여가 지급됩니다.", 20),
    }
    penalty = 0
    drivers: list[str] = []
    for field, (msg, pts) in checks.items():
        if getattr(inp, field):
            penalty += pts
            drivers.append(msg)
    return _clamp(penalty), drivers


# ── T5 채무 실재성과 상환능력 ────────────────────────────────────

class DebtSubstanceInput(BaseModel):
    is_family_loan: bool = False
    has_written_contract: bool = False
    has_maturity_date: bool = True
    interest_actually_paid: bool = True
    borrower_has_income_or_assets_or_future_income: bool = True
    creditor_repeatedly_extends_maturity: bool = False
    debt_effectively_extinguished_on_death: bool = False
    interest_paid_then_returned_to_borrower: bool = False
    planned_debt_forgiveness: bool = False
    donor_pays_instead_of_borrower: bool = False
    collateral_enforceable: bool = True


def score_t5_debt_substance(inp: DebtSubstanceInput) -> tuple[float, list[str]]:
    if not inp.is_family_loan:
        return 0.0, []
    penalty = 0
    drivers: list[str] = []
    if not inp.has_written_contract:
        penalty += 20
    if not inp.has_maturity_date:
        penalty += 20
        drivers.append("만기 없는 대여입니다.")
    if not inp.interest_actually_paid:
        penalty += 15
        drivers.append("이자가 실제 지급되지 않습니다.")
    if not inp.borrower_has_income_or_assets_or_future_income:
        penalty += 25
        drivers.append("차입자가 소득·자산·미래소득 중 어느 것도 없어 상환능력이 확인되지 않습니다.")
    if inp.creditor_repeatedly_extends_maturity:
        penalty += 15
    if inp.debt_effectively_extinguished_on_death:
        penalty += 20
        drivers.append("채권자 사망 시 채무가 사실상 소멸하도록 설계되어 있습니다.")
    if inp.interest_paid_then_returned_to_borrower:
        penalty += 25
        drivers.append("지급한 이자가 단기간 내 차입자에게 되돌아갑니다.")
    if inp.planned_debt_forgiveness:
        penalty += 25
    if inp.donor_pays_instead_of_borrower:
        penalty += 25
    if not inp.collateral_enforceable:
        penalty += 10
    return _clamp(penalty), drivers


# ── T6 순환·우회거래 탐지 ────────────────────────────────────────

class DirectionalTransfer(BaseModel):
    id: str
    party_from: str
    party_to: str
    amount: float
    date_offset_days: int  # 기준일로부터 경과일수 (음수 가능)


def detect_circular_flows(
    transfers: list[DirectionalTransfer],
    amount_tolerance_pct: float = 15.0,
    window_days: int = 365,
) -> list[str]:
    """직접 역방향(A→B, B→A) + 2단계 경유(A→B, B→C) 순환송금 탐지.

    스펙 7.9의 대표 예시(부모→할아버지 이자, 할아버지→손자 대여)가 2단계 경유
    패턴이므로 이를 기본으로 포함한다. 3단계 이상의 다단계 그래프 탐지는 원장
    그래프가 필요해 Phase 3 시나리오 엔진의 복식 원장 완성 후 확장한다.
    """
    flags: list[str] = []
    for i, t1 in enumerate(transfers):
        if t1.amount <= 0:
            continue
        for t2 in transfers[i + 1:]:
            if abs(t2.date_offset_days - t1.date_offset_days) > window_days:
                continue
            diff_pct = abs(t2.amount - t1.amount) / t1.amount * 100
            if diff_pct > amount_tolerance_pct:
                continue

            is_direct_reverse = (t2.party_from == t1.party_to and t2.party_to == t1.party_from)
            is_two_hop_chain = (t2.party_from == t1.party_to and t2.party_to != t1.party_from)

            if is_direct_reverse or is_two_hop_chain:
                pattern = "직접 역방향" if is_direct_reverse else "2단계 경유"
                flags.append(
                    f"CIRCULAR_FLOW_FLAG ({pattern}): {t1.party_from}→{t1.party_to} {t1.amount}와 "
                    f"{t2.party_from}→{t2.party_to} {t2.amount}가 {window_days}일 이내 유사금액으로 이동"
                )
    return flags


class CircularFlowInput(BaseModel):
    transfers: list[DirectionalTransfer] = Field(default_factory=list)
    corp_funded_then_lent_to_individual: bool = False
    sale_proceeds_returned_to_buyer: bool = False


def score_t6_circular_flow(inp: CircularFlowInput) -> tuple[float, list[str]]:
    flags = detect_circular_flows(inp.transfers)
    if inp.corp_funded_then_lent_to_individual:
        flags.append("CIRCULAR_FLOW_FLAG: 법인 출자금이 개인에게 대여되는 패턴")
    if inp.sale_proceeds_returned_to_buyer:
        flags.append("CIRCULAR_FLOW_FLAG: 매매대금이 매수자에게 재송금되는 패턴")
    if not flags:
        return 0.0, []
    # 단순 일치만으로 위법 판정하지 않음 — 플래그 개수만큼 "설명 요구" 점수를 올린다.
    return _clamp(30 + len(flags) * 20), flags


# ── T7 법인·개인 자금 혼용 ───────────────────────────────────────

class CorpPersonalMixingInput(BaseModel):
    corp_pays_personal_expense: bool = False
    corp_bears_personal_asset_cost: bool = False
    personal_uses_corp_asset_free: bool = False
    rent_paid_to_personal_account: bool = False
    undocumented_temporary_payment: bool = False   # 가지급금
    long_unrecovered_shareholder_loan: bool = False  # 주주대여금
    abnormal_family_salary: bool = False
    salary_without_real_work: bool = False
    dividend_withdrawal_without_resolution: bool = False


def score_t7_corp_mixing(inp: CorpPersonalMixingInput) -> tuple[float, list[str]]:
    checks = {
        "corp_pays_personal_expense": "법인계좌에서 개인 생활비가 지출됩니다.",
        "corp_bears_personal_asset_cost": "개인 소유 자산 비용을 법인이 부담합니다.",
        "personal_uses_corp_asset_free": "법인 자산을 개인이 무상 사용합니다.",
        "rent_paid_to_personal_account": "임대료가 대표 개인계좌로 수령됩니다.",
        "undocumented_temporary_payment": "무증빙 가지급금이 있습니다.",
        "long_unrecovered_shareholder_loan": "장기 미회수 주주대여금이 있습니다.",
        "abnormal_family_salary": "가족에게 비정상적인 급여가 지급됩니다.",
        "salary_without_real_work": "실제 근무 없이 급여가 지급됩니다.",
        "dividend_withdrawal_without_resolution": "배당 결의 없이 자금이 인출됩니다.",
    }
    penalty = 0
    drivers = []
    for field, msg in checks.items():
        if getattr(inp, field):
            penalty += 12
            drivers.append(msg)
    return _clamp(penalty), drivers


# ── T8 신고·문서·원천징수 미비 ───────────────────────────────────

class FilingDocumentationInput(BaseModel):
    document_type: str
    filed_or_executed: bool = False
    actually_performed: bool = False  # 실제 이행 여부 — 없으면 완화 안 함 (스펙 7.11)


def score_t8_filing_documentation(items: list[FilingDocumentationInput]) -> tuple[float, list[str]]:
    if not items:
        return 50.0, ["신고·문서 현황이 입력되지 않았습니다."]
    missing = [i for i in items if not (i.filed_or_executed and i.actually_performed)]
    ratio_missing = len(missing) / len(items)
    drivers = [f"{i.document_type}: 신고/이행 미비" for i in missing]
    return _clamp(ratio_missing * 100), drivers


# ── T9 거래시점 집중 및 인위적 단계화 ────────────────────────────

class TimingConcentrationInput(BaseModel):
    concentrated_before_filing_deadline: bool = False
    multiple_family_transactions_short_period: bool = False
    same_asset_repeated_gift_or_sale: bool = False
    repeated_transactions_match_deduction_limit_exactly: bool = False
    sudden_transactions_around_appraisal: bool = False
    transactions_near_expected_death: bool = False
    transactions_right_after_corp_establishment: bool = False

    long_term_plan_pre_documented: bool = False
    has_economic_purpose: bool = False


def score_t9_timing(inp: TimingConcentrationInput) -> tuple[float, list[str]]:
    checks = {
        "concentrated_before_filing_deadline": "신고기준일 직전 거래가 집중되어 있습니다.",
        "multiple_family_transactions_short_period": "짧은 기간에 여러 가족을 경유한 거래가 있습니다.",
        "same_asset_repeated_gift_or_sale": "동일 자산을 연속 증여·매매합니다.",
        "repeated_transactions_match_deduction_limit_exactly": "공제 한도에 정확히 맞춘 반복 거래가 있습니다.",
        "sudden_transactions_around_appraisal": "감정평가 전후로 거래가 급격히 발생했습니다.",
        "transactions_near_expected_death": "사망 임박 시점에 대규모 거래가 있습니다.",
        "transactions_right_after_corp_establishment": "법인 설립 직후 자산 이전·대여가 있습니다.",
    }
    penalty = 0
    drivers = []
    for field, msg in checks.items():
        if getattr(inp, field):
            penalty += 15
            drivers.append(msg)
    if inp.long_term_plan_pre_documented and inp.has_economic_purpose:
        penalty -= 20  # 사전 문서화된 장기계획 + 경제적 목적 존재 시 완화
    return _clamp(penalty), drivers


# ── T10 거주자·비거주자 및 국외거래 ──────────────────────────────

class NonResidentUncertaintyInput(BaseModel):
    residency_determined_by_nationality_only: bool = False
    multiple_country_living_base: bool = False
    no_residence_day_records: bool = False
    overseas_account_reporting_gap_possible: bool = False
    no_overseas_asset_valuation_data: bool = False
    remittance_purpose_mismatch: bool = False
    domestic_foreign_reported_value_mismatch: bool = False
    tax_treaty_not_reviewed: bool = False
    foreign_tax_credit_data_missing: bool = False


def score_t10_non_resident(inp: NonResidentUncertaintyInput) -> tuple[float, list[str]]:
    checks = {
        "residency_determined_by_nationality_only": "국적만으로 거주자를 판정했습니다.",
        "multiple_country_living_base": "실제 생활근거가 복수 국가에 걸쳐 있습니다.",
        "no_residence_day_records": "체류일 자료가 없습니다.",
        "overseas_account_reporting_gap_possible": "해외계좌 신고 누락 가능성이 있습니다.",
        "no_overseas_asset_valuation_data": "국외재산 평가자료가 없습니다.",
        "remittance_purpose_mismatch": "해외송금 목적이 실제와 불일치합니다.",
        "domestic_foreign_reported_value_mismatch": "국내외 신고가액이 불일치합니다.",
        "tax_treaty_not_reviewed": "조세조약 검토가 이루어지지 않았습니다.",
        "foreign_tax_credit_data_missing": "외국납부세액 자료가 없습니다.",
    }
    penalty = 0
    drivers = []
    for field, msg in checks.items():
        if getattr(inp, field):
            penalty += 12
            drivers.append(msg)
    return _clamp(penalty), drivers


# ── T11 경제적 합리성 ────────────────────────────────────────────

class EconomicRationalityInput(BaseModel):
    independent_third_party_would_do_this: bool = True
    has_non_tax_economic_purpose: bool = True
    cashflow_improves_after_transaction: bool = True
    ownership_and_risk_actually_transfer: bool = True
    benefit_exceeds_management_cost: bool = True
    simpler_alternative_available_but_not_chosen_for_no_reason: bool = False


def score_t11_economic_rationality(inp: EconomicRationalityInput) -> tuple[float, list[str]]:
    favorable = [
        inp.independent_third_party_would_do_this, inp.has_non_tax_economic_purpose,
        inp.cashflow_improves_after_transaction, inp.ownership_and_risk_actually_transfer,
        inp.benefit_exceeds_management_cost,
    ]
    penalty = (len(favorable) - sum(favorable)) * 15
    if inp.simpler_alternative_available_but_not_chosen_for_no_reason:
        penalty += 20
    drivers = ["경제적 목적 없이 세금 감소만 존재하는 것으로 보입니다."] if penalty >= 30 else []
    return _clamp(penalty), drivers


# ── T12 금액 중요도 ──────────────────────────────────────────────

class AmountMaterialityInput(BaseModel):
    transaction_amount: float
    family_net_worth: float
    acquirer_annual_income: float = 0.0
    prior_reported_income: float = 0.0
    tax_reduction_amount: float = 0.0
    cumulative_repeated_amount: float = 0.0


def score_t12_materiality(inp: AmountMaterialityInput) -> tuple[float, list[str]]:
    net_worth_ratio = inp.transaction_amount / inp.family_net_worth if inp.family_net_worth > 0 else 0
    income_ratio = inp.transaction_amount / inp.acquirer_annual_income if inp.acquirer_annual_income > 0 else 0
    # 금액이 크다는 것만으로 위법 판정하지 않으므로 완만한 스케일 사용 (스펙 7.15)
    score = _clamp((net_worth_ratio * 40) + min(30, income_ratio * 2))
    drivers = ["거래금액이 가족 총자산 대비 비중이 큽니다."] if net_worth_ratio > 0.3 else []
    return score, drivers


# ── 위험 상호작용 보정 (스펙 7.16) ───────────────────────────────

class InteractionFlags(BaseModel):
    related_party_and_large_valuation_gap: bool = False       # +10
    related_party_and_no_actual_payment: bool = False          # +15
    family_loan_and_no_repayment_capacity: bool = False        # +15
    family_loan_and_no_interest_paid: bool = False              # +15
    burdened_gift_and_donor_pays_debt: bool = False             # +20
    corp_transaction_and_personal_account_used: bool = False    # +15
    underpriced_sale_and_proceeds_returned: bool = False        # +20
    non_resident_unclear_and_overseas_remittance: bool = False  # +10
    formal_appraisal_exists_and_low_value_reported: bool = False  # +15


_INTERACTION_BONUS: dict[str, int] = {
    "related_party_and_large_valuation_gap": 10,
    "related_party_and_no_actual_payment": 15,
    "family_loan_and_no_repayment_capacity": 15,
    "family_loan_and_no_interest_paid": 15,
    "burdened_gift_and_donor_pays_debt": 20,
    "corp_transaction_and_personal_account_used": 15,
    "underpriced_sale_and_proceeds_returned": 20,
    "non_resident_unclear_and_overseas_remittance": 10,
    "formal_appraisal_exists_and_low_value_reported": 15,
}


def derive_interaction_flags(
    t1: RelatedPartyInput, t2: ValuationUncertaintyInput, t4: ContractCashflowMismatchInput,
    t5: DebtSubstanceInput, t7: CorpPersonalMixingInput, t10: NonResidentUncertaintyInput,
) -> InteractionFlags:
    """개별 T-입력의 사실관계로부터 자동으로 결합위험 플래그를 도출한다 — 호출자가 같은
    사실을 두 번 입력하지 않도록."""
    return InteractionFlags(
        related_party_and_large_valuation_gap=t1.is_related_party and t2.bank_vs_tax_valuation_gap_large,
        related_party_and_no_actual_payment=t1.is_related_party and t4.sale_contract_without_real_payment,
        family_loan_and_no_repayment_capacity=t5.is_family_loan and not t5.borrower_has_income_or_assets_or_future_income,
        family_loan_and_no_interest_paid=t5.is_family_loan and not t5.interest_actually_paid,
        burdened_gift_and_donor_pays_debt=t4.burdened_gift_but_donor_still_pays_debt,
        corp_transaction_and_personal_account_used=t7.rent_paid_to_personal_account or t4.corp_owned_but_rent_to_personal_account,
        underpriced_sale_and_proceeds_returned=False,  # T3.donor_funds_cycle_back_as_price와 결합 시 호출측에서 세팅
        non_resident_unclear_and_overseas_remittance=(
            t10.residency_determined_by_nationality_only and t10.overseas_account_reporting_gap_possible
        ),
        formal_appraisal_exists_and_low_value_reported=t2.formal_appraisal_around_transaction_date,
    )


def _interaction_bonus(flags: InteractionFlags) -> tuple[int, list[str]]:
    bonus = 0
    drivers = []
    for field, pts in _INTERACTION_BONUS.items():
        if getattr(flags, field):
            bonus += pts
            drivers.append(f"결합위험: {field} (+{pts})")
    return bonus, drivers


# ── 등급 (스펙 7.18) ─────────────────────────────────────────────

def _grade(score: float) -> str:
    if score >= 90:
        return "구조 재검토"
    if score >= 75:
        return "매우 높음"
    if score >= 60:
        return "높음"
    if score >= 40:
        return "주의"
    if score >= 20:
        return "관리 가능"
    return "낮음"


DISCLAIMER = (
    "본 점수는 실제 세무조사 선정 확률이 아니라 거래의 소명 부담과 "
    "증빙 취약성을 나타내는 내부 휴리스틱입니다."
)


class TaxReviewRiskInput(BaseModel):
    t1: RelatedPartyInput = Field(default_factory=RelatedPartyInput)
    t2: ValuationUncertaintyInput = Field(default_factory=ValuationUncertaintyInput)
    t3: FundingSourceLegitimacyInput
    t4: ContractCashflowMismatchInput = Field(default_factory=ContractCashflowMismatchInput)
    t5: DebtSubstanceInput = Field(default_factory=DebtSubstanceInput)
    t6: CircularFlowInput = Field(default_factory=CircularFlowInput)
    t7: CorpPersonalMixingInput = Field(default_factory=CorpPersonalMixingInput)
    t8: list[FilingDocumentationInput] = Field(default_factory=list)
    t9: TimingConcentrationInput = Field(default_factory=TimingConcentrationInput)
    t10: NonResidentUncertaintyInput = Field(default_factory=NonResidentUncertaintyInput)
    t11: EconomicRationalityInput = Field(default_factory=EconomicRationalityInput)
    t12: AmountMaterialityInput


def compute_tax_review_risk(inp: TaxReviewRiskInput) -> dict:
    s1, d1 = score_t1_related_party(inp.t1)
    s2, d2 = score_t2_valuation(inp.t2)
    s3, d3 = score_t3_funding_source(inp.t3)
    s4, d4 = score_t4_contract_mismatch(inp.t4)
    s5, d5 = score_t5_debt_substance(inp.t5)
    s6, d6 = score_t6_circular_flow(inp.t6)
    s7, d7 = score_t7_corp_mixing(inp.t7)
    s8, d8 = score_t8_filing_documentation(inp.t8)
    s9, d9 = score_t9_timing(inp.t9)
    s10, d10 = score_t10_non_resident(inp.t10)
    s11, d11 = score_t11_economic_rationality(inp.t11)
    s12, d12 = score_t12_materiality(inp.t12)

    t_scores = {
        "T1": s1, "T2": s2, "T3": s3, "T4": s4, "T5": s5, "T6": s6,
        "T7": s7, "T8": s8, "T9": s9, "T10": s10, "T11": s11, "T12": s12,
    }
    raw = sum(t_scores[k] * w for k, w in WEIGHTS.items())

    flags = derive_interaction_flags(inp.t1, inp.t2, inp.t4, inp.t5, inp.t7, inp.t10)
    bonus, bonus_drivers = _interaction_bonus(flags)

    total = _clamp(raw + bonus)
    all_drivers = d1 + d2 + d3 + d4 + d5 + d6 + d7 + d8 + d9 + d10 + d11 + d12 + bonus_drivers

    # 세 층 휴리스틱 집계 (스펙 7.2) — T-요소를 층별로 묶어 근사한다.
    transaction_recharacterization = _clamp((s1 + s4 + s5 + s6 + s7 + s11) / 6)
    valuation_adjustment = _clamp((s2 + s12) / 2)
    documentation_burden = _clamp((s3 + s8 + s9 + s10) / 4)

    return {
        "overall_risk_score": total,
        "grade": _grade(total),
        "risk_type_scores": {
            "transactionRecharacterization": transaction_recharacterization,
            "valuationAdjustment": valuation_adjustment,
            "documentationBurden": documentation_burden,
        },
        "t_scores": t_scores,
        "drivers": all_drivers[:8],
        "mitigations": _suggest_mitigations(t_scores),
        "disclaimer": DISCLAIMER,
    }


def _suggest_mitigations(t_scores: dict[str, float]) -> list[str]:
    suggestions = {
        "T2": "독립된 외부 감정평가를 받고 평가근거를 문서화하세요.",
        "T3": "취득자금 출처별 내역(현금·소득·대출·매각대금)을 정리해 보관하세요.",
        "T5": "차용증에 만기·상환방법을 명시하고 실제 이자·원금 지급 내역을 남기세요.",
        "T6": "자금이동의 경제적 목적을 사전에 문서화하고 순환 여부를 스스로 점검하세요.",
        "T7": "법인 계좌와 개인 계좌를 명확히 분리하고 가지급금을 정리하세요.",
        "T8": "계약서·신고서·원천징수 자료를 신고기한 내 완비하세요.",
        "T9": "장기 계획을 사전에 문서화해 거래가 세금 회피만을 목적으로 하지 않았음을 보이세요.",
        "T10": "체류일수 기록과 조세조약 검토 결과를 확보하세요.",
    }
    return [msg for key, msg in suggestions.items() if t_scores.get(key, 0) >= 50]
