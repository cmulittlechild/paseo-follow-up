import test from "node:test";
import assert from "node:assert/strict";
import { announcesUpdate, parseChangelog, quietRelease, recentUpdate, whatsNew, type WhatsNewInput } from "../shared/changelog";
import { compareVersions } from "../shared/version";

// Invariant (whats-new-after-every-stable-update): What's new opens after a stable update that brings new release notes, unless the switch is off; betas never do.
// New notes means a CHANGELOG section newer than the version the device last saw; with none, no sheet ("no-notes").
// It opens once per device (a major's rc carries the major's section and counts as its release). A first install, onboarding, a downgrade, a beta and the
// switch off are recorded quietly; the switch off records the installed version, so turning it back on never brings
// old notes. whatsNew in shared/changelog.ts is the one rule; the grid below enforces it.
// Home's "Follow-up X is available" line is a separate notice and stays major-only (update-notice-major-only,
// announcesUpdate, tests/updater.test.ts).

const VERSIONS = ["1.3.0", "1.4.0-beta.0", "1.4.0-beta.28", "1.4.0-beta.29", "1.4.0", "1.4.1", "1.5.0", "2.0.0-beta.0", "2.0.0-beta.1", "2.0.0", "2.0.1", "2.1.0-beta.0", "2.1.0", "3.0.0"];
// Stables carry notes, betas none: what a real CHANGELOG.md holds.
const STABLE = VERSIONS.filter(v => !quietRelease(v));
const notes = parseChangelog(STABLE.map(v => `## ${v} (2026-11-10)\n\n- Note for ${v}.`).join("\n\n"));
const at = (from: string | null, to: string, o: Partial<WhatsNewInput> = {}) => whatsNew({ installed: to, deviceSeen: from, previous: from, onboarding: false, notes, ...o });

test("fixture (2026-11-10): beta.28 to beta.29 opens no What's new sheet", () => {
  assert.deepEqual(at("1.4.0-beta.28", "1.4.0-beta.29"), { show: false, reason: "prerelease", record: "1.4.0-beta.29" }, "recorded silently");
});

test("a major, a minor and a patch update each open What's new with the notes since the device last looked", () => {
  for (const [from, to, want] of [["1.4.0", "2.0.0", "2.0.0,1.5.0,1.4.1"], ["2.0.1", "2.1.0", "2.1.0"], ["2.0.0", "2.0.1", "2.0.1"], ["2.1.0-beta.0", "2.1.0", "2.1.0"]] as const) {
    const d = at(from, to);
    assert.ok(d.show, `${from} -> ${to} shows`);
    assert.equal(d.notes.map(n => n.version).join(), want, `${from} -> ${to}`);
  }
});

test("quiet cases: first install, onboarding, downgrade, seen, beta, no notes, and the setting off", () => {
  assert.deepEqual(at(null, "2.1.0"), { show: false, reason: "first-run", record: "2.1.0" });
  assert.deepEqual(at("2.0.0", "2.1.0", { onboarding: true }), { show: false, reason: "onboarding", record: null });
  assert.deepEqual(at("2.1.0", "2.0.1"), { show: false, reason: "older", record: "2.0.1" });
  assert.deepEqual(at("2.1.0", "2.1.0"), { show: false, reason: "seen", record: null });
  assert.deepEqual(at("2.0.1", "2.1.0-beta.0"), { show: false, reason: "prerelease", record: "2.1.0-beta.0" });
  assert.deepEqual(at("2.0.0", "2.0.1", { notes: [] }), { show: false, reason: "no-notes", record: "2.0.1" });
  const older = notes.filter(n => n.version === "2.0.0" || n.version === "1.5.0");
  assert.deepEqual(at("2.0.0", "2.0.1", { notes: older }), { show: false, reason: "no-notes", record: "2.0.1" }, "a stable with no section newer than the device's last seen version: no sheet");
  assert.deepEqual(at("2.0.0", "2.1.0", { enabled: false }), { show: false, reason: "off", record: "2.1.0" }, "off: no sheet, the version is recorded");
  assert.ok(at("2.1.0", "3.0.0", { enabled: true }).show, "on again: only versions after the recorded one");
  assert.deepEqual(at("2.1.0", "2.1.0", { enabled: true }), { show: false, reason: "seen", record: null }, "turning it back on brings no old notes");
});

test("grid: a sheet opens exactly for a newer stable with notes, the setting on, onboarding done; everything else is recorded", () => {
  for (const enabled of [true, false]) for (const from of VERSIONS) for (const to of VERSIONS) {
    const d = at(from, to, { enabled });
    const newer = compareVersions(to, from) > 0;
    assert.equal(d.show, enabled && newer && !quietRelease(to), `${from} -> ${to} (${enabled ? "on" : "off"})`);
    if (!d.show && compareVersions(to, from) !== 0) assert.equal(d.record, to, `${from} -> ${to} is recorded`);
  }
});

test("announcesUpdate (Home's available-update line): a major counts when it is released, so beta-channel users still see 2.0", () => {
  assert.equal(announcesUpdate("1.4.0-beta.29", "2.0.0"), true);
  assert.equal(announcesUpdate("1.4.0", "2.0.0-beta.0"), false, "a 2.0 beta is not 2.0 yet");
  assert.equal(announcesUpdate("2.0.0-beta.1", "2.0.0"), true, "the 2.0 beta channel still gets the 2.0 line");
  assert.equal(announcesUpdate("2.0.0", "2.1.0-beta.0"), false);
  assert.equal(announcesUpdate("1.4.0", "1.5.0"), false);
  assert.equal(announcesUpdate("2.0.0", "1.4.0"), false, "a downgrade");
  assert.equal(announcesUpdate(null, "2.0.0"), false, "a first install");
});

test("Home's 'Updated to X · What's new' needs notes of X's own", () => {
  const view = { version: "1.4.0-beta.30", previous: "1.4.0-beta.29", updatedAt: 0, notes };
  assert.equal(recentUpdate(view, 1), false, "a beta without its own notes says plain 'Follow-up X · Release notes'");
  assert.equal(recentUpdate({ ...view, version: "2.0.0" }, 1), true);
});
