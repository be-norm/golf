# Golf Games Catalog — Scoring Engine Specification

Research-verified catalog of golf side games, precise enough to implement as engines.
Each engine lives in `src/engine/games/<type>/` and implements the `GameEngine` contract
in `src/engine/catalog.ts`.

**Built today (7):** Skins · Nassau · Match Play · Wolf · Vegas · Six Point · Closest to the
Pin. Everything else is roadmap.
The source of truth is `src/engine/games/index.ts` — if it's registered there it ships, and
the `[shipped]` tags below should agree. They drifted once; check the registry, not the tags.

Legend:
- **Net score** = gross − handicap strokes allocated by stroke index (SI).
- **Extra inputs** = data beyond per-hole gross strokes. "Strokes-only" = fully derivable,
  and by far the cheapest to add: no events, no UI channel, just a reducer and a settlement.
  An entry listing "Inputs:" needs an event kind and a place for players to answer.
- **Tier**: 1 = very common, 2 = common, 3 = niche.
- All money games are zero-sum ledgers settled by pairwise differences.

---

## MVP GAMES

### 1. Skins `[shipped]`
**Format:** 2–8 individuals. **Tier 1. Strokes-only.**
Each hole worth one skin; outright lowest (gross or net) wins it, any tie = no skin.
- **Carryover (default on):** tied hole's value rolls to the next hole, across the turn.
  Final-hole tie: pot dies (current impl) — alternates: split, playoff.
- **A dead pot is declared dead.** Once every hole is decided with skins still on the pile —
  the last hole tied, or the round finished early — the app says "N skins died unwon" instead
  of "N carried", which would promise a roll onto a hole that no longer exists (MAI-38). It
  reaches the settle screen and share card on the derivation's `notes` channel, rendered under
  the money and apart from it — never as a zero-cent settlement line, which would make the
  panel's "No money moved." read false on the very round where none did (MAI-40).
- **Validation variant (not yet impl):** skin banked only if winner ties-or-beats field on next hole.
- **Money:** winner collects stake × (n−1) per skin.
- Config: stakeCents, carryover, handicap mode (gross / net full / net off-low).

### 2. Nassau `[shipped]`
**Format:** 2 individuals or 2v2 best-ball. **Tier 1.** Extra inputs: press declarations (offered
on the tee about to be played, independent of the auto-press setting).
Three equal match-play bets: Front 9, Back 9, Overall 18. Hole won by lower net (best ball in teams);
+1/0/−1 per hole per relevant bet. Tied segment = push.
- **Presses:** new bet at same stake from declaration hole to end of parent bet's segment.
  Only the down side presses; presses can be pressed. **Available at ANY deficit, not gated at
  2-down** — 2-down is the traditional moment and the UI badges it, but a player pressing on
  read (knowing an opponent is fading, knowing they own the back nine) is the normal case, not
  an exception. A 1-hole press at the end of a stretch is allowed.
  **Auto-press (config):** spawn press whenever any live bet reaches 2-down. Manual presses stay
  available alongside it: auto covers the convention, the button covers judgment.
- **Press identity — exactly one bet per (segment, startHole), whatever created it.** A parent
  and its own presses can cross 2-down on the same hole and all point at the same new bet; so
  can a hand-tapped press. Collapsing them is load-bearing: duplicates settle twice while
  staying zero-sum, so the property fuzz cannot see the error (MAI-34).
