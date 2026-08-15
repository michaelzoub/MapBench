import type { CallGraph, CallGraphEntry } from "../types.js";
import type { ParsedFile, SourceEdit } from "./types.js";
import { applyEdits } from "./utils.js";

function relationships(entry: CallGraphEntry | undefined): string {
  if (!entry) return "";
  return [
    entry.calls.length ? `Calls: ${(entry.callsInSourceOrder ?? entry.calls).join(", ")}` : "",
    entry.instantiates?.length ? `Instantiates: ${entry.instantiates.join(", ")}` : "",
    entry.unresolvedProjectCalls?.length ? `Unresolved project: ${entry.unresolvedProjectCalls.join(", ")}` : "",
    entry.externalCalls?.length ? `External: ${entry.externalCalls.join(", ")}` : "",
  ].filter(Boolean).join("; ");
}

function bodyReplacement(file: ParsedFile, start: number, message: string): string {
  if (file.language === "python") {
    const prefix = Buffer.from(file.source, "utf8").subarray(0, start).toString("utf8");
    const line = prefix.slice(prefix.lastIndexOf("\n") + 1);
    const indent = line.match(/^\s*/)?.[0] ?? "    ";
    return message ? `\"\"\"${message.replace(/\"\"\"/g, "") }\"\"\"\n${indent}pass` : "pass";
  }
  if (file.language === "typescript" || file.language === "javascript") {
    return message ? `{ ${JSON.stringify(message)}; }` : "{ }";
  }
  const annotation = message ? `/* ${message.replace(/\*\//g, "")} */ ` : "";
  return file.language === "go"
    ? `{ ${annotation}panic(\"project-outline skeleton\") }`
    : `{ ${annotation}unimplemented!() }`;
}

export function createSkeleton(file: ParsedFile, graph: CallGraph): string {
  const edits: SourceEdit[] = [
    ...file.skeletonEdits,
    ...file.removeTopLevel.map((item) => ({ ...item, replacement: "" })),
  ];
  for (const symbol of file.symbols) {
    if (!symbol.body) continue;
    edits.push({
      ...symbol.body,
      replacement: bodyReplacement(file, symbol.body.start, relationships(graph[symbol.id])),
    });
  }
  const body = applyEdits(file.source, edits).trim();
  const header = file.language === "python"
    ? "# @project-outline generated"
    : file.language === "typescript" || file.language === "javascript"
      ? "// @ts-nocheck"
      : "// @project-outline generated";
  return `${header}\n\n${body}\n`;
}
