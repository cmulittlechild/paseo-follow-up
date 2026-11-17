// Catch up: everything in Needs you, one card at a time (docs/design/catch-up.md, docs/needs-you.md#catch-up). It
// renders the same components the panel and Home use (QuestionBody, NeedsYouList, BriefCard, the permission block), so
// the answer flow is the shared one, never a fork (one-answer-flow-for-every-question). The deck's order and every
// move are the pure session in shared/catch-up.ts (context-never-blocks-the-deck, the-card-on-screen-never-moves).
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { PanResponder, Platform, View } from "react-native";
import { Pressable, Text } from "./text";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon, ScrollView, TextInput } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { inboxBriefRpc } from "../shared/contracts";
import { needsYou } from "../shared/attention";
import { liveBrief } from "../shared/brief";
import { age, snoozeUntil } from "../shared/inbox";
import { laterChoices } from "../shared/row-menu";
import { errorText } from "../shared/errors";
import { CATCH_UP_RAIL_DEFAULT, CATCH_UP_RAIL_MAX, CATCH_UP_RAIL_MIN } from "../shared/display";
import { CATCH_UP_KEYS, CONTEXT_ASKS, MODE, askHeadline, deckCards, groupOf, park, prevPos, settle as settleCard, startSession, statsOf, sync, type ContextRequest, type DeckCard, type Outcome, type Session } from "../shared/catch-up";
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
import { DisplaySplit, PermissionBlock, useAgentLive } from "./home";

/** react-native-web's data attribute, so the option-letter keys find this card's radios. */
const CARD_MARK = { dataSet: { catchUpCard: "1" } } as object;
const RAIL_MIN_PX = 240;
const CARD_MIN_PX = 480;

export type CatchUpDeps = { sources: HomeSources; briefDeps: BriefDeps; openHome(): void; openPanel(workspaceId: string): void };
type Nav = { openAgent(a: { agentId: string }): void; openWorkspace(a: { workspaceId: string }): void } | undefined;

