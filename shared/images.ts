import { z } from "zod";

/**
 * Pasted images (every-agent-field-takes-images, docs/client.md#pasted-images). Every field that sends words to an agent
 * takes images through one component (client/image-attach.tsx); they ride the field's message to the agent.
 *
 * Follow-up's own caps, far below Paseo's (MAX_PROVIDER_IMAGE_BYTES, 128 MB): 5 MB per image is Claude's API limit.
 */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGES = 6;
export const MAX_MESSAGE_IMAGE_BYTES = 20 * 1024 * 1024;
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export type ImageType = typeof IMAGE_TYPES[number];
export const IMAGE_EXTENSIONS: Record<ImageType, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

/** Decoded size from base64 length (padding counted), without decoding. */
export function base64Bytes(data: string): number {
  const pad = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor(data.length * 3 / 4) - pad);
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
/** An image the client or a tool hands the server: its bytes as base64. Capped from the base64 length. */
export const imageUploadSchema = z.strictObject({
  name: z.string().trim().max(200).default("image"),
  mimeType: z.enum(IMAGE_TYPES),
  data: z.string().min(4).max(Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 4).regex(BASE64, "Not base64 image data."),
}).superRefine((v, ctx) => {
  const bytes = base64Bytes(v.data);
  if (bytes > MAX_IMAGE_BYTES) ctx.addIssue({ code: "custom", message: tooBig(v.name, bytes) });
});
export type ImageUpload = z.infer<typeof imageUploadSchema>;
/** One message's images: the count and total size capped. */
export const imageUploadsSchema = z.array(imageUploadSchema).max(MAX_IMAGES, `${MAX_IMAGES} images is the most one message takes.`).superRefine((list, ctx) => {
  const total = list.reduce((n, i) => n + base64Bytes(i.data), 0);
  if (total > MAX_MESSAGE_IMAGE_BYTES) ctx.addIssue({ code: "custom", message: `These images add up to ${mb(total)}; the most one message takes is ${mb(MAX_MESSAGE_IMAGE_BYTES)}.` });
});

/** A stored image (server/image-store.ts): what queue.json and dispatch.json keep, never the bytes. */
export const imageRefSchema = z.object({
  id: z.string().regex(/^[\w-]{8,80}$/),
  mimeType: z.enum(IMAGE_TYPES),
  bytes: z.number().int().min(0).max(MAX_IMAGE_BYTES),
  name: z.string().max(200),
});
export type ImageRef = z.infer<typeof imageRefSchema>;

export const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1).replace(/\.0$/, "")} MB`;
const tooBig = (name: string, bytes: number) => `${name && name !== "image" ? `${name} is` : "That image is"} ${mb(bytes)}; the most is ${mb(MAX_IMAGE_BYTES)}.`;
export const WRONG_TYPE = "Only PNG, JPEG, GIF and WebP images.";

/**
 * Whether `adding` may join `current` (refuse up front, invariant 8): the plain sentence for the first cap it passes,
 * or null. `adding` lists what the paste or drop carries; one refused item refuses the whole paste.
 */
export function imageRefusal(current: readonly { bytes: number }[], adding: readonly { bytes: number; mimeType: string; name?: string }[]): string | null {
  for (const a of adding) if (!(IMAGE_TYPES as readonly string[]).includes(a.mimeType)) return WRONG_TYPE;
  if (current.length + adding.length > MAX_IMAGES) return `${MAX_IMAGES} images is the most one message takes.`;
  for (const a of adding) if (a.bytes > MAX_IMAGE_BYTES) return tooBig(a.name ?? "image", a.bytes);
  const total = [...current, ...adding].reduce((n, i) => n + i.bytes, 0);
  if (total > MAX_MESSAGE_IMAGE_BYTES) return `These images add up to ${mb(total)}; the most one message takes is ${mb(MAX_MESSAGE_IMAGE_BYTES)}.`;
  return null;
}

/** The image type from a file's first bytes (magic numbers), never its name. Null: not one Follow-up takes. */
export function sniffImageType(head: Uint8Array): ImageType | null {
  const at = (i: number, ...bytes: number[]) => bytes.every((b, k) => head[i + k] === b);
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (at(0, 0x47, 0x49, 0x46, 0x38) && (head[4] === 0x37 || head[4] === 0x39) && head[5] === 0x61) return "image/gif";
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  return null;
}

/**
 * What can take an image (server/image-support.ts decides; follow.image-support asks). `reason` is the field's line:
 * "<Provider> can't take images; remove them to send."
 */
export const imageSupportSchema = z.object({ ok: z.boolean(), provider: z.string().nullable(), reason: z.string().nullable() });
export type ImageSupport = z.infer<typeof imageSupportSchema>;
export const imageTargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("agent"), agentId: z.string().min(1).max(200) }),
  z.strictObject({ kind: z.literal("workspace"), workspaceId: z.string().min(1).max(200) }),
  z.strictObject({ kind: z.literal("overseer") }),
  /** New: the provider the chosen action or agent picker starts (claude, codex, or a plugin provider's id). */
  z.strictObject({ kind: z.literal("provider"), provider: z.string().min(1).max(200) }),
]);
export type ImageTarget = z.infer<typeof imageTargetSchema>;
export const imageTargetKey = (t: ImageTarget) => t.kind === "agent" ? `agent:${t.agentId}` : t.kind === "workspace" ? `workspace:${t.workspaceId}` : t.kind === "provider" ? `provider:${t.provider}` : "overseer";
export const cantTakeImages = (provider: string) => `${provider} can't take images; remove them to send.`;

/** The plan line an agent tool's dry run shows for its images: names and sizes. */
export const imagesPlanLine = (images: readonly { name: string; bytes: number }[]) => images.length ? `With ${images.length === 1 ? "an image" : `${images.length} images`}: ${images.map(i => `${i.name} (${mb(i.bytes)})`).join(", ")}.` : "";
