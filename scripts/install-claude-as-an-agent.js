#!/usr/bin/env node
// install-claude-as-an-agent — install ONE office into ONE node of the tree as a
// SUBAGENT: a single file at <node>/.claude/agents/<office-id>.md.
//
// The office is the source; the agent file is the output, a deterministic
// projection of the office's record and skills:
//
//   1. the frontmatter (name, description) is generated from the record
//   2. the body is the office speaking — its normative structure, position,
//      deontic profile, and duties
//   3. every skill that realizes a duty the office records, every skill the
//      record provides, and every skill seated under the office, is projected
//      IN FULL into the body, so the agent starts holding them
//
// Skills project into the body rather than seating in <node>/.claude/skills/
// because the harness has one shared skill registry per node: anything seated
// there enters the MAIN session's context, and the one flag that removes a
// skill from the main session (`disable-model-invocation: true`) removes it
// from every agent too. Per-agent skill registration does not exist; projection
// is the same preload, done by generation, cluttering nothing. Scripts are NOT
// copied — a skill's text names its scripts by repo path, and the agent runs
// them where they seat.
//
// Closure-kind: process. No branching on surprise — every unmet precondition
// exits non-zero with the reason. Same office and node produce the same agent.
//
// usage:
//   install-claude-as-an-agent.js <office> <node> [--dry-run]
//   install-claude-as-an-agent.js <office> <node> --list
//   install-claude-as-an-agent.js <office> <node> --clean
//   install-claude-as-an-agent.js <office> <node> --reinstall
//   install-claude-as-an-agent.js <office> <node> --character <path> --incumbency <path>
//   install-claude-as-an-agent.js <office> <node> --skills-pool <dir> [--skills-pool <dir> ...]
//
// <office> is a path to an office record or office directory, or a bare office
// id resolved from where you stand: the nearest office of that id by filesystem
// distance wins. Where you stand is the working directory, or --from <path>.
//
// <node> is the directory whose .claude/agents/ receives the agent — a path, or
// omitted to mean the repo root.
//
// --character <path> --incumbency <path> are optional and always paired: a
// character record (kind "session") and the incumbency record that seats it
// in this <office>. When given, the rendered body opens with animation
// framing instead of asserting the office as an identity the agent holds —
// office + character + recognition + induction = officer, and a projection
// that skipped the character and incumbency would be seating a bare office
// again. Without them, rendering is unchanged (other callers project offices
// with no seating record yet).

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

const REPO_ROOT = argValue("--root") ?? "/home/emsenn/info";
const DRY_RUN = process.argv.includes("--dry-run");
// --skills-pool <dir> (repeatable) adds a directory of <skill>/SKILL.md to the
// skills pools. It is how a node whose skills are only projected (an exporter's
// .claude/skills output) names them; the walk still skips `.claude`.
const EXTRA_SKILL_POOLS = process.argv.flatMap((a, i) => (a === "--skills-pool" ? [resolve(REPO_ROOT, process.argv[i + 1] ?? "")] : []));
const STANDPOINT = resolve(argValue("--from") ?? process.cwd());

// Directories that are never part of an office's own record, and never a pool.
// `.claude` is excluded because it is output — output is never evidence about
// the record.
const SKIP_DIRS = new Set([
  "fixtures",
  "node_modules",
  ".git",
  ".claude",
  "dist",
  "build",
  "archive",
  "_archive",
  "triage",
  "preservation",
]);

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

function die(message) {
  console.error(`install-claude-as-an-agent: ${message}`);
  process.exit(1);
}

function rel(p) {
  return relative(REPO_ROOT, p) || ".";
}

// --- pools: rosters, duty pools, skill pools ---------------------------------

const POOL_CACHE = {};

function pools(name) {
  if (POOL_CACHE[name]) return POOL_CACHE[name];
  const found = [];
  (function walk(dir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      const child = join(dir, entry.name);
      if (entry.name === name) found.push(child);
      else walk(child);
    }
  })(REPO_ROOT);
  POOL_CACHE[name] = found;
  return found;
}

