import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkPermissions, loadPermissionPolicy, projectPermissions } from "../src/permissions.mjs";

const POLICY = {
  type: "ClaudePermissionProjection",
  actor: "actor:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  defaultMode: "bypassPermissions",
  allow: ["mcp__test-enterprise", "Bash(npm --prefix pkg run:*)"],
};

function seed(scratch, policy = POLICY) {
  const policyPath = join(scratch, "policy.json");
  writeFileSync(policyPath, JSON.stringify(policy));
  return policyPath;
}

test("loadPermissionPolicy refuses an untyped record and an empty rule", () => {
  const scratch = mkdtempSync(join(tmpdir(), "claude-permissions-"));
  try {
    assert.throws(() => loadPermissionPolicy(seed(scratch, { ...POLICY, type: "SomethingElse" })), /ClaudePermissionProjection/);
    assert.throws(() => loadPermissionPolicy(seed(scratch, { ...POLICY, allow: ["ok", " "] })), /nonempty permission rules/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("projectPermissions writes only the permissions key and preserves the rest of the file", () => {
  const scratch = mkdtempSync(join(tmpdir(), "claude-permissions-"));
  try {
    const policyPath = seed(scratch);
    mkdirSync(join(scratch, ".claude"), { recursive: true });
    writeFileSync(join(scratch, ".claude/settings.local.json"), JSON.stringify({ permissions: { allow: [] }, enableAllProjectMcpServers: true }));
    const receipt = projectPermissions({ policyPath, target: scratch });
    const live = JSON.parse(readFileSync(join(scratch, ".claude/settings.local.json"), "utf8"));
    assert.equal(live.enableAllProjectMcpServers, true);
    assert.deepEqual(live.permissions, { defaultMode: "bypassPermissions", allow: POLICY.allow });
    assert.equal(receipt.dryRun, false);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("checkPermissions passes after projection and refuses drift", () => {
  const scratch = mkdtempSync(join(tmpdir(), "claude-permissions-"));
  try {
    const policyPath = seed(scratch);
    assert.throws(() => checkPermissions({ policyPath, target: scratch }), /never been projected/);
    projectPermissions({ policyPath, target: scratch });
    const ok = checkPermissions({ policyPath, target: scratch });
    assert.deepEqual(ok.permissions.allow, POLICY.allow);
    const file = join(scratch, ".claude/settings.local.json");
    const tampered = JSON.parse(readFileSync(file, "utf8"));
    tampered.permissions.allow.push("Bash(rm:*)");
    writeFileSync(file, JSON.stringify(tampered));
    assert.throws(() => checkPermissions({ policyPath, target: scratch }), /drifted from the policy record/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("checkPermissions is key-order insensitive — same law in a different order is not drift", () => {
  const scratch = mkdtempSync(join(tmpdir(), "claude-permissions-"));
  try {
    const policyPath = seed(scratch);
    mkdirSync(join(scratch, ".claude"), { recursive: true });
    writeFileSync(
      join(scratch, ".claude/settings.local.json"),
      JSON.stringify({ permissions: { allow: POLICY.allow, defaultMode: "bypassPermissions" } }),
    );
    const ok = checkPermissions({ policyPath, target: scratch });
    assert.equal(ok.actor, "actor:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
