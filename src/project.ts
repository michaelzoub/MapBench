import path from "node:path";
import ts from "typescript";
import { assertSafeOutput, discoverTypeScriptFiles, isMeaningfulTypeScriptFile } from "./files.js";
import type { OutlineOptions, TypeScriptProjectContext } from "./types.js";

function formatDiagnostics(diagnostics: readonly ts.Diagnostic[]): string {
  return ts.formatDiagnostics(diagnostics, {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: ts.sys.getCurrentDirectory,
    getNewLine: () => ts.sys.newLine,
  });
}

export async function createProjectContext(
  options: OutlineOptions = {},
  detectedFileNames?: readonly string[],
): Promise<TypeScriptProjectContext> {
  const root = path.resolve(options.root ?? process.cwd());
  const out = path.resolve(root, options.out ?? ".project-outline");
  assertSafeOutput(root, out);

  const rootConfig = ["tsconfig.json", "jsconfig.json"]
    .map((name) => path.join(root, name))
    .find((candidate) => ts.sys.fileExists(candidate));
  const configPath = rootConfig;
  let compilerOptions: ts.CompilerOptions = {
    allowJs: true,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ESNext,
  };
  let fileNames: string[] = [];

  if (configPath) {
    const loaded = ts.readConfigFile(configPath, ts.sys.readFile);
    if (loaded.error) throw new Error(formatDiagnostics([loaded.error]));
    const parsed = ts.parseJsonConfigFileContent(loaded.config, ts.sys, root, undefined, configPath);
    if (parsed.errors.length > 0) throw new Error(formatDiagnostics(parsed.errors));
    compilerOptions = parsed.options;
    fileNames = parsed.fileNames.filter((fileName) => isMeaningfulTypeScriptFile(fileName, root, out));
  }

  if (detectedFileNames) fileNames = [...detectedFileNames];
  else if (fileNames.length === 0) fileNames = await discoverTypeScriptFiles(root, out);
  fileNames = [...new Set(fileNames.map((fileName) => path.resolve(fileName)))].sort();

  const program = ts.createProgram({ rootNames: fileNames, options: compilerOptions });
  return { root, out, configPath, compilerOptions, fileNames, program };
}