/** One card's label in the queue rail and in a More context ask: "Q1 · Retry declined cards?", "Merge #255". */
export function cardLabel(card: DeckCard, w: ListWorkspace | undefined): string {
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
/** The newest ask about this card, if any. */
const askFor = (context: readonly ContextRequest[], key: string) => [...context].reverse().find(r => r.cardKey === key) ?? null;

export function CatchUp({ theme, compact, deps, navigation, onExit }: { theme: Theme; compact: boolean; deps: CatchUpDeps; navigation: Nav; onExit: () => void }) {
  const c = theme.colors; const t = text(c, compact);
  const { inbox, live, extras } = deps.sources;
  const model = useHomeModel(deps.sources);
  const rows = useInbox(inbox, () => inbox.rows());
  const version = useSyncExternalStore(live.subscribe, live.version, live.version);
  const context = useSyncExternalStore(extras.subscribe, extras.context, extras.context);
  // Everything comes from what the client already holds: Home's model, the inbox rows, the listed workspaces.
  const liveCards = useMemo(() => deckCards({ model, rows, items: id => { const w = live.get(id); return w ? needsYou(w as unknown as Workspace) : []; } }),
    [model, rows, version, live]); // eslint-disable-line react-hooks/exhaustive-deps
  const byKey = useMemo(() => new Map(liveCards.map(x => [x.key, x])), [liveCards]);
  // A card that left Needs you keeps its last copy, so it can say "Handled elsewhere" in place.
  const seen = useRef(new Map<string, DeckCard>());
  for (const card of liveCards) seen.current.set(card.key, card);
  const cardOf = (k: string | undefined) => k ? byKey.get(k) ?? seen.current.get(k) ?? null : null;

  const [session, setSession] = useState<Session>(() => startSession(liveCards));
  const settled = (id: string) => { const r = context.find(x => x.id === id); return !r || r.state !== "asking"; };
  useEffect(() => { setSession(s => s.order.length || !liveCards.length ? sync(s, liveCards, settled) : startSession(liveCards)); },
    [liveCards, context]); // eslint-disable-line react-hooks/exhaustive-deps
  // Opening and each move read the asks once: a 0.15 host (no feed) is never stale for long, and nothing polls.
  useEffect(() => { void extras.refreshContext(); }, [session.pos]); // eslint-disable-line react-hooks/exhaustive-deps

  const [more, setMore] = useState(false);
  const key = session.order[session.pos];
  const card = cardOf(key);
  const gone = !!key && session.outcomes[key] === "gone";
  const finished = session.pos >= session.order.length;
  const settle = (outcome: Outcome) => { setMore(false); setSession(s => settleCard(s, outcome)); };
  const skip = () => settle("skipped");
  const back = () => { setMore(false); setSession(s => ({ ...s, pos: prevPos(s) })); };
  const jump = (i: number) => { setMore(false); setSession(s => ({ ...s, pos: i })); };
  const w = card?.s.workspaceId ? live.get(card.s.workspaceId) : undefined;
  // The next card's workspace detail is read while this one is on screen, so it paints at once (prefetch, no poll).
  const nextCard = cardOf(session.order[session.pos + 1]);
  useWorkspace(live, nextCard?.s.workspaceId ?? "", { enabled: !!nextCard?.s.workspaceId });

  const ask = async (target: "overseer" | "agent", words: string) => {
    if (!card) return;
    const out = await extras.askContext({ workspaceId: card.s.workspaceId, agentId: card.s.agentId, cardKey: card.key, card: cardLabel(card, w).slice(0, 300), target, ask: words });
    setMore(false);
    // context-never-blocks-the-deck: the workstream waits, the deck moves on.
    if (out.request.state === "asking") setSession(s => park(s, out.request.id, card.key));
  };

  // Desktop keys: option letters pick, J/K or the arrows move, M asks for context, Esc leaves. Never while typing.
  useEffect(() => {
    if (Platform.OS !== "web" || compact) return;
    type Ev = { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; isComposing: boolean; target: unknown; preventDefault(): void };
    type El = { tagName?: string; isContentEditable?: boolean; click?(): void };
    const doc = (globalThis as { document?: { querySelector(q: string): El | null; addEventListener(t: string, f: (e: Ev) => void): void; removeEventListener(t: string, f: (e: Ev) => void): void } }).document; if (!doc) return;
    const onKey = (e: Ev) => {
      const el = e.target as El | null;
      if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing || el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      const k = e.key.toLowerCase();
      if (k === "j" || e.key === "ArrowRight") skip();
      else if (k === "k" || e.key === "ArrowLeft") back();
      else if (k === "m" && !finished) setMore(v => !v);
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
    onPanResponderRelease: (_e, g) => { if (g.dx < -80) skip(); else if (g.dx > 80) back(); },
  }), [compact, key]); // eslint-disable-line react-hooks/exhaustive-deps

  const stats = statsOf(session);
  const total = session.order.length;
  const waitingChip = stats.waiting > 0 && <View accessibilityLabel={`${MODE.waiting(stats.waiting)}. They come back as the next card when the answer is ready; Back reaches them any time.`}
    style={{ flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 8, height: 22, borderRadius: 11, backgroundColor: c.surface2 }}>
    <Icon name="Hourglass" size={11} color={c.foregroundMuted} /><Text style={[t.small, { fontWeight: "600" }]}>{MODE.waiting(stats.waiting)}</Text>
  </View>;
  const progress = <View style={{ gap: 6, paddingHorizontal: compact ? 16 : 20, paddingTop: compact ? 8 : 14, paddingBottom: 10 }}>
    <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8, minHeight: compact ? 44 : 32 }}>
      {/* Phones: the host header's ← is the only back control (DESIGN.md "One header"). */}
      {!compact && <IconButton theme={theme} compact={compact} icon="X" label={`Leave ${MODE.name} (Esc)`} tooltip onPress={onExit} />}
      <Text accessibilityRole="header" style={[t.title, { flex: 1 }]}>{finished || !total ? MODE.name : <>{MODE.name} <Text style={{ color: c.foregroundMuted, fontWeight: "400", fontVariant: ["tabular-nums"] }}>{MODE.progress(session.pos + 1, total).slice(MODE.name.length + 1)}</Text></>}</Text>
      {waitingChip}
      {!compact && !finished && <Text style={t.small}>J skip · K back · M more context</Text>}
    </View>
    {/* One segment per card: done in the foreground colour, skipped hollow, waiting for context amber-tinted, the current one amber. */}
    {total > 0 && <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ flexDirection: "row", gap: 3 }}>
      {total > 24 ? <View style={{ flex: 1, height: 4, borderRadius: 2, backgroundColor: c.border }}><View style={{ width: `${Math.round(100 * (stats.done + stats.later + stats.gone) / total)}%`, height: 4, borderRadius: 2, backgroundColor: c.foreground }} /></View>
        : session.order.map((k, i) => {
          const o = session.outcomes[k];
          const waiting = !o && !!session.parked[groupOf(k)];
          const bg = i === session.pos && !finished ? c.statusWarning : o === "done" || o === "later" ? c.foreground : o ? withAlpha(c.foreground, 0.35) : waiting ? withAlpha(c.statusWarning, 0.4) : c.border;
          return <View key={k} style={{ flex: 1, height: 4, borderRadius: 2, backgroundColor: bg }} />;
        })}
    </View>}
  </View>;

  const body = finished || !card ? <Finished theme={theme} compact={compact} stats={stats} empty={!total} onHome={onExit}
      onSkipped={() => setSession(s => ({ ...s, pos: s.order.findIndex(k => s.outcomes[k] === "skipped"), lapped: true }))} />
    : <CardView key={card.key} card={card} w={w} theme={theme} compact={compact} deps={deps} navigation={navigation} gone={gone} more={more} setMore={setMore}
      request={askFor(context, card.key)} waiting={!!session.parked[card.s.key]} onAsk={ask}
      sameWorkspace={session.order.filter(k => cardOf(k)?.s.key === card.s.key)}
      onDone={() => settle("done")} onSkip={skip} onBack={session.pos > 0 ? back : undefined} onLater={() => settle("later")} />;

  const rail = <ScrollView contentContainerStyle={{ paddingVertical: 8 }}>
    {session.order.map((k, i) => {
      const x = cardOf(k); if (!x) return null;
      const xw = x.s.workspaceId ? live.get(x.s.workspaceId) : undefined;
      const o = session.outcomes[k]; const here = i === session.pos;
      const waiting = !o && !!session.parked[x.s.key];
      const firstOfWs = i === 0 || cardOf(session.order[i - 1])?.s.key !== x.s.key;
      const label = cardLabel(x, xw);
      return <View key={k}>
        {firstOfWs && <Text numberOfLines={1} style={[t.small, { paddingHorizontal: 16, paddingTop: i ? 10 : 2, paddingBottom: 2, fontWeight: "600" }]}>{x.s.title}</Text>}
        <Pressable accessibilityRole="button" accessibilityState={{ selected: here }} accessibilityLabel={`${label}${o ? `, ${o === "gone" ? "handled elsewhere" : o}` : waiting ? ", getting context" : ""}`} onPress={() => jump(i)}
          style={state => ({ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 32, paddingHorizontal: 16, backgroundColor: here ? c.surface2 : (state as { hovered?: boolean }).hovered ? c.surface1 : "transparent",
            borderLeftWidth: 2, borderLeftColor: here ? c.statusWarning : "transparent" })}>
          <Icon name={o === "done" ? "CircleCheck" : o === "skipped" ? "CornerUpRight" : o === "later" ? "AlarmClock" : o === "gone" ? "CircleCheck" : waiting ? "Hourglass" : cardIcon(x)} size={13}
            color={o === "done" || o === "gone" ? c.statusSuccess : o || waiting ? c.foregroundMuted : glyphColor(x.s, c, false)} />
          <Text numberOfLines={1} style={[t.meta, { flex: 1, color: o ? c.foregroundMuted : c.foreground, textDecorationLine: o === "done" ? "line-through" : "none" }]}>{label}</Text>
        </Pressable>
      </View>;
    })}
  </ScrollView>;

  const main = <View style={{ flex: 1, minWidth: 0 }} {...pan.panHandlers}>{body}</View>;
  return <View style={{ flex: 1, backgroundColor: c.surface0 }}>
    {progress}
    <View style={{ flex: 1, borderTopWidth: 1, borderTopColor: c.border }}>
      {/* Desktop: the queue rail beside the card, resizable (side-panes-are-resizable); its width is the Display field catch_up_rail_fraction. */}
      {!compact && total > 0 && !finished
        ? <DisplaySplit theme={theme} main={main} side={rail} field="catch_up_rail_fraction" testID="follow-up-catch-up-split" label="Resize the queue"
          defaultFraction={CATCH_UP_RAIL_DEFAULT} range={[CATCH_UP_RAIL_MIN, CATCH_UP_RAIL_MAX]} minSide={RAIL_MIN_PX} minMain={CARD_MIN_PX} />
        : main}
    </View>
  </View>;
}

