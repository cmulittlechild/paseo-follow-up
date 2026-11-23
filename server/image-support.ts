import { cantTakeImages, type ImageSupport } from "../shared/images";
import { queueTimeScale } from "./message-queue";

/**
 * Whether an agent's provider takes pasted images: the ONE place Follow-up decides it (every-agent-field-takes-images).
 *
 * Paseo's built-in providers that send image parts to their model: Claude Code, Codex, OpenCode, Pi and Oh My Pi (their
 * provider code maps `images` into the prompt, Paseo v0.17.1). A plugin provider declares `prompt.image` in its
 * capabilities, but Paseo's agent snapshot doesn't expose that (`AgentCapabilityFlags` maps only persistence,
 * listing, configure and revert), so `capabilities` is read when a host reports it and otherwise a provider Follow-up
 * doesn't know is a no, with its name in the reason: the field says so before Send, never after.
 */
export const IMAGE_PROVIDERS: Record<string, string> = { claude: "Claude", codex: "Codex", opencode: "OpenCode", pi: "Pi", omp: "Oh My Pi" };

export function imageSupport(agent: { provider?: string | null; providerLabel?: string | null; capabilities?: Record<string, unknown> | readonly string[] | null } | null): ImageSupport {
  if (!agent?.provider) return { ok: false, provider: null, reason: "Follow-up can't tell who gets these images; remove them to send." };
  const id = agent.provider.split("/")[0]!;
  const label = agent.providerLabel || IMAGE_PROVIDERS[id] || id;
  if (IMAGE_PROVIDERS[id] || harnessProviders.has(id)) return { ok: true, provider: label, reason: null };
  const caps = agent.capabilities;
  const declared = Array.isArray(caps) ? caps.includes("prompt.image") : !!caps && ((caps as Record<string, unknown>)["prompt.image"] === true || (caps as Record<string, unknown>).supportsImages === true);
  return declared ? { ok: true, provider: label, reason: null } : { ok: false, provider: label, reason: cantTakeImages(label) };
}

/** The line a message carries when its images were left off because the recipient can't take them. */
export const imagesLeftOff = (n: number, s: ImageSupport) => `\n\n(${n === 1 ? "An image was" : `${n} images were`} left off: ${s.provider ?? "this agent"} can't take images.)`;

/**
 * FOLLOW_UP_HARNESS_IMAGE_PROVIDERS: provider ids a harness run treats as taking images (its fixture provider), for
 * rendering the fields' ok state. Like FOLLOW_UP_QUEUE_TIME_SCALE it counts only when the data dir is under the OS temp
 * dir (queueTimeScale's rule), so a stray variable on a developer's machine changes nothing.
 */
let harnessProviders = new Set<string>();
export function trustHarnessImageProviders(directory: string, env: NodeJS.ProcessEnv = process.env): void {
  const list = (env.FOLLOW_UP_HARNESS_IMAGE_PROVIDERS ?? "").split(",").map(x => x.trim()).filter(Boolean);
  harnessProviders = list.length && queueTimeScale(directory, { FOLLOW_UP_QUEUE_TIME_SCALE: "0.5" }) !== 1 ? new Set(list) : new Set();
}
