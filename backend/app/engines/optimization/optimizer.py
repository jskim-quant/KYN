"""
최적화 엔진 (스펙 5.1 목표별 가중치, 8장 종합점수, Pareto frontier).

주의: 세금이 적다는 이유만으로 시나리오를 추천하지 않는다. 하드 탈락(스펙 6.13)된
시나리오는 아무리 점수가 좋아도 순위에서 제외한다 — 이는 `rank_scenarios`에서
`scenario.rejected` 필터로 강제한다.
"""
from __future__ import annotations

from dataclasses import dataclass

from app.models.scenario import Scenario, ScenarioObjective


@dataclass(frozen=True)
class ObjectiveWeights:
    """네 가지 공통 축 + 레버리지형 전용 스트레스 생존 축.
    가중치 합은 항상 1.0이어야 한다 (테스트로 강제)."""
    growth: float          # 세후 순자산 성장 (절세형의 "세금 절감"도 이 축의 근사치로 취급)
    feasibility: float     # 실현 가능성 (F1~F10 종합)
    cashflow: float        # 현금흐름 안정성 (feasibility.components.ongoing_cash_flow)
    tax_safety: float      # 세무상 안전성 (100 - 세무상설명부담)
    stress_survival: float = 0.0  # 스트레스 생존 가능성 (레버리지형 전용)

    def total(self) -> float:
        return self.growth + self.feasibility + self.cashflow + self.tax_safety + self.stress_survival


# 스펙 8의 4개 목표유형 가중치를 그대로 반영. 나머지 목표유형은 다음 단계에서 확정하기 전까지
# 중립 기본값(각 축 동일 가중)을 사용한다 — ASSUMED로 명시.
MODE_WEIGHTS: dict[ScenarioObjective, ObjectiveWeights] = {
    ScenarioObjective.STABLE: ObjectiveWeights(growth=0.15, feasibility=0.35, cashflow=0.30, tax_safety=0.20),
    ScenarioObjective.TAX_SAVING: ObjectiveWeights(growth=0.35, feasibility=0.25, cashflow=0.20, tax_safety=0.20),
    ScenarioObjective.CASHFLOW: ObjectiveWeights(growth=0.10, feasibility=0.30, cashflow=0.40, tax_safety=0.20),
    ScenarioObjective.LEVERAGE: ObjectiveWeights(
        growth=0.35, feasibility=0.20, cashflow=0.20, tax_safety=0.10, stress_survival=0.15,
    ),
}
DEFAULT_WEIGHTS_ASSUMED = ObjectiveWeights(growth=0.25, feasibility=0.25, cashflow=0.25, tax_safety=0.25)

for _mode, _w in MODE_WEIGHTS.items():
    assert abs(_w.total() - 1.0) < 1e-9, f"{_mode} weights must sum to 1.0"


def _clamp(v: float, lo: float = 0.0, hi: float = 100.0) -> float:
    return max(lo, min(hi, v))


@dataclass
class ScenarioObjectiveValues:
    growth: float
    feasibility: float
    cashflow: float
    tax_safety: float
    stress_survival: float


def extract_objective_values(scenario: Scenario, baseline: Scenario) -> ScenarioObjectiveValues:
    """시나리오의 원시 점수를 0~100 스케일 4~5개 축으로 뽑아낸다.
    growth는 baseline 대비 순자산 개선율을 50점 기준으로 환산한 것 — 정확한 절대 성장률이
    아니라 baseline 대비 상대적 우열을 나타내는 근사 지표다."""
    final = scenario.annual_states[-1] if scenario.annual_states else None
    baseline_final = baseline.annual_states[-1] if baseline.annual_states else None

    if final is not None and baseline_final is not None and baseline_final.net_worth != 0:
        growth_pct = (float(final.net_worth) - float(baseline_final.net_worth)) / abs(float(baseline_final.net_worth)) * 100
        growth = _clamp(50 + growth_pct)
    else:
        growth = 50.0

    feasibility = scenario.feasibility_score.total_score if scenario.feasibility_score else 50.0
    cashflow = (
        scenario.feasibility_score.components.ongoing_cash_flow
        if scenario.feasibility_score else 50.0
    )
    stress = (
        scenario.feasibility_score.components.stress_survival
        if scenario.feasibility_score else 50.0
    )
    tax_safety = (
        _clamp(100 - scenario.tax_review_risk.overall_risk_score)
        if scenario.tax_review_risk else 50.0
    )

    return ScenarioObjectiveValues(
        growth=growth, feasibility=feasibility, cashflow=cashflow,
        tax_safety=tax_safety, stress_survival=stress,
    )


def scenario_utility(scenario: Scenario, baseline: Scenario, mode: ScenarioObjective | None = None) -> float:
    weights = MODE_WEIGHTS.get(mode, DEFAULT_WEIGHTS_ASSUMED) if mode else DEFAULT_WEIGHTS_ASSUMED
    v = extract_objective_values(scenario, baseline)
    return (
        v.growth * weights.growth + v.feasibility * weights.feasibility
        + v.cashflow * weights.cashflow + v.tax_safety * weights.tax_safety
        + v.stress_survival * weights.stress_survival
    )


def rank_scenarios(
    scenarios: list[Scenario], baseline: Scenario, mode: ScenarioObjective | None = None,
) -> list[tuple[Scenario, float]]:
    """하드 탈락(scenario.rejected)된 시나리오는 점수와 무관하게 순위에서 제외한다."""
    eligible = [s for s in scenarios if not s.rejected]
    scored = [(s, scenario_utility(s, baseline, mode)) for s in eligible]
    return sorted(scored, key=lambda pair: pair[1], reverse=True)


def _dominates(a: ScenarioObjectiveValues, b: ScenarioObjectiveValues) -> bool:
    """a가 b를 지배하는가: 모든 축에서 a>=b이고 최소 한 축에서 a>b."""
    dims_a = (a.growth, a.feasibility, a.cashflow, a.tax_safety, a.stress_survival)
    dims_b = (b.growth, b.feasibility, b.cashflow, b.tax_safety, b.stress_survival)
    at_least_as_good = all(x >= y for x, y in zip(dims_a, dims_b))
    strictly_better = any(x > y for x, y in zip(dims_a, dims_b))
    return at_least_as_good and strictly_better


def pareto_frontier(scenarios: list[Scenario], baseline: Scenario) -> list[Scenario]:
    """하드 탈락 시나리오는 제외하고, 나머지 중 다른 어떤 시나리오에도 지배당하지 않는
    (mode-무관) 비지배 집합을 반환한다."""
    eligible = [s for s in scenarios if not s.rejected]
    values = {s.id: extract_objective_values(s, baseline) for s in eligible}

    frontier = []
    for s in eligible:
        dominated = any(
            other.id != s.id and _dominates(values[other.id], values[s.id])
            for other in eligible
        )
        if not dominated:
            frontier.append(s)
    return frontier
