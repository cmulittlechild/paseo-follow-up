// Catch up: everything in Needs you, one card at a time (docs/design/catch-up.md). Design prototype for review: it
// renders real Home data through the same components the panel and Home use (QuestionBody, NeedsYouList, BriefCard,
// the permission block), so the answer flow is the shared one, never a fork.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { PanResponder, Platform, View, useWindowDimensions } from "react-native";
import { Pressable, Text } from "./text";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon, ScrollView, TextInput } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { inboxBriefRpc } from "../shared/contracts";
import { needsYou } from "../shared/attention";
import { liveBrief } from "../shared/brief";
import { age } from "../shared/inbox";
import { CATCH_UP_KEYS, MODE, deckCards, reconcile, statsOf, type DeckCard, type Outcome } from "../shared/catch-up";
import type { Workspace } from "../shared/model";
import type { ListWorkspace } from "../shared/list";
import { bottomInset, Button, IconButton, text, type Theme } from "./kit";
import { glyphColor } from "./home-list";
import { useHomeModel, type HomeSources } from "./home-data";
import { useInbox } from "./inbox";
import { QuestionBody } from "./questions";
import { NeedsYouList } from "./needs-you";
import { BriefCard, type BriefDeps } from "./brief";
import { SummaryLine } from "./about";
import { ReferencesLine } from "./linked";
import { openRowCopy, useWorkspace } from "./workspace-data";
import { mergedColor, withAlpha, tint } from "./theme";
import { RichText } from "./rich-text";
import { PermissionBlock, useAgentLive } from "./home";

/** react-native-web's data attribute, so the option-letter keys find this card's radios. */
const CARD_MARK = { dataSet: { catchUpCard: "1" } } as object;

/** The design PR's renders set these in localStorage (`follow-up-catch-up-review`); nothing else does. */
export function reviewKnobs(): Knobs {
  try { return JSON.parse((globalThis as { localStorage?: { getItem(k: string): string | null } }).localStorage?.getItem("follow-up-catch-up-review") ?? "{}") as Knobs; } catch { return {}; }
}

export type CatchUpDeps = { sources: HomeSources; briefDeps: BriefDeps; openHome(): void; openPanel(workspaceId: string): void };
type Nav = { openAgent(a: { agentId: string }): void; openWorkspace(a: { workspaceId: string }): void } | undefined;
/** Review-only knobs for the design PR's renders: `layout` a|b, `rail` 0|1, `demo` more|overseer|asked|gone|arrived|keys. */
type Knobs = { layout?: string; rail?: string; demo?: string; at?: string; find?: string };

/** One card's label in the queue rail and the progress line: "Q1 · Retry declined cards?", "Merge #255". */
function cardLabel(card: DeckCard, w: ListWorkspace | undefined): string {
  if (card.kind === "permission") return "Permission";
  if (card.kind === "question") { const q = w?.questions.find(x => x.id === card.questionId); return q ? `${q.id} · ${q.title}` : card.questionId ?? "Question"; }
  if (card.kind === "item" && card.item) return card.item.title;
  if (card.kind === "brief") return card.s.line || card.s.word || "Ask";
  return card.s.line || "Finished";
}
/** The card's own word: a workspace row's word names its first item, the card names its own. */
function cardWord(card: DeckCard): string {
  if (card.kind === "permission") return "Permission";
  if (card.kind === "question") return card.item?.kind === "question" && card.item.state === "stopped" ? "Agent stopped" : "Question";
  if (card.kind === "finished") return "Finished";
  if (card.kind === "brief") return card.s.word ?? "Ask";
  switch (card.item?.kind) {
    case "merge": return "Merge"; case "reviewers": return "Add reviewers"; case "send": return "Send"; case "answer": return "Your answer";
    case "hold": return "Paused"; case "retry": case "capped": case "message": return "Retry"; case "check": return "Check"; case "decision": return "Blocked";
    default: return card.s.word ?? "Needs you";
  }
}
const cardIcon = (card: DeckCard) => card.kind === "permission" ? "ShieldQuestion" : card.kind === "question" ? "MessageCircleQuestion"
  : card.item?.kind === "merge" ? "GitMerge" : card.item?.kind === "reviewers" ? "UserPlus" : card.item?.kind === "send" ? "Send" : card.kind === "finished" ? "Flag" : card.s.icon;

