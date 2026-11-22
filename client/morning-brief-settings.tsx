import { useEffect, useState } from "react";
import { ActivityIndicator, TextInput, View } from "react-native";
import { openExternalUrl, useRpc } from "@getpaseo/plugin/client";
import { Icon, SettingsAction, SettingsCard, SettingsSection, SettingsSelect, SettingsSwitch, useToast } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pressable, Text } from "./text";
import { Button, errorText, text, type Theme } from "./kit";
import { tint, withAlpha } from "./theme";
import { briefChatSearchRpc, briefSettingsRpc, setBriefPlanRpc, setBriefSettingsRpc } from "../shared/contracts";
import { QUEUE_STATE_TYPES, WEEKDAYS, defaultWorkdays, isZone, type Weekday } from "../shared/linear-queue";
import {
  PLAN_MODES, planCard, queueStateLabel, type BriefSettingsView, type ChatRef, type PlanChange, type PlanMode, type PlanView, type QueueChange,
} from "../shared/morning-brief";

export const briefSettingsKey = ["follow-up", "brief-settings"];
const MODE_LABEL: Record<PlanMode, string> = { auto: "Find it for me", link: "Use a link", off: "Off" };

/**
 * Settings → Morning brief (docs/morning-brief.md#settings): this week's plan link and the Linear queue's settings.
 * Every change goes through the same RPCs the agent tools run (set_brief_plan, set_brief_settings).
 */
export function MorningBriefCategory({ theme, compact }: { theme: Theme; compact: boolean }) {
  const c = theme.colors;
  const read = useRpc(briefSettingsRpc);
  const query = useQuery({ queryKey: briefSettingsKey, queryFn: async () => await read({}) as BriefSettingsView, refetchInterval: 15_000 });
  if (query.isPending) return <ActivityIndicator accessibilityLabel="Loading Morning brief settings" color={c.foregroundMuted} style={{ alignSelf: "flex-start", marginVertical: 8 }} />;
  if (query.error || !query.data) return <SettingsCard><SettingsAction label="Couldn't load Morning brief settings" hint={query.error ? errorText(query.error) : undefined} actionLabel="Retry" onPress={() => void query.refetch()} /></SettingsCard>;
  return <>
    <PlanSection view={query.data} theme={theme} compact={compact} />
    <QueueSection view={query.data} theme={theme} compact={compact} />
  </>;
}

function usePlanChange() {
  const write = useRpc(setBriefPlanRpc); const cache = useQueryClient(); const toast = useToast();
  return useMutation({
    mutationFn: async (input: PlanChange) => await write(input) as PlanView,
    onSuccess: plan => { cache.setQueryData<BriefSettingsView>(briefSettingsKey, v => v ? { ...v, plan } : v); void cache.invalidateQueries({ queryKey: briefSettingsKey }); },
    onError: error => toast.error(errorText(error)),
  });
}

