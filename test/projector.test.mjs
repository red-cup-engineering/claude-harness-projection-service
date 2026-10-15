import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkExactRoster, colleagueIds, loadPolicy, projectClaudeHarness } from "../src/projector.mjs";

// A minimal, structurally-valid colleagueSeatings/rootSeating pair for a
// fixture named "test-office" / "test-root-office" — the paths need not
// resolve to real files unless the test is exercising the
// file-resolving half of the check (verifyIncumbency, inside
// projectClaudeHarness), since loadPolicy only validates structure.
function seatings(id = "test-office") {
  return {
    colleagueSeatings: {
      [id]: { character: `content/characters/${id}.json`, incumbency: `content/incumbencies/${id}-as-${id}.json` },
    },
    rootSeating: { character: "content/character.json", incumbency: "content/incumbencies/root.json" },
  };
}

// The one repository shape resolveOfficeProjector requires. The real
// installer instrument is not present under a scratch repoRoot; a stub is
// seated at exactly this shape so a test exercises projectClaudeHarness's own
// logic rather than tripping over an ⊥ absence that is not what it is about.
const INSTALLER_SHAPE =
  "lib/emsenn/services/561-group/services/board-of-directors/services/executive-office/lib/management/skills/installing-claude-as-an-agent/scripts/install-claude-as-an-agent.js";

function stubInstaller(scratch, body = `console.log("stub-installed:", process.argv.slice(2).join(" "));`) {
  const installerPath = join(scratch, INSTALLER_SHAPE);
  mkdirSync(dirname(installerPath), { recursive: true });
  writeFileSync(installerPath, `#!/usr/bin/env node\n${body}\nprocess.exit(0);\n`);
  return installerPath;
}

// The office record plus the full officer quartet behind one colleague seat,
// written so a test about the ROOT seat has nothing refusable in its
// colleagues and its refusal can only be about the root.
function seatColleague(scratch, id = "test-office") {
  mkdirSync(join(scratch, "content/offices"), { recursive: true });
  writeFileSync(join(scratch, `content/offices/${id}.json`), JSON.stringify({ kind: "office", id }));
  mkdirSync(join(scratch, "content/characters"), { recursive: true });
  writeFileSync(
    join(scratch, `content/characters/${id}.json`),
    JSON.stringify({ id: `${id}-session`, name: "Test office session", kind: "session", disposition: "Does the test thing." }),
  );
  mkdirSync(join(scratch, "content/incumbencies"), { recursive: true });
  writeFileSync(
    join(scratch, `content/incumbencies/${id}-as-${id}.json`),
    JSON.stringify({ id: `${id}-session-as-${id}`, office: id, holder: `${id}-session`, recognition: "t", induction: "t", from: "2026-07-30" }),
  );
}

// A root office is an officer or it is nothing: these write the same
// office + character + recognition + induction quartet for the root seating
// that a colleague seating gets, so a test about a colleague fails for its
// colleague and never incidentally for an unseated root.
function seatRoot(scratch, { office = "test-root-office", holder = "test-root-session", characterId = holder, kind = "session" } = {}) {
  mkdirSync(join(scratch, "content/incumbencies"), { recursive: true });
  writeFileSync(
    join(scratch, "content/character.json"),
    JSON.stringify({ id: characterId, name: "Test root session", kind, disposition: "Holds the root seat." }),
  );
  writeFileSync(
    join(scratch, "content/incumbencies/root.json"),
    JSON.stringify({ id: `${holder}-as-${office}`, office, holder, recognition: "t", induction: "t", from: "2026-07-30" }),
  );
}

