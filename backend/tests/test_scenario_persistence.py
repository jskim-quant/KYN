from datetime import date

from app.db.repository import get_scenario, save_scenario
from app.engines.scenario.builder import GiftRecipient, build_immediate_gift_scenario


def test_save_and_reload_scenario_roundtrip(db_session):
    scenario = build_immediate_gift_scenario(
        donor_id="parent1", family_total_assets=40.0, available_cash=10.0,
        recipients=[GiftRecipient(person_id="child1", relation="자녀", gift_amount=3.0)],
        annual_growth_rate=0.03, event_date=date(2026, 1, 1),
    )
    save_scenario(db_session, scenario)

    reloaded = get_scenario(db_session, scenario.id)
    assert reloaded is not None
    assert reloaded.name == scenario.name
    assert reloaded.feasibility_score.total_score == scenario.feasibility_score.total_score
    assert reloaded.rejected == scenario.rejected


def test_get_nonexistent_scenario_returns_none(db_session):
    assert get_scenario(db_session, "does-not-exist") is None