export function CatchUp({ theme, compact, deps, navigation, knobs, onExit }: { theme: Theme; compact: boolean; deps: CatchUpDeps; navigation: Nav; knobs: Knobs; onExit: () => void }) {
  const c = theme.colors; const t = text(c, compact);
  const { inbox, live } = deps.sources;
  const model = useHomeModel(deps.sources);
  const rows = useInbox(inbox, () => inbox.rows());
  const version = useSyncExternalStore(live.subscribe, live.version, live.version);
  // Everything comes from what the client already holds: Home's model, the inbox rows, the listed workspaces.
  const liveCards = useMemo(() => deckCards({ model, rows, items: id => { const w = live.get(id); return w ? needsYou(w as unknown as Workspace) : []; } }),
    [model, rows, version, live]); // eslint-disable-line react-hooks/exhaustive-deps
  const byKey = useMemo(() => new Map(liveCards.map(x => [x.key, x])), [liveCards]);
  // The deck as it opened, plus what arrived since (at the end). A card handled elsewhere stays in place, marked.
  const [order, setOrder] = useState<string[]>([]);
  const seen = useRef(new Map<string, DeckCard>());
  for (const card of liveCards) seen.current.set(card.key, card);
  useEffect(() => { setOrder(o => { const next = reconcile(o, liveCards); return next.length === o.length ? o : next; }); }, [liveCards]);
  const [pos, setPos] = useState(() => Number(knobs.at ?? 0) || 0);
  const [outcomes, setOutcomes] = useState(() => new Map<string, Outcome>());
  const [more, setMore] = useState(knobs.demo === "more" || knobs.demo === "overseer");
  const [arrivedAt] = useState(() => knobs.demo === "arrived" ? 1 : 0);
  // Review renders: start on the card whose key or label matches `find`.
  const found = useRef(false);
  useEffect(() => {
    if (found.current || !knobs.find || !order.length) return;
    const i = order.findIndex(k => { const x = byKey.get(k); return k.includes(knobs.find!) || (!!x && `${x.s.title} ${cardLabel(x, x.s.workspaceId ? live.get(x.s.workspaceId) : undefined)}`.includes(knobs.find!)); });
    found.current = true; if (i >= 0) setPos(i);
  }, [order]); // eslint-disable-line react-hooks/exhaustive-deps
  const key = order[pos] ?? null;
  const card = key ? byKey.get(key) ?? seen.current.get(key) ?? null : null;
  const gone = !!key && !byKey.has(key) || knobs.demo === "gone";
  const finished = order.length > 0 && pos >= order.length || knobs.demo === "finished";
  const settle = (outcome: Outcome) => {
    if (!key) return;
    setOutcomes(m => new Map(m).set(key, outcome)); setMore(false);
    setPos(p => p + 1);
  };
  const back = () => { setMore(false); setPos(p => Math.max(0, p - 1)); };
  const w = card?.s.workspaceId ? live.get(card.s.workspaceId) : undefined;
  // The next card's workspace detail is read while this one is on screen, so it paints at once (prefetch, no poll).
  const nextCard = order[pos + 1] ? byKey.get(order[pos + 1]) : undefined;
  useWorkspace(live, nextCard?.s.workspaceId ?? "", { enabled: !!nextCard?.s.workspaceId });

  // Desktop keys: option letters pick, J/K or the arrows move, M asks for context, Esc leaves. Never while typing.
  const root = useRef<View>(null);
  useEffect(() => {
    if (Platform.OS !== "web" || compact) return;
    type Ev = { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; isComposing: boolean; target: unknown; preventDefault(): void };
    type El = { tagName?: string; isContentEditable?: boolean; click?(): void };
    const doc = (globalThis as { document?: { querySelector(q: string): El | null; addEventListener(t: string, f: (e: Ev) => void): void; removeEventListener(t: string, f: (e: Ev) => void): void } }).document; if (!doc) return;
    const onKey = (e: Ev) => {
      const el = e.target as El | null;
      if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing || el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      const k = e.key.toLowerCase();
      if (k === "j" || e.key === "ArrowRight") settle("skipped");
      else if (k === "k" || e.key === "ArrowLeft") back();
      else if (k === "m") setMore(v => !v);
      else if (e.key === "Escape") onExit();
      else if (/^[a-h]$/.test(k)) { doc.querySelector(`[data-catch-up-card] [role="radio"][aria-label^="${k.toUpperCase()}. "]`)?.click?.(); }
      else return;
      e.preventDefault();
    };
    doc.addEventListener("keydown", onKey);
    return () => doc.removeEventListener("keydown", onKey);
  });
  // Phones: swipe left to skip, right to go back. Answers are never a swipe: a stray thumb must not decide anything.
  const pan = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_e, g) => compact && Math.abs(g.dx) > 24 && Math.abs(g.dx) > Math.abs(g.dy) * 2,
    onPanResponderRelease: (_e, g) => { if (g.dx < -80) settle("skipped"); else if (g.dx > 80) back(); },
  }), [compact, key]); // eslint-disable-line react-hooks/exhaustive-deps

  const stats = knobs.demo === "finished" ? { done: 7, skipped: 2, later: 1, asked: 1, gone: 1 } : statsOf(outcomes);
  const total = order.length + arrivedAt;
  const progress = <View style={{ gap: 6, paddingHorizontal: compact ? 16 : 20, paddingTop: compact ? 8 : 14, paddingBottom: 10 }}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: compact ? 44 : 32 }}>
      {/* Phones: the host header's ← is the only back control (DESIGN.md "One header"). */}
      {!compact && <IconButton theme={theme} compact={compact} icon="X" label={`Leave ${MODE.name}`} onPress={onExit} />}
      <Text accessibilityRole="header" style={[t.title, { flex: 1 }]}>{finished ? MODE.name : <>{MODE.name} <Text style={{ color: c.foregroundMuted, fontWeight: "400", fontVariant: ["tabular-nums"] }}>{MODE.progress(Math.min(pos + 1, total), total)}</Text></>}</Text>
      {knobs.demo === "arrived" && <View style={{ flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 8, height: 22, borderRadius: 11, backgroundColor: tint(c.statusWarning, c) }}>
        <Icon name="Plus" size={11} color={c.statusWarning} /><Text style={[t.small, { color: c.statusWarning, fontWeight: "600" }]}>1 new · at the end</Text>
      </View>}
      {knobs.demo === "asked" && <View style={{ flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 8, height: 22, borderRadius: 11, backgroundColor: c.surface2 }}>
        <Icon name="Hourglass" size={11} color={c.foregroundMuted} /><Text style={[t.small, { fontWeight: "600" }]}>1 explaining</Text>
      </View>}
      {!compact && !finished && <Text style={t.small}>J skip · K back · M more context</Text>}
    </View>
    {/* One segment per card: done in the foreground colour, skipped hollow, the current one amber, the rest the track. */}
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ flexDirection: "row", gap: 3 }}>
      {total > 24 ? <View style={{ flex: 1, height: 4, borderRadius: 2, backgroundColor: c.border }}><View style={{ width: `${Math.round(100 * Math.min(pos, total) / total)}%`, height: 4, borderRadius: 2, backgroundColor: c.foreground }} /></View>
        : Array.from({ length: total }, (_, i) => {
        const o = order[i] ? outcomes.get(order[i]) : undefined;
        const bg = i === pos && !finished ? c.statusWarning : o === "done" ? c.foreground : o ? withAlpha(c.foreground, 0.35) : c.border;
        return <View key={i} style={{ flex: 1, height: 4, borderRadius: 2, backgroundColor: bg }} />;
      })}
    </View>
  </View>;

  const body = finished || !card ? <Finished theme={theme} compact={compact} stats={stats} empty={!order.length} onHome={onExit} onSkipped={() => setPos(order.findIndex(k => outcomes.get(k) === "skipped"))} />
    : <CardView key={card.key} card={card} w={w} theme={theme} compact={compact} deps={deps} navigation={navigation} knobs={knobs} gone={gone} more={more} setMore={setMore}
      sameWorkspace={order.filter(k => (byKey.get(k) ?? seen.current.get(k))?.s.key === card.s.key)} position={order.indexOf(card.key)}
      onDone={() => settle("done")} onSkip={() => settle("skipped")} onBack={pos > 0 ? back : undefined} onLater={() => settle("later")} onAsked={() => settle("asked")} />;

  const rail = !compact && knobs.rail !== "0" && order.length > 0 && !finished && <View style={{ width: 300, borderRightWidth: 1, borderRightColor: c.border }}>
    <ScrollView contentContainerStyle={{ paddingVertical: 8 }}>
      {order.map((k, i) => {
        const x = byKey.get(k) ?? seen.current.get(k); if (!x) return null;
        const xw = x.s.workspaceId ? live.get(x.s.workspaceId) : undefined;
        const o = outcomes.get(k); const here = i === pos && !finished;
        const firstOfWs = i === 0 || (byKey.get(order[i - 1]) ?? seen.current.get(order[i - 1]))?.s.key !== x.s.key;
        return <View key={k}>
          {firstOfWs && <Text numberOfLines={1} style={[t.small, { paddingHorizontal: 16, paddingTop: i ? 10 : 2, paddingBottom: 2, fontWeight: "600" }]}>{x.s.title}</Text>}
          <Pressable accessibilityRole="button" accessibilityState={{ selected: here }} onPress={() => setPos(i)}
            style={state => ({ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 32, paddingHorizontal: 16, backgroundColor: here ? c.surface2 : (state as { hovered?: boolean }).hovered ? c.surface1 : "transparent",
              borderLeftWidth: 2, borderLeftColor: here ? c.statusWarning : "transparent" })}>
            <Icon name={o === "done" ? "CircleCheck" : o === "skipped" ? "CornerUpRight" : o === "asked" ? "Hourglass" : cardIcon(x)} size={13} color={o === "done" ? c.statusSuccess : o ? c.foregroundMuted : glyphColor(x.s, c, false)} />
            <Text numberOfLines={1} style={[t.meta, { flex: 1, color: o ? c.foregroundMuted : c.foreground, textDecorationLine: o === "done" ? "line-through" : "none" }]}>{cardLabel(x, xw)}</Text>
          </Pressable>
        </View>;
      })}
    </ScrollView>
  </View>;

  return <View ref={root} style={{ flex: 1, backgroundColor: c.surface0 }}>
    {progress}
    <View style={{ flex: 1, flexDirection: "row", borderTopWidth: 1, borderTopColor: c.border }}>
      {rail}
      <View style={{ flex: 1, minWidth: 0 }} {...pan.panHandlers}>{body}</View>
    </View>
    {knobs.demo === "keys" && <KeysSheet theme={theme} />}
  </View>;
}