function PlanSection({ view, theme, compact }: { view: BriefSettingsView; theme: Theme; compact: boolean }) {
  const c = theme.colors; const t = text(c, compact);
  const plan = view.plan;
  const change = usePlanChange();
  // "Use a link" with nothing pasted yet shows the field without saving a mode that has no link.
  const [picked, setPicked] = useState<PlanMode | null>(null);
  const mode = picked ?? plan.mode;
  useEffect(() => { if (picked && picked === plan.mode) setPicked(null); }, [picked, plan.mode]);
  const env = plan.source === "env";
  const choose = (m: PlanMode) => {
    if (m === "link" && !plan.link) { setPicked("link"); return; }
    setPicked(null);
    if (m !== plan.mode) change.mutate({ mode: m });
  };
  const reading = !!plan.url && !plan.read && change.isSuccess;
  const card = planCard({ ...plan, mode }, Date.now(), view.clock.timeZone, reading);
  return <SettingsSection title="This week's plan" info="The brief reads it once a day and AI priority uses it to rank your work. Agents can set it too.">
    {env
      ? <Text style={t.meta}>Set by the environment (FOLLOW_UP_PLAN_URL), which wins over these settings. Unset it to choose here.</Text>
      : <Segmented<PlanMode> label="Where the plan comes from" value={mode} options={PLAN_MODES.map(m => ({ value: m, label: MODE_LABEL[m] }))} onChange={choose} disabled={change.isPending} theme={theme} compact={compact} />}
    {!env && mode === "auto" && <WhoWhere plan={plan} busy={change.isPending} onChange={input => change.mutate(input)} theme={theme} compact={compact} />}
    {!env && mode === "link" && <LinkField initial={plan.link ?? ""} busy={change.isPending} onUse={link => change.mutate({ link, mode: "link" })} theme={theme} compact={compact} />}
    {card && <PlanCardView card={card} busy={change.isPending} theme={theme} compact={compact}
      onAnother={() => setPicked("link")} onRetry={() => change.mutate({ find: true })} onPaste={link => change.mutate({ link, mode: "link" })} />}
    {!env && mode === "link" && plan.person && plan.channels.length > 0 && <SettingsCard>
      <SettingsSwitch label="Replace when a newer one is found" hint={`Find it for me still looks in ${plan.channels.map(ch => `#${ch.name}`).join(", ")}.`} value={plan.replaceWhenNewer} disabled={change.isPending}
        onValueChange={value => change.mutate({ replaceWhenNewer: value })} />
    </SettingsCard>}
  </SettingsSection>;
}

/** Three choices in one row: 44 px tall on a phone. */
function Segmented<V extends string>({ label, value, options, onChange, disabled, theme, compact }: { label: string; value: V; options: { value: V; label: string }[]; onChange: (v: V) => void; disabled?: boolean; theme: Theme; compact: boolean }) {
  const c = theme.colors;
  return <View accessibilityRole="radiogroup" accessibilityLabel={label} style={{ flexDirection: "row", alignSelf: compact ? "stretch" : "flex-start", backgroundColor: c.surface2, borderRadius: 8, padding: 2, gap: 2 }}>
    {options.map(o => {
      const on = o.value === value;
      return <Pressable key={o.value} accessibilityRole="radio" accessibilityState={{ checked: on, disabled }} disabled={disabled} onPress={() => onChange(o.value)}
        style={state => ({ flexGrow: compact ? 1 : 0, flexBasis: compact ? 0 : "auto", minHeight: compact ? 44 : 30, paddingHorizontal: 12, borderRadius: 6, alignItems: "center", justifyContent: "center",
          backgroundColor: on ? c.surface0 : (state as { hovered?: boolean }).hovered ? tint(c.foreground, c) : "transparent", ...(on ? { boxShadow: "0px 0px 0px 1px rgba(127,127,127,0.18)" } : {}) })}>
        <Text style={{ color: on ? c.foreground : c.foregroundMuted, fontSize: compact ? 14 : 13, fontWeight: "500" }}>{o.label}</Text>
      </Pressable>;
    })}
  </View>;
}

/** A text field; `mono` sets the typed value in monospace (a link), never the placeholder. */
function field(theme: Theme, compact: boolean, mono = false) {
  const c = theme.colors;
  return { flex: 1, minWidth: 0, minHeight: compact ? 44 : 32, paddingHorizontal: 10, borderRadius: 6, borderWidth: 1, borderColor: c.border, color: c.foreground, fontSize: 13, backgroundColor: c.surface0, ...(mono ? { fontFamily: "ui-monospace, Menlo, monospace" } : {}) } as const;
}

function LinkField({ initial, busy, onUse, theme, compact, placeholder = "https://claude.ai/artifact/…" }: { initial: string; busy: boolean; onUse: (link: string) => void; theme: Theme; compact: boolean; placeholder?: string }) {
  const c = theme.colors;
  const [value, setValue] = useState(initial);
  useEffect(() => setValue(initial), [initial]);
  const dirty = value.trim() !== initial && value.trim().length > 0;
  return <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
    <TextInput accessibilityLabel="The plan's link" value={value} onChangeText={setValue} placeholder={placeholder} placeholderTextColor={c.foregroundMuted} autoCapitalize="none" autoCorrect={false}
      onSubmitEditing={() => dirty && onUse(value.trim())} style={field(theme, compact, value.length > 0)} />
    {/* Shown once there's something new to use: then it's the screen's one primary action. */}
    {dirty && <Button title="Use it" kind="primary" theme={theme} compact={compact} loading={busy} onPress={() => onUse(value.trim())} />}
  </View>;
}

/** "Posted by [person] in [channels]": each picked from the chat source's own search, or typed as a name. */
function WhoWhere({ plan, busy, onChange, theme, compact }: { plan: PlanView; busy: boolean; onChange: (c: PlanChange) => void; theme: Theme; compact: boolean }) {
  const c = theme.colors; const t = text(c, compact);
  const [open, setOpen] = useState<"people" | "channels" | null>(null);
  const chips = (refs: ChatRef[], prefix: string, remove?: (r: ChatRef) => void) => refs.map(r => <View key={r.id ?? r.name} style={{ flexDirection: "row", alignItems: "center", gap: 4, minHeight: compact ? 44 : 28, paddingLeft: 10, paddingRight: remove ? 4 : 10, borderRadius: 6, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface1 }}>
    <Text style={t.body}>{`${prefix}${r.name}`}</Text>
    {remove && <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${prefix}${r.name}`} onPress={() => remove(r)} hitSlop={6} style={{ minWidth: compact ? 36 : 22, minHeight: compact ? 36 : 22, alignItems: "center", justifyContent: "center" }}>
      <Icon name="X" size={12} color={c.foregroundMuted} />
    </Pressable>}
  </View>);
  const personChip = (r: ChatRef) => <Pressable accessibilityRole="button" accessibilityLabel={`Posted by @${r.name}. Change`} disabled={busy} onPress={() => setOpen(open === "people" ? null : "people")}
    style={state => ({ flexDirection: "row", alignItems: "center", gap: 6, minHeight: compact ? 44 : 28, paddingHorizontal: 10, borderRadius: 6, borderWidth: 1, borderColor: c.border,
      backgroundColor: state.pressed || (state as { hovered?: boolean }).hovered ? c.surface2 : c.surface1 })}>
    <Text style={t.body}>{`@${r.name}`}</Text>
    <Icon name="ChevronDown" size={12} color={c.foregroundMuted} />
  </Pressable>;
  const label = (s: string) => <Text style={[t.meta, { width: compact ? undefined : 72, minWidth: compact ? 64 : undefined }]}>{s}</Text>;
  const rowStyle = { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 } as const;
  return <View style={{ gap: 8 }}>
    <View style={rowStyle}>
      {label("Posted by")}
      {plan.person ? personChip(plan.person)
        : <Button title="Pick a person" icon="Plus" theme={theme} compact={compact} disabled={busy} onPress={() => setOpen(open === "people" ? null : "people")} />}
    </View>
    {open === "people" && <ChatPicker kind="people" exclude={plan.person ? [plan.person] : []} theme={theme} compact={compact} onCancel={() => setOpen(null)}
      onPick={ref => { setOpen(null); onChange({ person: ref }); }} />}
    <View style={rowStyle}>
      {label("In")}
      {chips(plan.channels, "#", r => onChange({ channels: plan.channels.filter(x => x !== r) }))}
      {plan.channels.length < 5 && <Button title={plan.channels.length ? "Add" : "Pick channels"} icon="Plus" kind={plan.channels.length ? "ghost" : "secondary"} theme={theme} compact={compact} disabled={busy} onPress={() => setOpen(open === "channels" ? null : "channels")} />}
    </View>
    {open === "channels" && <ChatPicker kind="channels" exclude={plan.channels} theme={theme} compact={compact} onCancel={() => setOpen(null)}
      onPick={ref => { setOpen(null); onChange({ channels: [...plan.channels, ref] }); }} />}
  </View>;
}

function ChatPicker({ kind, exclude, onPick, onCancel, theme, compact }: { kind: "people" | "channels"; exclude: ChatRef[]; onPick: (r: ChatRef) => void; onCancel: () => void; theme: Theme; compact: boolean }) {
  const taken = (r: ChatRef) => exclude.some(x => (x.id && x.id === r.id) || x.name.toLowerCase() === r.name.toLowerCase());
  const c = theme.colors; const t = text(c, compact);
  const search = useRpc(briefChatSearchRpc);
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => { const id = setTimeout(() => setDebounced(q.trim()), 350); return () => clearTimeout(id); }, [q]);
  const results = useQuery({ queryKey: ["follow-up", "brief-chat", kind, debounced], enabled: debounced.length >= 2, staleTime: 60_000,
    queryFn: async () => await search({ kind, query: debounced }) as { results: ChatRef[]; error: string | null } });
  const prefix = kind === "people" ? "@" : "#";
  const typed = q.trim().replace(/^[#@]/, "");
  const row = (label: string, hint: string | null, onPress: () => void, key: string) => <Pressable key={key} accessibilityRole="button" onPress={onPress}
    style={state => ({ minHeight: compact ? 44 : 34, paddingHorizontal: 12, paddingVertical: 8, justifyContent: "center", borderTopWidth: 1, borderTopColor: c.border, backgroundColor: state.pressed || (state as { hovered?: boolean }).hovered ? c.surface2 : "transparent" })}>
    <Text style={t.body}>{label}</Text>{hint && <Text style={t.meta}>{hint}</Text>}
  </Pressable>;
  return <View style={{ borderWidth: 1, borderColor: c.border, borderRadius: 8, backgroundColor: c.surface1, overflow: "hidden" }}>
    <View style={{ flexDirection: "row", gap: 8, padding: 8, alignItems: "center" }}>
      <TextInput autoFocus accessibilityLabel={kind === "people" ? "Search people" : "Search channels"} value={q} onChangeText={setQ} placeholder={kind === "people" ? "Pick who posts it: search by name" : "Add a channel: search by name"}
        placeholderTextColor={c.foregroundMuted} autoCapitalize="none" autoCorrect={false} style={field(theme, compact)} />
      <Button title="Cancel" kind="ghost" theme={theme} compact={compact} onPress={onCancel} />
    </View>
    {results.isFetching && <Text style={[t.meta, { paddingHorizontal: 12, paddingBottom: 8 }]}>Searching…</Text>}
    {results.data?.error && <Text style={[t.meta, { paddingHorizontal: 12, paddingBottom: 8, color: c.statusWarning }]}>{results.data.error}</Text>}
    {(results.data?.results ?? []).filter(r => !taken(r)).map(r => row(`${prefix}${r.name}`, null, () => onPick(r), r.id ?? r.name))}
    {debounced.length >= 2 && !results.isFetching && !results.data?.results.length && !results.data?.error && <Text style={[t.meta, { paddingHorizontal: 12, paddingBottom: 8 }]}>{`Nothing matches "${debounced}".`}</Text>}
    {typed.length >= 2 && !taken({ id: null, name: typed }) && !(results.data?.results ?? []).some(r => r.name.toLowerCase() === typed.toLowerCase()) && row(`Use "${prefix}${typed}" as typed`, null, () => onPick({ id: null, name: typed }), "typed")}
  </View>;
}

function PlanCardView({ card, busy, onAnother, onRetry, onPaste, theme, compact }: { card: NonNullable<ReturnType<typeof planCard>>; busy: boolean; onAnother: () => void; onRetry: () => void; onPaste: (link: string) => void; theme: Theme; compact: boolean }) {
  const c = theme.colors; const t = text(c, compact);
  const warn = card.tone === "warn"; const error = card.tone === "error";
  const icon = card.tone === "ok" ? "Check" : warn ? "TriangleAlert" : error ? "CircleAlert" : "Info";
  const iconColor = card.tone === "ok" ? c.statusSuccess : warn ? c.statusWarning : error ? c.statusDanger : c.foregroundMuted;
  return <View accessibilityRole={warn || error ? "alert" : undefined} style={{ flexDirection: "row", gap: 10, padding: compact ? 14 : 12, borderRadius: 8, borderWidth: 1, borderColor: warn ? withAlpha(c.statusWarning, 0.4) : c.border, backgroundColor: warn ? withAlpha(c.statusWarning, 0.14) : c.surface1 }}>
    <View style={{ paddingTop: 2 }}><Icon name={icon} size={14} color={iconColor} /></View>
    <View style={{ flex: 1, minWidth: 0, gap: 6 }}>
      <Text style={t.label}>{card.title}</Text>
      <Text style={t.meta}>{card.line}</Text>
      {(warn || error) && card.inUse && <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 4 }}>
        <Text style={t.meta}>{card.inUse.line}</Text>
        <Button title="Open" kind="ghost" icon="ExternalLink" theme={theme} compact={compact} onPress={() => void openExternalUrl(card.inUse!.url).catch(() => undefined)} />
      </View>}
      {card.tone === "ok" && <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {card.actions.includes("open") && <Button title="Open" icon="ExternalLink" grow={compact} theme={theme} compact={compact} onPress={() => void openExternalUrl(card.url).catch(() => undefined)} />}
        {card.actions.includes("another") && <Button title="Use another link" grow={compact} theme={theme} compact={compact} onPress={onAnother} />}
      </View>}
      {(warn || error) && card.paste && <LinkField initial="" busy={busy} onUse={onPaste} theme={theme} compact={compact} placeholder={error ? "Or paste this week's link" : "Paste this week's link"} />}
      {error && card.retry && <Button title="Look again" icon="RotateCcw" theme={theme} compact={compact} loading={busy} onPress={onRetry} />}
    </View>
  </View>;
}

const SWEEP_TIMES = ["05:00", "05:30", "06:00", "06:30", "07:00", "07:30", "08:00", "08:30", "09:00", "09:30", "10:00"];

function QueueSection({ view, theme, compact }: { view: BriefSettingsView; theme: Theme; compact: boolean }) {
  const c = theme.colors; const t = text(c, compact);
  const write = useRpc(setBriefSettingsRpc); const cache = useQueryClient(); const toast = useToast();
  const change = useMutation({
    mutationFn: async (input: QueueChange) => await write(input) as BriefSettingsView,
    onSuccess: value => cache.setQueryData(briefSettingsKey, value),
    onError: error => toast.error(errorText(error)),
  });
  const q = view.queue;
  const times = [...new Set([...SWEEP_TIMES, q.sweepAt])].sort();
  const zoneFrom = view.clock.zoneFrom === "setting" ? "set here" : view.clock.zoneFrom === "device" ? "this device's" : "the host's";
  const usual = defaultWorkdays(view.clock.timeZone);
  return <SettingsSection title="Linear queue" info="What the morning sweep reads, when, and what the brief's changes are counted from. The sweep reads every issue assigned to you in these states.">
    <ChipGroup label="Counts as the queue" hint="Issues assigned to you in these states. At least one."
      options={QUEUE_STATE_TYPES.map(st => ({ value: st, label: queueStateLabel(st) }))} value={q.states} disabled={change.isPending}
      onChange={states => change.mutate({ states: states as typeof q.states })} theme={theme} compact={compact} />
    <SettingsCard>
      <SettingsSelect label="Sweep at" hint={`On workdays, in ${view.clock.timeZone}.`} value={q.sweepAt} disabled={change.isPending}
        options={times.map(v => ({ value: v, label: v }))} onValueChange={sweepAt => change.mutate({ sweepAt })} />
      <SettingsSelect label="Changes since" hint={q.since === "read" ? "What moved since you last read the brief; before your first read, since the last workday's sweep." : "What moved since the last workday's sweep, however often you look."}
        value={q.since} disabled={change.isPending} options={[{ value: "read", label: "Your last read" }, { value: "workday", label: "Your last workday" }]} onValueChange={since => change.mutate({ since })} />
    </SettingsCard>
    <ZoneField view={view} zoneFrom={zoneFrom} busy={change.isPending} onChange={timeZone => change.mutate({ timeZone })} theme={theme} compact={compact} />
    <ChipGroup label="Workdays" hint={q.workdays ? "Set here." : "The zone's usual week."} options={WEEKDAYS.map(d => ({ value: d, label: d }))} value={q.workdays ?? usual} disabled={change.isPending}
      onChange={days => change.mutate({ workdays: sameDays(days, usual) ? null : days as Weekday[] })} theme={theme} compact={compact} />
  </SettingsSection>;
}
const sameDays = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every(d => b.includes(d));

/** A labelled row of on/off chips (checkboxes): at least one stays on. 44 px on a phone. */
function ChipGroup({ label, hint, options, value, onChange, disabled, theme, compact }: { label: string; hint?: string; options: { value: string; label: string }[]; value: readonly string[]; onChange: (v: string[]) => void; disabled?: boolean; theme: Theme; compact: boolean }) {
  const c = theme.colors; const t = text(c, compact);
  return <View style={{ gap: 6 }}>
    <Text style={t.label}>{label}</Text>
    {hint && <Text style={t.meta}>{hint}</Text>}
    <View role="group" aria-label={label} style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
      {options.map(o => {
        const on = value.includes(o.value);
        const last = on && value.length === 1;
        return <Pressable key={o.value} accessibilityRole="checkbox" accessibilityState={{ checked: on, disabled: disabled || last }} accessibilityLabel={o.label} disabled={disabled || last}
          onPress={() => onChange(on ? value.filter(x => x !== o.value) : options.map(x => x.value).filter(x => x === o.value || value.includes(x)))}
          style={state => ({ minWidth: compact ? 44 : 40, minHeight: compact ? 44 : 30, paddingHorizontal: 10, borderRadius: 6, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 5, borderWidth: 1,
            borderColor: on ? withAlpha(c.accent, 0.55) : c.border, backgroundColor: on ? withAlpha(c.accent, 0.1) : (state as { hovered?: boolean }).hovered ? c.surface1 : "transparent" })}>
          {on && <Icon name="Check" size={12} color={c.foreground} />}
          <Text style={{ color: on ? c.foreground : c.foregroundMuted, fontSize: 13, fontWeight: "500" }}>{o.label}</Text>
        </Pressable>;
      })}
    </View>
  </View>;
}

function ZoneField({ view, zoneFrom, busy, onChange, theme, compact }: { view: BriefSettingsView; zoneFrom: string; busy: boolean; onChange: (z: string | null) => void; theme: Theme; compact: boolean }) {
  const c = theme.colors; const t = text(c, compact);
  const [value, setValue] = useState(view.queue.timeZone ?? "");
  useEffect(() => setValue(view.queue.timeZone ?? ""), [view.queue.timeZone]);
  const v = value.trim();
  const valid = !v || isZone(v);
  const dirty = v !== (view.queue.timeZone ?? "");
  return <View style={{ gap: 6 }}>
    <Text style={t.meta}>{`Time zone: ${view.clock.timeZone} (${zoneFrom})`}</Text>
    <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
      <TextInput accessibilityLabel="Time zone" value={value} onChangeText={setValue} placeholder="Automatic: this device's zone" placeholderTextColor={c.foregroundMuted} autoCapitalize="none" autoCorrect={false}
        onSubmitEditing={() => valid && dirty && onChange(v || null)} style={field(theme, compact)} />
      {dirty && <Button title={v ? "Save" : "Use automatic"} theme={theme} compact={compact} disabled={!valid} loading={busy} onPress={() => onChange(v || null)} />}
    </View>
    {!valid && <Text accessibilityRole="alert" style={[t.meta, { color: c.statusDanger }]}>Use an IANA time zone, like Europe/Paris.</Text>}
  </View>;
}
