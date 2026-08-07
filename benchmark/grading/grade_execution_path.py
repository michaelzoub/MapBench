#!/usr/bin/env python3
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

from trace_metrics import normalize, parse_answer, symbol_matches, trace_metrics


def f1(precision: float, recall: float) -> float:
    return 0.0 if precision + recall == 0 else 2 * precision * recall / (precision + recall)


def main() -> int:
    rubric = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    answer_path, workspace, events = Path(sys.argv[2]), Path(sys.argv[3]), Path(sys.argv[4])
    parse_error = None
    try:
        payload = parse_answer(answer_path)
    except Exception as exc:
        payload = {}
        parse_error = f"{type(exc).__name__}: {exc}"

    raw_nodes = payload.get("nodes", []) if isinstance(payload, dict) else []
    nodes = [item.get("symbol") if isinstance(item, dict) else item for item in raw_nodes]
    nodes = [item for item in nodes if isinstance(item, str)]
    gold_nodes = rubric["goldNodes"]
    true_nodes = sum(any(symbol_matches(item, gold) for gold in gold_nodes) for item in nodes)
    node_precision = true_nodes / len(nodes) if nodes else 0.0
    node_recall = sum(any(symbol_matches(item, gold) for item in nodes) for gold in gold_nodes) / len(gold_nodes)

    raw_edges = payload.get("edges", []) if isinstance(payload, dict) else []
    edges = []
    for edge in raw_edges:
        if isinstance(edge, dict) and isinstance(edge.get("from"), str) and isinstance(edge.get("to"), str):
            edges.append((edge["from"], edge["to"]))
        elif isinstance(edge, list) and len(edge) == 2 and all(isinstance(item, str) for item in edge):
            edges.append((edge[0], edge[1]))
    gold_edges = [tuple(item) for item in rubric["goldEdges"]]
    edge_matches = lambda edge, gold: symbol_matches(edge[0], gold[0]) and symbol_matches(edge[1], gold[1])
    true_edges = sum(any(edge_matches(edge, gold) for gold in gold_edges) for edge in edges)
    edge_precision = true_edges / len(edges) if edges else 0.0
    edge_recall = sum(any(edge_matches(edge, gold) for edge in edges) for gold in gold_edges) / len(gold_edges)

    ordered = payload.get("orderedPath", []) if isinstance(payload, dict) else []
    if not isinstance(ordered, list):
        ordered = []
    index = 0
    matched = 0
    for gold in rubric["goldOrdering"]:
        while index < len(ordered) and not symbol_matches(ordered[index], gold):
            index += 1
        if index < len(ordered):
            matched += 1
            index += 1
    ordering = matched / len(rubric["goldOrdering"])

    side_effects = payload.get("sideEffects", []) if isinstance(payload, dict) else []
    if not isinstance(side_effects, list):
        side_effects = []
    side_effect_recall = sum(any(normalize(gold) in normalize(actual) for actual in side_effects)
                             for gold in rubric["goldSideEffects"]) / len(rubric["goldSideEffects"])
    validation = payload.get("validation", {}) if isinstance(payload, dict) else {}
    validation_symbol = validation.get("symbol") if isinstance(validation, dict) else validation
    validation_correct = float(symbol_matches(validation_symbol, rubric["validationSymbol"]))
    endpoint = payload.get("endpoint", {}) if isinstance(payload, dict) else {}
    endpoint_correct = float(isinstance(endpoint, dict)
                             and normalize(endpoint.get("method")) == normalize(rubric["endpoint"]["method"])
                             and endpoint.get("path") == rubric["endpoint"]["path"]
                             and symbol_matches(endpoint.get("registrationSymbol"), rubric["endpoint"]["registrationSymbol"]))

    metrics = {
        "nodePrecision": node_precision, "nodeRecall": node_recall,
        "edgePrecision": edge_precision, "edgeRecall": edge_recall,
        "correctOrdering": ordering, "sideEffectRecall": side_effect_recall,
        "validationCorrect": validation_correct, "endpointCorrect": endpoint_correct,
    }
    metrics.update(trace_metrics(events, workspace))
    clean = subprocess.run(["git", "status", "--porcelain"], cwd=workspace, capture_output=True, text=True).stdout.strip() == ""
    shape = isinstance(payload, dict) and isinstance(raw_nodes, list) and isinstance(raw_edges, list)
    exact = all(metrics[name] == 1 for name in (
        "nodePrecision", "nodeRecall", "edgePrecision", "edgeRecall", "correctOrdering",
        "sideEffectRecall", "validationCorrect", "endpointCorrect",
    ))
    checks = [
        {"name": "answer_shape", "passed": shape},
        {"name": "complete_exact_execution_path", "passed": exact},
        {"name": "workspace_unchanged", "passed": clean},
    ]
    score = sum((f1(node_precision, node_recall), f1(edge_precision, edge_recall), ordering,
                 side_effect_recall, validation_correct, endpoint_correct)) / 6
    passed = parse_error is None and all(item["passed"] for item in checks)
    print(json.dumps({"score": round(score, 6), "maxScore": 1, "passed": passed,
                      "parseError": parse_error, "metrics": metrics, "checks": checks}, sort_keys=True))
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