/** One card: who and what, the ask through its own surface's component, then the deck's moves pinned to the bottom. */
function CardView({ card, w, theme, compact, deps, navigation, knobs, gone, more, setMore, sameWorkspace, position, onDone, onSkip, onBack, onLater, onAsked }: {
  card: DeckCard; w: ListWorkspace | undefined; theme: Theme; compact: boolean; deps: CatchUpDeps; navigation: Nav; knobs: Knobs; gone: boolean; more: boolean; setMore: (v: boolean | ((v: boolean) => boolean)) => void;
  sameWorkspace: string[]; position: number; onDone: () => void; onSkip: () => void; onBack?: () => void; onLater: () => void; onAsked: () => void;
}) {
  const c = theme.colors; const t = text(c, compact);
  const s = card.s;
  const { workspace: full } = useWorkspace(deps.sources.live, s.workspaceId ?? "");
  const ws = openRowCopy<ListWorkspace>(w, full);
  const { width } = useWindowDimensions();
  const openChat = () => { if (!navigation) return; if (s.agentId) navigation.openAgent({ agentId: s.agentId }); else if (s.workspaceId) navigation.openWorkspace({ workspaceId: s.workspaceId }); };
  const word = cardWord(card);
  const color = card.item?.kind === "merge" ? mergedColor(c) : card.kind === "finished" ? c.foregroundMuted : c.statusWarning;
  const q = card.kind === "question" ? ws?.questions.find(x => x.id === card.questionId) ?? null : null;
  const nth = sameWorkspace.indexOf(card.key);
  const agentName = s.agent ?? "the agent";
  const layoutB = compact && knobs.layout === "b" && !!q;

  const head = <View style={{ gap: compact ? 6 : 6 }}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
      <Icon name={cardIcon(card)} size={14} color={color} />
      <Text numberOfLines={1} style={[t.meta, { flex: 1 }]}>
        <Text style={{ color, fontWeight: "600" }}>{word}</Text>
        {[s.at ? `${age(s.at, Date.now())} ago` : "", s.project].filter(Boolean).map(x => ` · ${x}`).join("")}
        {sameWorkspace.length > 1 ? ` · ${nth + 1} of ${sameWorkspace.length} here` : ""}
      </Text>
    </View>
    <Text accessibilityRole="header" numberOfLines={2} style={compact ? t.title : [t.title, { fontSize: 17, lineHeight: 23 }]}>{s.title}{s.agent ? <Text style={{ color: c.foregroundMuted, fontWeight: "400" }}>{` › ${s.agent}`}</Text> : null}</Text>
    {ws && <SummaryLine key={ws.id} workspace={ws} theme={theme} compact={compact} />}
    {full && <ReferencesLine workspace={full} theme={theme} compact={compact} />}
  </View>;

  const goneBanner = gone && <View accessibilityRole="alert" style={{ flexDirection: "row", alignItems: "center", gap: 8, padding: 12, borderRadius: 10, backgroundColor: c.surface1, borderWidth: 1, borderColor: c.border }}>
    <Icon name="CircleCheck" size={16} color={c.statusSuccess} />
    <Text style={[t.body, { flex: 1 }]}>Handled elsewhere. Nothing left to do here.</Text>
    <Button theme={theme} compact={compact} kind="primary" icon="ArrowRight" title="Next" onPress={onSkip} />
  </View>;

  const ask = card.kind === "question" && q && ws
    ? <View style={{ gap: 8 }}>
      <RichText plain style={compact ? t.ask : [t.body, { fontSize: 15, lineHeight: 21, fontWeight: "600" }]}>{`${q.id} · ${q.title}`}</RichText>
      <QuestionBody key={q.id} workspace={ws} question={q} theme={theme} compact={compact} dense={layoutB} bodyMaxHeight={layoutB ? 330 : undefined} inline={false}
        openAgent={id => navigation?.openAgent({ agentId: id })} onAnswered={onDone} />
    </View>
    : card.kind === "item" && card.item && full
    ? <View style={{ borderRadius: 10, borderWidth: 1, borderColor: withAlpha(c.statusWarning, 0.45), overflow: "hidden" }}>
      <NeedsYouList workspace={full} theme={theme} compact={compact} rows={[card.item]} flush actions={{ after: onDone, openAgent: openChat } as never} />
    </View>
    : card.kind === "permission" ? <PermissionCard s={s} theme={theme} compact={compact} onDone={onDone} />
    : card.kind === "brief" ? <BriefAsk s={s} theme={theme} compact={compact} deps={deps} />
    : <View style={{ gap: 10 }}>
      <Text style={compact ? t.ask : [t.body, { fontSize: 15, lineHeight: 21, fontWeight: "600" }]}>{s.line || "The agent finished its turn."}</Text>
      <Text style={t.meta}>Nothing to decide. Sign it off once you've read it, or reply.</Text>
      <View style={{ flexDirection: "row", gap: 8 }}><Button theme={theme} compact={compact} grow={compact} kind="primary" icon="Check" title="Sign off" onPress={() => { if (s.agentId) void deps.sources.inbox.signOff([s.agentId]); onDone(); }} /></View>
    </View>;

  // Add context without answering: every card that isn't a question has the agent's reply box (a question has its note).
  const reply = card.kind !== "question" && s.agentId && <NoteRow theme={theme} compact={compact} agentId={s.agentId} />;
  const moreBlock = more && <MorePanel theme={theme} compact={compact} agent={agentName} demo={knobs.demo} onClose={() => setMore(false)} onAskAgent={onAsked} />;

  // The deck's moves: in thumb reach on phones, under the card on desktop. One primary lives in the card (Send,
  // Merge, Allow); these stay secondary.
  const moves = <View style={[{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: compact ? 12 : 0, paddingTop: compact ? 10 : 4 }, compact ? bottomInset(true) : null]}>
    <IconButton theme={theme} compact={compact} icon="ChevronLeft" label="Back" disabled={!onBack} onPress={() => onBack?.()} />
    {compact ? <View style={{ flex: 1 }}><Button theme={theme} compact grow icon="Sparkles" title="Context" accessibilityLabel="More context" onPress={() => setMore(v => !v)} /></View>
      : <Button theme={theme} icon="Sparkles" title="More context" onPress={() => setMore(v => !v)} />}
    <IconButton theme={theme} compact={compact} icon="AlarmClock" label="Later" onPress={onLater} />
    <IconButton theme={theme} compact={compact} icon="MessageSquare" label="Open chat" onPress={openChat} />
    {!compact && <View style={{ flex: 1 }} />}
    {compact ? <View style={{ flex: 1 }}><Button theme={theme} compact grow icon="ArrowRight" title="Skip" onPress={onSkip} /></View>
      : <Button theme={theme} icon="ArrowRight" title="Skip" onPress={onSkip} />}
  </View>;

  const scroll = <ScrollView style={{ flex: 1 }} keyboardShouldPersistTaps="handled"
    contentContainerStyle={{ padding: compact ? 16 : 28, gap: compact ? 16 : 18, ...(compact ? {} : { maxWidth: 720, width: "100%", alignSelf: "center" }) }}>
    {goneBanner}
    {head}
    {layoutB && q ? <View style={{ gap: 8 }}>
      <Text style={t.section}>Context</Text>
      {q.links?.map((l, i) => <View key={i} style={{ flexDirection: "row", gap: 8, alignItems: "center" }}><Icon name="FileText" size={13} color={c.foregroundMuted} /><Text style={t.meta}>{l.label ?? l.path ?? l.url}</Text></View>)}
    </View> : <View {...CARD_MARK} style={{ gap: 16 }}>{ask}</View>}
    {reply}
    {moreBlock}
    {!compact && moves}
  </ScrollView>;

  if (layoutB) return <View style={{ flex: 1 }}>
    {scroll}
    <View {...CARD_MARK} style={{ borderTopWidth: 1, borderTopColor: c.border, backgroundColor: c.surface1, borderTopLeftRadius: 16, borderTopRightRadius: 16, paddingHorizontal: 16, paddingTop: 12 }}>
      {q && <RichText plain style={[t.ask, { marginBottom: 6 }]}>{`${q.id} · ${q.title}`}</RichText>}
      {ask && card.kind === "question" && q && ws && <QuestionBody key={q.id} workspace={ws} question={q} theme={theme} compact dense bodyMaxHeight={width < 380 ? 260 : 300} onAnswered={onDone} />}
      {moves}
    </View>
  </View>;
  return <View style={{ flex: 1 }}>
    {scroll}
    {compact && <View style={{ borderTopWidth: 1, borderTopColor: c.border, backgroundColor: c.surface0 }}>{moves}</View>}
  </View>;
}