- **Close-out — a bet is won when it is DECIDED, not when its holes run out.** Up more holes
  than the bet has left and it is over: reported in golf's notation (3&2 = three up with two
  to play; `2 up` when it went the distance), **frozen** at that margin so the dead holes
  cannot drift it, and **settled on that hole** — the standings, the pinned bar, the hole
  ledger, the settle screen and the share card all show the money there. A decided segment is
  no longer pressable, and a bet that closes 2&1 opens no auto-press over its last hole (both
  rules fire on the same hole; the close wins — you cannot press a match that is over). Live
  presses under a closed parent keep that segment pressable — you press the bet you're down on,
  and with auto-press ON that is the common case, so the offer NAMES the bet ("Colby 1 down on
  Press @3") rather than letting "Press F9 · 1 down" sit under a ledger line reading "F9 · won 3&2".
  A bet level at the end never closes — it pushes. And the `N&M` form is only ever quoted when a
  hole somebody actually played clinched it: a bet that runs out of room on an unplayed hole
  (finishing early finalizes the whole card at once) reports the plain `N up` instead, rather
  than describing holes that were never contested (MAI-38).
- **Undo follows ownership, not authorship.** A hand-tapped press can be toggled back off
  (`meta/retract` over its event). A press auto-press would open anyway cannot — retracting the
  event would only let the rules re-create the identical bet, so the UI shows it running and
  inert rather than offering an undo that does nothing.
- Handicaps: 100% of CH difference off the low player (90% each off low ball in four-ball).
- 9-hole round: collapses to a single match bet.
- Config: stake per bet, individual vs 2v2, press rules (manual/auto/threshold/re-press), gross/net.

### 3. Wolf `[shipped]`
**Format:** exactly 4 (3/5 variants), rotating Wolf; Wolf every 4th hole. **Tier 1.**
Extra inputs: per-hole pick — partner / lone / blind.
Wolf tees last (config), picks a partner immediately after that player's drive or passes;
pass all three = **Lone Wolf** (1v3). **Blind Wolf** = declare solo before anyone tees (3×).
Hole decided by best net ball of each side.
- **Stakes, not a score table (MAI-83):** every player has the stake on the line each hole;
  a won hole pays one stake per player in 2v2. Lone DOUBLES the hole and Blind TRIPLES it, and
  the outnumbered wolf plays that stake against EACH opponent — so at $1 a hole, lone is
  ±$6 for the wolf and ∓$2 for the others, blind is ±$9 / ∓$3. Symmetric both ways, so going
  lone is a real gamble rather than free money. The pack gets no bonus for beating the picker.
  (Tables vary by group; this one is `HOLE_UNITS` in the engine.)
- Ties: halved (config: carryover doubles next hole).
- Holes 17–18: lowest-points player is Wolf (config alternates).
- Config: per-hole stake, lone/blind multipliers, tie carryover, 17–18 rule, wolf tee position.

### 4. Vegas `[shipped]`
**Format:** exactly 4, two fixed teams. **Tier 1. Strokes-only.**
Team number = concat(low, high) of the pair's scores (4&5 → 45); low team wins the
difference in points. `teamNumber = 10*min + max`.
- **Double-digit exception:** a score of 10+ goes first: 4 & 10 → 104 (config: punitive 410).
- **Flip the bird:** natural gross birdie flips the *opponents'* number high-first (47→74);
  both sides birdie = flips cancel. **Eagle:** flip + double the differential (config toggles).
- Ties: no points (config: consecutive-tie multiplier). Optional per-hole point cap.
- Net Vegas: strokes applied per player before pairing; flips still keyed to gross birdies.
- Config: $/point, teams, flip on/off, eagle-double, double-digit rule, cap, gross/net.

---

## CORE FORMATS (post-MVP)

### 5. Stroke Play (Medal) — Tier 1, strokes-only
Lowest total net. Allowance 95% common (WHS). Ties: countback (back 9 → last 6 → 3 → 1).

### 6. Match Play `[shipped]` — Tier 1, strokes-only
**Format:** 2 individuals or 2v2 best ball (2v1 supported). One match over the round.
+1/0/−1 per hole by lower net; ends when up > remaining ("4&3"). 100% of CH difference off low.
- **Impl:** `src/engine/games/matchPlay/` — a thin engine over `core/match.ts`, which is the
  reason that kit was extracted (MAI-48). No events, no actions, no awards: the match is a
  pure function of the scores. Its span is `ctx.holesPlayed`, so **a 9-hole round is one match
  over that nine** with no special case, and the single bet is labelled by
  `stretchLabel` — `18` / `F9` / `B9`.
- **Deliberately NOT a Nassau config.** A one-bet, no-press Nassau settles the same money, but
  golfers look for "Match Play" by name, and press identity / auto-press / undo-follows-
  ownership are dead weight when there is nothing to press.
- **Close-out, margin and degradation are the kit's** and identical to Nassau's: decided the
  moment a side is up more than remains, frozen there, settled on that hole, and `N&M` quoted
  only when a hole somebody actually played clinched it (otherwise the plain `N up`, MAI-38).
  Level at the end is a push and never "closes".
- **Money:** one settlement line, and only when the match is won. Each player pays or collects
  the stake; a lone side against a pair plays the stake against each opponent (`sideStake`), so
  an uneven 2v1 stays zero-sum.
- `category: 'either'` — a match beside a group Skins is an ordinary side bet, and a `'main'`
  category would have made that unbuildable in the picker.

### 7. Best Ball / Four-Ball — Tier 1, strokes-only
Team hole score = lowest net among teammates. WHS: 90% match / 85% stroke, off low in group.

### 8. Stableford — Tier 1, strokes-only
Points vs net par: 0 (net double+), 1 bogey, 2 par, 3 birdie, 4 eagle, 5 albatross.

### 9. Modified Stableford — Tier 2, strokes-only
PGA table: albatross +8, eagle +5, birdie +2, par 0, bogey −1, double+ −3. Editable table.

### 10. Quota (Chicago) — Tier 2, strokes-only
Gross points (bogey 1, par 2, birdie 4, eagle 8) minus quota (36 − CH; classic 39 − CH).

### 11. Scramble — Tier 1, **team gross per hole** (input-model change)
Team plays one ball. Allowances 25/20/15/10% (4p). Min-drives constraint as validation.

### 12. Chapman/Pinehurst — Tier 2, team gross per hole
Both drive, swap for shot 2, pick one ball, alternate in. Handicap 60% low + 40% high.

### 13. Foursomes / Greensomes / Gruesomes — Tier 2, team gross per hole
Alternate shot family. 50% combined / 60-40 greensomes.

### 14. Shamble — Tier 2, strokes-only (+ whose drive for min-drive rules)
Best drive, then own ball in; best ball counts.

### 15. Sixes (Hollywood) — Tier 2, strokes-only
4 players, partners rotate every 6 holes; three independent 6-hole best-ball matches.

### 16. Nines (5-3-1) — Tier 2, strokes-only
Exactly 3 players; 9 points/hole by rank (5/3/1); ties combine-and-split (4-4-1, 5-2-2, 3-3-3).

### 17. Split Sixes / Six Point (4-2-0) `[shipped]` — Tier 2–3, strokes-only
Exactly 3 players; 6 points/hole by rank. Distinct → 4-2-0; two tie for low → 3-3-0;
one low + two tied → 4-1-1; three-way tie → 2-2-2 (moves no money).
- **Impl:** rank slots [4,2,0], tied players share the average of the slots they span
  (so all four splits fall out of one rule; every average is a whole number).
- **Money:** `(points − 2) × perPointStake` per player — zero-sum against the 2-point
  average by construction. Config: perPointStake, gross/net via handicap policy.
- A finalized hole missing any of the three scores is void (six points need all three).

---

## SIDE GAMES & OVERLAYS (post-MVP)

### 18. Dots / Junk — Tier 1 overlay. Extra inputs: junk events per hole.
Menu of ±1 achievements: birdie/eagle (derivable), greenie (par 3, on in 1, par-or-better),
sandie, barkie, chippie, arnie (par w/o fairway), hogan (FIR+GIR+par), poley; negatives:
snake/3-putt, whiff, water, OB. The `requiredInputs`/`game/event` framework already supports
this — junk buttons emit `junk/award` events.

### 19. Bingo Bango Bongo — Tier 2. Inputs: 3 point-winners per hole.
First on green / closest once all on / first holed. 54 pts per 18. Order of play is sacred.

### 20. Rabbit — Tier 2, strokes-only.
Outright hole win captures (or frees, traditional convention) the rabbit; holder at 9/18 wins pot.

### 21. Snake — Tier 2. Inputs: putts per hole (enables 3-putt automation).
Last 3-putter holds the snake; fixed or doubling pot.

### 22. Banker — Tier 2–3. Inputs: banker rotation, per-opponent wagers, presses.
Rotating banker plays simultaneous 1v1 hole matches vs everyone at chosen stakes.
Wagers and presses are optional player-initiated actions (`availableActions`), not blocking
prompts — see the two-channels note below.

### 23. Defender — Tier 3, strokes-only. 3 players rotating 1-v-2 best ball; ±2/0.

### 24. Aces & Deuces — Tier 2–3, strokes-only.
Outright low collects ace value from all; outright high pays deuce value to all (ace = 2× deuce).

### 25. Trouble — Tier 3. Inputs: trouble events (water, OB, 3-putt, tree, whiff...). Inverse junk.

### 26. Hammer — Tier 2. Inputs: hammer throws + accept/fold. Hole value doubles per accepted hammer.
The clean case for both channels at once: the **throw** is optional and player-initiated
(`availableActions`), the **accept/fold** is blocking (`requiredInputs`) — until it's answered
the hole has no value. Modelling the throw as a prompt would nag on every hole.

### 27. Umbrella — Tier 3. 2v2, 6-point categories per hole; sweep = double.

### 28. Criers & Whiners — Tier 3. Inputs: mulligans used. Replay credits ≈ ¾ CH instead of strokes.

### 29. Yellow Ball — Tier 3. Inputs: ball-survival flag. Rotating money ball + best ball aggregate.

### 30. Closest to the Pin (CTP) `[shipped]` — Inputs: one award per eligible hole (MAI-46).
The most-played side bet in golf, and the award channel's first game. Par 3s only (the engine
decides eligibility from `courseSnapshot` par, so the award grid simply doesn't offer it
elsewhere). One winner per hole collects the stake from every other player. No carryover: each
par 3 stands alone.
**Dead money:** an unawarded par 3 goes on `notes`, never a $0 settlement line (MAI-40) — and
only once the whole card is played out, because `finalized` is true from the next tee onwards
and the group may still be intending to record it. The first `category: 'side'` and
`family: 'award'` engine, so it is also what makes the picker's Side Bets section and its
"Awards" heading real.

