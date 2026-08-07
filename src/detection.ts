import { promises as fs } from "node:fs";
import path from "node:path";
import { assertSafeOutput, discoverPythonFiles, discoverTypeScriptFiles } from "./files.js";
import type { OutlineOptions, SupportedLanguage } from "./types.js";

export interface DetectedProject {
  root: string;
  out: string;
  languages: SupportedLanguage[];
  files: Record<SupportedLanguage, string[]>;
}

async function exists(fileName: string): Promise<boolean> {
  try {
    return (await fs.stat(fileName)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function totalBytes(fileNames: readonly string[]): Promise<number> {
  const sizes = await Promise.all(fileNames.map(async (fileName) => (await fs.stat(fileName)).size));
  return sizes.reduce((total, size) => total + size, 0);
}

function manualHint(): string {
  return "Specify the language manually with --language typescript or --language python.";
}

export async function detectProject(options: OutlineOptions = {}): Promise<DetectedProject> {
  const root = path.resolve(options.root ?? process.cwd());
  const out = path.resolve(root, options.out ?? ".project-outline");
  assertSafeOutput(root, out);

  const [typescript, python] = await Promise.all([
    discoverTypeScriptFiles(root, out),
    discoverPythonFiles(root, out),
  ]);
  const files = { typescript, python };
  const [hasTypeScriptMetadata, hasPythonMetadata] = await Promise.all([
    Promise.all(["package.json", "tsconfig.json", "jsconfig.json"].map((name) => exists(path.join(root, name))))
      .then((values) => values.some(Boolean)),
    Promise.all(["pyproject.toml", "setup.cfg", "requirements.txt", "Pipfile"].map((name) => exists(path.join(root, name))))
      .then((values) => values.some(Boolean)),
  ]);

  if (options.language) {
    if (files[options.language].length === 0) {
      throw new Error(`No meaningful ${options.language} source files were found under ${root}.`);
    }
    return { root, out, languages: [options.language], files };
  }

  if (typescript.length === 0 && python.length === 0) {
    if (hasTypeScriptMetadata && hasPythonMetadata) {
      throw new Error(`Language detection is ambiguous: both TypeScript/JavaScript and Python metadata are present, but neither has meaningful application source. ${manualHint()}`);
    }
    throw new Error(`No supported language was found. project-outline currently supports TypeScript/JavaScript and Python. ${manualHint()}`);
  }

  if (typescript.length === 0) return { root, out, languages: ["python"], files };
  if (python.length === 0) return { root, out, languages: ["typescript"], files };

  const [typescriptBytes, pythonBytes] = await Promise.all([totalBytes(typescript), totalBytes(python)]);
  const typescriptDominates = typescript.length >= python.length * 5 && typescriptBytes >= pythonBytes * 5 && python.length <= 2;
  const pythonDominates = python.length >= typescript.length * 5 && pythonBytes >= typescriptBytes * 5 && typescript.length <= 2;
  if (typescriptDominates && !hasPythonMetadata) return { root, out, languages: ["typescript"], files };
  if (pythonDominates && !hasTypeScriptMetadata) return { root, out, languages: ["python"], files };
  return { root, out, languages: ["typescript", "python"], files };
}