function PermissionCard({ s, theme, compact, onDone }: { s: DeckCard["s"]; theme: Theme; compact: boolean; onDone: () => void }) {
  const agent = useAgentLive(s.agentId);
  const t = text(theme.colors, compact);
  if (!agent.permissions.length) return <Text style={t.ask}>{s.line || "Permission"}</Text>;
  return <View style={{ gap: 10 }}>{agent.permissions.map(p => <PermissionBlock key={p.id} p={p} theme={theme} compact={compact} busy={false} primary
    onRespond={r => { void agent.handle?.respondToPermission({ requestId: p.id, response: r as never }); onDone(); }} />)}</View>;
}

function BriefAsk({ s, theme, compact, deps }: { s: DeckCard["s"]; theme: Theme; compact: boolean; deps: CatchUpDeps }) {
  const read = useRpc(inboxBriefRpc);
  const brief = useQuery({ queryKey: ["follow-up", "home-brief", s.agentId, "catch-up"], queryFn: () => read({ agentId: s.agentId! }), enabled: !!s.agentId });
  const b = liveBrief(brief.data?.brief);
  if (!b) return <Text style={text(theme.colors, compact).ask}>{s.line}</Text>;
  return <BriefCard {...({ embedded: true, item: { data: b }, theme, layout: { compact }, agentId: s.agentId, deps: deps.briefDeps } as unknown as Parameters<typeof BriefCard>[0])} />;
}

