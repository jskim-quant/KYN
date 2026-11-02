from datetime import date

from app.db.repository import (
    load_all_rules_from_db,
    seed_rule_tables_from_yaml,
)
from app.engines.rules.rule_loader import get_active_rule


def test_seed_and_load_rules_from_db(db_session):
    count = seed_rule_tables_from_yaml(db_session)
    assert count > 0

    rules = load_all_rules_from_db(db_session)
    assert len(rules) == count

    gift_rules = load_all_rules_from_db(db_session, tax_type="gift")
    assert all(r.tax_type == "gift" for r in gift_rules)
    assert len(gift_rules) < len(rules)


def test_rule_loader_get_active_rule_works_with_db_backed_rules(db_session):
    seed_rule_tables_from_yaml(db_session)
    rules = load_all_rules_from_db(db_session)
    rule = get_active_rule(rules, "gift", "증여세_상속세_누진세율_구간", date(2026, 1, 1), allow_pending_review=True)
    assert rule.parameters["bracket_1_rate"] == 0.10


def test_seeding_twice_is_idempotent_upsert(db_session):
    first = seed_rule_tables_from_yaml(db_session)
    second = seed_rule_tables_from_yaml(db_session)
    rules = load_all_rules_from_db(db_session)
    assert first == second == len(rules)
