#!/usr/bin/env node
import { cleanOutline, generateOutline, initOutline, navigateOutline, queryOutline, watchOutline } from "./index.js";
import type {
  CallGraphDirection,
  CallGraphNavigationRequest,
  OutlineOptions,
  QueryOptions,
} from "./types.js";

const HELP = `project-outline

Usage:
  project-outline generate [--root <directory>] [--out <directory>] [--language <typescript|javascript|python|go|rust>]
  project-outline watch [--root <directory>] [--out <directory>] [--language <typescript|javascript|python|go|rust>]
  project-outline clean [--root <directory>] [--out <directory>]
  project-outline init [--root <directory>] [--out <directory>]
  project-outline query find <terms> [--limit <1-100>] [--root <directory>] [--out <directory>]
  project-outline query inspect <symbol> [--limit <1-100>] [--root <directory>] [--out <directory>]
  project-outline query explore <symbol> [--direction <callers|callees|both>] [--depth <0-5>] [--limit <1-100>] [--root <directory>] [--out <directory>]
  project-outline query trace <from> <to> [--direction <callers|callees|both>] [--max-depth <0-50>] [--root <directory>] [--out <directory>]
  project-outline query <symbol> [--depth <0-3>] [--limit <1-100>] [--root <directory>] [--out <directory>]  # compatibility
  project-outline benchmark [ask|init] [options]
  project-outline --help
`;

function parseOptions(args: string[]): OutlineOptions {
  const options: OutlineOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const [flag, inlineValue] = argument.split("=", 2);
    if (flag !== "--root" && flag !== "--out" && flag !== "--language") throw new Error(`Unknown option: ${argument}`);
    const value = inlineValue ?? args[++index];
    if (!value) throw new Error(`Missing value for ${flag}`);
    if (flag === "--root") options.root = value;
    else if (flag === "--out") options.out = value;
    else if (["typescript", "javascript", "python", "go", "rust"].includes(value)) options.language = value as OutlineOptions["language"];
    else throw new Error(`Unsupported language: ${value}. Expected typescript, javascript, python, go, or rust.`);
  }
  return options;
}

function parseQueryOptions(args: string[]): { symbol: string; options: QueryOptions } {
  const symbol = args[0];
  if (!symbol || symbol.startsWith("--")) throw new Error("query requires a symbol name.");
  const options: QueryOptions = {};
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    const [flag, inlineValue] = argument.split("=", 2);
    if (!["--root", "--out", "--depth", "--limit"].includes(flag)) throw new Error(`Unknown option: ${argument}`);
    const value = inlineValue ?? args[++index];
    if (!value) throw new Error(`Missing value for ${flag}`);
    if (flag === "--root") options.root = value;
    else if (flag === "--out") options.out = value;
    else if (flag === "--depth") options.depth = Number(value);
    else options.limit = Number(value);
  }
  return { symbol, options };
}

function parseNavigationOptions(
  operation: CallGraphNavigationRequest["operation"],
  args: string[],
): { request: CallGraphNavigationRequest; options: Pick<QueryOptions, "root" | "out"> } {
  const positionals: string[] = [];
  const values: Record<string, string> = {};
  const allowedByOperation: Record<CallGraphNavigationRequest["operation"], string[]> = {
    find: ["--root", "--out", "--limit"],
    inspect: ["--root", "--out", "--limit"],
    explore: ["--root", "--out", "--direction", "--depth", "--limit"],
    trace: ["--root", "--out", "--direction", "--max-depth"],
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }
    const [flag, inlineValue] = argument.split("=", 2);
    if (!allowedByOperation[operation].includes(flag)) throw new Error(`Unknown option for query ${operation}: ${argument}`);
    const value = inlineValue ?? args[++index];
    if (!value) throw new Error(`Missing value for ${flag}`);
    values[flag] = value;
  }
  const expected = operation === "trace" ? 2 : 1;
  if (positionals.length !== expected) {
    throw new Error(`query ${operation} requires ${expected === 1 ? "one search or symbol argument" : "from and to symbol arguments"}.`);
  }
  const options = { root: values["--root"], out: values["--out"] };
  const direction = values["--direction"] as CallGraphDirection | undefined;
  if (operation === "find") {
    return { request: { operation, query: positionals[0], limit: values["--limit"] === undefined ? undefined : Number(values["--limit"]) }, options };
  }
  if (operation === "inspect") {
    return { request: { operation, query: positionals[0], limit: values["--limit"] === undefined ? undefined : Number(values["--limit"]) }, options };
  }
  if (operation === "explore") {
    return { request: {
      operation,
      query: positionals[0],
      direction,
      depth: values["--depth"] === undefined ? undefined : Number(values["--depth"]),
      limit: values["--limit"] === undefined ? undefined : Number(values["--limit"]),
    }, options };
  }
  return { request: {
    operation,
    from: positionals[0],
    to: positionals[1],
    direction,
    maxDepth: values["--max-depth"] === undefined ? undefined : Number(values["--max-depth"]),
  }, options };
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === "--help" || command === "-h") {
    process.stdout.write(HELP);
    return;
  }
  if (!command) {
    process.stdout.write(HELP);
    process.exitCode = 1;
    return;
  }

  if (command === "query") {
    const operation = args[0];
    if (operation === "find" || operation === "inspect" || operation === "explore" || operation === "trace") {
      const { request, options } = parseNavigationOptions(operation, args.slice(1));
      const result = await navigateOutline(request, options);
      process.stdout.write(`${JSON.stringify(result)}\n`);
      if (("matches" in result && !result.matches.length) || ("resolution" in result && result.resolution !== "exact")) {
        process.exitCode = 2;
      }
      return;
    }
    const { symbol, options } = parseQueryOptions(args);
    const result = await queryOutline(symbol, options);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.matches.length) process.exitCode = 2;
    return;
  }

  if (command === "benchmark") {
    const { runBenchmarkCli } = await import("../benchmark/cli.js");
    await runBenchmarkCli(args);
    return;
  }

  const options = parseOptions(args);
  if (command === "generate") {
    const result = await generateOutline(options);
    process.stdout.write(`Generated ${result.filesWritten} outline file${result.filesWritten === 1 ? "" : "s"} in ${result.out}.\n`);
    return;
  }
  if (command === "clean") {
    const out = await cleanOutline(options);
    process.stdout.write(`Removed ${out}.\n`);
    return;
  }
  if (command === "watch") {
    const handle = await watchOutline(options);
    process.stdout.write("Watching for supported source changes.\n");
    const close = (): void => {
      handle.close();
      process.exit(0);
    };
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
    return;
  }
  if (command === "init") {
    const result = await initOutline(options);
    process.stdout.write(result.changed
      ? `${result.created ? "Created" : "Updated"} ${result.agentsFile}.\n`
      : `${result.agentsFile} is already up to date.\n`);
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`project-outline: ${message}\n`);
  process.exitCode = 1;
});