/**
 * More context: the Overseer answers at once (it already reads every workspace, and asking it wakes no other agent);
 * Ask the agent sends the question to the agent that asked, and the card leaves the deck until it replies.
 */
function MorePanel({ theme, compact, agent, demo, onClose, onAskAgent }: { theme: Theme; compact: boolean; agent: string; demo?: string; onClose: () => void; onAskAgent: () => void }) {
  const c = theme.colors; const t = text(c, compact);
  const [words, setWords] = useState(demo === "overseer" ? "What happens to invoices already in dunning?" : "");
  const chips = ["Why does it matter?", "What did it try?", "What if I take the recommendation?"];
  return <View style={{ gap: 10, padding: compact ? 14 : 16, borderRadius: 12, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface1 }}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <Icon name="Sparkles" size={14} color={c.foreground} />
      <Text style={[t.label, { flex: 1, fontWeight: "600" }]}>More context</Text>
      <IconButton theme={theme} compact={compact} icon="X" label="Close more context" onPress={onClose} />
    </View>
    {demo === "overseer" ? <View style={{ gap: 8 }}>
      <View style={{ alignSelf: "flex-end", maxWidth: "85%", paddingHorizontal: 10, paddingVertical: 6, borderRadius: 10, backgroundColor: c.surface2 }}><Text style={t.meta}>{words}</Text></View>
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Icon name="MessagesSquare" size={14} color={c.foregroundMuted} />
        <View style={{ flex: 1, gap: 6 }}>
          <Text style={t.small}>Overseer · from the workspace and its chat · 4s</Text>
          <Text style={t.body}>Nothing changes for them. #142 only retries charges made after it deploys; invoices already in dunning keep their schedule. With B, a soft decline that clears within a day is charged once more instead of getting the dunning email.</Text>
          <Text style={t.meta}>Source: the agent's notes in docs/billing/retries.md and #142's description.</Text>
        </View>
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <Button theme={theme} compact={compact} kind="ghost" icon="MessageSquareText" title={agent === "the agent" ? "Ask the agent instead" : `Ask ${agent} instead`} onPress={onAskAgent} />
        <Button theme={theme} compact={compact} kind="ghost" icon="CornerDownLeft" title="Follow up" onPress={() => undefined} />
      </View>
    </View> : <>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        {chips.map(x => <Pressable key={x} accessibilityRole="button" onPress={() => setWords(x)} style={{ minHeight: compact ? 36 : 28, justifyContent: "center", paddingHorizontal: 10, borderRadius: 999, borderWidth: 1, borderColor: c.border }}>
          <Text style={t.meta}>{x}</Text>
        </Pressable>)}
      </View>
      <TextInput accessibilityLabel="What do you want to know?" placeholder="What do you want to know?" placeholderTextColor={c.foregroundMuted} value={words} onChangeText={setWords} multiline
        style={{ minHeight: compact ? 44 : 36, paddingHorizontal: 10, paddingVertical: 8, borderRadius: 6, borderWidth: 1, borderColor: c.border, color: c.foreground, backgroundColor: c.surface0 }} />
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <Button theme={theme} compact={compact} grow={compact} kind="primary" icon="MessagesSquare" title="Ask the Overseer" accessibilityHint="Answers now from what Follow-up and the chat already hold" onPress={() => undefined} />
        <Button theme={theme} compact={compact} grow={compact} icon="MessageSquareText" title={agent === "the agent" ? "Ask the agent" : `Ask ${agent}`} accessibilityHint="Sends it to the agent; the card comes back when it replies" onPress={onAskAgent} />
      </View>
      <Text style={t.small}>{`The Overseer answers now and wakes nobody. ${agent === "the agent" ? "The agent" : agent} knows best but answers in its own time; the card waits at the end of the deck.`}</Text>
    </>}
  </View>;
}