/** One card: who and what, the ask through its own surface's component, then the deck's moves pinned to the bottom. */
function CardView({ card, w, theme, compact, deps, navigation, gone, more, setMore, request, waiting, onAsk, sameWorkspace, onDone, onSkip, onBack, onLater }: {
  card: DeckCard; w: ListWorkspace | undefined; theme: Theme; compact: boolean; deps: CatchUpDeps; navigation: Nav; gone: boolean; more: boolean; setMore: (v: boolean | ((v: boolean) => boolean)) => void;
  request: ContextRequest | null; waiting: boolean; onAsk: (target: "overseer" | "agent", words: string) => Promise<void>;
  sameWorkspace: string[]; onDone: () => void; onSkip: () => void; onBack?: () => void; onLater: () => void;
}) {
  const c = theme.colors; const t = text(c, compact);
  const s = card.s;
  const { workspace: full } = useWorkspace(deps.sources.live, s.workspaceId ?? "");
  const ws = openRowCopy<ListWorkspace>(w, full);
  const overseerOn = useSyncExternalStore(deps.sources.extras.subscribe, () => deps.sources.extras.overseer()?.enabled !== false, () => true);
  const [laterOpen, setLaterOpen] = useState(false);
  const openChat = () => { if (!navigation) return; if (s.agentId) navigation.openAgent({ agentId: s.agentId }); else if (s.workspaceId) navigation.openWorkspace({ workspaceId: s.workspaceId }); };
  const word = cardWord(card);
  const color = card.item?.kind === "merge" ? mergedColor(c) : card.kind === "finished" ? c.foregroundMuted : c.statusWarning;
  const q = card.kind === "question" ? ws?.questions.find(x => x.id === card.questionId) ?? null : null;
  const nth = sameWorkspace.indexOf(card.key);
  const agentName = s.agent ?? "the agent";

  const head = <View style={{ gap: 6 }}>
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

  const askBlock = card.kind === "question" && q && ws
    ? <View style={{ gap: 8 }}>
      <RichText plain style={compact ? t.ask : [t.body, { fontSize: 15, lineHeight: 21, fontWeight: "600" }]}>{`${q.id} · ${q.title}`}</RichText>
      <QuestionBody key={q.id} workspace={ws} question={q} theme={theme} compact={compact} inline={false}
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
  const contextBlock = request && <ContextAnswer theme={theme} compact={compact} request={request} waiting={waiting} agent={agentName} openChat={openChat} />;
  const moreBlock = more && <MorePanel theme={theme} compact={compact} agent={agentName} hasAgent={!!s.agentId} overseerOn={overseerOn} onClose={() => setMore(false)} onAsk={onAsk} />;
  const later = (until: string) => { setLaterOpen(false); if (s.agentId) void deps.sources.inbox.snooze([s.agentId], until); onLater(); };
  const laterRow = laterOpen && <View accessibilityRole="menu" style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, paddingHorizontal: compact ? 12 : 0, paddingTop: 8 }}>
    {laterChoices(new Date()).map(([k, label]) => <Button key={k} theme={theme} compact={compact} kind="ghost" icon="AlarmClock" title={label} onPress={() => later(snoozeUntil(k, new Date()))} />)}
  </View>;

  // The deck's moves: in thumb reach on phones, under the card on desktop. One primary lives in the card (Send,
  // Merge, Allow); these stay secondary. Icon-only moves carry their name for screen readers and as a desktop tooltip.
  const moves = <View style={[{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: compact ? 12 : 0, paddingTop: compact ? 10 : 4 }, compact ? bottomInset(true) : null]}>
    <IconButton theme={theme} compact={compact} icon="ChevronLeft" label={compact ? "Back" : "Back (K)"} tooltip={!compact} disabled={!onBack} onPress={() => onBack?.()} />
    {compact ? <View style={{ flex: 1 }}><Button theme={theme} compact grow icon="Sparkles" title="Context" accessibilityLabel="More context" onPress={() => setMore(v => !v)} /></View>
      : <Button theme={theme} icon="Sparkles" title="More context" accessibilityHint="M" onPress={() => setMore(v => !v)} />}
    <IconButton theme={theme} compact={compact} icon="AlarmClock" label={compact ? "Later" : "Later (L)"} tooltip={!compact} disabled={!s.agentId} onPress={() => setLaterOpen(v => !v)} />
    <IconButton theme={theme} compact={compact} icon="MessageSquare" label={compact ? "Open chat" : "Open chat (O)"} tooltip={!compact} disabled={!navigation} onPress={openChat} />
    {!compact && <View style={{ flex: 1 }} />}
    {compact ? <View style={{ flex: 1 }}><Button theme={theme} compact grow icon="ArrowRight" title="Skip" onPress={onSkip} /></View>
      : <Button theme={theme} icon="ArrowRight" title="Skip" accessibilityHint="J" onPress={onSkip} />}
  </View>;

  const scroll = <ScrollView style={{ flex: 1 }} keyboardShouldPersistTaps="handled"
    contentContainerStyle={{ padding: compact ? 16 : 28, gap: compact ? 16 : 18, ...(compact ? {} : { maxWidth: 720, width: "100%", alignSelf: "center" }) }}>
    {goneBanner}
    {head}
    {contextBlock}
    <View {...CARD_MARK} style={{ gap: 16 }}>{askBlock}</View>
    {reply}
    {moreBlock}
    {!compact && laterRow}
    {!compact && moves}
  </ScrollView>;
  return <View style={{ flex: 1 }}>
    {scroll}
    {compact && <View style={{ borderTopWidth: 1, borderTopColor: c.border, backgroundColor: c.surface0 }}>{laterRow}{moves}</View>}
  </View>;
}

