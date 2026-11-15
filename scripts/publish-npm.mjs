// Publish once. npm acceptance and registry visibility are separate states.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const VERIFY_TIMEOUT_MS = 45 * 60_000;
export const POLL_INTERVAL_MS = 15_000;
const REGISTRY = "https://registry.npmjs.org/";
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export class PublicationError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/** Revalidate both client/CDN caches, including negative responses, on every probe. */
export async function registryJson(path, { fetch = globalThis.fetch, now = Date.now, timeoutMs = 30_000 } = {}) {
  const url = new URL(path, REGISTRY);
  url.searchParams.set("publication-check", String(now()));
  const response = await fetch(url, { headers: { Accept: "application/json", "Cache-Control": "no-cache", Pragma: "no-cache" }, signal: AbortSignal.timeout(Math.max(1, timeoutMs)) });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Registry GET failed (${response.status}).`);
  return response.json();
}

function reader(deps) {
  return deps.read ?? ((path, remaining = 30_000) => registryJson(path, { fetch: deps.fetch, now: deps.now, timeoutMs: Math.min(30_000, remaining) }));
}

function checkIntegrity(row, integrity, spec) {
  if (row?.dist?.integrity && row.dist.integrity !== integrity) throw new PublicationError("NPM_CONTENT_MISMATCH", `${spec} already exists with different contents. Release a new version; do not rewrite the tag.`);
}

/** A single elapsed-time budget covers integrity AND dist-tag propagation, not an attempt count. */
export async function waitForPublication(pkg, integrity, distTag, deps = {}) {
  const now = deps.now ?? Date.now, sleep = deps.sleep ?? pause, log = deps.log ?? console.log;
  const read = reader(deps), deadline = now() + (deps.timeoutMs ?? VERIFY_TIMEOUT_MS);
  const name = encodeURIComponent(pkg.name), spec = `${pkg.name}@${pkg.version}`;
  let lastLog = -Infinity;
  while (now() < deadline) {
    try {
      const row = await read(`${name}/${encodeURIComponent(pkg.version)}`, deadline - now());
      checkIntegrity(row, integrity, spec);
      if (row?.dist?.integrity === integrity && now() < deadline) {
        const tags = await read(`-/package/${name}/dist-tags`, deadline - now());
        if (distTag === "beta" && tags?.latest === pkg.version) throw new PublicationError("NPM_PRERELEASE_IS_LATEST", `Prerelease ${pkg.version} is tagged latest. Move latest back to the last stable release.`);
        if (tags?.[distTag] === pkg.version) {
          log(`Registry verified: ${spec} has matching integrity and dist-tag ${distTag}.`);
          return;
        }
      }
    } catch (error) {
      if (error instanceof PublicationError) throw error; // Content or channel errors are real failures.
      // Transient network errors, 404s, bad responses and throttling do not revoke npm's acceptance.
    }
    if (now() - lastLog >= 60_000) { log(`Waiting for registry integrity and dist-tag visibility for ${spec}.`); lastLog = now(); }
    const remaining = deadline - now();
    if (remaining > 0) await sleep(Math.min(deps.pollMs ?? POLL_INTERVAL_MS, remaining));
  }
  throw new PublicationError("NPM_ACCEPTED_NOT_VISIBLE", `${spec} was accepted by npm but is not fully visible yet after registry verification timed out. The tag must not be rewritten. Retry verification with the same version and tag; do not cut a replacement version just for this delay.`);
}

// This npm publish targets one exact spec. E403 alone is not proof of acceptance; npm's duplicate-version
// message or EPUBLISHCONFLICT is. If the message names a version, it must be the one we tried to publish.
function previouslyPublished(result, version) {
  const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const duplicate = text.match(/You cannot publish over the previously published versions(?:\s*:\s*([0-9][0-9A-Za-z.+-]*))?/i);
  if (duplicate) return !duplicate[1] || duplicate[1].replace(/\.$/, "") === version;
  return /(?:\bcode\s+|["']code["']\s*:\s*["'])EPUBLISHCONFLICT\b/i.test(text);
}

export async function publishPackage(pkg, deps = {}) {
  const npm = deps.npm ?? (args => spawnSync("npm", args, { encoding: "utf8", timeout: 120_000, maxBuffer: 8 * 1024 * 1024 }));
  const log = deps.log ?? console.log;
  const output = deps.output ?? ((stdout, stderr) => { if (stdout) process.stdout.write(stdout); if (stderr) process.stderr.write(stderr); });
  const spec = `${pkg.name}@${pkg.version}`, distTag = pkg.version.includes("-") ? "beta" : "latest";
  const packed = npm(["pack", "--dry-run", "--json"]);
  if (packed.status !== 0) { output(packed.stdout, packed.stderr); throw new PublicationError("NPM_PACK_FAILED", `Could not pack ${spec}.`); }
  const integrity = JSON.parse(packed.stdout)[0].integrity;
  if (!integrity) throw new PublicationError("NPM_PACK_FAILED", `No packed integrity for ${spec}.`);
  // Only a confirmed 404 permits publishing. Auth/network errors on this preflight must stop it.
  const existing = await reader(deps)(`${encodeURIComponent(pkg.name)}/${encodeURIComponent(pkg.version)}`);
  checkIntegrity(existing, integrity, spec);
  if (existing) log(`${spec} already exists; verifying its integrity and dist-tag without republishing.`);
  else {
    log(`Publishing ${spec} under the ${distTag} dist-tag.`);
    const result = npm(["publish", "--access", "public", "--tag", distTag, "--registry", REGISTRY]);
    output(result.stdout, result.stderr); // Preserve npm's + package@version receipt in the workflow log.
    const accepted = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.split(/\r?\n/).some(line => line.trim() === `+ ${spec}`) || previouslyPublished(result, pkg.version);
    if (result.status !== 0 && !accepted) throw new PublicationError("NPM_PUBLISH_FAILED", `npm publication failed for ${spec}. Check this package's trusted publisher settings and the npm output above.`);
    log(`${spec} was accepted by npm; waiting up to 45 minutes for registry verification.`);
  }
  await waitForPublication(pkg, integrity, distTag, deps);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await publishPackage(JSON.parse(readFileSync("package.json", "utf8"))); }
  catch (error) { console.error(`::error::[${error.code ?? "NPM_VERIFICATION_ERROR"}] ${error.message}`); process.exitCode = 1; }
}
