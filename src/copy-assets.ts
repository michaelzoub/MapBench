import { copyFile, cp } from "node:fs/promises";
import path from "node:path";

await copyFile(path.resolve("src/python_parser.py"), path.resolve("dist/src/python_parser.py"));
await Promise.all([
  cp(path.resolve("benchmark/tasks"), path.resolve("dist/benchmark/tasks"), { recursive: true }),
  cp(path.resolve("benchmark/grading"), path.resolve("dist/benchmark/grading"), { recursive: true }),
  cp(path.resolve("benchmark/examples"), path.resolve("dist/benchmark/examples"), { recursive: true }),
]);
