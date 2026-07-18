# Golf Games Catalog — Scoring Engine Specification

Research-verified catalog of golf side games, precise enough to implement as engines.
The MVP ships Skins, Nassau, Wolf, Vegas; everything else here is the roadmap.
Each engine lives in `src/engine/games/<type>/` and implements the `GameEngine` contract
in `src/engine/catalog.ts`.

Legend:
- **Net score** = gross − handicap strokes allocated by stroke index (SI).
- **Extra inputs** = data beyond per-hole gross strokes. "Strokes-only" = fully derivable.
- **Tier**: 1 = very common, 2 = common, 3 = niche.
- All money games are zero-sum ledgers settled by pairwise differences.

---

## MVP GAMES

### 1. Skins `[shipped]`
**Format:** 2–8 individuals. **Tier 1. Strokes-only.**
Each hole worth one skin; outright lowest (gross or net) wins it, any tie = no skin.
- **Carryover (default on):** tied hole's value rolls to the next hole, across the turn.
  Final-hole tie: pot dies (current impl) — alternates: split, playoff.
- **Validation variant (not yet impl):** skin banked only if winner ties-or-beats field on next hole.
- **Money:** winner collects stake × (n−1) per skin.
- Config: stakeCents, carryover, handicap mode (gross / net full / net off-low).

### 2. Nassau
**Format:** 2 individuals or 2v2 best-ball. **Tier 1.** Extra inputs: press declarations (unless auto).
Three equal match-play bets: Front 9, Back 9, Overall 18. Hole won by lower net (best ball in teams);
+1/0/−1 per hole per relevant bet. Tied segment = push.
- **Presses:** new bet at same stake from declaration hole to end of parent bet's segment.
  Convention: only the down side presses, traditionally at 2-down; presses can be pressed.
  **Auto-press (config):** spawn press whenever any live bet reaches 2-down (one per event,
  none with 1 hole left).
- Handicaps: 100% of CH difference off the low player (90% each off low ball in four-ball).
- 9-hole round: collapses to a single match bet.
- Config: stake per bet, individual vs 2v2, press rules (manual/auto/threshold/re-press), gross/net.

### 3. Wolf
**Format:** exactly 4 (3/5 variants), rotating Wolf; Wolf every 4th hole. **Tier 1.**
Extra inputs: per-hole pick — partner / lone / blind.
Wolf tees last (config), picks a partner immediately after that player's drive or passes;
pass all three = **Lone Wolf** (1v3). **Blind Wolf** = declare solo before anyone tees (3×).
Hole decided by best net ball of each side.
- **Point table (config, no universal standard):** Wolf+partner win: 2 each · non-wolf pair win:
  3 each · Lone Wolf wins: 4 · Lone Wolf loses: 1 each to others · Blind multiplies.
- Ties: halved (config: carryover doubles next hole).
- Holes 17–18: lowest-points player is Wolf (config alternates).
- Config: point table, lone/blind multipliers, tie carryover, 17–18 rule, wolf tee position, $/point.

### 4. Vegas
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

### 6. Match Play — Tier 1, strokes-only
+1/0/−1 per hole; ends when up > remaining ("4&3"). 100% of CH difference off low.

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

### 17. Split Sixes (4-2-0) — Tier 2–3, strokes-only
As Nines with 6 points/hole: 4-2-0; 3-3-0; 4-1-1; 2-2-2.

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

### 23. Defender — Tier 3, strokes-only. 3 players rotating 1-v-2 best ball; ±2/0.

### 24. Aces & Deuces — Tier 2–3, strokes-only.
Outright low collects ace value from all; outright high pays deuce value to all (ace = 2× deuce).

### 25. Trouble — Tier 3. Inputs: trouble events (water, OB, 3-putt, tree, whiff...). Inverse junk.

### 26. Hammer — Tier 2. Inputs: hammer throws + accept/fold. Hole value doubles per accepted hammer.

### 27. Umbrella — Tier 3. 2v2, 6-point categories per hole; sweep = double.

### 28. Criers & Whiners — Tier 3. Inputs: mulligans used. Replay credits ≈ ¾ CH instead of strokes.

### 29. Yellow Ball — Tier 3. Inputs: ball-survival flag. Rotating money ball + best ball aggregate.

---

## Cross-cutting implementation notes

- **Derivable vs not:** birdies/eagles, hole winners, stableford/quota points are all derivable
  from gross + par + SI + CH. Wolf picks, BBB winners, junk awards, putts, hammer/press/wager
  decisions, and team-format team scores are not — they arrive as `game/event`s.
- **Every game needs:** gross/net toggle + allowance, bet unit, ties policy; most per-hole money
  games need a carryover toggle. Point tables should be config-driven — sources disagree.
- **9-hole rounds:** most games scale directly; Nassau collapses to one bet; Quota halves the
  base; Sixes becomes 3-3-3; 4-player Wolf uses trailing-player rule for the 9th hole.
- **Team-score formats** (Scramble, Chapman, Foursomes) need team-score entry instead of
  per-player strokes — an input-model extension, deliberately deferred.

Sources: golf.com, Golf Digest, USGA/SCGA allowance tables, The Left Rough, Golf Compendium,
Wikipedia (Nassau, Stableford), 18Birdies, Stick, Settle Up. Verified July 2026.