function distanceFrom(standpoint, target) {
  const r = relative(standpoint, target);
  return r === "" ? 0 : r.split("/").length;
}

// Nearest wins; only a true tie is refused.
function nearest(kind, id, seats, standpoint) {
  const ranked = seats
    .map((path) => ({ path, distance: distanceFrom(standpoint, path) }))
    .sort((a, b) => a.distance - b.distance);
  if (ranked.length > 1 && ranked[0].distance === ranked[1].distance) {
    die(
      `${kind} '${id}' seats at two places equidistant from ${rel(standpoint)} — nothing decides between them:\n` +
        ranked
          .filter((s) => s.distance === ranked[0].distance)
          .map((s) => `  ${rel(s.path)}`)
          .join("\n") +
        `\nName it by path, or stand somewhere that decides.`,
    );
  }
  return ranked[0].path;
}

// --- frontmatter ---------------------------------------------------------------

function frontmatter(file) {
  if (!existsSync(file)) return undefined;
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(file, "utf8"));
  return match ? match[1] : undefined;
}

function frontmatterValue(file, key) {
  const fm = frontmatter(file);
  if (!fm) return undefined;
  const match = new RegExp(`^${key}:[ \\t]*(.+)$`, "m").exec(fm);
  return match ? match[1].trim() : undefined;
}

function frontmatterList(file, key) {
  const fm = frontmatter(file);
  if (!fm) return [];
  const inline = new RegExp(`^${key}:[ \\t]*\\[(.*)\\][ \\t]*$`, "m").exec(fm);
  if (inline) return inline[1].split(",").map((s) => s.trim()).filter(Boolean);
  const block = new RegExp(`^${key}:[ \\t]*\\r?\\n((?:[ \\t]*-[ \\t]*.+\\r?\\n?)+)`, "m").exec(fm);
  if (block) {
    return block[1]
      .split("\n")
      .map((l) => l.replace(/^[ \t]*-[ \t]*/, "").trim())
      .filter(Boolean);
  }
  return [];
}

// Reads `key: value` and the block-scalar forms (`key: >` / `key: |` with an
// indented body). Frontmatter here is written by hand in both shapes, so both
// are read; folded lines join with spaces, as YAML folds them.
function frontmatterText(file, key) {
  const fm = frontmatter(file);
  if (!fm) return undefined;
  const block = new RegExp(`^${key}:[ \\t]*[>|][+-]?[ \\t]*\\r?\\n((?:[ \\t]+.*\\r?\\n?|[ \\t]*\\r?\\n)+)`, "m").exec(fm);
  if (block) {
    return block[1]
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .join(" ");
  }
  return frontmatterValue(file, key);
}

function stripFrontmatter(text) {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}

// --- precondition: the argument names an office --------------------------------

// An office seats in a roster in one of three shapes: a bare record
// `offices/<id>.md`, a directory `offices/<id>/` holding `<id>.md`, or a
// canonical record `offices/<id>.schema.json` conforming to emsenn/office.
function officeAt(path) {
  if (existsSync(path) && statSync(path).isDirectory()) {
    const id = basename(path);
    const record = join(path, `${id}.md`);
    if (existsSync(record)) return { id, dir: path, record, seated: true };
    const canonical = join(path, `${id}.schema.json`);
    if (existsSync(canonical)) return { id, dir: path, record: canonical, seated: true, canonical: true };
    return undefined;
  }
  if (path.endsWith(".md") && existsSync(path)) {
    const id = basename(path, ".md");
    return { id, dir: dirname(path), record: path, seated: false };
  }
  if (path.endsWith(".schema.json") && existsSync(path)) {
    const id = basename(path, ".schema.json");
    return { id, dir: dirname(path), record: path, seated: false, canonical: true };
  }
  if (path.endsWith(".json") && existsSync(path)) {
    const id = basename(path, ".json");
    return { id, dir: dirname(path), record: path, seated: false, canonical: true };
  }
  return undefined;
}

