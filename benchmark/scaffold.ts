import { promises as fs } from "node:fs";
import path from "node:path";

const PROMPT = `Replace this paragraph with a repository-level question or implementation task whose answer is not obvious from a single file.

Inspect the repository and return JSON with this exact shape:

{
  "files": [{ "path": "relative/path", "reason": "why it matters" }],
  "symbols": [{ "name": "Qualified.symbol", "path": "relative/path", "reason": "why it matters" }]
}
`;

export interface ExpectedLocalizationAnswer {
  requiredFiles: string[];
  requiredSymbols: Array<{ name: string; path: string }>;
}

const EXPECTED: ExpectedLocalizationAnswer = {
  requiredFiles: ["replace/with/a/real/file.ts"],
  requiredSymbols: [{ name: "Replace.withRealSymbol", path: "replace/with/a/real/file.ts" }],
};

const GRADER = `import { readFile } from "node:fs/promises";
import path from "node:path";

const [answerFile, workspace] = process.argv.slice(2);

function result(payload, exitCode) {
  process.stdout.write(JSON.stringify(payload) + "\\n");
  process.exitCode = exitCode;
}

function parseAnswer(text) {
  const trimmed = text.trim();
  const fence = String.fromCharCode(96).repeat(3);
  const body = trimmed.startsWith(fence) && trimmed.endsWith(fence)
    ? trimmed.slice(fence.length, -fence.length).replace(/^json\\s*/i, "").trim()
    : trimmed;
  return JSON.parse(body);
}

function normalizeFile(value) {
  return String(value).replaceAll("\\\\", "/").replace(/^\\.\\//, "");
}

try {
  const expected = JSON.parse(await readFile(new URL("./expected.json", import.meta.url), "utf8"));
  const requiredFiles = Array.isArray(expected.requiredFiles) ? expected.requiredFiles : [];
  const requiredSymbols = Array.isArray(expected.requiredSymbols) ? expected.requiredSymbols : [];
  const maxScore = requiredFiles.length + requiredSymbols.length;
  if (maxScore === 0 || requiredFiles.some((file) => String(file).startsWith("replace/")) ||
      requiredSymbols.some((symbol) => String(symbol?.name ?? "").startsWith("Replace."))) {
    result({ score: 0, maxScore: Math.max(1, maxScore), passed: false,
      configurationError: "Edit grader/expected.json before running this eval." }, 1);
  } else {
    const invalidExpectedFiles = [];
    for (const file of requiredFiles) {
      try { await readFile(path.join(workspace, normalizeFile(file))); }
      catch { invalidExpectedFiles.push(file); }
    }
    for (const symbol of requiredSymbols) {
      try { await readFile(path.join(workspace, normalizeFile(symbol.path))); }
      catch { invalidExpectedFiles.push(symbol.path); }
    }
    if (invalidExpectedFiles.length) {
      result({ score: 0, maxScore, passed: false, configurationError: "Expected paths do not exist in the target commit.", invalidExpectedFiles }, 1);
    } else {
      const answer = parseAnswer(await readFile(answerFile, "utf8"));
      const files = new Set((Array.isArray(answer.files) ? answer.files : []).map((item) =>
        normalizeFile(typeof item === "string" ? item : item?.path ?? "")));
      const symbols = Array.isArray(answer.symbols) ? answer.symbols : [];
      const missingFiles = requiredFiles.filter((file) => !files.has(normalizeFile(file)));
      const missingSymbols = requiredSymbols.filter((required) => !symbols.some((item) => {
        const name = typeof item === "string" ? item : item?.name;
        const itemPath = typeof item === "string" ? "" : normalizeFile(item?.path ?? "");
        return name === required.name && (!required.path || itemPath === normalizeFile(required.path));
      }));
      const score = maxScore - missingFiles.length - missingSymbols.length;
      const passed = score === maxScore;
      result({ score, maxScore, passed, metrics: { fileRecall: requiredFiles.length ? (requiredFiles.length - missingFiles.length) / requiredFiles.length : 1,
        symbolRecall: requiredSymbols.length ? (requiredSymbols.length - missingSymbols.length) / requiredSymbols.length : 1 },
        missingFiles, missingSymbols }, passed ? 0 : 1);
    }
  }
} catch (error) {
  result({ score: 0, maxScore: 1, passed: false, error: error instanceof Error ? error.message : String(error) }, 1);
}
`;

export interface ScaffoldOptions {
  tasksRoot: string;
  id: string;
  title?: string;
  prompt?: string;
  expected?: ExpectedLocalizationAnswer;
}

export async function scaffoldEvalTask(options: ScaffoldOptions): Promise<string> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(options.id)) {
    throw new Error("Eval task id must contain only lowercase letters, digits, and hyphens.");
  }
  const directory = path.resolve(options.tasksRoot, options.id);
  await fs.mkdir(path.dirname(directory), { recursive: true });
  try {
    await fs.mkdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`Eval task already exists: ${directory}`);
    }
    throw error;
  }
  const graderDirectory = path.join(directory, "grader");
  await fs.mkdir(graderDirectory);
  const title = options.title?.trim() || options.id.split("-").map((part) => part[0].toUpperCase() + part.slice(1)).join(" ");
  await Promise.all([
    fs.writeFile(path.join(directory, "prompt.md"), options.prompt?.trim() ? `${options.prompt.trim()}\n` : PROMPT, "utf8"),
    fs.writeFile(path.join(directory, "task.json"), `${JSON.stringify({
      version: 1,
      id: options.id,
      title,
      promptFile: "prompt.md",
      grader: { command: ["node", "{grader}/grade.mjs", "{answer}", "{workspace}"], timeoutMs: 30_000 },
    }, null, 2)}\n`, "utf8"),
    fs.writeFile(path.join(graderDirectory, "expected.json"), `${JSON.stringify(options.expected ?? EXPECTED, null, 2)}\n`, "utf8"),
    fs.writeFile(path.join(graderDirectory, "grade.mjs"), GRADER, "utf8"),
  ]);
  return directory;
}
