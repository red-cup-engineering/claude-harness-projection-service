import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkLifecycleHooks, loadHookPolicy, projectLifecycleHooks } from "../src/hooks.mjs";

const module = "services/machine/scripts/observe-lifecycle.mjs";
const catalog = { "lifecycle-observer": module };
const portableModule = `${"${CLAUDE_PROJECT_DIR}"}/${module}`;
const policy = (handlers = [{ id: "lifecycle-observer", event: "SessionStart", matcher: "startup|resume", timeout: 5 }]) => ({
  type: "ClaudeLifecycleHookProjection",
  actor: "actor:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
  owner: "test-claude",
  handlers,
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "claude-hooks-"));
  mkdirSync(join(root, "services/machine/scripts"), { recursive: true });
  writeFileSync(join(root, module), "// fixture\n");
  const policyPath = join(root, "policy.json");
  writeFileSync(policyPath, JSON.stringify(policy()));
  return { root, policyPath };
}

test("hook policy contains ids and bounded lifecycle declarations, never executable commands", () => {
  const { root, policyPath } = fixture();
  try {
    assert.equal(loadHookPolicy(policyPath).owner, "test-claude");
    writeFileSync(policyPath, JSON.stringify(policy([{ id: "x", event: "Notification", timeout: 5 }])));
    assert.throws(() => loadHookPolicy(policyPath), /unsupported lifecycle event/);
    writeFileSync(policyPath, JSON.stringify(policy([{ id: "x", event: "PreToolUse", matcher: "Write|Edit", timeout: 5 }])));
    assert.equal(loadHookPolicy(policyPath).handlers[0].matcher, "Write|Edit");
    writeFileSync(policyPath, JSON.stringify(policy([{ id: "x", event: "Stop", matcher: "anything", timeout: 5 }])));
    assert.throws(() => loadHookPolicy(policyPath), /does not support/);
    writeFileSync(policyPath, JSON.stringify(policy([{ id: "x", event: "Stop", timeout: 31 }])));
    assert.throws(() => loadHookPolicy(policyPath), /1 through 30/);
    writeFileSync(policyPath, JSON.stringify(policy([{ id: "x", event: "Stop", timeout: 5, command: "capture" }])));
    assert.throws(() => loadHookPolicy(policyPath), /unsupported lifecycle handler fields/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("projection derives commands from the machine catalog and preserves foreign handlers in the same matcher group", () => {
  const { root, policyPath } = fixture();
  try {
    mkdirSync(join(root, ".claude"), { recursive: true });
    const foreign = { type: "command", command: "foreign-command" };
    writeFileSync(join(root, ".claude/settings.local.json"), JSON.stringify({
      permissions: { allow: ["Read"] },
      hooks: { SessionStart: [{ matcher: "startup|resume", hooks: [foreign] }] },
    }));
    projectLifecycleHooks({ policyPath, target: root, handlerCatalog: catalog });
    const live = JSON.parse(readFileSync(join(root, ".claude/settings.local.json"), "utf8"));
    assert.deepEqual(live.permissions, { allow: ["Read"] });
    assert.deepEqual(live.hooks.SessionStart[0].hooks, [foreign, {
      type: "command", command: "node", args: [portableModule, "--expected-event", "SessionStart"], timeout: 5,
    }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reprojection is idempotent and replaces stale managed placement", () => {
  const { root, policyPath } = fixture();
  try {
    projectLifecycleHooks({ policyPath, target: root, handlerCatalog: catalog });
    writeFileSync(policyPath, JSON.stringify(policy([{ id: "lifecycle-observer", event: "Stop", timeout: 7 }])));
    projectLifecycleHooks({ policyPath, target: root, handlerCatalog: catalog });
    projectLifecycleHooks({ policyPath, target: root, handlerCatalog: catalog });
    const live = JSON.parse(readFileSync(join(root, ".claude/settings.local.json"), "utf8"));
    assert.equal(live.hooks.SessionStart, undefined);
    assert.equal(live.hooks.Stop.length, 1);
    assert.equal(live.hooks.Stop[0].hooks.length, 1);
    assert.deepEqual(live.hooks.Stop[0].hooks[0].args, [portableModule, "--expected-event", "Stop"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("check is no-write and detects managed drift", () => {
  const { root, policyPath } = fixture();
  try {
    assert.throws(() => checkLifecycleHooks({ policyPath, target: root, handlerCatalog: catalog }), /never been projected/);
    projectLifecycleHooks({ policyPath, target: root, handlerCatalog: catalog });
    assert.equal(checkLifecycleHooks({ policyPath, target: root, handlerCatalog: catalog }).owner, "test-claude");
    const path = join(root, ".claude/settings.local.json");
    const live = JSON.parse(readFileSync(path, "utf8"));
    live.hooks.SessionStart[0].hooks[0].timeout = 9;
    writeFileSync(path, JSON.stringify(live));
    assert.throws(() => checkLifecycleHooks({ policyPath, target: root, handlerCatalog: catalog }), /have drifted/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("PreToolUse and PostToolUse project with a tool-name matcher", () => {
  const { root, policyPath } = fixture();
  try {
    writeFileSync(policyPath, JSON.stringify(policy([
      { id: "lifecycle-observer", event: "PreToolUse", matcher: "Write|Edit", timeout: 5 },
      { id: "lifecycle-observer", event: "PostToolUse", timeout: 5 },
    ])));
    assert.throws(() => loadHookPolicy(policyPath), /duplicate handler id/);
    writeFileSync(policyPath, JSON.stringify(policy([
      { id: "lifecycle-observer", event: "PreToolUse", matcher: "Write|Edit", timeout: 5 },
    ])));
    projectLifecycleHooks({ policyPath, target: root, handlerCatalog: catalog });
    const live = JSON.parse(readFileSync(join(root, ".claude/settings.local.json"), "utf8"));
    assert.equal(live.hooks.PreToolUse[0].matcher, "Write|Edit");
    assert.deepEqual(live.hooks.PreToolUse[0].hooks, [
      { type: "command", command: "node", args: [portableModule, "--expected-event", "PreToolUse"], timeout: 5 },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SubagentStop is an admitted lifecycle event without matcher support", () => {
  const { root, policyPath } = fixture();
  try {
    writeFileSync(policyPath, JSON.stringify(policy([{ id: "lifecycle-observer", event: "SubagentStop", matcher: "anything", timeout: 10 }])));
    assert.throws(() => loadHookPolicy(policyPath), /does not support/);

    writeFileSync(policyPath, JSON.stringify(policy([{ id: "lifecycle-observer", event: "SubagentStop", timeout: 10 }])));
    assert.equal(loadHookPolicy(policyPath).handlers[0].event, "SubagentStop");

    projectLifecycleHooks({ policyPath, target: root, handlerCatalog: catalog });
    const live = JSON.parse(readFileSync(join(root, ".claude/settings.local.json"), "utf8"));
    assert.deepEqual(live.hooks.SubagentStop[0].hooks, [
      { type: "command", command: "node", args: [portableModule, "--expected-event", "SubagentStop"], timeout: 10 },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("projection replaces exact prior coordinates, removes retired handlers, and relocates a retained hook", () => {
  const { root, policyPath } = fixture();
  const oldModule = "old location/scripts/observe-lifecycle.mjs";
  const retiredModule = "old location/scripts/short-reminder.mjs";
  const oldSubstrate = "old location/scripts/check-substrate-import-hook.mjs";
  const substrate = "services/machine/scripts/check-substrate-import-hook.mjs";
  try {
    writeFileSync(join(root, substrate), "// fixture\n");
    mkdirSync(join(root, ".claude"), { recursive: true });
    const foreign = { type: "command", command: "node", args: ["third party/scripts/hook.mjs", "--keep"], timeout: 8 };
    const substrateCommand = { type: "command", command: "node", args: [oldSubstrate, "--expected-event", "PreToolUse", "--strict"], timeout: 10 };
    writeFileSync(join(root, ".claude/settings.local.json"), JSON.stringify({ hooks: {
      SessionStart: [{ matcher: "startup|resume", hooks: [{ type: "command", command: "node", args: [oldModule, "--expected-event", "SessionStart"], timeout: 5 }] }],
      UserPromptSubmit: [{ hooks: [{ type: "command", command: "node", args: [retiredModule, "--expected-event", "UserPromptSubmit"], timeout: 5 }] }],
      PreToolUse: [{ matcher: "Write|Edit", hooks: [foreign, substrateCommand] }],
      PostToolUse: [{ hooks: [substrateCommand] }],
    } }));
    const options = { policyPath, target: root, handlerCatalog: catalog, priorOwnedModules: [oldModule], retiredOwnedModules: [retiredModule], moduleRelocations: { [oldSubstrate]: substrate } };
    projectLifecycleHooks(options);
    projectLifecycleHooks(options);
    const live = JSON.parse(readFileSync(join(root, ".claude/settings.local.json"), "utf8"));
    const serialized = JSON.stringify(live);
    assert.doesNotMatch(serialized, /old location/);
    assert.equal(live.hooks.UserPromptSubmit, undefined);
    assert.deepEqual(live.hooks.PreToolUse[0].hooks, [foreign, { ...substrateCommand, args: [`${"${CLAUDE_PROJECT_DIR}"}/${substrate}`, "--expected-event", "PreToolUse", "--strict"] }]);
    assert.deepEqual(live.hooks.PostToolUse[0].hooks, [{ ...substrateCommand, args: [`${"${CLAUDE_PROJECT_DIR}"}/${substrate}`, "--expected-event", "PreToolUse", "--strict"] }]);
    assert.equal(checkLifecycleHooks(options).owner, "test-claude");
    live.hooks.SessionStart[0].hooks.push({ type: "command", command: "node", args: [oldModule, "--expected-event", "SessionStart"], timeout: 5 });
    writeFileSync(join(root, ".claude/settings.local.json"), JSON.stringify(live));
    assert.throws(() => checkLifecycleHooks(options), /have drifted/);
    live.hooks.SessionStart[0].hooks.pop();
    live.hooks.SessionStart[0].hooks.push({ type: "command", command: "node", args: [portableModule, "--expected-event", "SessionStart"], timeout: 5 });
    writeFileSync(join(root, ".claude/settings.local.json"), JSON.stringify(live));
    assert.throws(() => checkLifecycleHooks(options), /have drifted/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unknown or absent catalog entries fail, and dry-run writes nothing", () => {
  const { root, policyPath } = fixture();
  try {
    assert.throws(() => projectLifecycleHooks({ policyPath, target: root, handlerCatalog: {} }), /absent from the machine-owned catalog/);
    rmSync(join(root, module));
    assert.throws(() => projectLifecycleHooks({ policyPath, target: root, handlerCatalog: catalog }), /absent from the target/);
    writeFileSync(join(root, module), "// fixture\n");
    const result = projectLifecycleHooks({ policyPath, target: root, handlerCatalog: catalog, dryRun: true });
    assert.equal(result.dryRun, true);
    assert.throws(() => readFileSync(result.file));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
