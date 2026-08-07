import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { generateOutline } from "../src/index.js";

const fixtures = path.resolve(process.cwd(), "test/fixtures/languages");
const execFileAsync = promisify(execFile);

function fixture(name: string): string {
  return path.join(fixtures, name);
}

async function withFixture<T>(name: string, run: (root: string) => Promise<T>): Promise<T> {
  const temporaryParent = await fs.mkdtemp(path.join(os.tmpdir(), `project-outline-${name}-`));
  const root = path.join(temporaryParent, "repository");
  await fs.cp(fixture(name), root, { recursive: true });
  try {
    return await run(root);
  } finally {
    await fs.rm(temporaryParent, { recursive: true, force: true });
  }
}

test("detects and outlines a Python-only repository with Python-native relationships", async () => {
  await withFixture("python-only", async (root) => {
    const result = await generateOutline({ root });
    assert.deepEqual(result.languages, ["python"]);

    const outline = await fs.readFile(path.join(result.out, "app/models.py"), "utf8");
    assert.match(outline, /^# @project-outline generated/);
    assert.match(outline, /from \.storage import load_job/);
    assert.doesNotMatch(outline, /from dataclasses|from enum|from typing/);
    assert.match(outline, /@dataclass\nclass Job:/);
    assert.match(outline, /class State\(Enum\):[\s\S]*READY = 'ready'/);
    assert.match(outline, /async def run\(self, job: Job, retries: int\s*=\s*3\) -> str:\n\s+[\"']{3}Calls: app\/models\.py#Worker\.prepare, app\/storage\.py#load_job; Unresolved project: self\.callback[\"']{3}\n\s+pass/);
    assert.match(outline, /API_TOKEN = \.\.\./);
    assert.match(outline, /def authenticate\(user: str, api_token: str\s*=\s*\.\.\.\) -> bool/);
    assert.doesNotMatch(outline, /must-not-leak|private-default|default-secret|select \*/);
    await execFileAsync("python3", [
      "-c",
      "import pathlib, sys; source = pathlib.Path(sys.argv[1]).read_text(); compile(source, sys.argv[1], 'exec')",
      path.join(result.out, "app/models.py"),
    ]);

    const serializedGraph = await fs.readFile(path.join(result.out, "callgraph.json"), "utf8");
    assert.doesNotMatch(serializedGraph, /default-secret/);
    const graph = JSON.parse(serializedGraph);
    const models = "app/models.py#";
    assert.deepEqual(graph[`${models}Worker.run`].calls,
      [`${models}Worker.prepare`, "app/storage.py#load_job"]);
    assert.deepEqual(graph[`${models}Worker.prepare`].calledBy, [`${models}Worker.run`]);
    assert.deepEqual(graph[`${models}Worker.run`].unresolvedProjectCalls, ["self.callback"]);
    assert.deepEqual(graph[`${models}build_worker`].instantiates, [`${models}Worker`]);
    assert.equal(graph[`${models}Worker.__init__`].kind, "constructor");
  });
});

test("detects TypeScript-only and ignores incidental frontend HTML", async () => {
  await withFixture("typescript-only", async (root) => {
    const typescript = await generateOutline({ root });
    assert.deepEqual(typescript.languages, ["typescript"]);
    assert.equal(await fs.readFile(path.join(typescript.out, "src/main.ts"), "utf8").then(() => true), true);
    const javascript = await fs.readFile(path.join(typescript.out, "src/legacy.js"), "utf8");
    assert.match(javascript, /export const version = undefined/);
    assert.match(javascript, /export function legacyGreeting\(name = undefined\) \{\s*\}/);
    assert.doesNotMatch(javascript, /private-build-value|private-default|name: string|name\?|declare/);
    await execFileAsync(process.execPath, ["--check", path.join(typescript.out, "src/legacy.js")]);
  });

  await withFixture("incidental-html", async (root) => {
    const frontend = await generateOutline({ root });
    assert.deepEqual(frontend.languages, ["typescript"]);
    await assert.rejects(fs.access(path.join(frontend.out, "public/index.html")));
  });
});

test("Python callback arguments become call graph edges without hiding dynamic dispatch", async () => {
  const temporaryParent = await fs.mkdtemp(path.join(os.tmpdir(), "project-outline-python-callbacks-"));
  const root = path.join(temporaryParent, "repository");
  await fs.mkdir(path.join(root, "app"), { recursive: true });
  await fs.writeFile(path.join(root, "pyproject.toml"), '[project]\nname = "callbacks"\nversion = "0.1.0"\n');
  await fs.writeFile(path.join(root, "app/callbacks.py"), `
import httpx

def dispatch(value: str, callback) -> None:
    callback(value)

def persist(value: str) -> None:
    pass

def notify(value: str) -> None:
    pass

def run() -> None:
    dispatch("stored", persist)
    dispatch("sent", callback=notify)

def fetch() -> None:
    httpx.get("https://example.test")

def normalize(value: str) -> str:
    return value.strip().lower()
`);
  try {
    const result = await generateOutline({ root });
    const graph = JSON.parse(await fs.readFile(path.join(result.out, "callgraph.json"), "utf8"));
    const prefix = "app/callbacks.py#";
    assert.deepEqual(graph[`${prefix}dispatch`].calls, [`${prefix}notify`, `${prefix}persist`]);
    assert.deepEqual(graph[`${prefix}dispatch`].callsInSourceOrder, [`${prefix}persist`, `${prefix}notify`]);
    assert.deepEqual(graph[`${prefix}dispatch`].unresolvedProjectCalls, ["callback"]);
    assert.deepEqual(graph[`${prefix}notify`].calledBy, [`${prefix}dispatch`]);
    assert.deepEqual(graph[`${prefix}persist`].calledBy, [`${prefix}dispatch`]);
    assert.deepEqual(graph[`${prefix}run`].calls, [`${prefix}dispatch`]);
    assert.deepEqual(graph[`${prefix}fetch`].externalCalls, ["httpx#get"]);
    assert.equal(graph[`${prefix}normalize`].unresolvedProjectCalls, undefined);
    assert.equal(graph[`${prefix}normalize`].externalCalls, undefined);
  } finally {
    await fs.rm(temporaryParent, { recursive: true, force: true });
  }
});

test("generates both language outlines for a mixed application repository", async () => {
  await withFixture("mixed", async (root) => {
    const result = await generateOutline({ root });
    assert.deepEqual(result.languages, ["typescript", "python"]);
    assert.equal(await fs.readFile(path.join(result.out, "src/client.ts"), "utf8").then(() => true), true);
    assert.equal(await fs.readFile(path.join(result.out, "service/worker.py"), "utf8").then(() => true), true);
    const graph = JSON.parse(await fs.readFile(path.join(result.out, "callgraph.json"), "utf8"));
    assert.deepEqual(graph["service/worker.py#create_worker"].instantiates, ["service/worker.py#Worker"]);
    assert.equal(graph["src/client.ts#Client.request"].kind, "method");
  });
});

test("language override selects one parser in a mixed repository", async () => {
  await withFixture("mixed", async (root) => {
    const python = await generateOutline({ root, out: ".python-outline", language: "python" });
    assert.deepEqual(python.languages, ["python"]);
    assert.equal(await fs.readFile(path.join(python.out, "service/worker.py"), "utf8").then(() => true), true);
    await assert.rejects(fs.access(path.join(python.out, "src/client.ts")));

    const typescript = await generateOutline({ root, out: ".typescript-outline", language: "typescript" });
    assert.deepEqual(typescript.languages, ["typescript"]);
    assert.equal(await fs.readFile(path.join(typescript.out, "src/client.ts"), "utf8").then(() => true), true);
    await assert.rejects(fs.access(path.join(typescript.out, "service/worker.py")));
  });
});

test("CLI accepts the language override", async () => {
  await withFixture("mixed", async (root) => {
    const cli = path.resolve(process.cwd(), "dist/src/cli.js");
    const { stdout } = await execFileAsync(process.execPath, [cli, "generate", "--root", root, "--language", "python"]);
    assert.match(stdout, /Generated 6 outline files/);
    assert.equal(await fs.readFile(path.join(root, ".project-outline/service/worker.py"), "utf8").then(() => true), true);
    await assert.rejects(fs.access(path.join(root, ".project-outline/src/client.ts")));
  });
});

test("unsupported and genuinely ambiguous repositories fail with manual guidance", async () => {
  await withFixture("unsupported", async (root) => assert.rejects(
    generateOutline({ root }),
    /No supported language.*--language typescript or --language python/s,
  ));
  await withFixture("ambiguous", async (root) => assert.rejects(
    generateOutline({ root }),
    /ambiguous.*--language typescript or --language python/s,
  ));
});
