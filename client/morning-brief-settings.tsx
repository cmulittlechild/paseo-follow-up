import { useEffect, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, TextInput, View } from "react-native";
import { openExternalUrl, useRpc } from "@getpaseo/plugin/client";
import { Icon, SettingsAction, SettingsCard, SettingsSection, SettingsSelect, SettingsSwitch, copyText, useToast } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pressable, Text } from "./text";
import { Button, IconButton, Switch, errorText, text, type Theme } from "./kit";
import { raised, tint, withAlpha } from "./theme";
import { briefChatSearchRpc, briefSettingsRpc, briefSourcesRpc, setBriefPlanRpc, setBriefSettingsRpc, setBriefSourcesRpc } from "../shared/contracts";
import type { BriefSource, SourcesChange, SourcesView } from "../shared/brief-sources";
import { QUEUE_STATE_TYPES, WEEKDAYS, defaultWorkdays, isZone, type Weekday } from "../shared/linear-queue";
import {
  PLAN_MODES, planCard, queueStateLabel, type BriefSettingsView, type ChatRef, type PlanChange, type PlanMode, type PlanView, type QueueChange,
} from "../shared/morning-brief";

export const briefSettingsKey = ["follow-up", "brief-settings"];
export const briefSourcesKey = ["follow-up", "brief-sources"];
const MODE_LABEL: Record<PlanMode, string> = { auto: "Find it for me", link: "Use a link", off: "Off" };

/**
 * Settings → Morning brief (docs/morning-brief.md#settings): the brief's sources, this week's plan link and the Linear
 * queue's settings. Every change goes through the same RPCs the agent tools run (set_brief_sources, set_brief_plan,
 * set_brief_settings).
 */
export function MorningBriefCategory({ theme, compact }: { theme: Theme; compact: boolean }) {
  const c = theme.colors;
  const read = useRpc(briefSettingsRpc);
  const query = useQuery({ queryKey: briefSettingsKey, queryFn: async () => await read({}) as BriefSettingsView, refetchInterval: 15_000 });
  if (query.isPending) return <ActivityIndicator accessibilityLabel="Loading Morning brief settings" color={c.foregroundMuted} style={{ alignSelf: "flex-start", marginVertical: 8 }} />;
  if (query.error || !query.data) return <SettingsCard><SettingsAction label="Couldn't load Morning brief settings" hint={query.error ? errorText(query.error) : undefined} actionLabel="Retry" onPress={() => void query.refetch()} /></SettingsCard>;
  return <>
    <SourcesSection view={query.data} theme={theme} compact={compact} />
    <PlanSection view={query.data} theme={theme} compact={compact} />
    <QueueSection view={query.data} theme={theme} compact={compact} />
  </>;
}

/**
 * Sources: every server mcpproxy has, matched by its tools (never its name), plus GitHub and Paseo. Opening Settings
 * asks mcpproxy again (once per visit); after that the card only re-reads Follow-up's own state.
 */
