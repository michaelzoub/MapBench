import { readFile } from "node:fs/promises";
import path from "node:path";

const [answerFile, workspace] = process.argv.slice(2);

function result(payload, exitCode) {
  process.stdout.write(JSON.stringify(payload) + "\n");
  process.exitCode = exitCode;
}

function parseAnswer(text) {
  const trimmed = text.trim();
  const fence = String.fromCharCode(96).repeat(3);
  const body = trimmed.startsWith(fence) && trimmed.endsWith(fence)
    ? trimmed.slice(fence.length, -fence.length).replace(/^json\s*/i, "").trim()
    : trimmed;
  return JSON.parse(body);
}

function normalizeFile(value) {
  return String(value).replaceAll("\\", "/").replace(/^\.\//, "");
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