test("loadPolicy refuses a policy naming its own root office as a colleague", () => {
  const scratch = mkdtempSync(join(tmpdir(), "claude-harness-policy-"));
  try {
    const policyPath = join(scratch, "policy.json");
    writeFileSync(
      policyPath,
      JSON.stringify({
        type: "ClaudeAgentHarnessProjection",
        actor: "urn:ame:test-actor",
        rootOffice: "test-office",
        colleagueOffices: ["content/offices/test-office.json"],
        ...seatings(),
      }),
    );
    const policy = loadPolicy(policyPath);
    assert.deepEqual(colleagueIds(policy), ["test-office"]);
    assert.throws(() => projectClaudeHarness({ policyPath, repoRoot: scratch }), /rootOffice/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("loadPolicy refuses a colleague office with no seating reference", () => {
  const scratch = mkdtempSync(join(tmpdir(), "claude-harness-policy-"));
  try {
    const policyPath = join(scratch, "policy.json");
    writeFileSync(
      policyPath,
      JSON.stringify({
        type: "ClaudeAgentHarnessProjection",
        actor: "urn:ame:test-actor",
        rootOffice: "test-root-office",
        colleagueOffices: ["content/offices/test-office.json"],
        colleagueSeatings: {},
        rootSeating: { character: "content/character.json", incumbency: "content/incumbencies/root.json" },
      }),
    );
    assert.throws(() => loadPolicy(policyPath), /names no seating .*for colleague office 'test-office'/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("loadPolicy refuses a policy with no colleagueOffices", () => {
  const scratch = mkdtempSync(join(tmpdir(), "claude-harness-policy-"));
  try {
    const policyPath = join(scratch, "policy.json");
    writeFileSync(
      policyPath,
      JSON.stringify({ type: "ClaudeAgentHarnessProjection", actor: "urn:ame:test-actor", rootOffice: "test-office", colleagueOffices: [] }),
    );
    assert.throws(() => loadPolicy(policyPath), /nonempty/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

// .claude/agents/ is one shared directory a node's whole roster of
// independent offices populates, not a location one policy owns exclusively.
// A colleague another policy installed must never read as this policy's
// drift — reproduces the real bug found dogfooding this harness against
// /home/emsenn/info, where an unrelated office's obsmetrologia-consultant.md
// made checkExactRoster refuse a roster that was, in fact, exactly installed.
test("checkExactRoster ignores an unrelated agent installed by another policy", () => {
  const scratch = mkdtempSync(join(tmpdir(), "claude-harness-check-"));
  try {
    const policyPath = join(scratch, "policy.json");
    writeFileSync(
      policyPath,
      JSON.stringify({
        type: "ClaudeAgentHarnessProjection",
        actor: "urn:ame:test-actor",
        rootOffice: "test-root-office",
        colleagueOffices: ["content/offices/test-office.json"],
        ...seatings(),
      }),
    );
    const agentDir = join(scratch, ".claude/agents");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(scratch, ".claude/.claude-agent-manifest"), "test-office\nunrelated-office\n");
    writeFileSync(join(agentDir, "test-office.md"), "# test office\n");
    writeFileSync(join(agentDir, "unrelated-office.md"), "# an unrelated office installed by a different policy\n");
    const result = checkExactRoster({ policyPath, repoRoot: scratch });
    assert.deepEqual(result.colleagues, ["test-office"]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

// The inverse of the shared-directory case: a policy that declares it owns
// its target's agent directory (the single projecting policy there) gets
// exact-set semantics — a seated colleague it never named is drift, found
// dogfooding against /home/emsenn/info where an off-policy seat passed the
// subset check silently for two days.
test("checkExactRoster under ownsAgentDirectory refuses a seated colleague the policy never named", () => {
  const scratch = mkdtempSync(join(tmpdir(), "claude-harness-check-"));
  try {
    const policyPath = join(scratch, "policy.json");
    writeFileSync(
      policyPath,
      JSON.stringify({
        type: "ClaudeAgentHarnessProjection",
        actor: "urn:ame:test-actor",
        rootOffice: "test-root-office",
        ownsAgentDirectory: true,
        colleagueOffices: ["content/offices/test-office.json"],
        ...seatings(),
      }),
    );
    const agentDir = join(scratch, ".claude/agents");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(scratch, ".claude/.claude-agent-manifest"), "test-office\noff-policy-office\n");
    writeFileSync(join(agentDir, "test-office.md"), "# test office\n");
    writeFileSync(join(agentDir, "off-policy-office.md"), "# a seat the owning policy never named\n");
    assert.throws(() => checkExactRoster({ policyPath, repoRoot: scratch }), /seats colleagues the owning policy never named: off-policy-office/);
    writeFileSync(join(scratch, ".claude/.claude-agent-manifest"), "test-office\n");
    assert.throws(() => checkExactRoster({ policyPath, repoRoot: scratch }), /agent files at .* exist for colleagues the owning policy never named: off-policy-office/);
    rmSync(join(agentDir, "off-policy-office.md"));
    const result = checkExactRoster({ policyPath, repoRoot: scratch });
    assert.deepEqual(result.colleagues, ["test-office"]);
    assert.equal(result.ownsAgentDirectory, true);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("checkExactRoster still refuses a colleague that never actually installed", () => {
  const scratch = mkdtempSync(join(tmpdir(), "claude-harness-check-"));
  try {
    const policyPath = join(scratch, "policy.json");
    writeFileSync(
      policyPath,
      JSON.stringify({
        type: "ClaudeAgentHarnessProjection",
        actor: "urn:ame:test-actor",
        rootOffice: "test-root-office",
        colleagueOffices: ["content/offices/test-office.json"],
        ...seatings(),
      }),
    );
    assert.throws(() => checkExactRoster({ policyPath, repoRoot: scratch }), /missing from the manifest/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

// office + character + recognition + induction = officer: a colleague office
// named in colleagueOffices with a structurally-valid colleagueSeatings entry
// (so loadPolicy accepts the policy) but whose incumbency record does not
// actually exist at repoRoot is still a bare office at project time, and
// projectClaudeHarness — which alone holds repoRoot to resolve the seating
// paths — refuses it rather than dispatching an uncharactered subagent.
test("projectClaudeHarness refuses a colleague office whose incumbency does not resolve", () => {
  const scratch = mkdtempSync(join(tmpdir(), "claude-harness-project-"));
  try {
    const policyPath = join(scratch, "policy.json");
    writeFileSync(
      policyPath,
      JSON.stringify({
        type: "ClaudeAgentHarnessProjection",
        actor: "urn:ame:test-actor",
        rootOffice: "test-root-office",
        colleagueOffices: ["content/offices/test-office.json"],
        ...seatings(),
      }),
    );
    mkdirSync(join(scratch, "content/offices"), { recursive: true });
    writeFileSync(join(scratch, "content/offices/test-office.json"), JSON.stringify({ kind: "office", id: "test-office" }));
    // The seating check is required to trip before any office is ever
    // spawned to the installer, so a stub installer is seated here purely to
    // let execution reach that check — resolveOfficeProjector runs first and
    // would otherwise refuse the scratch repoRoot as an ⊥ absence of its own,
    // which is not the refusal this test is about.
    stubInstaller(scratch, "");
    // The root seat is genuinely seated, so the only bare office here is the
    // colleague — this refusal names the colleague and nothing else.
    seatRoot(scratch);
    // Deliberately no content/incumbencies/test-office-as-test-office.json —
    // the seating reference names a record that was never actually seated.
    assert.throws(
      () => projectClaudeHarness({ policyPath, repoRoot: scratch }),
      /colleague office 'test-office' has no incumbency record seated at .*refusing to project a bare office with no officer behind it/s,
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

// The positive case: a colleague office backed by a real incumbency record
// (office matches) and a real character record (kind "session", id matches
// the incumbency's holder) projects — the projector hands the installer both
// paths via --character/--incumbency so it can render the animation framing.
test("projectClaudeHarness projects a colleague office that is seated", () => {
  const scratch = mkdtempSync(join(tmpdir(), "claude-harness-project-"));
  try {
    const policyPath = join(scratch, "policy.json");
    writeFileSync(
      policyPath,
      JSON.stringify({
        type: "ClaudeAgentHarnessProjection",
        actor: "urn:ame:test-actor",
        rootOffice: "test-root-office",
        colleagueOffices: ["content/offices/test-office.json"],
        ...seatings(),
      }),
    );
    mkdirSync(join(scratch, "content/offices"), { recursive: true });
    writeFileSync(join(scratch, "content/offices/test-office.json"), JSON.stringify({ kind: "office", id: "test-office" }));
    mkdirSync(join(scratch, "content/characters"), { recursive: true });
    writeFileSync(
      join(scratch, "content/characters/test-office.json"),
      JSON.stringify({ id: "test-office-session", name: "Test office session", kind: "session", disposition: "Does the test thing." }),
    );
    mkdirSync(join(scratch, "content/incumbencies"), { recursive: true });
    writeFileSync(
      join(scratch, "content/incumbencies/test-office-as-test-office.json"),
      JSON.stringify({
        id: "test-office-session-as-test-office",
        office: "test-office",
        holder: "test-office-session",
        recognition: "t",
        induction: "t",
        from: "2026-07-30",
      }),
    );
    // The real installer instrument is not present under this scratch
    // repoRoot; stand in a stub at the exact repository shape
    // resolveOfficeProjector requires, so this test exercises
    // projectClaudeHarness's own seating logic without invoking the real
    // installer (that instrument's behavior is exercised by its own tests).
    stubInstaller(scratch);
    // The root office is subject to the same law as its colleagues, so a
    // policy only projects at all once its own root seat is really seated.
    seatRoot(scratch);
    const result = projectClaudeHarness({ policyPath, repoRoot: scratch, dryRun: true });
    assert.deepEqual(result.colleagues, ["test-office"]);
    assert.equal(result.receipts.length, 1);
    assert.match(result.receipts[0], /--character .*content[/\\]characters[/\\]test-office\.json/);
    assert.match(result.receipts[0], /--incumbency .*content[/\\]incumbencies[/\\]test-office-as-test-office\.json/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

// The root office is an office like any other: office + character +
// recognition + induction = officer applies to the seat a session already
// holds exactly as it applies to the seats it dispatches to. rootSeating was
// checked only for structural presence (loadPolicy) and its records were
// never resolved, so a root pair naming an incumbency that was never seated
// projected cleanly — the same bare-office flattening
// harness-seats-bare-offices-without-incumbency was raised against, surviving
// in the one seat nobody checked.
test("projectClaudeHarness refuses a root office whose incumbency does not resolve", () => {
  const scratch = mkdtempSync(join(tmpdir(), "claude-harness-root-"));
  try {
    const policyPath = join(scratch, "policy.json");
    writeFileSync(
      policyPath,
      JSON.stringify({
        type: "ClaudeAgentHarnessProjection",
        actor: "urn:ame:test-actor",
        rootOffice: "test-root-office",
        colleagueOffices: ["content/offices/test-office.json"],
        ...seatings(),
      }),
    );
    // The colleague is fully seated, so nothing here is refusable except the
    // root — whatever refusal comes back is about the root pair or is a bug.
    seatColleague(scratch);
    stubInstaller(scratch);
    // Deliberately no content/incumbencies/root.json and no
    // content/character.json — rootSeating names records never seated.
    assert.throws(
      () => projectClaudeHarness({ policyPath, repoRoot: scratch, dryRun: true }),
      /root office 'test-root-office' has no incumbency record seated at .*refusing to project a bare office with no officer behind it/s,
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

// The mismatch half of the same law at the root: an incumbency that resolves
// and seats the right office, but whose holder is not the character the
// rootSeating names, is two records that were never a single officer.
test("projectClaudeHarness refuses a root office whose incumbency holder is not the seated character", () => {
  const scratch = mkdtempSync(join(tmpdir(), "claude-harness-root-"));
  try {
    const policyPath = join(scratch, "policy.json");
    writeFileSync(
      policyPath,
      JSON.stringify({
        type: "ClaudeAgentHarnessProjection",
        actor: "urn:ame:test-actor",
        rootOffice: "test-root-office",
        colleagueOffices: ["content/offices/test-office.json"],
        ...seatings(),
      }),
    );
    seatColleague(scratch);
    stubInstaller(scratch);
    seatRoot(scratch, { holder: "some-other-session", characterId: "test-root-session" });
    assert.throws(
      () => projectClaudeHarness({ policyPath, repoRoot: scratch, dryRun: true }),
      /carries id 'test-root-session', not incumbency holder 'some-other-session' — refusing to project a bare office with no officer behind it/,
    );
    // And the third clause of the same law: a character that resolves and
    // matches, but is not a session, is not a dispatchable officer either.
    seatRoot(scratch, { kind: "person" });
    assert.throws(
      () => projectClaudeHarness({ policyPath, repoRoot: scratch, dryRun: true }),
      /is kind 'person', not 'session' — refusing to project a bare office with no officer behind it/,
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});


/** Receiving: a non-Bare-Cedar-Fog repository calls the *actual* source-owned
 * installer, not a stub at the legacy absolute tree shape. Office, character,
 * and incumbency are real fixture records; the skill comes from a separately
 * selected projected pool that the ordinary recursive scan must ignore.
 */
test("portable owner installer receives seated office and independently projected skill", () => {
  const scratch = mkdtempSync(join(tmpdir(), "claude-harness-portable-"));
  try {
    seatColleague(scratch);
    seatRoot(scratch);
    const officePath = join(scratch, "content/offices/test-office.json");
    writeFileSync(officePath, JSON.stringify({
      kind: "office", id: "test-office", name: "Test Office",
      "normative-structure": "Discharge the verified fixture duty.",
      "provides-skill": ["verified-test"]
    }));
    const skillPool = join(scratch, "projected-pool");
    mkdirSync(join(skillPool, "verified-test"), { recursive: true });
    writeFileSync(join(skillPool, "verified-test", "SKILL.md"),
      "---\nname: verified-test\ndescription: Portable source-backed skill.\n---\n\nPortable source-backed skill body.\n");
    symlinkSync(skillPool, join(scratch, "aliased-projected-pool"), "dir");
    const policyPath = join(scratch, "policy.json");
    writeFileSync(policyPath, JSON.stringify({
      type: "ClaudeAgentHarnessProjection", actor: "urn:ame:test-actor",
      rootOffice: "test-root-office",
      colleagueOffices: ["content/offices/test-office.json"],
      ...seatings(), skillPools: ["projected-pool", "aliased-projected-pool"]
    }));
    const receiving = projectClaudeHarness({ policyPath, repoRoot: scratch });
    assert.deepEqual(receiving.colleagues, ["test-office"]);
    assert.equal(receiving.receipts.length, 1);
    const agentPath = join(scratch, ".claude/agents/test-office.md");
    const accepted = readFileSync(agentPath, "utf8");
    assert.match(accepted, /Portable source-backed skill body\./);
    assert.match(accepted, /test-office-session/);
    assert.equal(accepted.split("### verified-test").length, 2, "aliased pools provide one skill");
    assert.deepEqual(checkExactRoster({ policyPath, repoRoot: scratch }).colleagues, ["test-office"]);
    const next = projectClaudeHarness({ policyPath, repoRoot: scratch });
    assert.equal(next.receipts.length, 1);
    assert.equal(readFileSync(agentPath, "utf8"), accepted, "repeating installation preserves exact projection");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("portable projection refuses to invent an unseated colleague", () => {
  const scratch = mkdtempSync(join(tmpdir(), "claude-harness-portable-refusal-"));
  try {
    seatRoot(scratch);
    mkdirSync(join(scratch, "content/offices"), { recursive: true });
    writeFileSync(join(scratch, "content/offices/test-office.json"),
      JSON.stringify({ kind: "office", id: "test-office", name: "Unseated Office" }));
    const policyPath = join(scratch, "policy.json");
    writeFileSync(policyPath, JSON.stringify({
      type: "ClaudeAgentHarnessProjection", actor: "urn:ame:test-actor",
      rootOffice: "test-root-office",
      colleagueOffices: ["content/offices/test-office.json"], ...seatings()
    }));
    assert.throws(() => projectClaudeHarness({ policyPath, repoRoot: scratch }),
      /colleague office 'test-office' has no incumbency record/);
    assert.throws(() => readFileSync(join(scratch, ".claude/agents/test-office.md"), "utf8"),
      { code: "ENOENT" });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