function canonicalOffice(office) {
  let spec;
  try {
    spec = JSON.parse(readFileSync(office.record, "utf8"));
  } catch (e) {
    die(`${rel(office.record)} is unreadable: ${e.message}`);
  }
  if (spec.kind !== "office") {
    die(`${rel(office.record)} declares 'kind: ${spec.kind ?? "(nothing)"}' — refusing to install from a non-office.`);
  }
  const claimed = spec.id ?? (typeof spec.$id === "string" ? spec.$id.split("/").pop() : undefined);
  if (claimed !== office.id) {
    die(`${rel(office.record)} carries id '${claimed}' — that is not office '${office.id}'.`);
  }
  return spec;
}

function resolveOffice(arg) {
  if (!arg) {
    die(
      "no office given. usage: install-claude-as-an-agent.js <office> <node> [--dry-run|--list|--clean|--reinstall]",
    );
  }

  let office;
  if (arg.includes("/") || isAbsolute(arg)) {
    const path = isAbsolute(arg) ? arg : resolve(REPO_ROOT, arg);
    office = officeAt(path) ?? officeAt(`${path}.json`) ?? officeAt(`${path}.md`) ?? officeAt(`${path}.schema.json`);
    if (!office) die(`office path '${arg}' is neither an office record nor an office directory.`);
  } else {
    const rosters = pools("offices");
    const seats = rosters
      .flatMap((roster) => [join(roster, arg), join(roster, `${arg}.json`), join(roster, `${arg}.md`), join(roster, `${arg}.schema.json`)])
      .filter((p) => officeAt(p));
    if (seats.length === 0) {
      die(
        `office '${arg}' seats in no roster. Rosters searched:\n  ` +
          (rosters.length ? rosters.map(rel).join("\n  ") : "(none)"),
      );
    }
    office = officeAt(nearest("office", arg, seats, STANDPOINT));
  }

  if (office.canonical) {
    office.spec = canonicalOffice(office);
    return office;
  }
  const type = frontmatterValue(office.record, "type");
  if (type !== "office") {
    die(`${rel(office.record)} declares 'type: ${type ?? "(nothing)"}' — refusing to install from a non-office.`);
  }
  return office;
}

// --- the node --------------------------------------------------------------------

function resolveNode(arg) {
  const dir = arg ? (isAbsolute(arg) ? arg : resolve(process.cwd(), arg)) : REPO_ROOT;
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    die(`node '${arg}' is not a directory. The node is where the agent gets installed; it must already exist.`);
  }
  return dir;
}

// --- optional seating: office + character + recognition + induction = officer -----

// --character and --incumbency are always given together, or not at all: a
// character with no incumbency has no seat, and an incumbency with no
// character has no sitter. Both records are read and cross-checked against
// each other and against the office being installed, so a mismatched pair
// fails loudly here rather than rendering a plausible-looking lie.
function resolveSeating(office) {
  const characterArg = argValue("--character");
  const incumbencyArg = argValue("--incumbency");
  if (!characterArg && !incumbencyArg) return undefined;
  if (!characterArg || !incumbencyArg) {
    die("--character and --incumbency are only ever given together — one was given without the other.");
  }
  const characterPath = isAbsolute(characterArg) ? characterArg : resolve(REPO_ROOT, characterArg);
  const incumbencyPath = isAbsolute(incumbencyArg) ? incumbencyArg : resolve(REPO_ROOT, incumbencyArg);
  if (!existsSync(characterPath)) die(`--character '${rel(characterPath)}' does not exist.`);
  if (!existsSync(incumbencyPath)) die(`--incumbency '${rel(incumbencyPath)}' does not exist.`);

  let character;
  try {
    character = JSON.parse(readFileSync(characterPath, "utf8"));
  } catch (e) {
    die(`--character '${rel(characterPath)}' is unreadable: ${e.message}`);
  }
  let incumbency;
  try {
    incumbency = JSON.parse(readFileSync(incumbencyPath, "utf8"));
  } catch (e) {
    die(`--incumbency '${rel(incumbencyPath)}' is unreadable: ${e.message}`);
  }

  if (character.kind !== "session") {
    die(`--character '${rel(characterPath)}' is kind '${character.kind ?? "(nothing)"}', not 'session' — refusing to animate a non-session character as a subagent.`);
  }
  if (incumbency.office !== office.id) {
    die(`--incumbency '${rel(incumbencyPath)}' seats office '${incumbency.office}', not '${office.id}'.`);
  }
  if (incumbency.holder !== character.id) {
    die(`--incumbency '${rel(incumbencyPath)}' names holder '${incumbency.holder}', which is not character '${character.id}' from --character.`);
  }
  return { character, incumbency, characterPath, incumbencyPath };
}

