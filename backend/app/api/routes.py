"""
FastAPI 라우터 — 규칙/시나리오/리스크 엔진을 HTTP로 노출한다.

Next.js 프론트엔드는 이 API만 호출한다. 계산 로직은 여기 없다 — 전부 app/engines/*에
있고, 이 파일은 입출력 스키마 변환만 담당한다 (스펙 0.1 계층 분리 원칙).
"""
from __future__ import annotations

from datetime import date

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.engines.rules.acquisition_tax import AcquisitionTaxInput, compute_acquisition_tax
from app.engines.rules.capital_gains_tax import CGTInput, compute_cgt
from app.engines.rules.gift_tax import GiftTaxInput, compute_gift_tax
from app.engines.rules.inheritance_tax import HeirInput, InheritanceTaxInput, compute_inheritance_tax
from app.engines.rules.residency import ResidencyFactors, determine_tax_residency, generate_parallel_residency_scenarios
from app.engines.rules.rule_loader import RuleNotFoundError, RuleRequiresReviewError
from app.engines.scenario.builder import GiftRecipient, build_immediate_gift_scenario
from app.engines.scenario.assignment import MyAssignmentRequest, evaluate_my_assignment
from app.engines.balance_sheet.engine import build_family_balance_sheet, compute_metrics
from app.engines.leverage.engine import (
    compare_leverage_levels,
    compute_downside_stress,
    simulate_capital_recycling,
)
from app.engines.allocation.engine import compute_marginal_purchase_effect, compute_portfolio_metrics
from app.models.asset import Asset
from app.models.debt import Debt
from app.models.leverage import CapitalRecyclingInput, LeverageScenarioInput
from app.models.allocation import MarginalPurchaseInput, PortfolioAllocationInput

router = APIRouter()


@router.get("/health")
def health():
    return {"status": "ok"}


@router.post("/calc/gift-tax")
def calc_gift_tax(inp: GiftTaxInput):
    try:
        return compute_gift_tax(inp)
    except (RuleNotFoundError, RuleRequiresReviewError) as e:
        raise HTTPException(status_code=422, detail=str(e))


@router.post("/calc/inheritance-tax")
def calc_inheritance_tax(inp: InheritanceTaxInput):
    try:
        return compute_inheritance_tax(inp)
    except (RuleNotFoundError, RuleRequiresReviewError) as e:
        raise HTTPException(status_code=422, detail=str(e))


@router.post("/calc/cgt")
def calc_cgt(inp: CGTInput):
    try:
        return compute_cgt(inp)
    except (RuleNotFoundError, RuleRequiresReviewError) as e:
        raise HTTPException(status_code=422, detail=str(e))


@router.post("/calc/acquisition-tax")
def calc_acquisition_tax(inp: AcquisitionTaxInput):
    try:
        return compute_acquisition_tax(inp)
    except (RuleNotFoundError, RuleRequiresReviewError) as e:
        raise HTTPException(status_code=422, detail=str(e))


@router.post("/residency/determine")
def residency_determine(factors: ResidencyFactors):
    return determine_tax_residency(factors)


@router.post("/residency/parallel-scenarios")
def residency_parallel_scenarios(factors: ResidencyFactors):
    return generate_parallel_residency_scenarios(factors)


class GiftRecipientRequest(BaseModel):
    person_id: str
    relation: str
    gift_amount: float
    is_adult: bool = True


class ImmediateGiftScenarioRequest(BaseModel):
    donor_id: str
    family_total_assets: float
    available_cash: float  # 순수 보유 현금(대출 제외) — 하위호환용, funding_sources 없으면 전액 CASH_ON_HAND로 처리
    recipients: list[GiftRecipientRequest]
    annual_growth_rate: float = 0.03
    event_date: date
    years: int = 10
    # ── 자금조달 재원 구성 (대출을 현금과 같은 확실성으로 취급하던 버그 수정용) ──
    family_loan_amount: float = 0.0        # 가족간 차용으로 조달하는 증여세 재원
    bank_loan_amount: float = 0.0          # 담보대출로 조달하는 증여세 재원
    bank_loan_annual_interest: float = 0.0  # 그 담보대출의 연간 이자 (DSCR/ICR 근사용)
    corp_conversion_amount: float = 0.0    # 법인전환에 걸린 자산가액 (0이면 미포함)
    foundation_amount: float = 0.0         # 공익법인 출연액 (0이면 미포함)


@router.post("/scenario/immediate-gift")
def scenario_immediate_gift(req: ImmediateGiftScenarioRequest):
    return build_immediate_gift_scenario(
        donor_id=req.donor_id,
        family_total_assets=req.family_total_assets,
        available_cash=req.available_cash,
        recipients=[GiftRecipient(**r.model_dump()) for r in req.recipients],
        annual_growth_rate=req.annual_growth_rate,
        event_date=req.event_date,
        years=req.years,
        family_loan_amount=req.family_loan_amount,
        bank_loan_amount=req.bank_loan_amount,
        bank_loan_annual_interest=req.bank_loan_annual_interest,
        corp_conversion_amount=req.corp_conversion_amount,
        foundation_amount=req.foundation_amount,
    )


@router.post("/scenario/my-assignment")
def scenario_my_assignment(req: MyAssignmentRequest):
    return evaluate_my_assignment(req)


class BalanceSheetRequest(BaseModel):
    assets: list[Asset]
    debts: list[Debt] = []
    as_of: date
    annual_total_income: float | None = None
    annual_debt_service: float | None = None
    annual_interest_expense: float | None = None


def _opt_decimal(v: float | None):
    from decimal import Decimal
    return None if v is None else Decimal(str(v))


@router.post("/balance-sheet/compute")
def balance_sheet_compute(req: BalanceSheetRequest):
    bs = build_family_balance_sheet(req.assets, req.debts, as_of=req.as_of.isoformat())
    metrics = compute_metrics(
        bs,
        annual_total_income=_opt_decimal(req.annual_total_income),
        annual_debt_service=_opt_decimal(req.annual_debt_service),
        annual_interest_expense=_opt_decimal(req.annual_interest_expense),
    )
    return {"balance_sheet": bs, "metrics": metrics}


class LeverageCompareRequest(BaseModel):
    base: LeverageScenarioInput
    equity_ratios: list[float] | None = None
    downside_shock_pct: float = -0.25


@router.post("/leverage/compare")
def leverage_compare(req: LeverageCompareRequest):
    return compare_leverage_levels(req.base, req.equity_ratios, req.downside_shock_pct)


@router.post("/leverage/downside")
def leverage_downside(req: LeverageScenarioInput, shock_pct: float = -0.25):
    return compute_downside_stress(req, shock_pct)


@router.post("/leverage/capital-recycling")
def leverage_capital_recycling(req: CapitalRecyclingInput):
    return simulate_capital_recycling(req)


@router.post("/allocation/portfolio-metrics")
def allocation_portfolio_metrics(req: PortfolioAllocationInput):
    return compute_portfolio_metrics(req)


@router.post("/allocation/marginal-purchase")
def allocation_marginal_purchase(req: MarginalPurchaseInput):
    return compute_marginal_purchase_effect(req)
