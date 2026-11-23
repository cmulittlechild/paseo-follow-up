import type { ImageUpload } from "../shared/images";

/**
 * Pasted images of a send that isn't confirmed yet (every-agent-field-takes-images, invariant 36: never dropped
 * silently). A field that sends puts its images here under its key before the call and takes them out only once the
 * send is confirmed; a field that mounts again under the same key (Retry on a question, a reply box opened again after
 * a failed send) gets them back. Memory only: images are too large for localStorage, so a reload loses them, and the
 * entry that survives it (pending-answers) says so by count.
 */
const kept = new Map<string, { images: ImageUpload[]; text?: string }>();

/** Home's search asking the Overseer. */
export const OVERSEER_ASK_KEY = "overseer-ask";

export function keepUnsent(key: string, images: readonly ImageUpload[] | undefined, text?: string): void {
  if (!images?.length && text === undefined) { kept.delete(key); return; }
  kept.set(key, { images: [...(images ?? [])], ...(text !== undefined ? { text } : {}) });
}
export const unsent = (key: string): { images: ImageUpload[]; text?: string } | undefined => kept.get(key);
export const unsentImages = (key: string): ImageUpload[] => kept.get(key)?.images ?? [];
export function dropUnsent(key: string): void { kept.delete(key); }
/** The field's images changed while its send is still unconfirmed (one removed): the kept copy follows. */
export function updateUnsentImages(key: string, images: readonly ImageUpload[]): void {
  const k = kept.get(key); if (!k) return;
  if (!images.length && k.text === undefined) kept.delete(key); else kept.set(key, { ...k, images: [...images] });
}
