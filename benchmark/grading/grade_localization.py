#!/usr/bin/env python3
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

from trace_metrics import normalize, parse_answer, symbol_matches, trace_metrics


def main() -> int:
    rubric = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    answer_path, workspace, events = Path(sys.argv[2]), Path(sys.argv[3]), Path(sys.argv[4])
    parse_error = None
    try:
        payload = parse_answer(answer_path)
        ranked = payload.get("rankedSymbols", []) if isinstance(payload, dict) else []
        valid_shape = isinstance(ranked, list) and all(
            isinstance(item, dict) and isinstance(item.get("symbol"), str)
            and isinstance(item.get("reason"), str) and isinstance(item.get("relevance"), (int, float))
            and 0 <= item["relevance"] <= 1 for item in ranked
        )
    except Exception as exc:
        payload, ranked, valid_shape = None, [], False
        parse_error = f"{type(exc).__name__}: {exc}"

    gold = rubric["goldSymbols"]
    symbol_files = {normalize(key): value for key, value in rubric["symbolFiles"].items()}
    relevant_files = set(rubric["relevantFiles"])

    def is_gold(item: dict) -> bool:
        return any(symbol_matches(item.get("symbol"), expected) for expected in gold)

    def candidate_file(item: dict) -> str | None:
        actual = normalize(item.get("symbol"))
        for symbol, file_name in symbol_files.items():
            if symbol_matches(actual, symbol):
                return file_name
        return item.get("file") if isinstance(item.get("file"), str) else None

    first = next((index + 1 for index, item in enumerate(ranked) if isinstance(item, dict) and is_gold(item)), None)
    metrics = {
        "fileRecallAt1": float(any(candidate_file(item) in relevant_files for item in ranked[:1] if isinstance(item, dict))),
        "fileRecallAt3": float(any(candidate_file(item) in relevant_files for item in ranked[:3] if isinstance(item, dict))),
        "fileRecallAt5": float(any(candidate_file(item) in relevant_files for item in ranked[:5] if isinstance(item, dict))),
        "functionRecallAt1": float(first is not None and first <= 1),
        "functionRecallAt5": float(first is not None and first <= 5),
        "functionRecallAt10": float(first is not None and first <= 10),
        "meanReciprocalRank": 1 / first if first else 0.0,
    }
    metrics.update(trace_metrics(events, workspace, rubric["relevantFiles"][0], rubric["relevantLine"], gold))
    clean = subprocess.run(["git", "status", "--porcelain"], cwd=workspace, capture_output=True, text=True).stdout.strip() == ""
    within_budget = metrics["sourceLinesRetrieved"] <= rubric.get("lineBudget", 500)
    checks = [
        {"name": "answer_shape", "passed": valid_shape},
        {"name": "relevant_function_ranked_first", "passed": metrics["functionRecallAt1"] == 1},
        {"name": "source_line_budget", "passed": within_budget},
        {"name": "workspace_unchanged", "passed": clean},
    ]
    accuracy = sum(float(metrics[name]) for name in (
        "fileRecallAt1", "fileRecallAt3", "fileRecallAt5", "functionRecallAt1",
        "functionRecallAt5", "functionRecallAt10", "meanReciprocalRank",
    )) / 7
    passed = parse_error is None and all(item["passed"] for item in checks)
    print(json.dumps({"score": round(accuracy, 6), "maxScore": 1, "passed": passed,
                      "parseError": parse_error, "metrics": metrics, "checks": checks}, sort_keys=True))
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
