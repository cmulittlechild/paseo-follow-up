import { useState } from "react";
import { ActivityIndicator, TextInput, View } from "react-native";
import { Text } from "./text";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon, Modal, SettingsAction, SettingsCard, SettingsSection, SettingsSelect, SettingsSwitch, useToast } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { prStatsSettingsRpc, setPrStatsRpc } from "../shared/contracts";
import { estimateLines, sizeWords, statsRepoLine, statsRepoWait, type SetPrStatsInput, type StatsSettingsView, type StatsTeam } from "../shared/pr-stats-settings";
import { Button, errorText, SubmitScope, text, type Theme } from "./kit";
import { Disclosure } from "./settings-shell";

export const prStatsSettingsKey = ["follow-up", "pr-stats-settings"];
type Row = StatsSettingsView["repos"][number];
const REPO = /^[\w.-]+\/[\w.-]+$/;
export const PR_STATS_INFO = "PR statistics show who opens PRs and whose PRs wait longest for a first review, from each repository's own GitHub data. Turn them on per repository. They read GitHub slowly in the background, stop whenever GitHub's limit drops under 40% so your agents and PR checks come first, and stay on this machine.";

/**
 * Settings → Following → PR statistics: one switch per repository Follow-up knows. Turning one on opens the opt-in
 * sheet (the estimate first, `OptInSheet`); turning one off asks in place, with keeping the data as the default and
 * deleting it as the quiet extra. Options per repository (window, team, hidden people) fold under it; the clock and
 * GitHub share are host-wide.
 */
