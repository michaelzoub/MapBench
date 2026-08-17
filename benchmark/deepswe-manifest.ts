export const DEEPSWE_SOURCE = {
  name: "deep-swe",
  version: "1.1",
  schemaVersion: "1.3",
  repository: "https://github.com/datacurve-ai/deep-swe.git",
  revision: "435ee89ec2f2e2289f33b0da4f992f0b7b7266b9",
  tasksDirectory: "tasks",
  sets: {
    smoke: ["abs-module-cache-flags", "actionlint-action-pinning-lint"],
  },
} as const;

export type DeepSweTaskSet = keyof typeof DEEPSWE_SOURCE.sets;
