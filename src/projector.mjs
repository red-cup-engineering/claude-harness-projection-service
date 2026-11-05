import { existsSync, readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { assertPolicyActor } from "./actor.mjs";
import { officeIncumbencyState } from "@red-cup-engineering/principal-office-seating-service";
import {
  checkSharedInstructionSources,
  projectSharedInstructionSources,
} from "@red-cup-engineering/agent-root-instructions-projection-service";

// The projector delegates agent-file authoring to
// installing-claude-as-an-agent's install script, found by the same up-walk
// every sibling caller in this repo uses, rather than duplicating that logic
// here.
const PROJECTOR_SHAPE =
  "lib/emsenn/services/561-group/services/board-of-directors/services/executive-office/lib/management/skills/installing-claude-as-an-agent/scripts/install-claude-as-an-agent.js";

// The instrument is revived beside this projector (scripts/), so a repository
// that does not hold Bare Cedar Fog's tree can still project. The repository
// shape wins where it exists: it is the one the Group maintains.
const REVIVED_PROJECTOR = join(dirname(fileURLToPath(import.meta.url)), "../scripts/install-claude-as-an-agent.js");

const RECOVERED_PROJECTOR_SHAPE =
  "lib/emsenn/services/561-group/services/science-services-section/services/information-science-services-section/services/knowledge-services-section/services/divination-services-section/lib/management/skills/installing-claude-as-an-agent/scripts/install-claude-as-an-agent.js";


export function resolveOfficeProjector(repoRoot) {
  const direct = join(repoRoot, PROJECTOR_SHAPE);
  if (existsSync(direct)) return direct;
  const recovered = join(repoRoot, RECOVERED_PROJECTOR_SHAPE);
  if (existsSync(recovered)) return recovered;
  if (existsSync(REVIVED_PROJECTOR)) return REVIVED_PROJECTOR;
  throw new Error(`office projector is absent at the expected repository shape: ${direct}`);
}

const CLAUDE_RUNTIME_INSTRUCTION_SOURCES = Object.freeze({
  skillsPath: ".claude/skills",
  rulesPath: ".claude/rules",
});

// A ClaudeAgentHarnessProjection: one machine actor's Claude harness policy.
// Validated the same way codex-agent-harness.json is validated by its own
// projector — an incomplete policy is refused, not patched with a default.
export function loadPolicy(policyPath) {
  const policy = JSON.parse(readFileSync(policyPath, "utf8"));
  if (policy.type !== "ClaudeAgentHarnessProjection") {
    throw new Error(`${policyPath} does not declare 'type: ClaudeAgentHarnessProjection'`);
  }
  assertPolicyActor(policy.actor, policyPath);
  if (typeof policy.rootOffice !== "string" || !policy.rootOffice) {
    throw new Error(`${policyPath} names no rootOffice`);
  }
  if (!Array.isArray(policy.colleagueOffices)) {
    throw new Error(`${policyPath} requires a colleagueOffices roster`);
  }
  // office + character + recognition + induction = officer: colleagueOffices
  // names only the seat. A policy that named seats with no seating reference
  // could project a bare office again, the exact flattening
  // harness-seats-bare-offices-without-incumbency was raised against — so the
  // seating reference is validated here, structurally, before any office is
  // ever projected. This is structural only (are the paths named at all);
  // whether they resolve to a real incumbency and a real session character is
  // projectClaudeHarness's job, which alone holds the repoRoot to resolve them.
  if (typeof policy.colleagueSeatings !== "object" || policy.colleagueSeatings === null) {
    throw new Error(`${policyPath} requires a colleagueSeatings map (office id -> {character, incumbency})`);
  }
  for (const office of policy.colleagueOffices) {
    const id = office.split("/").at(-1).replace(/\.json$/u, "");
    const seating = policy.colleagueSeatings[id];
    if (!seating || typeof seating.character !== "string" || typeof seating.incumbency !== "string") {
      throw new Error(
        `${policyPath} names no seating (character + incumbency) for colleague office '${id}' in colleagueSeatings`,
      );
    }
  }
  if (policy.skillPools !== undefined && (!Array.isArray(policy.skillPools) || policy.skillPools.some((p) => typeof p !== "string"))) {
    throw new Error(`${policyPath} declares skillPools that is not an array of repository-relative paths`);
  }
  if (
    typeof policy.rootSeating !== "object" ||
    policy.rootSeating === null ||
    typeof policy.rootSeating.character !== "string" ||
    typeof policy.rootSeating.incumbency !== "string"
  ) {
    throw new Error(`${policyPath} requires a rootSeating (character + incumbency) for its rootOffice`);
  }
  return Object.freeze(policy);
}

export function colleagueIds(policy) {
  return policy.colleagueOffices.map((office) => office.split("/").at(-1).replace(/\.json$/u, ""));
}

function manifestPath(target) {
  return join(target, ".claude/.claude-agent-manifest");
}

function readManifest(target) {
  const file = manifestPath(target);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").map((l) => l.trim()).filter(Boolean);
}

// Every office on the policy's roster is installed as a subagent at target
// by spawning the office projector as a subprocess (see
// resolveOfficeProjector), which writes .claude/agents/*.md. The root office
// is not projected as a subordinate colleague: it is the identity a session
// already holds, not one it dispatches to.
export function projectClaudeHarness({ policyPath, repoRoot, target = repoRoot, dryRun = false }) {
  repoRoot = resolve(repoRoot);
  target = resolve(target);
  const policy = loadPolicy(resolve(policyPath));
  if (colleagueIds(policy).includes(policy.rootOffice)) {
    throw new Error(`policy roster names its own rootOffice '${policy.rootOffice}' as a colleague — the root office is not projected as a subordinate`);
  }
  // The root seat is validated the same way, before any colleague is
  // projected. loadPolicy only established that rootSeating names a character
  // and an incumbency at all; here — where repoRoot is held — those records
  // are resolved. The root office is not projected as a subagent, so the
  // returned paths go unused; this call is only for the validation, which
  // throws if the root seat's records are missing or mismatched, so nothing
  // gets projected under an invalid root.
  verifyIncumbency(policy.rootSeating, repoRoot, policy.rootOffice, "root");
  const projector = resolveOfficeProjector(repoRoot);
  const flags = dryRun ? ["--dry-run"] : [];
  const receipts = [];
  for (const office of policy.colleagueOffices) {
    const officePath = join(repoRoot, office);
    if (!existsSync(officePath)) throw new Error(`policy names an office that seats nowhere: ${officePath}`);
    const id = office.split("/").at(-1).replace(/\.json$/u, "");
    const { characterPath, incumbencyPath } = verifyIncumbency(policy.colleagueSeatings[id], repoRoot, id);
    const poolFlags = (policy.skillPools ?? []).flatMap((pool) => ["--skills-pool", pool]);
    const result = spawnSync(
      process.execPath,
      [projector, officePath, target, "--root", repoRoot, "--character", characterPath, "--incumbency", incumbencyPath, ...poolFlags, ...flags],
      { cwd: repoRoot, encoding: "utf8" },
    );
    if (result.status !== 0) {
      throw new Error(`office projection failed for ${office}: ${result.stderr || result.stdout}`);
    }
    receipts.push(result.stdout.trim());
  }
  const sharedInstructionSources = dryRun
    ? Object.freeze({ files: [] })
    : projectSharedInstructionSources({ target, ...CLAUDE_RUNTIME_INSTRUCTION_SOURCES });
  return Object.freeze({
    actor: policy.actor,
    target,
    colleagues: colleagueIds(policy),
    receipts,
    sharedInstructionFiles: sharedInstructionSources.files,
    dryRun,
  });
}

// Before an office is projected as a subagent, this checks that it has a
// real incumbency record: one that seats exactly this office id, settles to
// the double-settlement state 'dignitas' (recognition and induction both
// "t", via principal-office-seating-service's officeIncumbencyState over the record's own
// recognition/induction fields), and whose holder resolves to an existing
// character record of kind "session". A seat that is vacant, half-seated, in
// repair (a Belnap "top" on either axis), failed (an explicit "f" on either
// axis), or does not resolve at all throws instead of being projected — this
// is the fix for harness-seats-bare-offices-without-incumbency, a bug where
// offices were projected with no character record — and no settled
// recognition/induction — behind them.
//
// Shared by both the root seat and every colleague seat: it takes the
// seating pair directly rather than reading colleagueSeatings itself, since
// rootSeating is the same shape under a different key. `role` only names
// which seat appears in the thrown error message; it never changes what is
// checked.
function verifyIncumbency(seating, repoRoot, id, role = "colleague") {
  const incumbencyPath = join(repoRoot, seating.incumbency);
  if (!existsSync(incumbencyPath)) {
    throw new Error(
      `${role} office '${id}' has no incumbency record seated at ${incumbencyPath} — refusing to project a bare office with no officer behind it`,
    );
  }
  let incumbency;
  try {
    incumbency = JSON.parse(readFileSync(incumbencyPath, "utf8"));
  } catch (e) {
    throw new Error(`incumbency record ${incumbencyPath} for office '${id}' is unreadable: ${e.message}`);
  }
  if (incumbency.office !== id) {
    throw new Error(
      `incumbency record ${incumbencyPath} seats office '${incumbency.office}', not '${id}' — refusing to project a bare office with no officer behind it`,
    );
  }
  const settled = officeIncumbencyState({ recognition: incumbency.recognition, induction: incumbency.induction });
  if (settled !== "dignitas") {
    throw new Error(
      `incumbency record ${incumbencyPath} for ${role} office '${id}' settles to '${settled}' (recognition=${incumbency.recognition}, induction=${incumbency.induction}), not the required double settlement 'dignitas' — refusing to project an officer whose recognition and induction are not both affirmed`,
    );
  }
  const characterPath = join(repoRoot, seating.character);
  if (!existsSync(characterPath)) {
    throw new Error(
      `${role} office '${id}' names holder '${incumbency.holder}' but no character record is seated at ${characterPath} — refusing to project a bare office with no officer behind it`,
    );
  }
  let character;
  try {
    character = JSON.parse(readFileSync(characterPath, "utf8"));
  } catch (e) {
    throw new Error(`character record ${characterPath} for office '${id}' is unreadable: ${e.message}`);
  }
  if (character.id !== incumbency.holder) {
    throw new Error(
      `character record ${characterPath} carries id '${character.id}', not incumbency holder '${incumbency.holder}' — refusing to project a bare office with no officer behind it`,
    );
  }
  if (character.kind !== "session") {
    throw new Error(
      `character '${character.id}' for office '${id}' is kind '${character.kind}', not 'session' — refusing to project a bare office with no officer behind it`,
    );
  }
  return { characterPath, incumbencyPath };
}

/**
 * Verifies a harness policy's colleague seatings both ways, shared by every
 * harness driver that consumes this projection service (owner-ruled
 * 2026-09-04: seating verification lives once upstream, harnesses carry
 * parameters only). Forward: every office in policy.colleagueOffices has a
 * colleagueSeatings entry whose incumbency settles to dignitas and whose
 * character is kind 'session' (verifyIncumbency). Reverse
 * (seated-but-unrostered): a dignitas-settled incumbency under
 * incumbenciesDir naming an office that is neither rootOffice nor on the
 * roster is a seated officer nobody can dispatch, and refuses.
 * @param {object} params
 * @param {object} params.policy - parsed harness policy with colleagueOffices
 *   (repoRoot-relative office paths) and colleagueSeatings (office id ->
 *   {character, incumbency} repoRoot-relative paths)
 * @param {string} params.repoRoot - root colleagueOffices/colleagueSeatings paths resolve against
 * @param {string} params.incumbenciesDir - directory of incumbency JSON records scanned for the reverse gate
 * @param {string} [params.rootOffice] - office id excluded from the reverse gate; defaults to policy.rootOffice
 * @param {readonly string[]} [params.foreignOfficeSourceRoots] - repository-relative office roots belonging to other harnesses
 * @returns {void}
 * @throws {Error} on a missing/unsettled colleague seating or a seated-but-unrostered office
 */
export function verifySeatings({ policy, repoRoot, incumbenciesDir, rootOffice = policy.rootOffice, foreignOfficeSourceRoots = [] }) {
  repoRoot = resolve(repoRoot);
  const foreignRoots = foreignOfficeSourceRoots.map((sourceRoot) => {
    if (typeof sourceRoot !== "string" || sourceRoot.length === 0 || isAbsolute(sourceRoot)) throw new TypeError("foreign office source roots must be nonempty repository-relative paths");
    const normalized = resolve(repoRoot, sourceRoot);
    const inside = relative(repoRoot, normalized);
    if (inside === "" || inside === ".." || inside.startsWith(`..${sep}`)) throw new TypeError("foreign office source roots must be repository-relative paths");
    return normalized;
  });
  for (const office of policy.colleagueOffices) {
    const id = office.split("/").at(-1).replace(/\.json$/u, "");
    const seating = policy.colleagueSeatings?.[id];
    if (!seating || typeof seating.character !== "string" || typeof seating.incumbency !== "string") {
      throw new Error(`policy names no seating (character + incumbency) for colleague office '${id}' in colleagueSeatings`);
    }
    verifyIncumbency(seating, repoRoot, id);
  }
  const rosterIds = new Set(colleagueIds(policy));
  let files;
  try {
    files = readdirSync(incumbenciesDir).filter((name) => name.endsWith(".json"));
  } catch {
    files = [];
  }
  for (const file of files) {
    const path = join(incumbenciesDir, file);
    let incumbency;
    try {
      incumbency = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      continue;
    }
    if (typeof incumbency.office !== "string" || incumbency.office === rootOffice) continue;
    const settled = officeIncumbencyState({ recognition: incumbency.recognition, induction: incumbency.induction });
    if (settled !== "dignitas" || rosterIds.has(incumbency.office)) continue;
    const officeSource = incumbency?.["x-provenance"]?.["office-source"];
    const normalizedSource = typeof officeSource === "string" ? resolve(repoRoot, officeSource) : undefined;
    if (normalizedSource !== undefined && foreignRoots.some((foreignRoot) => normalizedSource === foreignRoot || normalizedSource.startsWith(`${foreignRoot}${sep}`))) continue;
    throw new Error(
      `seated-but-unrostered: office '${incumbency.office}' (incumbency ${file}) settles to dignitas ` +
        `(recognition=${incumbency.recognition}, induction=${incumbency.induction}) but is absent from ` +
        `colleagueOffices — a seated officer this policy never rosters cannot be dispatched.`,
    );
  }
}

// The roster and content check: the manifest and .claude/agents/ at target
// must each name every one of the policy's colleagues, then the office
// projector re-renders each colleague in --check mode and compares its bytes
// without writing. By default roster membership is a subset check, not
// exact-set equality — .claude/agents/ is one shared
// directory a node's whole roster of independent offices and enterprises
// populates, not a location this one policy owns exclusively. An entry this
// policy did not name is another office's installed colleague, never this
// policy's drift to flag.
//
// A policy that declares `"ownsAgentDirectory": true` claims the whole
// directory: it is the single policy projecting at its target, so a seated
// colleague it never named IS drift and fails the check. Only the policy that
// genuinely owns its target may declare this — two owning policies at one
// target would each flag the other's roster.
export function checkExactRoster({ policyPath, repoRoot, target = repoRoot }) {
  repoRoot = resolve(repoRoot);
  target = resolve(target);
  const policy = loadPolicy(resolve(policyPath));
  const expected = [...colleagueIds(policy)].sort();
  const observed = new Set(readManifest(target));
  const missingFromManifest = expected.filter((id) => !observed.has(id));
  if (missingFromManifest.length > 0) {
    throw new Error(`projected colleague roster at ${target} is missing from the manifest: ${missingFromManifest.join(", ")}`);
  }
  const agentDir = join(target, ".claude/agents");
  const files = new Set(
    existsSync(agentDir)
      ? readdirSync(agentDir).filter((n) => n.endsWith(".md")).map((n) => n.replace(/\.md$/u, ""))
      : [],
  );
  const missingFiles = expected.filter((id) => !files.has(id));
  if (missingFiles.length > 0) {
    throw new Error(`projected agent files at ${agentDir} are missing for: ${missingFiles.join(", ")}`);
  }
  if (policy.ownsAgentDirectory === true) {
    const expectedSet = new Set(expected);
    const extraSeated = [...observed].filter((id) => !expectedSet.has(id)).sort();
    if (extraSeated.length > 0) {
      throw new Error(`manifest at ${target} seats colleagues the owning policy never named: ${extraSeated.join(", ")}`);
    }
    const extraFiles = [...files].filter((id) => !expectedSet.has(id)).sort();
    if (extraFiles.length > 0) {
      throw new Error(`agent files at ${agentDir} exist for colleagues the owning policy never named: ${extraFiles.join(", ")}`);
    }
  }

  verifyIncumbency(policy.rootSeating, repoRoot, policy.rootOffice, "root");
  const projector = resolveOfficeProjector(repoRoot);
  for (const office of policy.colleagueOffices) {
    const id = office.split("/").at(-1).replace(/\.json$/u, "");
    const { characterPath, incumbencyPath } = verifyIncumbency(policy.colleagueSeatings[id], repoRoot, id);
    const poolFlags = (policy.skillPools ?? []).flatMap((pool) => ["--skills-pool", pool]);
    const result = spawnSync(
      process.execPath,
      [projector, join(repoRoot, office), target, "--root", repoRoot, "--character", characterPath, "--incumbency", incumbencyPath, ...poolFlags, "--check"],
      { cwd: repoRoot, encoding: "utf8" },
    );
    if (result.status !== 0) {
      throw new Error(`projected agent content has drifted for ${office}: ${result.stderr || result.stdout}`);
    }
  }

  const sharedInstructionSources = checkSharedInstructionSources({
    target,
    ...CLAUDE_RUNTIME_INSTRUCTION_SOURCES,
  });

  return Object.freeze({
    actor: policy.actor,
    target,
    colleagues: expected,
    ownsAgentDirectory: policy.ownsAgentDirectory === true,
    contentChecked: true,
    sharedInstructionFiles: sharedInstructionSources.files,
  });
}