function SourcesSection({ view, theme, compact }: { view: BriefSettingsView; theme: Theme; compact: boolean }) {
  const c = theme.colors; const t = text(c, compact);
  const read = useRpc(briefSourcesRpc); const write = useRpc(setBriefSourcesRpc); const writeQueue = useRpc(setBriefSettingsRpc);
  const cache = useQueryClient(); const toast = useToast();
  const checked = useRef(false);
  // While mcpproxy is being asked or a source read again, look again soon; otherwise every 15 s.
  const query = useQuery({ queryKey: briefSourcesKey, refetchInterval: q => q.state.data?.checking || q.state.data?.retrying.length ? 1_500 : 15_000,
    queryFn: async () => { const check = !checked.current; checked.current = true; return await read({ check }) as SourcesView; } });
  const change = useMutation({
    mutationFn: async (input: SourcesChange) => await write(input) as SourcesView,
    onSuccess: value => cache.setQueryData(briefSourcesKey, value),
    onError: error => toast.error(errorText(error)),
  });
  const windows = useMutation({
    mutationFn: async (input: QueueChange) => await writeQueue(input) as BriefSettingsView,
    onSuccess: value => cache.setQueryData(briefSettingsKey, value),
    onError: error => toast.error(errorText(error)),
  });
  const data = query.data;
  const used = (data?.sources ?? []).filter(r => r.kind === "recipe" || r.kind === "builtin");
  const notRead = (data?.sources ?? []).filter(r => r.kind === "unknown" || r.kind === "skipped");
  const pending = change.isPending ? change.variables : null;
  const [showNotRead, setShowNotRead] = useState(false);
  const checking = !!data?.checking || !!pending?.check;
  const copy = (command: string) => { void copyText(command).then(() => toast.show("Copied", { variant: "success" }), () => toast.error("Couldn't copy here")); };
  return <SettingsSection title="Sources" info="What the brief reads each morning. Follow-up finds each source by the tools mcpproxy offers, and only ever calls its read-only tools. A lookup is one read-only call. Agents can turn sources on and off too.">
    {query.isPending && <ActivityIndicator accessibilityLabel="Checking sources" color={c.foregroundMuted} style={{ alignSelf: "flex-start", marginVertical: 8 }} />}
    {query.error && <SettingsCard><SettingsAction label="Couldn't read the sources" hint={errorText(query.error)} actionLabel="Retry" onPress={() => void query.refetch()} /></SettingsCard>}
    {/* The section's one line: "5 sources read", or what failed, so a broken source shows above the fold. */}
    {data && (data.error || data.line.tone === "warn"
      ? <Warning text={data.error ?? data.line.text} theme={theme} compact={compact} />
      : <Text style={t.meta}>{data.line.text}</Text>)}
    {data && <View style={{ ...raised(c), borderRadius: 10, backgroundColor: c.surface1, overflow: "hidden" }}>
      {used.map((row, i) => <SourceRow key={row.id} row={row} first={i === 0} theme={theme} compact={compact} checking={checking}
        busy={data.retrying.includes(row.id) || (!!pending && (pending.retry === row.id || (pending.on ? row.id in pending.on : false)))}
        onToggle={on => change.mutate({ on: { [row.id]: on } })} onRetry={() => change.mutate({ retry: row.id })} onCheck={() => change.mutate({ check: true })} onCopy={copy} />)}
    </View>}
    <SettingsCard>
      <SettingsSelect label="Chat window" hint="How far back the brief reads DMs and mentions." value={String(view.queue.chatHours)} disabled={windows.isPending}
        options={[24, 48, 72].map(h => ({ value: String(h), label: `Last ${h} h` }))} onValueChange={v => windows.mutate({ chatHours: Number(v) as 24 | 48 | 72 })} />
      <SettingsSelect label="Calendar" hint="Which meetings the brief reads." value={String(view.queue.calendarDays)} disabled={windows.isPending}
        options={[{ value: "1", label: "Today" }, { value: "2", label: "Today and tomorrow" }]} onValueChange={v => windows.mutate({ calendarDays: Number(v) as 1 | 2 })} />
    </SettingsCard>
    {notRead.length > 0 && <View style={{ gap: 6 }}>
      <Pressable accessibilityRole="button" aria-expanded={showNotRead} accessibilityState={{ expanded: showNotRead }} onPress={() => setShowNotRead(v => !v)}
        style={{ flexDirection: "row", alignItems: "center", gap: 4, alignSelf: "flex-start", minHeight: compact ? 44 : 24 }}>
        <Text style={t.meta}>{`${notRead.length} more on mcpproxy the brief can't read`}</Text>
        <Icon name={showNotRead ? "ChevronUp" : "ChevronDown"} size={13} color={c.foregroundMuted} />
      </Pressable>
      {showNotRead && notRead.map(row => <View key={row.id} style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", columnGap: 6 }}>
        <Text style={[t.meta, MONO, { color: c.foreground }]}>{row.label}</Text>
        <Text style={t.meta}>{row.detail ?? row.adds}</Text>
      </View>)}
    </View>}
    {data && <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
      <Button title="Check sources again" icon="RotateCcw" theme={theme} compact={compact} loading={checking} onPress={() => change.mutate({ check: true })} />
      {data.checking ? <Text style={t.meta}>Asking mcpproxy…</Text> : data.checkedAt && <Text style={t.meta}>{`Checked ${clock(data.checkedAt)}`}</Text>}
    </View>}
  </SettingsSection>;
}

const MONO = { fontFamily: "ui-monospace, Menlo, monospace", fontSize: 11 } as const;
/** 24-hour time, like the sweep's "07:00". */
const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/** An amber line: the icon stays beside the first line, the text wraps under itself, an action follows it. */
function Warning({ text: line, action, theme, compact }: { text: string; action?: ReactNode; theme: Theme; compact: boolean }) {
  const c = theme.colors; const t = text(c, compact);
  return <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 6 }}>
    <View style={{ paddingTop: compact ? 4 : 3 }}><Icon name="TriangleAlert" size={12} color={c.statusWarning} /></View>
    <View style={{ flex: 1, minWidth: 0, flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 8 }}>
      <Text style={[t.meta, { color: c.statusWarning, flexShrink: 1 }]}>{line}</Text>
      {action}
    </View>
  </View>;
}

/**
 * One source: healthy ones show no colour; one that failed says why in amber with Retry, one that needs a sign-in
 * gives the command to copy and Check again.
 */
