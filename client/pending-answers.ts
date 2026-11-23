import { useSyncExternalStore } from "react";
import type { ImageUpload } from "../shared/images";
import { dropUnsent, keepUnsent } from "./unsent-images";

/**
 * Answers the developer sent that the server hasn't confirmed yet. The dialog closes the moment Send is pressed, so
 * this is where the answer lives until `follow.answer-question` replies. The server records an answer before it
 * messages the agent (sending → sent, queued or unconfirmed), so only a failure before the server saw it needs
 * keeping here; that entry keeps the words and the reason, and the question shows "Not sent · Retry".
 *
 * Web and desktop keep entries in localStorage, so a reload in the middle of a send loses nothing. Phones (React
 * Native, no localStorage) keep them in memory for the session.
 */
/**
 * `images`: how many pasted images went with it. The images themselves are kept in memory (client/unsent-images.ts,
 * too large for localStorage) under `answerImagesKey`; after a reload only the count is left, and the reason says so.
 */
export type PendingAnswer = { choice: string; words?: string; at: number; error?: string; images?: number };

const KEY = "follow-up:pending-answers";
const DAY_MS = 24 * 3_600_000;
type Store = { getItem(k: string): string | null; setItem(k: string, v: string): void };
const storage = (): Store | null => { try { const s = (globalThis as { localStorage?: Store }).localStorage; return typeof s?.getItem === "function" ? s : null; } catch { return null; } };

let entries: Record<string, PendingAnswer> = (() => {
  try {
    const raw = storage()?.getItem(KEY); const parsed = raw ? JSON.parse(raw) as Record<string, PendingAnswer> : {};
    // A reload mid-send: an entry without a reply is treated as not sent, so the developer sees it and can retry.
    const now = Date.now();
    return restore(parsed, now);
  } catch { return {}; }
})();

/** Entries read back after a reload: unconfirmed ones are not sent, and images they carried are gone (never silently). */
export function restore(parsed: Record<string, PendingAnswer>, now: number): Record<string, PendingAnswer> {
  return Object.fromEntries(Object.entries(parsed).filter(([, p]) => p && typeof p.choice === "string" && now - p.at < DAY_MS)
    .map(([k, p]) => {
      const why = p.error ?? "Follow-up was reloaded before Paseo confirmed it";
      if (!p.images) return [k, { ...p, error: why }];
      const { images: n, ...rest } = p;
      return [k, { ...rest, error: `${why.replace(/\.$/, "")}. ${n === 1 ? "Its image wasn't" : `Its ${n} images weren't`} kept; paste ${n === 1 ? "it" : "them"} again.` }];
    }));
}
const listeners = new Set<() => void>();
const key = (workspaceId: string, questionId: string) => `${workspaceId}/${questionId}`;
function commit(next: Record<string, PendingAnswer>) {
  entries = next;
  try { storage()?.setItem(KEY, JSON.stringify(entries)); } catch { /* Memory still holds it. */ }
  for (const l of listeners) l();
}

export const pendingAnswer = (workspaceId: string, questionId: string): PendingAnswer | undefined => entries[key(workspaceId, questionId)];
/** Where the unsent answer's images are kept (client/unsent-images.ts), and where QuestionBody's model reads them back. */
export const answerImagesKey = (workspaceId: string, questionId: string) => `answer:${key(workspaceId, questionId)}`;
export function setPendingAnswer(workspaceId: string, questionId: string, answer: { choice: string; words?: string; images?: readonly ImageUpload[] }) {
  keepUnsent(answerImagesKey(workspaceId, questionId), answer.images);
  commit({ ...entries, [key(workspaceId, questionId)]: { choice: answer.choice, words: answer.words, at: Date.now(), ...(answer.images?.length ? { images: answer.images.length } : {}) } });
}
export function clearPendingAnswer(workspaceId: string, questionId: string) {
  dropUnsent(answerImagesKey(workspaceId, questionId));
  const k = key(workspaceId, questionId); if (!(k in entries)) return;
  const { [k]: _, ...rest } = entries; commit(rest);
}
export function failPendingAnswer(workspaceId: string, questionId: string, error: string) {
  const k = key(workspaceId, questionId); const p = entries[k]; if (!p) return;
  commit({ ...entries, [k]: { ...p, error } });
}

/** The question's unsent answer, if any; re-renders when it changes. */
export function usePendingAnswer(workspaceId: string, questionId: string): PendingAnswer | undefined {
  return useSyncExternalStore(l => { listeners.add(l); return () => { listeners.delete(l); }; }, () => entries[key(workspaceId, questionId)], () => undefined);
}
export function usePendingAnswers(): Record<string, PendingAnswer> {
  return useSyncExternalStore(l => { listeners.add(l); return () => { listeners.delete(l); }; }, () => entries, () => entries);
}
export const pendingKey = key;
