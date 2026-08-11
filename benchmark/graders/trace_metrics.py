from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any


SOURCE_SUFFIXES = (".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py")
PATH_PATTERN = re.compile(r"(?:\.?\.?/)?[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)+\.(?:ts|tsx|js|jsx|mjs|cjs|py)")


def normalize(value: Any) -> str:
    return str(value or "").strip().strip("`").replace("()", "").replace("\\", "/").replace(":", ".").casefold()


def symbol_matches(actual: Any, expected: Any) -> bool:
    left, right = normalize(actual), normalize(expected)
    return bool(left and right and (left == right or left.endswith("." + right) or right.endswith("." + left)))


def parse_answer(path: Path) -> Any:
    text = path.read_text(encoding="utf-8").strip()
    if text.startswith("```"):
        lines = text.splitlines()
        if lines and lines[-1].strip() == "```":
            text = "\n".join(lines[1:-1])
    return json.loads(text)


def event_commands(path: Path) -> list[dict[str, Any]]:
    commands = []
    if not path.exists():
        return commands
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        payload = event.get("item") if isinstance(event.get("item"), dict) else event
        kind = str(payload.get("type") or event.get("type") or "")
        if "command" not in kind:
            continue
        command = payload.get("command") or payload.get("cmd") or ""
        if isinstance(command, list):
            command = " ".join(map(str, command))
        output = payload.get("aggregated_output") or payload.get("output") or ""
        commands.append({"command": str(command), "output": str(output)})
    return commands


def _source_paths(command: str) -> list[str]:
    return sorted({match.group(0).lstrip("./") for match in PATH_PATTERN.finditer(command)
                   if not match.group(0).lstrip("./").startswith(".project-outline/")})


def _line_count(workspace: Path, relative: str) -> int:
    try:
        return len((workspace / relative).read_text(encoding="utf-8").splitlines())
    except (OSError, UnicodeError):
        return 0


def trace_metrics(events: Path, workspace: Path, relevant_file: str = "", relevant_line: int = 0,
                  relevant_symbols: list[str] | None = None) -> dict[str, Any]:
    symbols = [normalize(item) for item in (relevant_symbols or [])]
    relevant_file = relevant_file.replace("\\", "/")
    total_lines = 0
    before = 0
    reached = False
    opened: set[str] = set()

    for item in event_commands(events):
        command, output = item["command"], item["output"]
        paths = _source_paths(command)
        output_paths = _source_paths(output)
        opened.update(path for path in paths if path.endswith(SOURCE_SUFFIXES))
        opened.update(path for path in output_paths if path.endswith(SOURCE_SUFFIXES))
        command_lines = 0
        target_offset = None
        sed = re.search(r"\bsed\s+-n\s+['\"]?(\d+)(?:,(\d+))?p['\"]?\s+([^\s;&|]+)", command)
        if sed:
            start, end = int(sed.group(1)), int(sed.group(2) or sed.group(1))
            relative = sed.group(3).strip("'\"`").lstrip("./")
            actual_end = min(end, _line_count(workspace, relative))
            command_lines = max(0, actual_end - start + 1)
            if relative == relevant_file and start <= relevant_line <= end:
                target_offset = max(0, relevant_line - start)
        elif re.search(r"\bcat\b", command) and paths:
            command_lines = sum(_line_count(workspace, relative) for relative in paths)
            if relevant_file in paths and relevant_line:
                preceding = sum(_line_count(workspace, relative) for relative in paths[:paths.index(relevant_file)])
                target_offset = preceding + max(0, relevant_line - 1)
        elif paths or (re.search(r"\b(?:rg|grep|find)\b", command) and ".project-outline" not in command):
            command_lines = len([line for line in output.splitlines() if line.strip()])

        output_normalized = normalize(output)
        line_hit = bool(re.search(re.escape(relevant_file) + rf"[:\-]{relevant_line}(?:[:\-]|\b)", output)) if relevant_file and relevant_line else False
        found = target_offset is not None or line_hit or (
            (not relevant_file or relevant_file in paths or relevant_file.casefold() in output.casefold())
            and any(symbol in output_normalized for symbol in symbols)
        )
        if not reached:
            before += target_offset if target_offset is not None else (0 if found else command_lines)
        total_lines += command_lines
        reached = reached or found

    return {
        "sourceLinesRetrieved": total_lines,
        "linesRetrievedBeforeRelevantSymbol": before if reached else total_lines,
        "relevantSymbolReached": reached,
        "sourceBodiesOpened": len(opened),
    }
