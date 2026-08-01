#!/usr/bin/env node
// usage:
//   project-claude-harness.mjs --policy <path> --repo-root <path> [--target <path>] [--dry-run]
//   project-claude-harness.mjs --policy <path> --repo-root <path> [--target <path>] --check
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkExactRoster, projectClaudeHarness } from "../src/projector.mjs";

function arg(name) {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
}

function die(message) {
  process.stderr.write(`project-claude-harness: ${message}\n`);
  process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const policyPath = arg("--policy");
  const repoRoot = arg("--repo-root");
  const target = arg("--target") ?? repoRoot;
  if (!policyPath || !repoRoot) {
    die("--policy and --repo-root are required");
  } else {
    try {
      const result = process.argv.includes("--check")
        ? checkExactRoster({ policyPath, repoRoot, target })
        : projectClaudeHarness({ policyPath, repoRoot, target, dryRun: process.argv.includes("--dry-run") });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } catch (error) {
      die(error instanceof Error ? error.message : String(error));
    }
  }
}
