from datetime import date

import pytest

from app.engines.optimization.optimizer import (
    MODE_WEIGHTS,
    extract_objective_values,
    pareto_frontier,
    rank_scenarios,
    scenario_utility,
)
from app.engines.rules.inheritance_tax import HeirInput
from app.engines.scenario.baseline import build_baseline_scenario
from app.engines.scenario.builder import GiftRecipient, build_immediate_gift_scenario
from app.models.scenario import ScenarioObjective

AS_OF = date(2026, 1, 1)


def test_mode_weights_all_sum_to_one():
    for mode, w in MODE_WEIGHTS.items():
        assert w.total() == pytest.approx(1.0)


@pytest.fixture()
def baseline():
    return build_baseline_scenario(
        decedent_id="grandpa", family_total_assets=40.0,
        heirs=[HeirInput(relation="자녀", age=30)], heir_ids=["child1"],
        annual_growth_rate=0.03, event_date=AS_OF,
    )


def test_good_scenario_scores_higher_than_baseline_growth(baseline):
    scenario = build_immediate_gift_scenario(
        donor_id="grandpa", family_total_assets=40.0, available_cash=10.0,
        recipients=[GiftRecipient(person_id="child1", relation="자녀", gift_amount=3.0)],
        annual_growth_rate=0.03, event_date=AS_OF,
    )
    values = extract_objective_values(scenario, baseline)
    assert values.growth > 0


def test_rank_scenarios_excludes_hard_blocked(baseline):
    good = build_immediate_gift_scenario(
        donor_id="grandpa", family_total_assets=40.0, available_cash=10.0,
        recipients=[GiftRecipient(person_id="child1", relation="자녀", gift_amount=3.0)],
        annual_growth_rate=0.03, event_date=AS_OF,
    )
    blocked = build_immediate_gift_scenario(
        donor_id="grandpa", family_total_assets=4400.0, available_cash=0.0,
        recipients=[GiftRecipient(person_id="child1", relation="자녀", gift_amount=2000.0)],
        annual_growth_rate=0.03, event_date=AS_OF,
    )
    assert blocked.rejected is True

    ranked = rank_scenarios([good, blocked], baseline, mode=ScenarioObjective.TAX_SAVING)
    ranked_ids = [s.id for s, _ in ranked]
    assert good.id in ranked_ids
    assert blocked.id not in ranked_ids


def test_scenario_utility_varies_by_mode(baseline):
    scenario = build_immediate_gift_scenario(
        donor_id="grandpa", family_total_assets=40.0, available_cash=10.0,
        recipients=[GiftRecipient(person_id="child1", relation="자녀", gift_amount=3.0)],
        annual_growth_rate=0.03, event_date=AS_OF,
    )
    stable_score = scenario_utility(scenario, baseline, ScenarioObjective.STABLE)
    tax_saving_score = scenario_utility(scenario, baseline, ScenarioObjective.TAX_SAVING)
    assert stable_score != tax_saving_score


def test_pareto_frontier_excludes_hard_blocked_and_dominated(baseline):
    good = build_immediate_gift_scenario(
        donor_id="grandpa", family_total_assets=40.0, available_cash=10.0,
        recipients=[GiftRecipient(person_id="child1", relation="자녀", gift_amount=3.0)],
        annual_growth_rate=0.03, event_date=AS_OF,
    )
    blocked = build_immediate_gift_scenario(
        donor_id="grandpa", family_total_assets=4400.0, available_cash=0.0,
        recipients=[GiftRecipient(person_id="child1", relation="자녀", gift_amount=2000.0)],
        annual_growth_rate=0.03, event_date=AS_OF,
    )
    frontier = pareto_frontier([good, blocked, baseline], baseline)
    frontier_ids = {s.id for s in frontier}
    assert blocked.id not in frontier_ids
