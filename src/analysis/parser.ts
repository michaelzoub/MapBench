import { promises as fs } from "node:fs";
import Parser from "tree-sitter";
import JavaScript from "tree-sitter-javascript";
import TypeScript from "tree-sitter-typescript";
import Python from "tree-sitter-python";
import Go from "tree-sitter-go";
import Rust from "tree-sitter-rust";
import { extractGoFile } from "../languages/go.js";
import { extractPythonFile } from "../languages/python.js";
import { extractRustFile } from "../languages/rust.js";
import { extractEcmaFile } from "../languages/typescript.js";
import type { DetectedProject } from "../detection.js";
import type { SupportedLanguage } from "../types.js";
import type { NormalizedProject, ParsedFile } from "./types.js";
import { compare, posixRelative } from "./utils.js";

const MAX_SOURCE_BYTES = 5 * 1024 * 1024;
const PARSE_TIMEOUT_MICROS = 2_000_000;
const MAX_PARSE_CONCURRENCY = 16;

function grammar(language: SupportedLanguage): Parser.Language {
  if (language === "typescript") return TypeScript.typescript as Parser.Language;
  if (language === "javascript") return JavaScript as unknown as Parser.Language;
  if (language === "python") return Python as unknown as Parser.Language;
  if (language === "go") return Go as unknown as Parser.Language;
  return Rust as unknown as Parser.Language;
}

async function parseFile(root: string, absolutePath: string, language: SupportedLanguage): Promise<ParsedFile> {
  const source = await fs.readFile(absolutePath, "utf8");
  const sourceBytes = Buffer.byteLength(source, "utf8");
  if (sourceBytes > MAX_SOURCE_BYTES) {
    throw new Error(`Refusing to parse ${posixRelative(root, absolutePath)}: ${sourceBytes} bytes exceeds the 5 MiB source-file limit.`);
  }
  const parser = new Parser();
  parser.setLanguage(grammar(language));
  const file = posixRelative(root, absolutePath);
  parser.setTimeoutMicros(PARSE_TIMEOUT_MICROS);
  let tree: Parser.Tree;
  try {
    tree = parser.parse(source);
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : "";
    throw new Error(`Tree-sitter failed to parse ${file}${detail}`);
  }
  if (!tree || tree.rootNode.hasError) {
    let failed = tree?.rootNode;
    if (tree) {
      const stack = [tree.rootNode];
      while (stack.length) {
        const candidate = stack.shift()!;
        if (candidate.isError || candidate.isMissing) {
          failed = candidate;
          break;
        }
        stack.unshift(...candidate.namedChildren.filter((child) => child.hasError || child.isMissing));
      }
    }
    const point = failed?.startPosition;
    const at = point ? ` at ${point.row + 1}:${point.column + 1}` : "";
    throw new Error(`Tree-sitter could not parse ${file}${at}; no artifacts were generated.`);
  }
  if (language === "typescript" || language === "javascript") {
    return extractEcmaFile(absolutePath, file, language, source, tree);
  }
  if (language === "python") return extractPythonFile(absolutePath, file, source, tree);
  if (language === "go") return extractGoFile(absolutePath, file, source, tree);
  return extractRustFile(absolutePath, file, source, tree);
}

export async function parseProject(detected: DetectedProject): Promise<NormalizedProject> {
  const pairs = detected.languages.flatMap((language) =>
    detected.files[language].map((fileName) => ({ language, fileName })));
  const files: ParsedFile[] = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(MAX_PARSE_CONCURRENCY, pairs.length) }, async () => {
    while (cursor < pairs.length) {
      const index = cursor++;
      const { language, fileName } = pairs[index];
      files.push(await parseFile(detected.root, fileName, language));
    }
  });
  await Promise.all(workers);
  files.sort((left, right) => compare(left.file, right.file));
  const symbols = files.flatMap((file) => file.symbols).sort((left, right) => compare(left.id, right.id));
  const references = files.flatMap((file) => file.references)
    .sort((left, right) => compare(left.file, right.file) || left.order - right.order);
  return { root: detected.root, files, symbols, references };
}
