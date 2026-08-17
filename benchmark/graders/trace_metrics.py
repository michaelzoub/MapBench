from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any


SOURCE_SUFFIXES = (".c", ".cc", ".cpp", ".cs", ".go", ".h", ".hpp", ".java", ".js", ".jsx", ".mjs", ".cjs", ".kt", ".kts", ".php", ".py", ".rb", ".rs", ".scala", ".sol", ".swift", ".ts", ".tsx", ".vue", ".svelte")
PATH_PATTERN = re.compile(r"(?:\.?\.?/)?[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)+\.(?:c|cc|cpp|cs|go|h|hpp|java|js|jsx|mjs|cjs|kt|kts|php|py|rb|rs|scala|sol|swift|ts|tsx|vue|svelte)")


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
    active_tools: dict[str, dict[str, Any]] = {}
    if not path.exists():
        return commands
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        event_type = str(event.get("type") or "")
        if event_type == "tool_execution_start":
            active_tools[str(event.get("toolCallId") or "")] = {
                "name": str(event.get("toolName") or "unknown"),
                "args": event.get("args") if isinstance(event.get("args"), dict) else {},
            }
            continue
        if event_type == "tool_execution_end":
            started = active_tools.pop(str(event.get("toolCallId") or ""), {})
            name = str(event.get("toolName") or started.get("name") or "unknown")
            args = started.get("args") or {}
            result = event.get("result")
            texts: list[str] = []
            if isinstance(result, dict) and isinstance(result.get("content"), list):
                texts = [str(item.get("text") or "") for item in result["content"] if isinstance(item, dict) and item.get("type") == "text"]
            commands.append({"command": f"{name} {json.dumps(args, sort_keys=True)}", "output": "\n".join(texts)})
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
                   if not match.group(0).lstrip("./").startswith((".cartograph/", ".mapbench/"))})


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
        read = re.match(r"^read\s+(\{.*\})$", command)
        if read:
            try:
                args = json.loads(read.group(1))
            except json.JSONDecodeError:
                args = {}
            relative = str(args.get("path") or "").lstrip("./")
            start = int(args.get("offset") or 1)
            file_lines = _line_count(workspace, relative)
            requested = int(args.get("limit") or max(0, file_lines - start + 1))
            actual_end = min(file_lines, start + requested - 1)
            command_lines = max(0, actual_end - start + 1)
            if relative == relevant_file and start <= relevant_line <= actual_end:
                target_offset = max(0, relevant_line - start)
        else:
            sed = re.search(r"\bsed\s+-n\s+['\"]?(\d+)(?:,(\d+))?p['\"]?\s+([^\s;&|]+)", command)
        if not read and sed:
            start, end = int(sed.group(1)), int(sed.group(2) or sed.group(1))
            relative = sed.group(3).strip("'\"`").lstrip("./")
            actual_end = min(end, _line_count(workspace, relative))
            command_lines = max(0, actual_end - start + 1)
            if relative == relevant_file and start <= relevant_line <= end:
                target_offset = max(0, relevant_line - start)
        elif not read and re.search(r"\bcat\b", command) and paths:
            command_lines = sum(_line_count(workspace, relative) for relative in paths)
            if relevant_file in paths and relevant_line:
                preceding = sum(_line_count(workspace, relative) for relative in paths[:paths.index(relevant_file)])
                target_offset = preceding + max(0, relevant_line - 1)
        elif not read and (paths or (re.search(r"\b(?:rg|grep|find)\b", command) and ".cartograph" not in command and ".mapbench" not in command)):
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
