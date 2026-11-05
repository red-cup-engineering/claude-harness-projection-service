import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { canonicalizeJsonValue } from "@red-cup-engineering/atomic-json-file-service/canonical";
import { writeJsonAtomically } from "@red-cup-engineering/atomic-json-file-service/write";
import { assertPolicyActor } from "./actor.mjs";

const EVENTS = new Set(["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "SubagentStop"]);
const MATCHABLE_EVENTS = new Set(["SessionStart", "PreToolUse", "PostToolUse"]);
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

function safeRelativeModule(path) {
  return typeof path === "string" && path.endsWith(".mjs") && !path.startsWith("/") && !path.includes("\\") && !path.split("/").includes("..");
}

function portableModule(module) {
  return `${"${CLAUDE_PROJECT_DIR}"}/${module}`;
}

function moduleFromArgument(argument) {
  if (typeof argument !== "string") return null;
  if (argument.startsWith(`${"${CLAUDE_PROJECT_DIR}"}/`)) return argument.slice(`${"${CLAUDE_PROJECT_DIR}"}/`.length);
  return safeRelativeModule(argument) ? argument : null;
}

/**
 * Loads and validates one ClaudeLifecycleHookProjection policy file.
 *
 * @param {string} policyPath Path to the policy JSON file.
 * @returns {object} The frozen, validated policy record.
 */
export function loadHookPolicy(policyPath) {
  policyPath = resolve(policyPath);
  const policy = JSON.parse(readFileSync(policyPath, "utf8"));
  if (policy.type !== "ClaudeLifecycleHookProjection") throw new Error(`${policyPath} does not declare 'type: ClaudeLifecycleHookProjection'`);
  assertPolicyActor(policy.actor, policyPath);
  if (typeof policy.owner !== "string" || !ID.test(policy.owner)) throw new Error(`${policyPath} requires a lowercase kebab-case owner`);
  if (!Array.isArray(policy.handlers) || policy.handlers.length === 0) throw new Error(`${policyPath} requires a nonempty handlers array`);
  const ids = new Set();
  for (const handler of policy.handlers) {
    const keys = new Set(["id", "event", "matcher", "timeout"]);
    if (!handler || typeof handler !== "object" || Object.keys(handler).some((key) => !keys.has(key))) {
      throw new Error(`${policyPath} declares unsupported lifecycle handler fields`);
    }
    if (typeof handler.id !== "string" || !ID.test(handler.id)) throw new Error(`${policyPath} handler ids must be lowercase kebab-case`);
    if (ids.has(handler.id)) throw new Error(`${policyPath} declares duplicate handler id '${handler.id}'`);
    ids.add(handler.id);
    if (!EVENTS.has(handler.event)) throw new Error(`${policyPath} declares unsupported lifecycle event '${handler.event}'`);
    if (!MATCHABLE_EVENTS.has(handler.event) && handler.matcher !== undefined) {
      throw new Error(`${policyPath} declares a matcher for '${handler.event}', which does not support one`);
    }
    if (handler.matcher !== undefined && (typeof handler.matcher !== "string" || handler.matcher.trim() === "")) {
      throw new Error(`${policyPath} declares an empty matcher`);
    }
    if (!Number.isInteger(handler.timeout) || handler.timeout < 1 || handler.timeout > 30) {
      throw new Error(`${policyPath} handler timeout must be an integer from 1 through 30 seconds`);
    }
  }
  return Object.freeze(policy);
}

function loadCatalog(handlerCatalog, target, policy) {
  if (!handlerCatalog || typeof handlerCatalog !== "object" || Array.isArray(handlerCatalog)) throw new Error("a machine-owned handler catalog is required");
  const catalog = new Map();
  for (const [id, module] of Object.entries(handlerCatalog)) {
    if (!ID.test(id) || !safeRelativeModule(module)) throw new Error(`handler catalog entry '${id}' must name a safe repo-relative .mjs module`);
    const path = join(target, module);
    if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`handler catalog entry '${id}' is absent from the target: ${module}`);
    catalog.set(id, module);
  }
  for (const handler of policy.handlers) if (!catalog.has(handler.id)) throw new Error(`policy handler '${handler.id}' is absent from the machine-owned catalog`);
  return catalog;
}

function loadOwnedModules({ priorOwnedModules = [], retiredOwnedModules = [], moduleRelocations = {} }, target) {
  const loadModules = (modules, label) => {
    if (!Array.isArray(modules) || modules.some((module) => !safeRelativeModule(module))) {
      throw new Error(`${label} must contain safe repo-relative .mjs module coordinates`);
    }
    return new Set(modules);
  };
  const prior = loadModules(priorOwnedModules, "priorOwnedModules");
  const retired = loadModules(retiredOwnedModules, "retiredOwnedModules");
  if (!moduleRelocations || typeof moduleRelocations !== "object" || Array.isArray(moduleRelocations)) {
    throw new Error("moduleRelocations must map exact old module coordinates to current module coordinates");
  }
  const relocations = new Map();
  for (const [oldModule, currentModule] of Object.entries(moduleRelocations)) {
    if (!safeRelativeModule(oldModule) || !safeRelativeModule(currentModule)) {
      throw new Error("moduleRelocations must map safe repo-relative .mjs module coordinates");
    }
    if (!existsSync(join(target, currentModule)) || !statSync(join(target, currentModule)).isFile()) {
      throw new Error(`module relocation target is absent from the target: ${currentModule}`);
    }
    relocations.set(oldModule, currentModule);
  }
  return { prior, retired, relocations };
}

function settingsPath(target) {
  return join(target, ".claude/settings.local.json");
}

function readSettings(target) {
  const path = settingsPath(target);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`projected Claude settings are not valid JSON: ${path}`);
  }
}

