/**
 * Dictation in an answer field (dictated-text-lands-in-the-field): the host's usePaseoDictation (Paseo's
 * plugin API, when the host has it) turns speech into text, and the text goes into the same field the keyboard
 * writes to, at the caret, editable, never sent by itself. Pure, so the state machine is tested without a host.
 */

/** Paseo's PluginDictation, mirrored: the installed SDK may predate it. */
export type HostDictationStatus = "idle" | "listening" | "transcribing";
export type HostDictation = {
  readonly unavailable: { readonly reason: "disconnected" | "not_ready"; readonly message: string | null } | null;
  readonly status: HostDictationStatus;
  readonly volume: number;
  readonly error: string | null;
  start(): Promise<void>;
  stop(): Promise<void>;
  cancel(): Promise<void>;
};
export type UseHostDictation = (options: { onText(text: string): void }) => HostDictation;

/** The host's hook, or null when this Paseo has none: then there is no mic, no hint and no space for one. */
export function hostDictationHook(client: unknown): UseHostDictation | null {
  const hook = client && typeof client === "object" ? (client as { usePaseoDictation?: unknown }).usePaseoDictation : undefined;
  return typeof hook === "function" ? hook as UseHostDictation : null;
}

export type MicState = "unavailable" | "idle" | "listening" | "transcribing";
export type MicView = {
  state: MicState;
  icon: string;
  /** The button's accessible name and desktop tooltip. */
  label: string;
  /** One line under the field, or null. `tone` colors it. */
  line: string | null;
  tone: "muted" | "live" | "danger";
  /** The button does nothing while the words are being written. */
  disabled: boolean;
};

export const DICTATE_KEY = "V";

/** What the mic shows. `explain`: the developer pressed an unavailable mic, so it says why (never silently nothing). */
export function micView(d: Pick<HostDictation, "unavailable" | "status" | "error">, o: { explain?: boolean; key?: boolean } = {}): MicView {
  const k = o.key ? ` (${DICTATE_KEY})` : "";
  if (d.unavailable && d.status === "idle") {
    const why = d.unavailable.reason === "disconnected" ? "the host is offline"
      : d.unavailable.message?.trim() || "set up speech-to-text in Paseo's settings";
    return { state: "unavailable", icon: "MicOff", label: "Dictation isn't available", line: o.explain ? `Can't dictate: ${lower(why)}` : null, tone: "muted", disabled: false };
  }
  if (d.status === "listening") return { state: "listening", icon: "Square", label: `Stop dictating${k}`, line: `Listening · Stop${o.key ? ` (${DICTATE_KEY})` : ""} adds it to your answer`, tone: "live", disabled: false };
  if (d.status === "transcribing") return { state: "transcribing", icon: "Mic", label: "Writing down what you said", line: "Writing it down…", tone: "muted", disabled: true };
  return { state: "idle", icon: "Mic", label: `Dictate${k}`, line: d.error ? `Couldn't dictate: ${denied(d.error) ? "microphone access is blocked. Allow it for Paseo in your settings" : lower(d.error)}` : null, tone: "danger", disabled: false };
}
const denied = (error: string) => /permission|denied|not ?allowed/i.test(error);
const lower = (s: string) => {
  const t = s.trim().replace(/[.\s]+$/, "");
  return /^[A-Z][a-z]/.test(t) ? t[0].toLowerCase() + t.slice(1) : t;
};

/**
 * Put dictated text where the caret is (replacing a selection), with one space between it and the words around it,
 * within the field's length limit. Returns the new words and where the caret goes (after the inserted text).
 */
export function insertDictated(words: string, text: string, selection?: { start: number; end: number } | null, maxLength = 2000): { words: string; caret: number } {
  const said = text.replace(/\s+/g, " ").trim();
  const start = Math.max(0, Math.min(selection?.start ?? words.length, words.length));
  const end = Math.max(start, Math.min(selection?.end ?? start, words.length));
  if (!said) return { words, caret: end };
  const before = words.slice(0, start); const after = words.slice(end);
  const lead = before && !/\s$/.test(before) ? " " : "";
  const trail = after && !/^[\s.,;:!?)]/.test(after) ? " " : "";
  const room = maxLength - before.length - after.length - lead.length - trail.length;
  if (room <= 0) return { words, caret: end };
  const fit = said.slice(0, room);
  return { words: before + lead + fit + trail + after, caret: before.length + lead.length + fit.length };
}
