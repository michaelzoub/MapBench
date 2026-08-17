import { runProcess } from "./process.js";
import { expandCommand } from "./task-loader.js";
import type { CheckResult, CommandSpec, GraderResult, LoadedTask } from "./types.js";

export function unavailableCheck(): CheckResult {
  return { status: "unavailable", command: null, exitCode: null, durationMs: 0, stdout: "", stderr: "" };
}

export async function runCheck(
  spec: CommandSpec | undefined,
  workspace: string,
  graderDirectory: string,
  answerFile = "",
  eventsFile = "",
  artifactsDirectory = "",
): Promise<CheckResult> {
  if (!spec) return unavailableCheck();
  const command = expandCommand(spec.command, workspace, graderDirectory, answerFile, eventsFile, artifactsDirectory);
  const result = await runProcess(command, { cwd: workspace, timeoutMs: spec.timeoutMs ?? 300_000 });
  return {
    status: result.timedOut ? "timeout" : result.exitCode === 0 ? "passed" : "failed",
    command,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    stdout: result.stdout,
    stderr: result.stderr || result.error || "",
  };
}

export async function runHiddenGrader(
  task: LoadedTask,
  workspace: string,
  answerFile = "",
  eventsFile = "",
  artifactsDirectory = "",
): Promise<GraderResult> {
  const check = await runCheck(task.grader, workspace, task.graderDirectory, answerFile, eventsFile, artifactsDirectory);
  let details: unknown = null;
  let score = 0;
  let maxScore = 1;
  let declaredPassed: boolean | undefined;
  const lines = check.stdout.trim().split(/\r?\n/).reverse();
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as { score?: unknown; maxScore?: unknown; passed?: unknown };
      if (typeof parsed.score === "number") score = parsed.score;
      if (typeof parsed.maxScore === "number" && parsed.maxScore > 0) maxScore = parsed.maxScore;
      if (typeof parsed.passed === "boolean") declaredPassed = parsed.passed;
      details = parsed;
      break;
    } catch { /* grader diagnostics may precede its JSON result */ }
  }
  const passed = check.status === "passed" && score >= maxScore && declaredPassed !== false;
  return { ...check, score, maxScore, passed, details };
}
