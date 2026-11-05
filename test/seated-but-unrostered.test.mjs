// verifySeatings's reverse gate: a dignitas incumbency naming an office absent
// from colleagueOffices (and distinct from rootOffice) must refuse. Moved
// here from bare-cedar-fog-claude-services-section (2026-09-04): seating
// verification lives once upstream of both harness drivers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifySeatings } from "../src/projector.mjs";

function writeIncumbency(dir, file, fields) {
  writeFileSync(join(dir, file), JSON.stringify({ id: file.replace(/\.json$/u, ""), holder: "some-session", from: "2026-01-01", ...fields }));
}

test("refuses a dignitas incumbency whose office is absent from colleagueOffices", () => {
  const scratch = mkdtempSync(join(tmpdir(), "seated-but-unrostered-"));
  try {
    writeIncumbency(scratch, "seated-office-a.json", { office: "office-a", recognition: "t", induction: "t" });
    const policy = { rootOffice: "root-office", colleagueOffices: [], colleagueSeatings: {} };
    assert.throws(
      () => verifySeatings({ policy, repoRoot: scratch, incumbenciesDir: scratch }),
      /seated-but-unrostered: office 'office-a'/,
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("passes when a dignitas incumbency's office is on the roster", () => {
  const scratch = mkdtempSync(join(tmpdir(), "seated-but-unrostered-"));
  try {
    writeFileSync(join(scratch, "office-a-character.json"), JSON.stringify({ id: "office-a-holder", kind: "session" }));
    writeIncumbency(scratch, "office-a-incumbency.json", { office: "office-a", holder: "office-a-holder", recognition: "t", induction: "t" });
    const policy = {
      rootOffice: "root-office",
      colleagueOffices: ["content/offices/office-a.json"],
      colleagueSeatings: { "office-a": { character: "office-a-character.json", incumbency: "office-a-incumbency.json" } },
    };
    assert.doesNotThrow(() => verifySeatings({ policy, repoRoot: scratch, incumbenciesDir: scratch }));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("does not flag the rootOffice's own incumbency even though it is never a colleague", () => {
  const scratch = mkdtempSync(join(tmpdir(), "seated-but-unrostered-"));
  try {
    writeIncumbency(scratch, "seated-root.json", { office: "root-office", recognition: "t", induction: "t" });
    const policy = { rootOffice: "root-office", colleagueOffices: [], colleagueSeatings: {} };
    assert.doesNotThrow(() => verifySeatings({ policy, repoRoot: scratch, incumbenciesDir: scratch }));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("does not flag an unrostered office whose incumbency has not settled to dignitas", () => {
  const scratch = mkdtempSync(join(tmpdir(), "seated-but-unrostered-"));
  try {
    writeIncumbency(scratch, "half-seated.json", { office: "office-c", recognition: "t", induction: "bottom" });
    const policy = { rootOffice: "root-office", colleagueOffices: [], colleagueSeatings: {} };
    assert.doesNotThrow(() => verifySeatings({ policy, repoRoot: scratch, incumbenciesDir: scratch }));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("ignores only a foreign office under its full nested source root", () => {
  const scratch = mkdtempSync(join(tmpdir(), "seated-but-unrostered-"));
  try {
    const foreignRoot = "lib/emsenn/services/561-group/services/561-group-services-section/services/561-group-computer-services-section/services/computer-machine-services-section/services/persistent-computer-machine-services-section/services/bare-cedar-fog-services-section/services/bare-cedar-fog-inference-services-section/services/bare-cedar-fog-claude-services-section/content/offices";
    writeIncumbency(scratch, "foreign.json", { office: "foreign-office", recognition: "t", induction: "t", "x-provenance": { "office-source": `${foreignRoot}/foreign.json` } });
    writeIncumbency(scratch, "own.json", { office: "own-office", recognition: "t", induction: "t", "x-provenance": { "office-source": `${foreignRoot}-backup/own.json` } });
    const policy = { rootOffice: "root-office", colleagueOffices: [], colleagueSeatings: {} };
    assert.throws(() => verifySeatings({ policy, repoRoot: scratch, incumbenciesDir: scratch, foreignOfficeSourceRoots: [foreignRoot] }), /seated-but-unrostered: office 'own-office'/);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test("refuses a settled unrostered office with missing or outside provenance", () => {
  const scratch = mkdtempSync(join(tmpdir(), "seated-but-unrostered-"));
  try {
    writeIncumbency(scratch, "unscoped.json", { office: "unscoped-office", recognition: "t", induction: "t" });
    const policy = { rootOffice: "root-office", colleagueOffices: [], colleagueSeatings: {} };
    assert.throws(() => verifySeatings({ policy, repoRoot: scratch, incumbenciesDir: scratch, foreignOfficeSourceRoots: ["services/foreign/offices"] }), /seated-but-unrostered: office 'unscoped-office'/);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test("refuses absolute and escaping foreign office roots", () => {
  const scratch = mkdtempSync(join(tmpdir(), "seated-but-unrostered-"));
  try {
    const policy = { rootOffice: "root-office", colleagueOffices: [], colleagueSeatings: {} };
    assert.throws(() => verifySeatings({ policy, repoRoot: scratch, incumbenciesDir: scratch, foreignOfficeSourceRoots: [scratch] }), /repository-relative/);
    assert.throws(() => verifySeatings({ policy, repoRoot: scratch, incumbenciesDir: scratch, foreignOfficeSourceRoots: ["../escape"] }), /repository-relative/);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
