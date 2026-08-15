import path from "node:path";
import {
  assertSafeOutput,
  discoverGoFiles,
  discoverJavaScriptFiles,
  discoverPythonFiles,
  discoverRustFiles,
  discoverTypeScriptFiles,
} from "./files.js";
import type { OutlineOptions, SupportedLanguage } from "./types.js";

export interface DetectedProject {
  root: string;
  out: string;
  languages: SupportedLanguage[];
  files: Record<SupportedLanguage, string[]>;
}

function manualHint(): string {
  return "Specify the language manually with --language typescript, javascript, python, go, or rust.";
}

export async function detectProject(options: OutlineOptions = {}): Promise<DetectedProject> {
  const root = path.resolve(options.root ?? process.cwd());
  const out = path.resolve(root, options.out ?? ".project-outline");
  assertSafeOutput(root, out);

  const [typescript, javascript, python, go, rust] = await Promise.all([
    discoverTypeScriptFiles(root, out),
    discoverJavaScriptFiles(root, out),
    discoverPythonFiles(root, out),
    discoverGoFiles(root, out),
    discoverRustFiles(root, out),
  ]);
  const files = { typescript, javascript, python, go, rust };

  if (options.language) {
    if (files[options.language].length === 0) {
      throw new Error(`No meaningful ${options.language} source files were found under ${root}.`);
    }
    return { root, out, languages: [options.language], files };
  }

  const languages = (["typescript", "javascript", "python", "go", "rust"] as const)
    .filter((language) => files[language].length > 0);
  if (!languages.length) throw new Error(`No supported language was found. project-outline supports TypeScript, JavaScript, Python, Go, and Rust. ${manualHint()}`);
  return { root, out, languages: [...languages], files };
}
