#!/usr/bin/env bun
import { promises as fs } from "node:fs";
import path from "node:path";
import { generateReport } from "./report.js";
import { buildSummary } from "./summary.js";
import type { BenchmarkSummary } from "./types.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write("Usage: bun run benchmark:report --results <directory>\n");
    return;
  }
  const index = args.findIndex((arg) => arg === "--results" || arg.startsWith("--results="));
  if (index < 0) throw new Error("--results is required.");
  const input = args[index].includes("=") ? args[index].split("=", 2)[1] : args[index + 1];
  if (!input) throw new Error("Missing value for --results.");
  const root = path.resolve(input);
  const summary = JSON.parse(await fs.readFile(path.join(root, "summary.json"), "utf8")) as BenchmarkSummary;
  if (summary.schemaVersion !== 2 || !Array.isArray(summary.runs)) throw new Error("Unsupported summary.json schema.");
  const normalized = buildSummary(summary.runs, summary.generatedAt);
  await generateReport(root, normalized);
  process.stdout.write(`Report regenerated: ${root}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`benchmark:report: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