/** What came back for this card: the answer, "answered in its chat", a failure, or (seen going Back) that it's still asking. */
function ContextAnswer({ theme, compact, request, waiting, agent, openChat }: { theme: Theme; compact: boolean; request: ContextRequest; waiting: boolean; agent: string; openChat: () => void }) {
  const c = theme.colors; const t = text(c, compact);
  const who = request.target === "overseer" ? "Overseer" : agent === "the agent" ? "The agent" : agent;
  const asking = request.state === "asking";
  return <View accessibilityLiveRegion="polite" style={{ gap: 8, padding: compact ? 14 : 16, borderRadius: 12, borderWidth: 1, borderColor: asking ? c.border : withAlpha(c.statusSuccess, 0.4), backgroundColor: c.surface1 }}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <Icon name={asking ? "Hourglass" : request.state === "failed" ? "CircleAlert" : "Sparkles"} size={14} color={request.state === "failed" ? c.statusDanger : c.foregroundMuted} />
      <RichText plain style={[t.small, { flex: 1 }]}>{asking ? `Asked ${who === "Overseer" ? "the Overseer" : who}${waiting ? " · this comes back as the next card when it answers. You can still act on it now" : ""}` : `${who} · you asked: ${askHeadline(request.ask)}`}</RichText>
    </View>
    {request.state === "answered" && request.answer && <RichText selectable style={t.body}>{request.answer}</RichText>}
    {request.state === "chat" && <View style={{ gap: 8 }}>
      <Text style={t.body}>{`${who} answered in its chat.`}</Text>
      <View style={{ flexDirection: "row" }}><Button theme={theme} compact={compact} icon="MessageSquare" title="Open chat" onPress={openChat} /></View>
    </View>}
    {request.state === "failed" && <Text style={t.body}>{request.error ?? "The ask didn't go through. Try again, or open the chat."}</Text>}
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
 * More context: "I don't get it" first (most asks just need explaining), then the developer's own words. The Overseer
 * answers from what it already reads and wakes nobody; the card's agent knows best and may wake, because the
 * developer asked. Either way the deck moves on and this workspace comes back when the answer is ready.
 */
function MorePanel({ theme, compact, agent, hasAgent, overseerOn, onClose, onAsk }: { theme: Theme; compact: boolean; agent: string; hasAgent: boolean; overseerOn: boolean; onClose: () => void; onAsk: (target: "overseer" | "agent", words: string) => Promise<void> }) {
  const c = theme.colors; const t = text(c, compact);
  const [words, setWords] = useState<string>(CONTEXT_ASKS[0].text);
  const [picked, setPicked] = useState<string>(CONTEXT_ASKS[0].id);
  const [busy, setBusy] = useState<"overseer" | "agent" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const send = (target: "overseer" | "agent") => {
    if (!words.trim() || busy) return;
    setBusy(target); setError(null);
    // The words stay unless the ask is recorded.
    onAsk(target, words.trim()).catch(e => setError(errorText(e))).finally(() => setBusy(null));
  };
  const agentLabel = agent === "the agent" ? "Ask the agent" : `Ask ${agent}`;
  return <View style={{ gap: 10, padding: compact ? 14 : 16, borderRadius: 12, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface1 }}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <Icon name="Sparkles" size={14} color={c.foreground} />
      <Text style={[t.label, { flex: 1, fontWeight: "600" }]}>More context</Text>
      <IconButton theme={theme} compact={compact} icon="X" label="Close more context" onPress={onClose} />
    </View>
    <View accessibilityRole="radiogroup" style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
      {CONTEXT_ASKS.map(x => <Pressable key={x.id} accessibilityRole="radio" accessibilityState={{ checked: picked === x.id }} onPress={() => { setPicked(x.id); setWords(x.text); }}
        style={{ minHeight: compact ? 36 : 28, justifyContent: "center", paddingHorizontal: 10, borderRadius: 999, borderWidth: 1, borderColor: picked === x.id ? c.foreground : c.border, backgroundColor: picked === x.id ? c.surface2 : "transparent" }}>
        <Text style={[t.meta, { color: picked === x.id ? c.foreground : c.foregroundMuted }]}>{x.label}</Text>
      </Pressable>)}
    </View>
    <TextInput accessibilityLabel="What do you want to know?" placeholder="What do you want to know?" placeholderTextColor={c.foregroundMuted} value={words} multiline
      onChangeText={v => { setWords(v); setPicked(CONTEXT_ASKS.find(x => x.text === v)?.id ?? ""); }}
      style={{ minHeight: compact ? 44 : 36, paddingHorizontal: 10, paddingVertical: 8, borderRadius: 6, borderWidth: 1, borderColor: c.border, color: c.foreground, backgroundColor: c.surface0 }} />
    {!!error && <Text accessibilityRole="alert" style={[t.meta, { color: c.statusDanger }]}>{error}</Text>}
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      {overseerOn && <Button theme={theme} compact={compact} grow={compact} kind="primary" icon="MessagesSquare" title="Ask the Overseer" loading={busy === "overseer"} disabled={!words.trim() || !!busy}
        accessibilityHint="Answers from what Follow-up and the chats already hold; wakes nobody" onPress={() => send("overseer")} />}
      {hasAgent && <Button theme={theme} compact={compact} grow={compact} kind={overseerOn ? "secondary" : "primary"} icon="MessageSquareText" title={agentLabel} loading={busy === "agent"} disabled={!words.trim() || !!busy}
        accessibilityHint="Sends it to the agent, which may wake it" onPress={() => send("agent")} />}
    </View>
    <Text style={t.small}>This workspace steps aside while you keep going, and comes back as your next card with the answer. Back reaches it any time.</Text>
  </View>;
}

function Finished({ theme, compact, stats, empty, onHome, onSkipped }: { theme: Theme; compact: boolean; stats: ReturnType<typeof statsOf>; empty: boolean; onHome: () => void; onSkipped: () => void }) {
  const c = theme.colors; const t = text(c, compact);
  // "All caught up" only when it is true: a skipped or waiting card means the developer is not, so the end says so.
  const caughtUp = !stats.skipped && !stats.waiting;
  const icon = caughtUp ? "Check" : stats.waiting ? "Hourglass" : "CornerUpRight";
  const tone = caughtUp ? c.statusSuccess : stats.waiting ? c.statusWarning : c.foregroundMuted;
  const line = [stats.done && `${stats.done} done`, stats.skipped && `${stats.skipped} skipped`, stats.later && `${stats.later} for later`, stats.gone && `${stats.gone} handled elsewhere`].filter(Boolean).join(" · ");
  return <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: "center", alignItems: "center", padding: 24, gap: 14 }}>
    <View style={{ width: 56, height: 56, borderRadius: 28, alignItems: "center", justifyContent: "center", backgroundColor: tint(tone, c) }}>
      <Icon name={icon} size={28} color={tone} />
    </View>
    <Text accessibilityRole="header" style={t.headline}>{empty ? MODE.empty : caughtUp ? MODE.finished : MODE.endOfDeck}</Text>
    {!!line && <Text style={[t.body, { color: c.foregroundMuted, textAlign: "center" }]}>{line}</Text>}
    {stats.waiting > 0 && <Text style={[t.body, { textAlign: "center" }]}>{`${MODE.waiting(stats.waiting)}. ${stats.waiting === 1 ? "It comes" : "They come"} back here when the answer is ready; Back reaches ${stats.waiting === 1 ? "it" : "them"} now.`}</Text>}
    {stats.done > 0 && <Text style={[t.meta, { textAlign: "center", maxWidth: 420 }]}>Your answers are on their way; agents pick them up as soon as they're free. Anything new shows in Needs you and the pill.</Text>}
    <View style={{ flexDirection: compact ? "column" : "row", alignSelf: compact ? "stretch" : "center", gap: 8, marginTop: 6 }}>
      {stats.skipped > 0 && <Button theme={theme} compact={compact} grow={compact} kind="primary" icon="CornerUpRight" title={`Catch up on ${stats.skipped} skipped`} onPress={onSkipped} />}
      <Button theme={theme} compact={compact} grow={compact} kind={stats.skipped ? "secondary" : "primary"} icon="House" title="Back to Home" onPress={onHome} />
    </View>
  </ScrollView>;
}

