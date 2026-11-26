import zhText from "./locales/zh-text.json";

/**
 * Message-id style translation for the plugin's own UI: the English source string
 * is the key, so a missing entry simply renders the English text.
 *
 * Named `tr` rather than `t` because `t` is already used as a local identifier in
 * hundreds of places (tooltip params, table rows, callbacks).
 *
 * The locale is reported once per contribution (client.i18n.locale). Registrations
 * that must follow a language switch live in client/i18n.ts instead.
 */
let locale = "en";

export function setI18nLocale(next: string | undefined) {
  locale = (next ?? "en").toLowerCase();
}

const TABLE = zhText as Record<string, string>;

export function tr(english: string): string {
  if (!locale.startsWith("zh")) return english;
  return TABLE[english] ?? english;
}