export function PrStatsSettings({ theme, compact }: { theme: Theme; compact: boolean }) {
  const c = theme.colors; const t = text(c, compact);
  const read = useRpc(prStatsSettingsRpc); const write = useRpc(setPrStatsRpc); const cache = useQueryClient(); const toast = useToast();
  const query = useQuery({ queryKey: prStatsSettingsKey, queryFn: () => read({}), staleTime: 30_000, refetchInterval: 60_000 });
  const change = useMutation({
    mutationFn: (input: SetPrStatsInput & { toast?: string }) => { const { toast: _, ...rest } = input; return write(rest); },
    onSuccess: (v, input) => { cache.setQueryData(prStatsSettingsKey, v); if (input.toast) toast.show(input.toast, { variant: "success" }); },
    onError: e => toast.error(errorText(e)),
  });
  const [optIn, setOptIn] = useState<string | null>(null);
  const [confirmOff, setConfirmOff] = useState<string | null>(null);
  const [adding, setAdding] = useState("");
  const data = query.data;
  const withStats = data?.repos.filter(r => r.state !== "off") ?? [];
  const addValid = REPO.test(adding.trim()) && !data?.repos.some(r => r.repo === adding.trim() && r.state !== "off");
  return <SettingsSection title="PR statistics" info={PR_STATS_INFO}>
    {query.isPending && <ActivityIndicator accessibilityLabel="Loading PR statistics settings" color={c.foregroundMuted} style={{ alignSelf: "flex-start", marginVertical: 8 }} />}
    {query.error && <SettingsCard><SettingsAction label="Couldn't load PR statistics" hint={errorText(query.error)} actionLabel="Retry" onPress={() => void query.refetch()} /></SettingsCard>}
    {data && <>
      <SettingsCard>
        {data.repos.map(row => <View key={row.repo}>
          <SettingsSwitch label={row.repo} hint={[statsRepoLine(row, data.timeZone), statsRepoWait(row)].filter(Boolean).join("\n")} value={row.state === "on"} disabled={change.isPending}
            onValueChange={on => {
              if (on && row.state === "paused") change.mutate({ repo: row.repo, enable: true, toast: `${row.repo}: PR statistics on` });
              else if (on) setOptIn(row.repo);
              else setConfirmOff(row.repo);
            }} />
          {confirmOff === row.repo && <TurnOffConfirm row={row} theme={theme} compact={compact} busy={change.isPending}
            onKeep={() => { setConfirmOff(null); change.mutate({ repo: row.repo, enable: false, toast: `${row.repo}: paused, data kept` }); }}
            onDelete={() => { setConfirmOff(null); change.mutate({ repo: row.repo, enable: false, delete: true, toast: `${row.repo}: off, data deleted` }); }}
            onCancel={() => setConfirmOff(null)} />}
        </View>)}
        {/* A repository Follow-up hasn't seen yet. */}
        <SubmitScope enabled={addValid} onSubmit={() => setOptIn(adding.trim())} style={{ flexDirection: compact ? "column" : "row", alignItems: compact ? "stretch" : "center", gap: 8, paddingHorizontal: compact ? 16 : 14, paddingVertical: 10, borderTopWidth: data.repos.length ? 1 : 0, borderTopColor: c.border }}>
          <TextInput accessibilityLabel="Another repository, owner/repo" value={adding} onChangeText={setAdding} placeholder="Another repository: owner/repo" placeholderTextColor={c.foregroundMuted} autoCapitalize="none" autoCorrect={false}
            style={{ flex: compact ? undefined : 1, minWidth: 0, minHeight: compact ? 44 : 32, paddingHorizontal: 10, borderRadius: 6, borderWidth: 1, borderColor: c.border, color: c.foreground, fontSize: compact ? 15 : 13, backgroundColor: c.surface0 }} />
          <Button theme={theme} compact={compact} grow={compact} icon="Plus" title="Add…" disabled={!addValid} onPress={() => setOptIn(adding.trim())} />
        </SubmitScope>
      </SettingsCard>
      {!data.repos.length && <Text style={t.meta}>Repositories show here once Follow-up sees a PR in them or a project with a GitHub remote, or add one above.</Text>}
      {withStats.length > 0 && <SettingsCard>
        <SettingsSelect label="GitHub share for stats" hint="At most this much of GitHub's hourly limit in any hour; stats always stop under 40% left." value={String(Math.round(data.settings.slice * 100))} disabled={change.isPending}
          options={["1", "2", "5", "10"].map(v => ({ value: v, label: `${v}%` }))} onValueChange={v => change.mutate({ slice: Number(v) / 100, toast: `Stats may use ${v}% of GitHub's limit` })} />
        <SettingsSelect<"calendar" | "working"> label="Clock" hint={`Working hours use one schedule for everyone: ${hoursWords(data.settings.hours)}, ${data.timeZone}.`} value={data.settings.clock} disabled={change.isPending}
          options={[{ value: "calendar", label: "Calendar time" }, { value: "working", label: "Working hours" }]} onValueChange={v => change.mutate({ clock: v, toast: v === "working" ? "Stats count working hours" : "Stats count calendar time" })} />
        <SettingsSwitch label="Count stacks fairly" hint="A stacked PR's review clock starts when its parent got a first review or merged, not while it waits its turn." value={data.settings.enable_stack_aware} disabled={change.isPending}
          onValueChange={v => change.mutate({ enable_stack_aware: v, toast: v ? "Stacked PRs start their clocks when reached" : "Stacked PRs start their clocks when asked" })} />
      </SettingsCard>}
      {withStats.map(row => <Disclosure key={row.repo} id={`pr-stats.repo.${row.repo}`} title={`${row.repo} options`} summary={repoOptionsSummary(row)} defaultOpen={false} theme={theme} compact={compact}>
        <RepoOptions row={row} theme={theme} compact={compact} busy={change.isPending} set={(input, label) => change.mutate({ repo: row.repo, ...input, toast: `${row.repo}: ${label}` })} />
      </Disclosure>)}
    </>}
    {optIn && <OptInSheet repo={optIn} theme={theme} compact={compact} onClose={() => setOptIn(null)}
      onTurnOn={() => { const repo = optIn; setOptIn(null); setAdding(""); change.mutate({ repo, enable: true, toast: `${repo}: PR statistics on. The first read runs in the background.` }); }} />}
  </SettingsSection>;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const hhmm = (m: number) => `${Math.floor(m / 60)}${m % 60 ? `:${String(m % 60).padStart(2, "0")}` : ""}`;
export function hoursWords(h: { days: number[]; from: number; to: number }): string {
  const days = [...h.days].sort((a, b) => a - b);
  const run = days.length > 1 && days.every((d, i) => i === 0 || d === days[i - 1]! + 1);
  return `${run ? `${DAYS[days[0]!]}–${DAYS[days.at(-1)!]}` : days.map(d => DAYS[d]).join(", ")} ${hhmm(h.from)}–${hhmm(h.to)}`;
}
const teamWords = (team: StatsTeam) => team.kind === "everyone" ? "everyone" : team.kind === "people" ? `${team.logins.length} ${team.logins.length === 1 ? "person" : "people"}` : `@${team.team}`;
function repoOptionsSummary(row: Row): string {
  const s = row.settings!;
  return [`${s.windowDays} days`, teamWords(s.team), s.ignore.length ? `${s.ignore.length} hidden` : null].filter(Boolean).join(" · ");
}

/** The quiet two-choice confirm in place (Q123's pattern): keep the data is the bordered default; delete is quiet red text. */
function TurnOffConfirm({ row, theme, compact, busy, onKeep, onDelete, onCancel }: { row: Row; theme: Theme; compact: boolean; busy: boolean; onKeep: () => void; onDelete: () => void; onCancel: () => void }) {
  const c = theme.colors; const t = text(c, compact);
  const n = row.settings?.status?.records ?? 0;
  return <View accessibilityRole="alert" style={{ flexDirection: compact ? "column" : "row", alignItems: compact ? "stretch" : "center", gap: compact ? 10 : 16, paddingHorizontal: compact ? 16 : 14, paddingVertical: 12, borderTopWidth: 1, borderTopColor: c.border, borderStyle: "dashed" }}>
    <Text style={[t.body, { flex: compact ? undefined : 1 }]}>{`Stop reading ${row.repo}? Its stored PRs stay readable unless you delete them.`}</Text>
    <View style={{ flexDirection: compact ? "column-reverse" : "row", alignItems: compact ? "stretch" : "center", gap: 8 }}>
      {n > 0 && <Button theme={theme} compact={compact} kind="danger" title={`Also delete the ${n.toLocaleString("en-US")} PRs`} disabled={busy} onPress={onDelete} accessibilityHint="Turns stats off and deletes what was read. This can't be undone." />}
      {!compact && <Button theme={theme} compact={compact} kind="ghost" title="Cancel" onPress={onCancel} />}
      <Button theme={theme} compact={compact} kind="secondary" title="Turn off, keep data" disabled={busy} onPress={onKeep} />
      {compact && <Button theme={theme} compact={compact} kind="ghost" title="Cancel" onPress={onCancel} />}
    </View>
  </View>;
}

/** Window, team filter and hidden people for one repository. */
function RepoOptions({ row, theme, compact, busy, set }: { row: Row; theme: Theme; compact: boolean; busy: boolean; set: (input: Omit<SetPrStatsInput, "repo">, label: string) => void }) {
  const c = theme.colors; const t = text(c, compact);
  const s = row.settings!;
  const [teamDraft, setTeamDraft] = useState(s.team.kind === "people" ? s.team.logins.join(", ") : s.team.kind === "github" ? s.team.team : "");
  const [teamKind, setTeamKind] = useState<StatsTeam["kind"]>(s.team.kind);
  const [hidden, setHidden] = useState(s.ignore.join(", "));
  const members = s.status?.teamMembers;
  const teamHint = s.team.kind === "github" && members?.team === s.team.team && members.error ? `Can't read the team @${s.team.team} with this GitHub account, so stats show everyone. Pick people instead, or give gh read:org.`
    : teamKind === "people" ? "Logins, separated by commas." : teamKind === "github" ? "org/team-slug, read once a day." : "Everyone who opened or reviewed a PR here, minus bots and hidden people.";
  const logins = (v: string) => [...new Set(v.split(/[\s,]+/).map(x => x.trim().replace(/^@/, "")).filter(Boolean))];
  const field = { flex: 1, minWidth: 0, minHeight: compact ? 44 : 32, paddingHorizontal: 10, borderRadius: 6, borderWidth: 1, borderColor: c.border, color: c.foreground, fontSize: compact ? 15 : 13, backgroundColor: c.surface0 } as const;
  const saveTeam = () => {
    if (teamKind === "people" && logins(teamDraft).length) set({ team: { kind: "people", logins: logins(teamDraft) } }, `team: ${logins(teamDraft).length} people`);
    if (teamKind === "github" && /^[\w.-]+\/[\w.-]+$/.test(teamDraft.trim().replace(/^@/, ""))) set({ team: { kind: "github", team: teamDraft.trim().replace(/^@/, "") } }, `team: @${teamDraft.trim().replace(/^@/, "")}`);
  };
  const pad = { paddingHorizontal: compact ? 16 : 14, paddingBottom: 10 };
  return <View style={{ paddingBottom: 6 }}>
    <SettingsSelect label="History" hint="How far back stats read. Longer reads more once, then costs the same to keep current." value={String(s.windowDays)} disabled={busy}
      options={[30, 90, 180].map(d => ({ value: String(d), label: `${d} days` }))} onValueChange={v => set({ windowDays: Number(v) as 30 | 90 | 180 }, `${v} days of history`)} />
    <SettingsSelect<StatsTeam["kind"]> label="Team" hint={teamHint} value={teamKind} disabled={busy}
      options={[{ value: "everyone", label: "Everyone" }, { value: "people", label: "Picked people" }, { value: "github", label: "A GitHub team" }]}
      onValueChange={v => { setTeamKind(v); if (v === "everyone") set({ team: { kind: "everyone" } }, "team: everyone"); }} />
    {teamKind !== "everyone" && <SubmitScope enabled={!busy} onSubmit={saveTeam} style={[pad, { flexDirection: "row", alignItems: "center", gap: 8 }]}>
      <TextInput accessibilityLabel={teamKind === "people" ? "Team logins" : "GitHub team, org/slug"} value={teamDraft} onChangeText={setTeamDraft} placeholder={teamKind === "people" ? "alice, bob, carol" : "example/backend"} placeholderTextColor={c.foregroundMuted} autoCapitalize="none" autoCorrect={false} style={field} />
      <Button theme={theme} compact={compact} title="Save" disabled={busy} onPress={saveTeam} />
    </SubmitScope>}
    <View style={{ height: 1, backgroundColor: c.border, marginLeft: 16 }} />
    <View style={{ paddingHorizontal: compact ? 16 : 14, paddingTop: 10, gap: 4 }}>
      <Text style={t.body}>Hidden from stats</Text>
      <Text style={t.meta}>Bots are always hidden. Add service accounts that look like people; * matches anything.</Text>
    </View>
    <SubmitScope enabled={!busy} onSubmit={() => set({ ignore: logins(hidden) }, logins(hidden).length ? `${logins(hidden).length} hidden` : "nobody hidden")} style={[pad, { paddingTop: 8, flexDirection: "row", alignItems: "center", gap: 8 }]}>
      <TextInput accessibilityLabel="Hidden from stats, logins" value={hidden} onChangeText={setHidden} placeholder="deploy-robot, release-*" placeholderTextColor={c.foregroundMuted} autoCapitalize="none" autoCorrect={false} style={field} />
      <Button theme={theme} compact={compact} title="Save" disabled={busy} onPress={() => set({ ignore: logins(hidden) }, logins(hidden).length ? `${logins(hidden).length} hidden` : "nobody hidden")} />
    </SubmitScope>
  </View>;
}

/**
 * The opt-in sheet: what turning stats on reads, costs and stores, from the repository's own count (1 GitHub point),
 * before anything is read. The switch turns on only from its Turn on; a repository the token can't read is refused here.
 */
export function OptInSheet({ repo, theme, compact, onClose, onTurnOn }: { repo: string; theme: Theme; compact: boolean; onClose: () => void; onTurnOn: () => void }) {
  const c = theme.colors; const t = text(c, compact);
  const read = useRpc(prStatsSettingsRpc);
  const query = useQuery({ queryKey: [...prStatsSettingsKey, "estimate", repo], queryFn: () => read({ repo, estimate: true }), staleTime: 5 * 60_000, retry: false });
  const e = query.data?.estimate ?? null;
  const slice = query.data?.settings.slice ?? 0.05;
  const lines = e ? estimateLines(e, slice) : null;
  const point = (icon: string, main: string, sub?: string) => <View style={{ flexDirection: "row", gap: 10 }}>
    <View style={{ paddingTop: compact ? 2 : 1 }}><Icon name={icon} size={16} color={c.foregroundMuted} /></View>
    <View style={{ flex: 1, gap: 2 }}><Text style={t.body}>{main}</Text>{sub && <Text style={t.meta}>{sub}</Text>}</View>
  </View>;
  return <Modal title={`Turn on PR stats for ${repo}?`} open onOpenChange={next => { if (!next) onClose(); }}>
    <Modal.Content contentContainerStyle={{ padding: compact ? 16 : 20 }}>
      <SubmitScope enabled={!!lines} onSubmit={onTurnOn} style={{ gap: compact ? 16 : 14, maxWidth: 560 }}>
        {query.isPending && <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}><ActivityIndicator color={c.foregroundMuted} /><Text style={t.meta}>Counting PRs changed in the last 90 days…</Text></View>}
        {(query.error || e?.error) && <Text accessibilityRole="alert" style={[t.body, { color: c.statusDanger }]}>{e?.error ?? errorText(query.error)}</Text>}
        {lines && e && <>
          <Text style={[t.body, { color: c.foregroundMuted }]}>About <Text style={[t.body, { fontWeight: "600" }]}>{`${e.prs!.toLocaleString("en-US")} PRs`}</Text> changed in the last 90 days.</Text>
          {point("Gauge", `${lines.cost} ${lines.time}`, "Staying current: about 1–15 points an hour.")}
          {point("CirclePause", "Stats pause whenever GitHub's limit drops under 40%, so your agents and PR checks always come first.")}
          {point("Lock", `Stored on this machine only, about ${sizeWords(e.bytes ?? 0)}: numbers, times, logins and PR titles.`, "No code and no comment text. Bots are left out.")}
          <Text style={t.meta}>90 days · everyone · calendar time. Change these under the repository's options once it's on.</Text>
        </>}
        <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8, flexWrap: "wrap" }}>
          <Button theme={theme} compact={compact} grow={compact} kind="ghost" title="Cancel" onPress={onClose} />
          <Button shortcut theme={theme} compact={compact} grow={compact} kind="primary" title="Turn on" disabled={!lines} onPress={onTurnOn} />
        </View>
      </SubmitScope>
    </Modal.Content>
  </Modal>;
}
