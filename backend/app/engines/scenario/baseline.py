"""
기준 시나리오(단순 상속, 아무 조치 없음) — 최적화 엔진이 "대비 개선폭"을
계산할 때 필요한 baseline. 별도 원자 없이 상속세 규칙 엔진만으로 구성한다.
"""
from __future__ import annotations

from datetime import date

from app.engines.rules.inheritance_tax import HeirInput, InheritanceTaxInput, compute_inheritance_tax
from app.models.scenario import AnnualFinancialState, Scenario, ScenarioObjective


def build_baseline_scenario(
    decedent_id: str,
    family_total_assets: float,
    heirs: list[HeirInput],
    heir_ids: list[str],
    annual_growth_rate: float,
    event_date: date,
    years: int = 10,
) -> Scenario:
    annual_states: list[AnnualFinancialState] = []
    for year in range(0, years + 1):
        asset_value = family_total_assets * ((1 + annual_growth_rate) ** year)
        tax_result = compute_inheritance_tax(InheritanceTaxInput(
            total_estate=asset_value, heirs=heirs, as_of=event_date,
        ))
        annual_states.append(AnnualFinancialState(
            year=year,
            total_assets=asset_value,
            total_debt=0.0,
            net_worth=asset_value - tax_result.final_tax,
            net_cashflow=0.0,
            ending_cash_balance=0.0,
            cumulative_tax_paid=tax_result.final_tax,
            below_reserve_target=False,
        ))

    return Scenario(
        id="baseline-no-action",
        name="단순 상속 (아무 조치 없음)",
        objective_type=ScenarioObjective.BASELINE,
        annual_states=annual_states,
        rejected=False,
    )
