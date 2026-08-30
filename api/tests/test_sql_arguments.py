"""Every SQL call passes as many arguments as its statement has placeholders.

PostgreSQL only reports this when the statement actually runs, and the
statement that broke was on the agent's inventory path — which no console
click reaches, so it failed silently on every check-in and the machine simply
never appeared to report. PREPARE does not catch it either: the SQL was valid,
it was the call that was wrong.

Static, so it runs everywhere rather than only where a database is available.
"""

from __future__ import annotations

import ast
import pathlib
import re

PLACEHOLDER = re.compile(r"\$(\d+)")
# The asyncpg calls that take a statement followed by its arguments, one per
# placeholder. executemany is deliberately absent: it takes a single sequence
# of rows, so counting its arguments proves nothing.
METHODS = {"execute", "fetch", "fetchrow", "fetchval"}

SOURCES = sorted((pathlib.Path(__file__).resolve().parents[1] / "odm").rglob("*.py"))


def _calls():
    for path in SOURCES:
        tree = ast.parse(path.read_text(), filename=str(path))
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            if not isinstance(node.func, ast.Attribute) or node.func.attr not in METHODS:
                continue
            if not node.args or not isinstance(node.args[0], ast.Constant):
                continue
            sql = node.args[0].value
            if not isinstance(sql, str) or "$1" not in sql:
                continue
            # *args forwarding cannot be counted statically.
            if any(isinstance(argument, ast.Starred) for argument in node.args):
                continue
            yield path.name, node.lineno, sql, len(node.args) - 1


def test_the_extractor_finds_the_statements():
    found = list(_calls())
    assert len(found) > 40, f"only found {len(found)} parameterised calls; extractor broke"


def test_no_call_passes_the_wrong_number_of_arguments():
    wrong = []
    for name, line, sql, passed in _calls():
        highest = max(int(number) for number in PLACEHOLDER.findall(sql))
        if highest != passed:
            wrong.append(f"{name}:{line} uses ${highest} but passes {passed} arguments")
    assert not wrong, "argument counts that do not match:\n" + "\n".join(wrong)
