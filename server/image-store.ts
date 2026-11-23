import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { base64Bytes, IMAGE_EXTENSIONS, imageUploadsSchema, MAX_IMAGE_BYTES, sniffImageType, WRONG_TYPE, type ImageRef, type ImageUpload } from "../shared/images";

/**
 * Pasted images on disk (every-agent-field-takes-images): `plugin-data/follow-up/images/<id>.<ext>`, files 0600. A
 * queue item (queue.json) or a dispatch record (dispatch.json) keeps only the refs, never the bytes. A file is removed
 * when its message is delivered or cancelled (MessageQueue.settle), or its dispatch is created or failed; a worker start
 * removes every file no item references (sweep). Nothing leaves the host except to the agent.
 */
export const IMAGES_DIR = "images";

export class ImageStore {
  readonly dir: string;
  constructor(directory: string) { this.dir = join(directory, IMAGES_DIR); }

  private path(ref: Pick<ImageRef, "id" | "mimeType">): string { return join(this.dir, `${ref.id}.${IMAGE_EXTENSIONS[ref.mimeType]}`); }

  /** Writes each upload (validated again: caps, type by its bytes) and returns the refs. Nothing is kept on a refusal. */
  async save(uploads: readonly ImageUpload[] | undefined): Promise<ImageRef[]> {
    if (!uploads?.length) return [];
    const list = imageUploadsSchema.parse(uploads);
    const decoded = list.map(u => ({ u, bytes: Buffer.from(u.data, "base64") }));
    for (const { u, bytes } of decoded) {
      const sniffed = sniffImageType(bytes.subarray(0, 16));
      if (!sniffed || sniffed !== u.mimeType) throw new Error(WRONG_TYPE);
    }
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const refs: ImageRef[] = [];
    try {
      for (const { u, bytes } of decoded) {
        const ref: ImageRef = { id: randomUUID(), mimeType: u.mimeType, bytes: bytes.length, name: u.name.slice(0, 200) || "image" };
        await writeFile(this.path(ref), bytes, { mode: 0o600, flag: "wx" });
        refs.push(ref);
      }
    } catch (error) { await this.remove(refs); throw error; }
    return refs;
  }

  /** The images as Paseo's `images` field takes them. A missing file is left out (logged), never a failed send. */
  async read(refs: readonly ImageRef[] | undefined): Promise<{ data: string; mimeType: string }[]> {
    const out: { data: string; mimeType: string }[] = [];
    for (const ref of refs ?? []) {
      try { out.push({ data: (await readFile(this.path(ref))).toString("base64"), mimeType: ref.mimeType }); }
      catch (error) { console.warn(`[follow-up] pasted image ${ref.id} is missing: ${(error as NodeJS.ErrnoException).code ?? String(error)}`); }
    }
    return out;
  }

  async remove(refs: readonly Pick<ImageRef, "id" | "mimeType">[] | undefined): Promise<void> {
    for (const ref of refs ?? []) await rm(this.path(ref), { force: true }).catch(() => undefined);
  }

  /** Worker start: removes every file whose id no live item references. Returns how many went. */
  async sweep(referenced: Iterable<string>): Promise<number> {
    const keep = new Set(referenced);
    let names: string[];
    try { names = await readdir(this.dir); } catch { return 0; }
    let removed = 0;
    for (const name of names) {
      if (keep.has(name.replace(/\.[^.]+$/, ""))) continue;
      await rm(join(this.dir, name), { force: true }).then(() => { removed++; }, () => undefined);
    }
    return removed;
  }
}

/**
 * An agent tool's image argument: a local file path the caller gives, checked before anything else happens (a regular
 * readable file, an image type by its first bytes, under the cap). Refuses with the reason.
 */
export async function readImageFile(path: string): Promise<ImageUpload> {
  if (typeof path !== "string" || !path.trim()) throw new Error("An image is a local file path.");
  const name = path.split(/[\\/]/).pop() || "image";
  let info;
  try { info = await lstat(path); } catch { throw new Error(`${name} can't be read: no such file.`); }
  if (!info.isFile()) throw new Error(`${name} isn't a regular file.`);
  if (info.size > MAX_IMAGE_BYTES) throw new Error(`${name} is ${(info.size / 1024 / 1024).toFixed(1)} MB; the most is 5 MB.`);
  let handle;
  try { handle = await open(path, "r"); } catch { throw new Error(`${name} can't be read.`); }
  try {
    const bytes = await handle.readFile();
    if (bytes.length > MAX_IMAGE_BYTES) throw new Error(`${name} is ${(bytes.length / 1024 / 1024).toFixed(1)} MB; the most is 5 MB.`);
    const mimeType = sniffImageType(bytes.subarray(0, 16));
    if (!mimeType) throw new Error(`${name}: ${WRONG_TYPE}`);
    const data = bytes.toString("base64");
    if (base64Bytes(data) !== bytes.length) throw new Error(`${name} can't be read.`);
    return { name, mimeType, data };
  } finally { await handle.close(); }
}

/** Every path an agent tool was given, read and checked; the whole call is refused on the first bad one. */
export async function readImageFiles(paths: unknown): Promise<ImageUpload[] | undefined> {
  if (paths === undefined || paths === null) return undefined;
  if (!Array.isArray(paths)) throw new Error("images is a list of local file paths.");
  const list = [];
  for (const p of paths) list.push(await readImageFile(String(p)));
  return imageUploadsSchema.parse(list);
}