// --- discovery: the office's duties and skills ------------------------------------

// A canonical office names its duties in `bears-duty`, each by full address
// (`emsenn/duty/<id>`); an older frontmatter office names them bare in
// `duties:`. Same assignment mechanism, two spellings.
function resolveDuties(office) {
  const ids = office.canonical
    ? (Array.isArray(office.spec["bears-duty"]) ? office.spec["bears-duty"] : []).map((a) =>
        a.replace(/^emsenn\/duty\//, ""),
      )
    : frontmatterList(office.record, "duties");
  const all = pools("duties");
  return ids.map((id) => {
    const seats = all
      .flatMap((pool) => [join(pool, `${id}.json`), join(pool, `${id}.schema.json`), join(pool, `${id}.md`), join(pool, id, `${id}.md`)])
      .filter((p) => existsSync(p));
    if (seats.length === 0) {
      die(
        `office '${office.id}' records duty '${id}', which seats in no duties pool. Pools searched:\n  ` +
          (all.length ? all.map(rel).join("\n  ") : "(none)"),
      );
    }
    const record = nearest("duty", id, seats, office.dir);
    if (record.endsWith(".json")) {
      let spec;
      try {
        spec = JSON.parse(readFileSync(record, "utf8"));
      } catch (e) {
        die(`${rel(record)} is unreadable: ${e.message}`);
      }
      const claimedDuty = spec.id ?? (typeof spec.$id === "string" ? spec.$id.split("/").pop() : undefined);
      if (claimedDuty !== id) die(`${rel(record)} carries id '${claimedDuty}' — that is not duty '${id}'.`);
      return { id, record, skills: Array.isArray(spec.skills) ? spec.skills : [], spec };
    }
    const type = frontmatterValue(record, "type");
    if (type !== "duty") die(`${rel(record)} declares 'type: ${type ?? "(nothing)"}' — that is not a duty.`);
    return { id, record, skills: frontmatterList(record, "realized-by-skills") };
  });
}

function resolveSkill(name, namedBy) {
  const all = [...pools("skills"), ...EXTRA_SKILL_POOLS.filter((p) => existsSync(p))];
  // A projected pool may link to the source pool (symlinks): one skill by
  // real path is one seat, however many pools reach it.
  const seats = [...new Map(
    all
      .map((pool) => join(pool, name))
      .filter((d) => existsSync(join(d, "SKILL.md")))
      .map((d) => [realpathSync(d), d]),
  ).values()];
  if (seats.length === 0) {
    die(
      `'${rel(namedBy)}' names skill '${name}', which seats in no skills pool. Pools searched:\n  ` +
        (all.length ? all.map(rel).join("\n  ") : "(none)"),
    );
  }
  return { name, dir: nearest("skill", name, seats, dirname(namedBy)) };
}

// Skills seated under the office itself — only when the office is a directory of
// its own.
function walkForSkills(office) {
  if (!office.seated) return [];
  const skills = [];
  (function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      const child = join(dir, entry.name);
      if (existsSync(join(child, "SKILL.md"))) skills.push({ name: entry.name, dir: child });
      else walk(child);
    }
  })(office.dir);
  return skills;
}

