from datetime import date

import pytest

from app.engines.rules.rule_loader import (
    RuleNotFoundError,
    RuleRequiresReviewError,
    get_active_rule,
    load_all_rules,
)


def test_load_all_rules_finds_gift_tax_yaml():
    rules = load_all_rules()
    rule_names = {r.rule_name for r in rules}
    assert "증여세_상속세_누진세율_구간" in rule_names
    assert "관계별_10년_증여공제_한도" in rule_names


def test_get_active_rule_raises_without_allow_pending_review():
    rules = load_all_rules()
    with pytest.raises(RuleRequiresReviewError):
        get_active_rule(rules, "gift", "증여세_상속세_누진세율_구간", date(2026, 1, 1))


def test_get_active_rule_succeeds_with_allow_pending_review():
    rules = load_all_rules()
    rule = get_active_rule(rules, "gift", "증여세_상속세_누진세율_구간", date(2026, 1, 1), allow_pending_review=True)
    assert rule.parameters["bracket_1_rate"] == 0.10


def test_get_active_rule_not_found_before_effective_date():
    rules = load_all_rules()
    with pytest.raises(RuleNotFoundError):
        get_active_rule(rules, "gift", "관계별_10년_증여공제_한도", date(1999, 1, 1), allow_pending_review=True)