function commandFor(handler, catalog) {
  return { type: "command", command: "node", args: [portableModule(catalog.get(handler.id)), "--expected-event", handler.event], timeout: handler.timeout };
}

function isOwnedCommand(handler, modules) {
  return handler?.type === "command" && handler.command === "node" && Array.isArray(handler.args) && modules.has(moduleFromArgument(handler.args[0]));
}

function groupMatcher(group) {
  return group.matcher ?? null;
}

function projectedHooks(settings, policy, catalog, owned) {
  const modules = new Set([...catalog.values(), ...owned.prior, ...owned.retired, ...owned.relocations.keys(), ...owned.relocations.values()]);
  const relocated = new Map();
  for (const [event, groups] of Object.entries(settings.hooks ?? {})) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) for (const handler of group.hooks ?? []) {
      const module = moduleFromArgument(handler?.args?.[0]);
      const currentModule = owned.relocations.get(module) ?? (module && [...owned.relocations.values()].includes(module) ? module : null);
      const relocatedHandler = currentModule && { ...handler, args: [portableModule(currentModule), ...handler.args.slice(1)] };
      const key = relocatedHandler && canonicalizeJsonValue({ event, matcher: groupMatcher(group), handler: relocatedHandler });
      if (key && !relocated.has(key) && isOwnedCommand(handler, modules)) {
        relocated.set(key, { event, matcher: groupMatcher(group), handler: relocatedHandler });
      }
    }
  }
  const hooks = {};
  for (const [event, groups] of Object.entries(settings.hooks ?? {})) {
    const retained = Array.isArray(groups)
      ? groups.map((group) => ({ ...group, hooks: Array.isArray(group.hooks) ? group.hooks.filter((handler) => !isOwnedCommand(handler, modules)) : group.hooks }))
        .filter((group) => !Array.isArray(group.hooks) || group.hooks.length > 0)
      : groups;
    if (!Array.isArray(retained) || retained.length > 0) hooks[event] = retained;
  }
  for (const handler of policy.handlers) {
    const groups = Array.isArray(hooks[handler.event]) ? hooks[handler.event] : [];
    const matcher = handler.matcher ?? null;
    let group = groups.find((candidate) => groupMatcher(candidate) === matcher);
    if (!group) {
      group = { ...(handler.matcher === undefined ? {} : { matcher: handler.matcher }), hooks: [] };
      groups.push(group);
    }
    group.hooks = [...group.hooks, commandFor(handler, catalog)];
    hooks[handler.event] = groups;
  }
  for (const { event, matcher, handler } of relocated.values()) {
    const groups = Array.isArray(hooks[event]) ? hooks[event] : [];
    let group = groups.find((candidate) => groupMatcher(candidate) === matcher);
    if (!group) {
      group = { ...(matcher === null ? {} : { matcher }), hooks: [] };
      groups.push(group);
    }
    group.hooks = [...group.hooks, handler];
    hooks[event] = groups;
  }
  return hooks;
}