function findSkills(office, duties) {
  const found = new Map();
  const add = (skill) => {
    const prior = found.get(skill.name);
    if (prior && realpathSync(prior.dir) !== realpathSync(skill.dir)) {
      die(
        `office '${office.id}' holds skill '${skill.name}' from two places — one name cannot resolve to two skills:\n` +
          `  ${rel(prior.dir)}\n  ${rel(skill.dir)}`,
      );
    }
    found.set(skill.name, skill);
  };

  for (const skill of walkForSkills(office)) add(skill);
  if (office.canonical) {
    for (const name of Array.isArray(office.spec["provides-skill"]) ? office.spec["provides-skill"] : []) {
      add(resolveSkill(name, office.record));
    }
  }
  for (const duty of duties) {
    for (const name of duty.skills) add(resolveSkill(name, duty.record));
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function checkSkills(skills, office) {
  if (skills.length === 0) {
    die(
      `office '${office.id}' (${rel(office.record)}) has no skills — it records no duties realized by any skill, and holds none of its own. An agent holding nothing can discharge nothing.`,
    );
  }
  for (const skill of skills) {
    const source = join(skill.dir, "SKILL.md");
    const declared = frontmatterValue(source, "name");
    if (!declared) die(`${rel(source)} has no 'name:' in its frontmatter.`);
    if (declared !== skill.name) {
      die(
        `${rel(source)} declares name '${declared}' but sits in directory '${skill.name}'. ` +
          `The directory name is the skill's name; make them agree.`,
      );
    }
  }
}

// --- the projection ------------------------------------------------------------

// A list field of the canonical record, rendered for prose; absent is absent.
function listed(value) {
  if (Array.isArray(value)) return value.length ? value.join(", ") : undefined;
  return value || undefined;
}

// The agent's description tells the delegating session when to hand work here:
// the record's own first sentence, then the duty side of the deontic profile.
function describeCanonical(spec) {
  const first = String(spec["normative-structure"] ?? "").split(/(?<=\.)\s/)[0];
  const dutyKeys = Object.entries(spec["deontic-profile"] ?? {})
    .filter(([, v]) => v === "duty")
    .map(([k]) => k.replaceAll("-", " "));
  const duties = dutyKeys.length ? ` Duties: ${dutyKeys.join("; ")}.` : "";
  return `The ${spec.name} office. ${first}${duties}`;
}

// Without seating: the office is spoken of as an identity the agent holds.
// With seating: office + character + recognition + induction = officer, so
// the opening instead states the four-part fact plainly — the office is the
// seat, the character is the sitter, this animation is one ephemeral turn of
// that character and inherits nothing from it (identityInheritance: false).
// The character's own disposition is included, because that disposition is
// what actually gives the subagent a role to carry, not the office alone.
function animationOpening(office, officeName, seating) {
  const { character, incumbency } = seating;
  return (
    `You are one ephemeral animation of the session character **${character.name}** ` +
    `(\`${character.id}\`, kind \`${character.kind}\`), which is seated in the office of ` +
    `**${officeName}** (\`emsenn/office/${office.id}\`) by incumbency \`${incumbency.id}\` ` +
    `since ${incumbency.from}. The office is the seat; the character is the sitter; this ` +
    `animation is one ephemeral turn of that character and inherits nothing from it ` +
    `(\`identityInheritance: false\`). This file is output, projected from the office's ` +
    `record — \`${rel(office.record)}\` — by installing-claude-as-an-agent. The record is ` +
    `the office; edits here are discarded on the next install.\n\n` +
    `**Disposition of ${character.name}:** ${character.disposition}\n\n`
  );
}

function officeOpening(office, officeName) {
  return (
    `You hold the office of **${officeName}** (\`emsenn/office/${office.id}\`). This file is output, ` +
    `projected from the office's record — \`${rel(office.record)}\` — by ` +
    `installing-claude-as-an-agent. The record is the office; edits here are ` +
    `discarded on the next install.\n\n`
  );
}

function renderAgent(office, duties, skills, seating) {
  const spec = office.spec;
  let description;
  let body;

  if (office.canonical) {
    description = describeCanonical(spec);
    const position = [
      ["part of", listed(spec["part-of"])],
      ["reports to", listed(spec["reports-to"])],
      ["peer offices", listed(spec["peer-offices"])],
      ["jurisdiction", listed(spec.jurisdiction)],
      ["distinguished from", listed(spec["distinguished-from"])],
    ].filter(([, v]) => v);
    const deontic = Object.entries(spec["deontic-profile"] ?? {});
    body =
      `# ${spec.name}\n\n` +
      (seating ? animationOpening(office, spec.name, seating) : officeOpening(office, spec.name)) +
      `## The office\n\n${spec["normative-structure"]}\n\n` +
      (position.length
        ? `## Position\n\n${position.map(([k, v]) => `- ${k}: ${v}`).join("\n")}\n\n`
        : "") +
      (deontic.length
        ? `## Deontic profile\n\n${deontic.map(([k, v]) => `- ${k.replaceAll("-", " ")} — **${v}**`).join("\n")}\n\n`
        : "") +
      (duties.length
        ? `## Duties and their skills\n\n${duties
            .map(
              (d) =>
                `- **${d.id}**` +
                (d.spec?.authority ? ` (authority: ${d.spec.authority}` + (d.spec.claim ? `; claim: ${d.spec.claim}` : "") + `)` : "") +
                (d.skills.length ? ` — discharged by: ${d.skills.join(", ")}` : " — realized by no skill"),
            )
            .join("\n")}\n\n`
        : "") +
      (Array.isArray(spec.unrealized) && spec.unrealized.length
        ? `## Unrealized\n\n${spec.unrealized.map((u) => `- ${u}`).join("\n")}\n\n`
        : "");
  } else {
    description = frontmatterText(office.record, "description");
    if (!description) {
      die(`${rel(office.record)} has no 'description:' in its frontmatter — an agent needs one to be delegated to.`);
    }
    const carried = office.seated ? join(office.dir, "CLAUDE.md") : undefined;
    const spoken = carried && existsSync(carried) ? carried : office.record;
    body =
      (seating ? animationOpening(office, office.id, seating) : "") +
      stripFrontmatter(readFileSync(spoken, "utf8")).trim() +
      "\n\n";
  }

  const skillSection =
    `## Skills\n\n` +
    `The office's skills follow in full — you hold them from session start; there is ` +
    `nothing to invoke. Scripts a skill names seat at their recorded repository paths; ` +
    `run them from the repository root.\n\n` +
    skills
      .map((s) => `### ${s.name}\n\n${stripFrontmatter(readFileSync(join(s.dir, "SKILL.md"), "utf8")).trim()}\n`)
      .join("\n");

  // A canonical record may carry an x-agent block — harness projection hints
  // (model, effort, maxTurns, tools), extension-prefixed because the harness
  // is not doctrine. Absent keys are absent from the frontmatter, so the
  // agent inherits the session's defaults — except model, which defaults to
  // sonnet so dispatched offices run on sonnet unless the record says otherwise.
  const harness = (office.canonical && office.spec["x-agent"]) || {};
  return (
    `---\n` +
    `name: ${office.id}\n` +
    `description: ${JSON.stringify(description)}\n` +
    `model: ${harness.model || "sonnet"}\n` +
    (harness.effort ? `effort: ${harness.effort}\n` : "") +
    (harness.maxTurns ? `maxTurns: ${harness.maxTurns}\n` : "") +
    (Array.isArray(harness.tools) && harness.tools.length ? `tools: ${harness.tools.join(", ")}\n` : "") +
    `---\n\n` +
    body +
    skillSection +
    `\n`
  );
}

// --- manifest: which offices installed agents here, so clean is exact -------------

function manifestPath(node) {
  return join(node, ".claude/.claude-agent-manifest");
}

function readManifest(node) {
  const file = manifestPath(node);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

function writeManifest(node, entries) {
  mkdirSync(dirname(manifestPath(node)), { recursive: true });
  writeFileSync(manifestPath(node), [...entries].sort().map((e) => `${e}\n`).join(""));
}

// A manifest holding no entries is a file that answers no question a
// manifest exists to answer — removed rather than left behind as an empty
// witness, so clean's residue is nothing, not a zero-byte file.
function writeOrRemoveManifest(node, entries) {
  if (entries.length) writeManifest(node, entries);
  else rmSync(manifestPath(node), { force: true });
}

// A directory this mechanism created and then emptied by its own removals
// is removed too — an empty `agents/` left behind is as much residue as a
// stray file; a directory this mechanism did not empty (something else's
// entry still in it) is left untouched.
function removeIfEmptyDir(dir) {
  if (!existsSync(dir)) return;
  if (readdirSync(dir, { withFileTypes: true }).length === 0) rmSync(dir, { recursive: true, force: true });
}

// --- the motions -------------------------------------------------------------------

function agentTarget(node, office) {
  return join(node, ".claude/agents", `${office.id}.md`);
}

function doList(office, node, duties, skills) {
  console.log(`agent\t${rel(office.record)}\t->\t${rel(agentTarget(node, office))}`);
  for (const skill of skills) {
    console.log(`${skill.name}\t${rel(skill.dir)}\t->\t(projected into agent body)`);
  }
}

function doClean(office, node) {
  const manifest = readManifest(node);
  if (!manifest.includes(office.id)) {
    console.log(`install-claude-as-an-agent: office '${office.id}' has no agent installed at ${rel(node)}.`);
    return;
  }
  if (DRY_RUN) {
    console.log(
      `install-claude-as-an-agent: dry run — would remove agent '${office.id}' from ${rel(node)}; nothing was removed.`,
    );
    return;
  }
  rmSync(agentTarget(node, office), { force: true });
  writeOrRemoveManifest(node, manifest.filter((e) => e !== office.id));
  removeIfEmptyDir(join(node, ".claude/agents"));
  console.log(`install-claude-as-an-agent: removed agent '${office.id}' from ${rel(node)}.`);
}

function doInstall(office, node, rendered) {
  const target = agentTarget(node, office);
  const manifest = readManifest(node);

  // An agent file this mechanism did not install is someone else's agent: it has
  // an author whose reasoning is not in any office record, and overwriting it
  // would discard that reasoning silently. Refused, not merged.
  if (existsSync(target) && !manifest.includes(office.id)) {
    die(
      `${rel(target)} already exists and was not installed from office '${office.id}' — ` +
        `refusing to overwrite an agent this mechanism does not answer for. Remove it, or move it aside.`,
    );
  }

  if (DRY_RUN) {
    console.log(`install-claude-as-an-agent: dry run — would install agent '${office.id}' into ${rel(node)}.`);
    return;
  }

  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, rendered);
  console.log(`  installed  agents/${office.id}.md  (${rel(office.record)})`);

  writeManifest(node, [...manifest.filter((e) => e !== office.id), office.id]);

  // Postcondition, checked rather than assumed: the file at the target is
  // byte-identical to the projection of the record.
  if (readFileSync(target, "utf8") !== rendered) {
    die(`postcondition failed: ${rel(target)} differs from the projection of ${rel(office.record)}.`);
  }

  console.log(`install-claude-as-an-agent: installed agent '${office.id}' into ${rel(node)}.`);
}

// --- main ----------------------------------------------------------------------------

const FLAGS_TAKING_VALUE = new Set(["--root", "--from", "--character", "--incumbency", "--skills-pool"]);
const positionals = [];
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg.startsWith("--")) {
    if (FLAGS_TAKING_VALUE.has(arg)) i++;
    continue;
  }
  positionals.push(arg);
}

const office = resolveOffice(positionals[0]);
const node = resolveNode(positionals[1]);

if (process.argv.includes("--clean")) {
  doClean(office, node);
} else {
  const duties = resolveDuties(office);
  const skills = findSkills(office, duties);
  checkSkills(skills, office);
  const seating = resolveSeating(office);
  if (process.argv.includes("--list")) {
    doList(office, node, duties, skills);
  } else {
    if (process.argv.includes("--reinstall")) doClean(office, node);
    doInstall(office, node, renderAgent(office, duties, skills, seating));
  }
}
