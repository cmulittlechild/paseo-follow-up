# Catch up: Needs you, one card at a time (design)

Status: decided 2026-11-17 ([the picks](#the-picks)); building in small stacked PRs. The renders below come from the
phase 1 prototype, drawn with Follow-up's own components and synthetic data (`scripts/screenshots.mjs --only
catch-up`), and still show its working name, "Go through". The shipped words are Catch up's.

The developer asked for a mode on Follow-up Home where they go through everything that needs them, one item at a time,
mainly on the phone: read the card, act, next card, act, next card. The rhythm matters most. Every card carries what
it takes to decide without opening the chat, and acting never waits on the network.

The name is **Catch up** (one constant, `MODE` in `shared/catch-up.ts`; code identifiers say `catch-up` too).

## The deck

**What goes in.** Exactly what Home's Needs you group holds, expanded to one card per thing to act on:

| Card | From | The card's one primary |
| --- | --- | --- |
| Permission | the agent's pending permission | Allow (Deny beside it) |
| Question | each open question, a multi-decision brief's questions included | Send to agent |
| Ask | an agent's `needs_you` decision, action or review with no tracked question | the brief's own moves (pick, Done, Open PR) |
| Item | every other Needs-you row: Merge, Add reviewers, Send N tasks, an unsent or failed answer (Send, Retry), Resume, Retry, Check state, a blocked task | that row's own button |
| Finished | a flagged finished turn with nothing above | Sign off |

A workspace with two questions and a merge is three cards. Snoozed items (Later) aren't in the deck.

**Order.** Home's Needs-you order, so the deck never disagrees with the list the developer already sees: blocking asks
first (permissions, errors, questions that stopped an agent, decisions), then actions (merge, reviewers, sends), then
finished turns to sign off; inside a tier, the developer's chosen sort, AI priority included. Inside one workspace the
Needs-you block's order (`needsYouBlock`): permission, stopped questions, other questions, then the rows. A workspace's
cards stay together, so its context is read once and the card says "2 of 3 here".

Alternatives considered: quick wins first (merges and sign-offs before questions) gets the count down fast but leaves a
stopped agent waiting longest; AI priority across tiers ignores that a stopped agent is idle until answered. Recommended:
Home's order.

**One source, no reads of its own.** The deck is a pure function (`deckCards`) of Home's model, the inbox rows and the
listed workspaces the client already holds through the feeds. Opening it costs nothing; it adds no polling.

### Every card in the demo deck, in order

The synthetic deck (17 cards from 12 workspaces), on a phone, in the order Go through shows them:

| | | | |
| --- | --- | --- | --- |
| ![00](catch-up/cu-deck-00-phone-light.png) | ![01](catch-up/cu-deck-01-phone-light.png) | ![02](catch-up/cu-deck-02-phone-light.png) | ![03](catch-up/cu-deck-03-phone-light.png) |
| ![04](catch-up/cu-deck-04-phone-light.png) | ![05](catch-up/cu-deck-05-phone-light.png) | ![06](catch-up/cu-deck-06-phone-light.png) | ![07](catch-up/cu-deck-07-phone-light.png) |
| ![08](catch-up/cu-deck-08-phone-light.png) | ![09](catch-up/cu-deck-09-phone-light.png) | ![10](catch-up/cu-deck-10-phone-light.png) | ![11](catch-up/cu-deck-11-phone-light.png) |
| ![12](catch-up/cu-deck-12-phone-light.png) | ![13](catch-up/cu-deck-13-phone-light.png) | ![14](catch-up/cu-deck-14-phone-light.png) | ![15](catch-up/cu-deck-15-phone-light.png) |

## The card

![Question card, phone, light](catch-up/cu-question-a-phone-light.png)

Top to bottom:

1. **Progress.** "Go through 3 of 17" and a segmented bar, one segment per card: done in the foreground colour, skipped
   faded, the current one amber (what needs you), the rest the track; past 24 cards it becomes one continuous bar.
   Desktop has Leave (×) on the left; on a phone the host header's ← is the only back control (DESIGN.md, One header).
2. **Who.** The state word in its colour (Question, Merge, Permission), age, project, and "2 of 3 here" when the
   workspace has more cards. Then the workspace title (› agent when it has several roots), its Summary line, and the
   references line (spec, linked issue, Slack thread): the same lines Home's detail pane shows.
3. **The ask, through the surface's own component.** A question is `QuestionBody`, the same body as the question
   dialog, the pill and the panel: the question, what the agent does meanwhile, the background, links and the PR it is
   about, the lettered options with Recommended, Something else, the note field, Send to agent and Put in chat. A
   Needs-you row is `NeedsYouList` with that one row (Merge names its scope, one click). An ask is the brief card. So
   the answer flow is the shared one, never a fork: when the shared answer flow lands (panel-own-answer), the card gets
   it for free.
4. **Tell the agent something.** A card that isn't a question has a one-line reply field (a question has its note).
5. **The deck's moves**, secondary, pinned in thumb reach on phones: Back, Context (more context), Later, Open chat,
   Skip.

Deep context folds, so a card fits a phone: the background is a few lines, the references line is one row of chips,
Recent steps aren't on the card (they would load an unloaded agent; Open chat is one tap).

### Layout: two directions on phones

| A. One card (recommended) | B. Answer sheet |
| --- | --- |
| ![A](catch-up/cu-question-a-phone-light.png) | ![B](catch-up/cu-question-b-phone-light.png) |

- **A. One card.** Everything scrolls as one card; the deck's moves sit in a bar at the bottom. Reads top to bottom
  like the question dialog the developer already knows. Long options push Send down a scroll.
- **B. Answer sheet.** Context scrolls above; the question, options and Send sit in a sheet pinned to the bottom, in
  thumb reach. Faster on long cards, but the sheet takes half the screen, so the context window is small, and on a
  short card the screen is half empty.

Recommended: A. Most cards are short; one scroll for a long one is cheaper than half a screen for the sheet.

### Desktop: queue rail or one column

| Queue rail (recommended) | One column |
| --- | --- |
| ![rail](catch-up/cu-rail-desktop-dark.png) | ![one column](catch-up/cu-norail-desktop-dark.png) |

The rail lists every card under its workspace, the current one marked amber, done ones checked and struck through,
skipped ones with a corner arrow; a click jumps. It is the progress, the map and Back in one, and desktop has the room. In phase 2 the rail sits in a `ResizableSplit` like Home's pane (`side-panes-are-resizable`); the prototype draws it at a fixed 300 px.

## Actions

Every action is one tap, and the card leaves the moment it is taken. The work runs in the background.

| Action | What it does |
| --- | --- |
| **Answer** | Pick an option and Send (or write your own through Something else). Goes through `follow.answer-question` and the durable message queue; the card moves on at once, a failure comes back as "Not sent · Retry" on the card and in the finished summary. |
| **Add context** | The note field under the options: words for the agent with the answer ("The developer added: …"). Without answering: the same field with Send note, a plain message to the agent; the card stays. |
| **More context** | See below. |
| **Skip** | Moves on; the card waits at the end ("Go through 2 skipped"). Nothing changes on the server. |
| **Later** | The row's Later (snooze), the same four choices as Home; the card leaves the deck. |
| **The item's own button** | Merge, Add reviewers, Send N tasks, Allow, Sign off, Retry: the Needs-you row's own button, the same path. |
| **Open chat** | The agent's chat (desktop docks the panel beside it), the deck keeps its place. |

Agent parity: each of these already has its agent tool (`answer_question`, `brief_action`, `inbox_act`, `send_repairs`,
`pr_action`, …). New in phase 2: `catch_up_deck` (read: the deck in order, what each card holds) and the "ask the agent
to explain" action as a planned/confirmed tool.

### More context

![more context](catch-up/cu-more-phone-light.png)

Picked: **the Overseer inline plus Ask the agent**, both shipped, to try in the beta.

- **Suggestions, "I don't get it" first.** Most of the time the question just isn't understood and needs a simple
  explanation and more context, so the first chip asks for a plain-language explanation of the question plus what is
  needed to decide. Then "Why does it matter?", "What did it try?", "What if I take the recommendation?", and the
  developer's own words.
- **Ask the Overseer.** It answers from what it already reads (every workspace's state, agents' transcripts on disk)
  and wakes no one.
- **Ask the agent.** Authoritative: the ask goes to the card's agent as a queued message. It may wake the agent, only
  because the developer asked.
- **Never wait on the card.** Either ask moves the deck on to the next workspace at once, and the rest of this
  workspace's cards wait with it. The progress line says "1 getting context". When the answer is ready, the workspace
  comes back as the very next card (right after the one on screen, never interrupting it), with the answer on the
  card. A card handled elsewhere while it waits doesn't come back; Back still reaches it; the finished screen counts
  what is still getting context. Invariant `context-never-blocks-the-deck`.
- **How the answer returns.** The asked agent (or the Overseer) replies with `context_reply` and the request's id; an
  agent that ends its turn without it settles the ask as "answered in its chat" (Open chat). The answer reaches the
  client on Home's feed, so nothing polls.

| Overseer answer on the card | Asked the agent: the card waits |
| --- | --- |
| ![overseer](catch-up/cu-overseer-phone-light.png) | ![asked](catch-up/cu-asked-phone-dark.png) |

With the Overseer off, More context offers only Ask the agent.

## Flow

- **Entry.** "Go through 17" is the primary on Home: the morning brief's button on desktop (it replaces "Open <first>"),
  a full-width button under the status strip on phones. Also ⌘K "Follow-up: Go through what needs you", the sidebar
  view's Needs-you header, and the pill when more than one workspace needs you. The count is cards, the deck the mode opens on.
- **Progress.** "3 of 17" and the bar; on desktop the rail too.
- **Back.** The Back move, K or ←, a swipe right. A card already answered shows its recorded answer and delivery
  state (the question body already does), so going back never answers twice.
- **New item mid-session.** Appended at the end, never under the developer's thumb: "1 new · at the end" in the
  progress line, the count grows.
- **Resolved elsewhere** (answered on the desktop, the agent withdrew it, the PR merged): a card still ahead drops out
  silently; the card on screen says "Handled elsewhere. Nothing left to do here." with Next.
- **Finished.** "Nothing else needs you", with what happened ("7 done · 2 skipped · 1 for later · 1 waiting on an
  explanation"), what happens next (answers are on their way, new asks show in Needs you and the pill), Go through N
  skipped, and Back to Home.

| New item arrived | Handled elsewhere | Finished |
| --- | --- | --- |
| ![arrived](catch-up/cu-arrived-phone-light.png) | ![gone](catch-up/cu-gone-phone-light.png) | ![finished](catch-up/cu-finished-phone-light.png) |

## Gestures and keys

**Phone.** Swipe left to skip, right to go back. Answering is never a swipe: a stray thumb must not decide anything.
Every target is 44 or more; the moves sit at the bottom, in thumb reach. When the keyboard opens for a note, the card
scrolls the field above it and the moves hide (the detail pane already does this with `typing`).

**Desktop** (`CATCH_UP_KEYS`, only while the mode is on screen and never while typing):

| Key | Does |
| --- | --- |
| A–H | pick that option |
| W | write your own answer (Something else) |
| ⌘↵ (Ctrl↵) | send (the existing `SubmitScope` rule) |
| J or → | skip |
| K or ← | back |
| M | more context |
| N | add a note |
| L | later |
| O | open chat |
| Esc | leave |

No collisions: option letters stop at H and the moves use J to W. Home's own keys (j/k, Enter, /) aren't mounted while
the mode is on screen, ⌘/ stays Search from anywhere, and nothing takes a modified key Paseo binds (`PASEO_BOUND`).

![keys](catch-up/cu-keys-desktop-dark.png)

## Speed

- The next card shows instantly: the deck is already on the client, and the next card's full workspace read
  (`follow.get`, for the PR sheet and references) is fetched while the current card is on screen. One read per card,
  only for the next one.
- Sending never blocks: answers go through the durable message queue (`a-message-is-saved-before-sent-and-arrives-once`);
  the card moves on as soon as the action is handed off, as quick actions already do (`runAction`, pending answers).
- No new polling: the deck re-derives from the feeds Home already subscribes to.
- No agent wakes, except when the developer asks an agent to explain.

## The name

| Name | Why | Home button | ⌘K | Progress | Finished |
| --- | --- | --- | --- | --- | --- |
| **Go through** (recommended) | Plain, a verb, says what you do and works any time, not only after time away. | Go through 17 | Follow-up: Go through what needs you | Go through 3 of 17 | Nothing else needs you |
| One by one | Names the mechanic exactly; reads less like an action on a button. | One by one · 17 | Follow-up: One by one | One by one 3 of 17 | Nothing else needs you |
| Triage | Familiar to developers, short. But it means sorting, and here you decide and act. | Triage 17 | Follow-up: Triage what needs you | Triage 3 of 17 | Triaged everything |
| Focus | Short, calm. Clashes with the OS's Focus modes and with keyboard focus in docs and code. | Focus · 17 | Follow-up: Focus on what needs you | Focus 3 of 17 | Nothing else needs you |

## The picks

Tom, 2026-11-17:

1. **Name: Catch up.** "people know the name". Home "Catch up · 17", ⌘K "Follow-up: Catch up on what needs you",
   progress "Catch up 3 of 17", finished "All caught up". The Home button's accessible name and tooltip say the number
   counts things to act on, since it can differ from Needs you's workspace count beside it.
2. **Phone: A, one card.**
3. **Desktop: A, the queue rail.** Keys matter on desktop: every action is reachable from the keyboard (A–H, W, ⌘↵,
   J/K, M, N, L, O, ?, Esc, plus the More context chips and the rail), keys show in the hint line, button tooltips and
   a `?` overlay, and a test checks they never collide with Paseo's or Home's keys.
4. **More context: the Overseer inline plus Ask the agent**, with "I don't get it" first and the deck never waiting
   (above).
5. **Answering: pick, then Send.**
6. **Order: Home's Needs-you order.**

Also folded in from review: the finished screen's bar shows done and skipped; Later and Open chat on the phone bar
carry labels for screen readers and tooltips on desktop.

## Decisions for the developer (phase 1, now picked)

1. **Name:** Go through (recommended), One by one, Triage, or Focus.
2. **Phone layout:** A one card (recommended) or B answer sheet.
3. **Desktop:** queue rail (recommended) or one column.
4. **More context:** Overseer inline plus Ask the agent (recommended), Overseer only, or agent only.
5. **Answering speed:** pick then Send, two taps (recommended: the note field sits between them, and Back shows what
   was sent), or one tap on an option sends at once with a 6-second Undo (faster, but no room for a note).
6. **Deck order:** Home's Needs-you order (recommended) or quick wins first.

## Phase 2 plan

Small stacked PRs, each green on its own:

1. Server and tools: the deck and session state machine (`shared/catch-up.ts`), More context's store and RPCs
   (`server/context-requests.ts`, `follow.context-ask`, `follow.context-list`, `follow.context-reply`, the answers on
   `follow.home-feed`), agent tools `catch_up_deck`, `context_requests`, `ask_context` (planned/confirm, audited) and
   `context_reply`; invariants 45 `context-never-blocks-the-deck` and 46 `the-card-on-screen-never-moves`.
2. The mode: the card, the deck, entry points (Home, ⌘K), More context on the card, finished state, live updates,
   offline and queued answers, the desktop rail in a resizable split.
3. Keys, gestures and polish: the full key set with tooltips and the `?` overlay, the collision test, swipe.