function Finished({ theme, compact, stats, empty, onHome, onSkipped }: { theme: Theme; compact: boolean; stats: ReturnType<typeof statsOf>; empty: boolean; onHome: () => void; onSkipped: () => void }) {
  const c = theme.colors; const t = text(c, compact);
  const line = [stats.done && `${stats.done} done`, stats.skipped && `${stats.skipped} skipped`, stats.later && `${stats.later} for later`, stats.asked && `${stats.asked} waiting on an explanation`].filter(Boolean).join(" · ");
  return <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: "center", alignItems: "center", padding: 24, gap: 14 }}>
    <View style={{ width: 56, height: 56, borderRadius: 28, alignItems: "center", justifyContent: "center", backgroundColor: tint(c.statusSuccess, c) }}><Icon name="Check" size={28} color={c.statusSuccess} /></View>
    <Text accessibilityRole="header" style={t.headline}>{empty ? MODE.empty : MODE.finished}</Text>
    {!!line && <Text style={[t.body, { color: c.foregroundMuted, textAlign: "center" }]}>{line}</Text>}
    <Text style={[t.meta, { textAlign: "center", maxWidth: 420 }]}>Your answers are on their way; agents pick them up as soon as they're free. Anything new shows in Needs you and the pill.</Text>
    <View style={{ flexDirection: compact ? "column" : "row", alignSelf: compact ? "stretch" : "center", gap: 8, marginTop: 6 }}>
      {stats.skipped > 0 && <Button theme={theme} compact={compact} grow={compact} kind="primary" icon="CornerUpRight" title={`Go through ${stats.skipped} skipped`} onPress={onSkipped} />}
      <Button theme={theme} compact={compact} grow={compact} kind={stats.skipped ? "secondary" : "primary"} icon="House" title="Back to Home" onPress={onHome} />
    </View>
  </ScrollView>;
}