### 31. Long Drive — Tier 1. Inputs: one award per eligible hole.
Usually one nominated hole (a par 5), sometimes several; fairway-only is the common house
rule. Same shape as CTP — one winner, one award, same dead-money problem when nobody keeps it
in play. Eligible holes are config, not derivable, since the group picks them at the tee.

---

## Cross-cutting implementation notes

- **Derivable vs not:** birdies/eagles, hole winners, stableford/quota points are all derivable
  from gross + par + SI + CH. Wolf picks, BBB winners, junk awards, putts, hammer/press/wager
  decisions, and team-format team scores are not — they arrive as `game/event`s.
- **Putts live at ROUND level, not in any game (MAI-54).** Snake is driven by them and Dots
  needs them for 3-putt/poley, so a `score/putts` event feeding `RoundContext` is entered once
  and read one-way by both — which also makes 3-putt/snake derivable rather than tapped. Not
  built yet; it ships with Snake. Awards stayed binary because of it.
- **Three channels for those events, and picking the wrong one is a real bug.** Sort every
  non-derivable input by whether the hole can compute without it, and by whether it expires:
  - **Blocking → `requiredInputs` / `InputRequest`.** The hole is stuck until someone answers
    (Wolf's pick, a hammer accept/fold, BBB's point winners). Right to interrupt scoring.
    An option may carry its own `data`, merged under `{ hole, choice }`.
  - **Optional, player-initiated → `availableActions` / `GameAction`.** Legal but not required
    (a Nassau press, a hammer throw, a Banker wager). These live behind a button and only
    *badge* when the game's convention says act now (`recommended`). Frontier-gated: they
    belong to the tee you are standing on. The engine supplies the verb (`meta.actions`).
  - **Per-player, per-hole and permanent → `awards` / `Award`.** CTP, greenies, sandies, the
    snake. A grid of group rows × player cells under the score rows, no frontier gate and no
    all-scored gate — an award belongs to its hole forever, so it stays editable until the
    round is completed.

  Availability ("this is legal") is true on most holes; recommendation ("do it now") is rare.
  Nassau shipped them on one channel and nagged "Press?" on every hole while never saying why
  (MAI-34). A `GameAction` carries its own argument — `detail` (why it's offered) and `effect`
  (what taking it creates, quoted at what it costs the side being invited).
- **Every game needs:** gross/net toggle + allowance, bet unit, ties policy; most per-hole money
  games need a carryover toggle. Point tables should be config-driven — sources disagree.
- **9-hole rounds:** most games scale directly; Nassau collapses to one bet; Quota halves the
  base; Sixes becomes 3-3-3; 4-player Wolf uses trailing-player rule for the 9th hole.
- **9-hole handicaps** are two different adjustments, and mixing them up doubles or halves every
  payout. A true 9-hole course takes HALF the index against the nine's own rating/slope
  (`courseHandicapForTee`, core/handicap.ts). Playing 9 of an 18-hole course instead halves the
  post-allowance *course handicap*, since (rating − par) is an 18-hole term (`nineOfEighteen`,
  core/context.ts). A nine played twice around tees off as a doubled 18-hole snapshot
  (`doubleNine`, core/tees.ts) and so takes the full index.
- **Team-score formats** (Scramble, Chapman, Foursomes) need team-score entry instead of
  per-player strokes — an input-model extension, deliberately deferred.

Sources: golf.com, Golf Digest, USGA/SCGA allowance tables, The Left Rough, Golf Compendium,
Wikipedia (Nassau, Stableford), 18Birdies, Stick, Settle Up. Verified July 2026.