/** The keys, from the one list the handler reads (shared/catch-up.ts). */
export function KeysSheet({ theme }: { theme: Theme }) {
  const c = theme.colors; const t = text(c, false);
  return <View style={{ position: "absolute", right: 20, bottom: 20, width: 260, padding: 14, gap: 6, borderRadius: 10, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface1, shadowColor: "#000", shadowOpacity: 0.25, shadowRadius: 12 }}>
    <Text style={[t.label, { fontWeight: "600" }]}>Keys</Text>
    {CATCH_UP_KEYS.map(k => <View key={k.key} style={{ flexDirection: "row", gap: 10 }}>
      <Text style={[t.meta, { width: 64, color: c.foreground, fontVariant: ["tabular-nums"] }]}>{k.key}</Text><Text style={t.meta}>{k.what}</Text>
    </View>)}
  </View>;
}

/**
 * Home's way in. It counts cards (one per thing to act on), which can differ from Needs you's workspace count beside
 * it, so its accessible name and desktop tooltip say what the number is.
 */
export function CatchUpButton({ theme, compact, count, onPress }: { theme: Theme; compact: boolean; count: number; onPress: () => void }): ReactNode {
  if (!count) return null;
  const label = MODE.buttonLabel(count);
  const button = <Button theme={theme} compact={compact} grow={compact} kind="primary" icon="Layers" title={MODE.button(count)} accessibilityLabel={label} onPress={onPress} />;
  return Platform.OS === "web" && !compact ? <View {...({ dataSet: { tooltip: label }, title: label } as object)}>{button}</View> : button;
}

/** Tell the agent something with or without acting: a plain message, the detail pane's reply box in a line. */
function NoteRow({ theme, compact, agentId }: { theme: Theme; compact: boolean; agentId: string }) {
  const c = theme.colors;
  const agent = useAgentLive(agentId);
  const [words, setWords] = useState("");
  return <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 8 }}>
    <TextInput accessibilityLabel="Tell the agent something" placeholder="Tell the agent something" placeholderTextColor={c.foregroundMuted} value={words} onChangeText={setWords} multiline
      style={{ flex: 1, minHeight: compact ? 44 : 36, paddingHorizontal: 10, paddingVertical: 8, borderRadius: 6, borderWidth: 1, borderColor: c.border, color: c.foreground, backgroundColor: c.surface0 }} />
    <IconButton theme={theme} compact={compact} icon="Send" label="Send to the agent" tooltip={!compact} disabled={!words.trim()} onPress={() => { void agent.handle?.send(words.trim()); setWords(""); }} />
  </View>;
}
