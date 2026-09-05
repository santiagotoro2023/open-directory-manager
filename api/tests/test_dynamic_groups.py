"""Groups whose membership is a query rather than a list."""

from __future__ import annotations

import pytest

from odm import dynamicgroups as dg


def test_a_query_is_built_from_named_conditions_rather_than_typed():
    """A filter typed by hand is one nobody reviews, and one that is subtly
    wrong quietly empties a group a sudo rule depends on."""
    conditions = dg.validate(
        [
            {"attribute": "department", "operator": "is", "value": "Finance"},
            {"attribute": "title", "operator": "starts with", "value": "Senior"},
        ]
    )
    built = dg.build_filter("user", conditions, match_all=True)
    assert built == (
        "(&(&(objectCategory=person)(objectClass=user))"
        "(&(department=Finance)(title=Senior*)))"
    )
    any_of = dg.build_filter("user", conditions, match_all=False)
    assert "(|" in any_of


def test_every_comparison_produces_the_filter_it_says_it_does():
    for operator, expected in (
        ("is", "(department=Finance)"),
        ("is not", "(!(department=Finance))"),
        ("starts with", "(department=Finance*)"),
        ("contains", "(department=*Finance*)"),
    ):
        built = dg.build_filter(
            "user", [{"attribute": "department", "operator": operator, "value": "Finance"}], True
        )
        assert expected in built
    for operator, expected in (("is set", "(title=*)"), ("is not set", "(!(title=*))")):
        built = dg.build_filter(
            "user", [{"attribute": "title", "operator": operator, "value": ""}], True
        )
        assert expected in built


def test_a_value_cannot_become_a_filter_of_its_own():
    """This reaches the directory as a search. A parenthesis in a value would
    otherwise be a filter of the caller's choosing."""
    conditions = dg.validate(
        [{"attribute": "department", "operator": "is", "value": "Finance)(objectClass=*"}]
    )
    built = dg.build_filter("user", conditions, True)
    assert "Finance)(objectClass=*" not in built
    assert r"\29\28" in built


def test_an_attribute_nobody_organises_by_is_refused():
    for bad in (
        [{"attribute": "unicodePwd", "operator": "is", "value": "x"}],
        [{"attribute": "department", "operator": "sounds like", "value": "x"}],
        [{"attribute": "department", "operator": "is", "value": ""}],
        [],
    ):
        with pytest.raises(dg.QueryError):
            dg.validate(bad)


def test_only_users_and_computers_can_be_matched():
    with pytest.raises(dg.QueryError):
        dg.build_filter("group", [{"attribute": "title", "operator": "is set", "value": ""}], True)


def test_membership_is_compared_without_regard_to_how_a_name_is_cased():
    """A distinguished name read back from the directory is not always cased
    the way it was written; comparing them literally makes every run add and
    remove the same people for ever."""
    current = ["CN=Ada,OU=Staff,DC=corp", "CN=Bob,OU=Staff,DC=corp"]
    wanted = ["cn=ada,ou=staff,dc=corp", "CN=Cai,OU=Staff,DC=corp"]
    add, remove = dg.membership_change(current, wanted)
    assert add == ["CN=Cai,OU=Staff,DC=corp"]
    assert remove == ["CN=Bob,OU=Staff,DC=corp"]

    # And a settled group changes nothing on the next run.
    assert dg.membership_change(wanted, wanted) == ([], [])


def test_a_query_reads_as_a_sentence():
    summary = dg.describe(
        [
            {"attribute": "department", "operator": "is", "value": "Finance"},
            {"attribute": "title", "operator": "is set", "value": ""},
        ],
        match_all=True,
    )
    assert summary == "Department is Finance and Title is set"
