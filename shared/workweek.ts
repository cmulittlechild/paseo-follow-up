/**
 * The zone's usual working week: general calendar knowledge, never a workplace's (invariant 24, `public-code-carries-no-host-identifiers`). The Morning brief's
 * workdays and PR statistics' week start and working hours both start here; a saved setting always wins.
 */
export const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
export type Weekday = typeof WEEKDAYS[number];

/**
 * Zones whose working week is Sunday to Thursday (a Friday–Saturday weekend), from CLDR's week data by region. Every
 * other zone works Monday to Friday.
 */
const FRI_SAT_WEEKEND = new Set([
  "Asia/Jerusalem", "Asia/Tel_Aviv", "Asia/Hebron", "Asia/Gaza", "Asia/Riyadh", "Asia/Kuwait", "Asia/Bahrain", "Asia/Qatar",
  "Asia/Baghdad", "Asia/Amman", "Asia/Damascus", "Asia/Aden", "Asia/Muscat", "Asia/Dhaka", "Africa/Cairo", "Africa/Algiers",
  "Africa/Tripoli", "Africa/Khartoum", "Egypt", "Israel",
]);
/** The zone's usual workdays: Sun–Thu where the weekend is Friday–Saturday, else Mon–Fri. */
export function defaultWorkdays(timeZone: string): Weekday[] {
  return FRI_SAT_WEEKEND.has(timeZone) ? ["Sun", "Mon", "Tue", "Wed", "Thu"] : ["Mon", "Tue", "Wed", "Thu", "Fri"];
}
/** The same days as numbers (0 = Sunday). */
export const defaultWorkdayNumbers = (timeZone: string): number[] => defaultWorkdays(timeZone).map(d => WEEKDAYS.indexOf(d));
/** The day the zone's week starts on: its first workday (0 = Sunday, 1 = Monday). */
export const defaultWeekStart = (timeZone: string): 0 | 1 => FRI_SAT_WEEKEND.has(timeZone) ? 0 : 1;
