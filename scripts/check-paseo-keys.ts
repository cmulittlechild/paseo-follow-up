// Manual release check. Packs latest and beta into disposable directories; never installs or reloads Paseo.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CATCH_UP_KEYS } from "../shared/catch-up";
import { HOME_KEYS } from "../shared/home-keys";
import { PASEO_BOUND, SEARCH_SHORTCUTS, shortcutCombos } from "../shared/search-key";
import { extractPaseoCombos, keyConflicts, normalizeCombos } from "../shared/paseo-keys";

const exec = promisify(execFile);
const followUp = normalizeCombos([
  ...SEARCH_SHORTCUTS.flatMap(shortcutCombos),
  ...CATCH_UP_KEYS.flatMap(k => k.combos),
  ...HOME_KEYS.flatMap(k => k.combos ?? []),
]).filter(c => /^(Cmd|Ctrl|Alt|Shift)\+/.test(c));
let failed = false;
for (const tag of ["latest", "beta"]) {
  const dir = await mkdtemp(join(tmpdir(), "follow-up-paseo-keys-"));
  try {
    const { stdout } = await exec("npm", ["pack", `@getpaseo/server@${tag}`, "--json", "--ignore-scripts"], { cwd: dir, timeout: 180_000, maxBuffer: 4 * 1024 * 1024 });
    const [packed] = JSON.parse(stdout) as { filename: string; version: string }[];
    // npm supplies the filename; require a leaf so extraction always stays in this scratch directory.
    if (!packed || !/^[\w.-]+\.tgz$/.test(packed.filename)) throw new Error("npm pack returned no valid archive");
    await exec("tar", ["-xzf", packed.filename], { cwd: dir, timeout: 30_000 });
    const web = join(dir, "package/dist/server/web-ui/_expo/static/js/web");
    const bundles = (await readdir(web)).filter(name => /^index-.*\.js$/.test(name));
    const actual = normalizeCombos((await Promise.all(bundles.map(async name => extractPaseoCombos(await readFile(join(web, name), "utf8"))))).flat());
    if (!actual.length) throw new Error("no combo declarations found; inspect Paseo's bundle layout/extractor");
    const { collisions, additions } = keyConflicts(actual, PASEO_BOUND, followUp);
    console.log(`${tag} ${packed.version}: ${actual.length} normalized combos; ${collisions.length} collisions; ${additions.length} new vs PASEO_BOUND`);
    if (collisions.length) console.error(`Follow-up collisions: ${collisions.join(", ")}`);
    if (additions.length) console.error(`Refresh PASEO_BOUND with: ${additions.join(", ")}`);
    if (collisions.length || additions.length) failed = true;
  } catch (error) {
    // Avoid printing subprocess stderr: failures must not leak environment or local machine details.
    console.error(`${tag}: could not inspect the npm package (${error instanceof Error ? error.name : "error"}); retry or inspect the bundle manually`);
    failed = true;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
process.exitCode = failed ? 1 : 0;