/**
 * Projects a validated lifecycle hook policy into the target's .claude/settings.local.json, preserving foreign hooks.
 *
 * @param {object} request The policy path, target directory, handler catalog, and optional dry-run flag.
 * @returns {object} A frozen projection receipt naming the actor, owner, target, file, and handlers.
 */
export function projectLifecycleHooks({ policyPath, target, handlerCatalog, priorOwnedModules, retiredOwnedModules, moduleRelocations, dryRun = false }) {
  target = resolve(target);
  const policy = loadHookPolicy(policyPath);
  const catalog = loadCatalog(handlerCatalog, target, policy);
  const owned = loadOwnedModules({ priorOwnedModules, retiredOwnedModules, moduleRelocations }, target);
  const file = settingsPath(target);
  const settings = readSettings(target);
  const hooks = projectedHooks(settings, policy, catalog, owned);
  if (!dryRun) writeJsonAtomically(file, { ...settings, hooks }, { mode: 0o600 });
  return Object.freeze({ actor: policy.actor, owner: policy.owner, target, file, handlers: policy.handlers, dryRun });
}

/**
 * Checks that a target's projected .claude/settings.local.json still matches the policy, without writing.
 *
 * @param {object} request The policy path, target directory, and handler catalog.
 * @returns {object} A frozen receipt naming the actor, owner, target, file, and handlers.
 * @throws {Error} When the hooks have never been projected or have drifted from the policy.
 */
export function checkLifecycleHooks({ policyPath, target, handlerCatalog, priorOwnedModules, retiredOwnedModules, moduleRelocations }) {
  target = resolve(target);
  const policy = loadHookPolicy(policyPath);
  const catalog = loadCatalog(handlerCatalog, target, policy);
  const owned = loadOwnedModules({ priorOwnedModules, retiredOwnedModules, moduleRelocations }, target);
  const file = settingsPath(target);
  if (!existsSync(file)) throw new Error(`Claude lifecycle hooks have never been projected for owner '${policy.owner}'`);
  const settings = readSettings(target);
  const modules = new Set([...catalog.values(), ...owned.prior, ...owned.retired, ...owned.relocations.keys(), ...owned.relocations.values()]);
  const observed = [];
  for (const [event, groups] of Object.entries(settings.hooks ?? {})) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) for (const handler of group.hooks ?? []) {
      if (isOwnedCommand(handler, modules)) observed.push({ event, matcher: groupMatcher(group), handler });
    }
  }
  const expected = [];
  const hooks = projectedHooks(settings, policy, catalog, owned);
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) for (const handler of group.hooks ?? []) {
      if (isOwnedCommand(handler, modules)) expected.push({ event, matcher: groupMatcher(group), handler });
    }
  }
  const ordered = (values) => [...values].sort((left, right) => canonicalizeJsonValue(left).localeCompare(canonicalizeJsonValue(right)));
  if (canonicalizeJsonValue(ordered(observed)) !== canonicalizeJsonValue(ordered(expected))) throw new Error(`Claude lifecycle hooks at ${file} have drifted from owner '${policy.owner}'`);
  return Object.freeze({ actor: policy.actor, owner: policy.owner, target, file, handlers: policy.handlers });
}