function SourceRow({ row, first, busy, checking, onToggle, onRetry, onCheck, onCopy, theme, compact }: {
  row: BriefSource; first: boolean; busy: boolean; checking: boolean; onToggle: (on: boolean) => void; onRetry: () => void; onCheck: () => void; onCopy: (command: string) => void; theme: Theme; compact: boolean;
}) {
  const c = theme.colors; const t = text(c, compact);
  const bad = row.on && (row.health === "failed" || row.health === "sign-in");
  const meta = [row.adds, row.cost, row.on && row.health === "ok" && row.readAt ? `read ${clock(row.readAt)}` : null].filter(Boolean).join(" · ");
  const action = (title: string, onPress: () => void, loading: boolean) => <Pressable accessibilityRole="button" onPress={onPress} disabled={loading} hitSlop={compact ? 0 : 6}
    style={{ flexDirection: "row", alignItems: "center", gap: 4, minHeight: compact ? 44 : 18, opacity: loading ? 0.6 : 1 }}>
    {loading ? <ActivityIndicator size="small" color={c.accent} /> : <Icon name="RotateCcw" size={12} color={c.accent} />}
    <Text style={[t.meta, { color: c.accent, fontWeight: "600" }]}>{title}</Text>
  </Pressable>;
  return <View style={{ flexDirection: "row", gap: 10, alignItems: "flex-start", padding: compact ? 14 : 12, borderTopWidth: first ? 0 : 1, borderTopColor: c.border }}>
    <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", columnGap: 6 }}>
        <Text style={[t.label, { color: row.on ? c.foreground : c.foregroundMuted }]}>{row.label}</Text>
        {/* The mcpproxy server it reads, unless it says the same as the label. */}
        {row.server && row.server.toLowerCase() !== row.label.toLowerCase() && <Text style={[t.meta, MONO]}>{row.server}</Text>}
      </View>
      <Text style={t.meta}>{meta}</Text>
      {bad && <Warning text={row.detail ?? (row.health === "sign-in" ? "Needs a sign-in." : "The last read failed.")} theme={theme} compact={compact}
        action={row.health === "failed" ? action("Retry", onRetry, busy) : action("Check again", onCheck, checking)} />}
      {bad && row.command && <View style={{ flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-start", maxWidth: "100%", marginLeft: 18, paddingLeft: 10, borderRadius: 6, backgroundColor: c.surface2 }}>
        <Text selectable numberOfLines={1} style={{ flexShrink: 1, color: c.foreground, fontSize: 12, lineHeight: 17, fontFamily: MONO.fontFamily }}>{row.command}</Text>
        <IconButton theme={theme} compact={compact} icon="Copy" label={`Copy ${row.command}`} onPress={() => onCopy(row.command!)} />
      </View>}
      {!row.on && row.detail && <Text style={t.meta}>{row.detail}</Text>}
    </View>
    {row.canToggle
      ? <Switch theme={theme} compact={compact} label={compact ? "" : row.on ? "On" : "Off"} accessibilityLabel={`Read ${row.label} in the brief`} value={row.on} disabled={busy} onChange={onToggle} />
      : <Text style={[t.meta, { minHeight: compact ? 44 : 28, lineHeight: compact ? 44 : 28 }]}>Always</Text>}
  </View>;
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
    {options.map(choice => {
      const on = choice.value === value;
      return <Pressable key={choice.value} accessibilityRole="radio" accessibilityState={{ checked: on, disabled }} disabled={disabled} onPress={() => onChange(choice.value)}
        style={state => ({ flexGrow: compact ? 1 : 0, flexBasis: compact ? 0 : "auto", minHeight: compact ? 44 : 30, paddingHorizontal: 12, borderRadius: 6, alignItems: "center", justifyContent: "center",
          backgroundColor: on ? c.surface0 : (state as { hovered?: boolean }).hovered ? tint(c.foreground, c) : "transparent", ...(on ? { boxShadow: "0px 0px 0px 1px rgba(127,127,127,0.18)" } : {}) })}>
        <Text style={{ color: on ? c.foreground : c.foregroundMuted, fontSize: compact ? 14 : 13, fontWeight: "500" }}>{choice.label}</Text>
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
      {options.map(choice => {
        const on = value.includes(choice.value);
        const last = on && value.length === 1;
        return <Pressable key={choice.value} accessibilityRole="checkbox" accessibilityState={{ checked: on, disabled: disabled || last }} accessibilityLabel={choice.label} disabled={disabled || last}
          onPress={() => onChange(on ? value.filter(x => x !== choice.value) : options.map(x => x.value).filter(x => x === choice.value || value.includes(x)))}
          style={state => ({ minWidth: compact ? 44 : 40, minHeight: compact ? 44 : 30, paddingHorizontal: 10, borderRadius: 6, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 5, borderWidth: 1,
            borderColor: on ? withAlpha(c.accent, 0.55) : c.border, backgroundColor: on ? withAlpha(c.accent, 0.1) : (state as { hovered?: boolean }).hovered ? c.surface1 : "transparent" })}>
          {on && <Icon name="Check" size={12} color={c.foreground} />}
          <Text style={{ color: on ? c.foreground : c.foregroundMuted, fontSize: 13, fontWeight: "500" }}>{choice.label}</Text>
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
