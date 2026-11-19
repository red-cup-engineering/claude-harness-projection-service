import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { canonicalizeJsonValue } from "@red-cup-engineering/atomic-json-file-service/canonical";
import { assertPolicyActor } from "./actor.mjs";

// A ClaudePermissionProjection: one machine actor's Claude harness permission
// block, projected from an enterprise-owned record into the target's
// .claude/settings.local.json. The record is the law; the settings file is
// output. Only the `permissions` key is this projection's to write — every
// other key in the settings file is some other authority's state and is
// carried through byte-identical.
export function loadPermissionPolicy(policyPath) {
  const policy = JSON.parse(readFileSync(policyPath, "utf8"));
  if (policy.type !== "ClaudePermissionProjection") {
    throw new Error(`${policyPath} does not declare 'type: ClaudePermissionProjection'`);
  }
  assertPolicyActor(policy.actor, policyPath);
  if (!Array.isArray(policy.allow) || policy.allow.some((rule) => typeof rule !== "string" || rule.trim() === "")) {
    throw new Error(`${policyPath} requires 'allow' as an array of nonempty permission rules`);
  }
  if (policy.defaultMode !== undefined && (typeof policy.defaultMode !== "string" || policy.defaultMode.trim() === "")) {
    throw new Error(`${policyPath} declares an empty defaultMode`);
  }
  return Object.freeze(policy);
}

function settingsPath(target) {
  return join(target, ".claude/settings.local.json");
}

function readSettings(target) {
  const file = settingsPath(target);
  if (!existsSync(file)) return {};
  return JSON.parse(readFileSync(file, "utf8"));
}

function projectedPermissions(policy) {
  return {
    ...(policy.defaultMode ? { defaultMode: policy.defaultMode } : {}),
    allow: [...policy.allow],
  };
}

export function projectPermissions({ policyPath, target, dryRun = false }) {
  target = resolve(target);
  const policy = loadPermissionPolicy(resolve(policyPath));
  const settings = readSettings(target);
  const next = { ...settings, permissions: projectedPermissions(policy) };
  const file = settingsPath(target);
  if (!dryRun) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
  }
  return Object.freeze({ actor: policy.actor, target, file, permissions: next.permissions, dryRun });
}

// The drift check: the live settings file's `permissions` block must equal the
// record's projection exactly. Everything else in the file is out of scope.
export function checkPermissions({ policyPath, target }) {
  target = resolve(target);
  const policy = loadPermissionPolicy(resolve(policyPath));
  const expected = projectedPermissions(policy);
  const file = settingsPath(target);
  if (!existsSync(file)) {
    throw new Error(`no settings file at ${file} — the permission policy has never been projected here`);
  }
  const live = readSettings(target).permissions;
  if (canonicalizeJsonValue(live) !== canonicalizeJsonValue(expected)) {
    throw new Error(`permissions at ${file} have drifted from the policy record: live ${JSON.stringify(live)} vs record ${JSON.stringify(expected)}`);
  }
  return Object.freeze({ actor: policy.actor, target, file, permissions: expected });
}
