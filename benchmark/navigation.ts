import type { CommandRecord, NavigationKind, NavigationMetrics, ReadRange } from "./types.js";

const NAVIGATION_TOOL = /\b(?:read|grep|find|ls|mapbench_query|cat|sed|head|tail|rg|jq|tree|wc|awk|python3?|node)\b/;
const SOURCE_EXTENSION = /\.(?:c|cc|cpp|cs|go|h|hpp|java|js|jsx|mjs|cjs|kt|kts|php|py|rb|rs|scala|sol|swift|ts|tsx|vue|svelte)\b/i;
const PATH_PATTERN = /(?:\.?\.?\/)?[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+\.(?:c|cc|cpp|cs|go|h|hpp|java|js|jsx|mjs|cjs|kt|kts|php|py|rb|rs|scala|sol|swift|ts|tsx|vue|svelte|json|md|cfg|toml)/g;

function cleanPath(value: string): string {
  return value.replace(/^["'`]+|["'`,;:)]+$/g, "").replace(/^\.\//, "");
}

export function accessedPaths(command: string): string[] {
  return [...new Set((command.match(PATH_PATTERN) ?? []).map(cleanPath))].sort();
}

export function navigationKind(command: string): NavigationKind {
  if (!NAVIGATION_TOOL.test(command)) return "other";
  const paths = accessedPaths(command);
  const mentionsOutline = paths.some((item) => item === ".mapbench" || item.startsWith(".mapbench/")) ||
    /\.mapbench(?:\/|\b)|\bmapbench_query\b/.test(command);
  const withoutOutline = command.replace(/\.mapbench\/[A-Za-z0-9_.*?{}\/[\].-]+/g, "");
  const mentionsSource = paths.some((item) => !item.startsWith(".mapbench/") && SOURCE_EXTENSION.test(item)) ||
    SOURCE_EXTENSION.test(withoutOutline);
  if (mentionsOutline && mentionsSource) return "mixed";
  if (mentionsOutline) return "outline";
  if (mentionsSource) return "source";
  return "other";
}

export function readRanges(command: string): ReadRange[] {
  const ranges: ReadRange[] = [];
  const toolMatch = command.match(/^read\s+(\{.*\})$/s);
  if (toolMatch) {
    try {
      const args = JSON.parse(toolMatch[1]) as { path?: unknown; offset?: unknown; limit?: unknown };
      if (typeof args.path === "string") {
        const start = typeof args.offset === "number" ? args.offset : 1;
        const end = typeof args.limit === "number" ? start + args.limit - 1 : start;
        ranges.push({ file: cleanPath(args.path), start, end, outline: args.path.startsWith(".mapbench/") });
      }
    } catch { /* malformed tool telemetry is ignored */ }
  }
  const pattern = /\bsed\s+-n\s+["']?(\d+)(?:,(\d+))?p["']?\s+([^\s;&|]+)/g;
  for (const match of command.matchAll(pattern)) {
    const start = Number(match[1]);
    const end = Number(match[2] ?? match[1]);
    const file = cleanPath(match[3]);
    if (!file || !Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
    ranges.push({ file, start, end, outline: file.startsWith(".mapbench/") });
  }
  return ranges;
}

export function analyzeNavigation(commands: CommandRecord[]): NavigationMetrics {
  let commandOutputBytes = 0;
  let runningOutputBytes = 0;
  let cumulativeOutputBytes = 0;
  let duplicateSourceReadCount = 0;
  let duplicateSourceReadLines = 0;
  const previous = new Map<string, Array<{ start: number; end: number }>>();
  const outlineFiles = new Set<string>();
  const sourceFiles = new Set<string>();

  for (const command of commands) {
    commandOutputBytes += command.outputBytes;
    runningOutputBytes += command.outputBytes;
    cumulativeOutputBytes += runningOutputBytes;
    for (const file of command.accessedPaths) {
      if (file.startsWith(".mapbench/")) outlineFiles.add(file);
      else if (SOURCE_EXTENSION.test(file)) sourceFiles.add(file);
    }
    for (const range of command.readRanges.filter((item) => !item.outline)) {
      const overlaps = (previous.get(range.file) ?? []).flatMap((seen) => {
        const start = Math.max(range.start, seen.start);
        const end = Math.min(range.end, seen.end);
        return end >= start ? [end - start + 1] : [];
      });
      if (overlaps.length) {
        duplicateSourceReadCount += 1;
        duplicateSourceReadLines += Math.max(...overlaps);
      }
      previous.set(range.file, [...(previous.get(range.file) ?? []), { start: range.start, end: range.end }]);
    }
  }
  const outlineCommands = commands.filter((item) => item.navigation === "outline" || item.navigation === "mixed");
  const sourceCommands = commands.filter((item) => item.navigation === "source" || item.navigation === "mixed");
  return {
    outlineAccessCommandCount: outlineCommands.length,
    successfulOutlineAccessCommandCount: outlineCommands.filter((item) => !item.failed).length,
    sourceAccessCommandCount: sourceCommands.length,
    mixedAccessCommandCount: commands.filter((item) => item.navigation === "mixed").length,
    failedNavigationCommandCount: commands.filter((item) => item.navigation !== "other" && item.failed).length,
    outlineOutputBytes: commands.filter((item) => item.navigation === "outline").reduce((sum, item) => sum + item.outputBytes, 0),
    sourceOutputBytes: commands.filter((item) => item.navigation === "source").reduce((sum, item) => sum + item.outputBytes, 0),
    mixedOutputBytes: commands.filter((item) => item.navigation === "mixed").reduce((sum, item) => sum + item.outputBytes, 0),
    commandOutputBytes,
    cumulativeOutputBytes,
    duplicateSourceReadCount,
    duplicateSourceReadLines,
    uniqueOutlineFiles: outlineFiles.size,
    uniqueSourceFiles: sourceFiles.size,
    outlineUsed: outlineCommands.some((item) => !item.failed),
  };
}

export function emptyNavigationMetrics(): NavigationMetrics {
  return analyzeNavigation([]);
}