function KeysSheet({ theme }: { theme: Theme }) {
  const c = theme.colors; const t = text(c, false);
  return <View style={{ position: "absolute", right: 20, bottom: 20, width: 260, padding: 14, gap: 6, borderRadius: 10, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface1, shadowColor: "#000", shadowOpacity: 0.25, shadowRadius: 12 }}>
    <Text style={[t.label, { fontWeight: "600" }]}>Keys</Text>
    {CATCH_UP_KEYS.map(k => <View key={k.key} style={{ flexDirection: "row", gap: 10 }}>
      <Text style={[t.meta, { width: 64, color: c.foreground, fontVariant: ["tabular-nums"] }]}>{k.key}</Text><Text style={t.meta}>{k.what}</Text>
    </View>)}
  </View>;
}

export function CatchUpButton({ theme, compact, count, onPress }: { theme: Theme; compact: boolean; count: number; onPress: () => void }): ReactNode {
  if (!count) return null;
  return <Button theme={theme} compact={compact} grow={compact} kind="primary" icon="Layers" title={MODE.button(count)} accessibilityHint="Go through everything that needs you, one card at a time" onPress={onPress} />;
}

/** Tell the agent something with or without acting: a plain message, the detail pane's reply box in a line. */
function NoteRow({ theme, compact, agentId }: { theme: Theme; compact: boolean; agentId: string }) {
  const c = theme.colors;
  const agent = useAgentLive(agentId);
  const [words, setWords] = useState("");
  return <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 8 }}>
    <TextInput accessibilityLabel="Tell the agent something" placeholder="Tell the agent something" placeholderTextColor={c.foregroundMuted} value={words} onChangeText={setWords} multiline
      style={{ flex: 1, minHeight: compact ? 44 : 36, paddingHorizontal: 10, paddingVertical: 8, borderRadius: 6, borderWidth: 1, borderColor: c.border, color: c.foreground, backgroundColor: c.surface0 }} />
    <IconButton theme={theme} compact={compact} icon="Send" label="Send to the agent" disabled={!words.trim()} onPress={() => { void agent.handle?.send(words.trim()); setWords(""); }} />
  </View>;
}
