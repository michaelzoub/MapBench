#!/usr/bin/env python3
"""Grade a structured architecture answer against repository-derived facts."""
from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Any


def normalize(value: Any) -> Any:
    if isinstance(value, str):
        # Agents commonly spell Python symbols as either ``module:symbol``
        # (entry-point notation) or ``module.symbol`` (qualified-name
        # notation). They identify the same symbol for these comprehension
        # tasks, so punctuation alone must not erase an otherwise correct
        # behavioral answer.
        return (
            value.strip()
            .strip("`")
            .replace("()", "")
            .replace("\\", "/")
            .replace(":", ".")
            .casefold()
        )
    if isinstance(value, list):
        return [normalize(item) for item in value]
    if isinstance(value, dict):
        return {str(key): normalize(item) for key, item in value.items()}
    return value


def at_path(payload: Any, dotted: str) -> Any:
    current = payload
    for part in dotted.split(".") if dotted else []:
        if not isinstance(current, dict) or part not in current:
            return None
        current = current[part]
    return current


def parse_answer(path: Path) -> Any:
    text = path.read_text(encoding="utf-8").strip()
    if text.startswith("```"):
        lines = text.splitlines()
        if lines and lines[-1].strip() == "```":
            text = "\n".join(lines[1:-1])
    return json.loads(text)


def symbol_matches(actual: Any, expected: Any) -> bool:
    """Match exact, fully-qualified, or unambiguous bare-symbol spellings."""
    if not isinstance(actual, str) or not isinstance(expected, str):
        return actual == expected
    if actual == expected or actual.endswith("." + expected):
        return True
    if "." not in actual and expected.endswith("." + actual):
        return True
    return re.search(r"(?:^|[^a-z0-9_])" + re.escape(expected) + r"(?:$|[^a-z0-9_])", actual) is not None


def component_symbol_matches(actual: Any, expected: Any) -> bool:
    if symbol_matches(actual, expected):
        return True
    if not isinstance(actual, str) or not isinstance(expected, str):
        return False
    return actual.startswith(expected + ".") or expected.startswith(actual + ".")


def check_one(payload: Any, check: dict[str, Any]) -> bool:
    actual = normalize(at_path(payload, str(check.get("path", ""))))
    kind = check["kind"]
    if kind == "equals":
        return actual == normalize(check["expected"])
    if kind == "entrypoint_equals":
        expected = normalize(check["expected"])
        return (
            isinstance(actual, dict)
            and isinstance(expected, dict)
            and actual.get("metadata_path") == expected.get("metadata_path")
            and str(actual.get("command") or "").split(maxsplit=1)[0] == expected.get("command")
            and actual.get("target") == expected.get("target")
        )
    if kind == "object_contains":
        expected = normalize(check["expected"])
        return isinstance(actual, dict) and all(actual.get(key) == value for key, value in expected.items())
    if kind == "string_contains":
        return isinstance(actual, str) and all(normalize(item) in actual for item in check["expected"])
    if kind == "list_contains":
        return isinstance(actual, list) and all(
            any(symbol_matches(candidate, normalize(item)) for candidate in actual)
            for item in check["expected"]
        )
    if kind == "object_list_contains":
        if not isinstance(actual, list):
            return False
        objects = [item for item in actual if isinstance(item, dict)]
        return all(
            any(all(candidate.get(key) == normalize(value) for key, value in expected.items()) for candidate in objects)
            for expected in check["expected"]
        )
    if kind == "object_list_component_contains":
        if not isinstance(actual, list):
            return False
        objects = [item for item in actual if isinstance(item, dict)]
        return all(
            any(
                all(
                    component_symbol_matches(candidate.get(key), normalize(value))
                    if key == "symbol" else candidate.get(key) == normalize(value)
                    for key, value in expected.items()
                )
                for candidate in objects
            )
            for expected in check["expected"]
        )
    if kind == "ordered_contains":
        if not isinstance(actual, list):
            return False
        index = 0
        for expected in [normalize(item) for item in check["expected"]]:
            while index < len(actual) and not symbol_matches(actual[index], expected):
                index += 1
            if index == len(actual):
                return False
            index += 1
        return True
    if kind == "none_contains":
        values: list[str] = []

        def collect(value: Any) -> None:
            if isinstance(value, str):
                values.append(value)
            elif isinstance(value, list):
                for item in value:
                    collect(item)
            elif isinstance(value, dict):
                for item in value.values():
                    collect(item)

        collect(actual)
        return not any(normalize(item) in value for item in check["expected"] for value in values)
    raise ValueError(f"Unknown rubric check kind: {kind}")


def main() -> int:
    rubric_path = Path(sys.argv[1]).resolve()
    answer_path = Path(sys.argv[2]).resolve()
    workspace = Path(sys.argv[3]).resolve()
    rubric = json.loads(rubric_path.read_text(encoding="utf-8"))
    try:
        payload = parse_answer(answer_path)
        parse_error = None
    except Exception as exc:
        payload = None
        parse_error = f"{type(exc).__name__}: {exc}"

    results = []
    if payload is not None:
        for check in rubric["checks"]:
            passed = check_one(payload, check)
            results.append({"name": check["name"], "weight": check["weight"], "passed": passed})
    clean = subprocess.run(
        ["git", "status", "--porcelain"], cwd=workspace, check=False, capture_output=True, text=True,
    ).stdout.strip() == ""
    if rubric.get("requiresCleanWorkspace", True):
        results.append({"name": "workspace_unchanged", "weight": 0.0, "passed": clean})

    score = round(sum(item["weight"] for item in results if item["passed"]), 6)
    max_score = round(sum(float(item["weight"]) for item in rubric["checks"]), 6)
    passed = parse_error is None and clean and score == max_score
    output = {
        "score": score,
        "maxScore": max_score,
        "passed": passed,
        "parseError": parse_error,
        "checks": results,
    }
    print(json.dumps(output, sort_keys=True))
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
