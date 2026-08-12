# Pixel art — the house standard

Every picture in this app is hand-made pixel art: `shape-rendering="crispEdges"`
rects on an integer grid, in the arcade idiom the app icon set. This note is the
standard they are drawn to, written down after MAI-94 spent four rounds
rediscovering it.

It exists because the technique is **cross-cutting** — glyphs, sprites, the
favicon and the icon set all obey it, and it belongs to none of those files.
CLAUDE.md carries the rules that code can silently violate; this carries the
how-to.

## The reference

`public/pwa-512x512.png` (and its 1254px sibling `docs/assets/app-cover-image.png`)
is the identity: bright sky, clouds, a tree line, dithered fairway, a putting
surface ringed in near-black, a cream flagstick and a red pennant carrying a `$`.

**It is PAINTED, not pixel art.** It has 32 colours with per-pixel jitter and
sits on no clean grid, so it cannot be downsampled into a sprite — several of its
greens differ by one or two values and are meant to read as one colour. Treat it
as the source of PALETTE and COMPOSITION, and redraw rather than trace.

The palette, sampled from the 512 master and clustered:

| role | hex | notes |
| --- | --- | --- |
| sky, high | `#1983f4` | deeper blue at the top of the frame |
| sky, horizon | `#228dfa` | lighter toward the tree line |
| cloud / stick / `$` | `#f9f0d7` | warm cream, never pure white |
| tree line | `#044a22` | the darkest green; reads as a mass, not trees |
| fairway light | `#77d217` | the dither highlight |
| fairway | `#5bbf17` | |
| fairway mid | `#2a9c1c` | the base green |
| putting surface | `#35a421` | flatter and darker than the fairway |
| outline / cup | `#112711` | near-black green — the ring around the green |
| flag | `#ec0e12` | |
| flag shadow | `#71140c` | the pennant's lower edge and its trailing point |

## The rules

1. **Integer scale, always.** Crisp rects snap to device pixels; at a fractional
   scale they snap to DIFFERENT widths and one side of a coin comes out flat.
   `PixelSprite` enforces this rather than asking politely. It is also why sizes
   are set in explicit pixels and never with a Tailwind `size-*` class — those
   are rem-based against a 19px root, so `size-16` is 76px, not 64.

2. **The grid is chosen by RENDER SIZE AND SHAPE, not by taste.** A sprite
   declares a width and a height; they need not match.
   - **16** for anything drawn at 16 CSS pixels: one art pixel is one screen
     pixel, and there is no room for detail that would only turn to mud.
   - **32** for anything that plays large — 64px and up. At 16 the same drawing
     reads flat and cheap, which is the whole of what "too NES" means here.
   - **A banner** for anything spanning a column: the course mark is 135×40,
     because a square asked to fill a width either crops or leaves the sides
     empty. Note it cannot be `width: 100%` — a fluid width is a
     fractional scale, and rule (1) is why it can't be.
   - Each sprite declares its own grid (`PixelSprite`'s `SPRITES` table), and
     **callers ask for a SIZE, not a scale** (`scaleFor(name, px)`). A hardcoded
     scale silently means a different picture size the day a sprite is redrawn:
     moving the coin from 16 to 32 doubled every one of its callers at once.
   - The same subject at two sizes is TWO DRAWINGS, not one scaled. The wolf is
     a 16px mark and a 32px sprite; the coin is a 16px confetti speck
     (`coin-small`) and a 32px celebration. That is this rule applied, not
     duplication — and a 32-grid sprite cannot render below 32px at all, since
     the scale is an integer.

3. **A one-pixel dark outline is the single largest difference** between a sprite
   that reads and one that doesn't — but only for CHARACTER sprites, the ones
   floating free over whatever is behind them. Scene sprites (the course, the
   scorecard) carry their own filled background and need depth instead: more
   grid, more tones, dithering.

4. **Outline overlapping parts against each other, not just against space.** A
   silhouette outline gives you the figure; an INTERNAL edge is what keeps an arm
   legible where it crosses a chest. Draw such parts on separate layers and edge
   each as it lands.

5. **Three tones per material, and shadows shift COOL** rather than merely
   darkening — that is the difference between fur and grey paint. The budget is
   per MATERIAL, not per sprite: the wolf's swing runs to 17 colours across a
   wolf, a club, a ball and sparks, and each of those is three or four.

6. **Objects that overlap need hue separation, not just value separation.** The
   golf ball reads against the wolf because it is cool where he is warm. Matched
   in value they dissolved into each other on every frame where they met.

7. **Generate what is mechanical; draw what is not.** Shading derived from a
   silhouette cannot drift out of register with it. Limbs drawn as strokes
   between a pivot and a grip cannot forget an arm. Hand-draw the silhouette and
   the face; compute the rest.

8. **Past a certain amount of picture, author it as a CHARACTER MAP** rather than
   rect tuples (`wolfArt.tsx`). Seven frames of a wolf, a club and a ball is more
   than coordinates can hold in a reader's head, and re-shaping an ear should not
   mean counting. Runs collapse back into the same rects on the way out.

## Two lessons that cost the most

- **A profile torso can never show two arms.** Stacked one behind the other they
  render as a single limb no matter how they are shaded. Square the shoulders and
  let the far arm cross the chest; the triangle that makes is the pose.
- **A profile head has no face.** The eye ends up at the back of the skull with
  the snout at the other end, and the result is a featureless lump. Turn the head
  to camera even when the body stays in profile — the oldest trick in sprite work
  and the only thing that survives at this size.

## The 16px exception: shaded, but not outlined and not lit

`PixelGlyph`'s wolf marks render inline in a sentence at exactly 16 CSS pixels,
where one art pixel is one screen pixel. Rule (3)'s outline is unavailable there
— it eats the outer ring and leaves a 14×14 animal, and the ear tips are most of
what makes the mark read as a wolf rather than a cat. Tone costs nothing in
dimensions, so tone is what they get.

**But only the shadow half**, and the reason is worth keeping. Rule (7)'s derived
shading lights every cell with nothing above it. On a head with EARS, that set
includes the gap between them — which is a hole in the silhouette, not a surface
turned to the light. The rule cannot tell those apart, so the brow came out
wearing a bright band across it. At sprite size the same rule is fine, because
one row in thirty-two reads as a highlight; at sixteen it is one row in sixteen
and reads as a blaze.

So: derive the shadow, place any highlight by hand, and be suspicious of a
generated highlight wherever the top edge of a shape is concave.

## Staying in sync

`public/icon.svg`, the in-app course sprites and the PNG icon set are three
pictures of one thing, and they have drifted before — the PNGs were upgraded and
the other two were not, which is what MAI-94 surfaced.

- The **sprites and `icon.svg` are generated from one drawing**
  (`src/components/courseArt.tsx`), so they cannot drift; a test compares the
  committed SVG against that source.
- The **PNG set is painted by hand** and is regenerated deliberately. Changing it
  means `favicon.ico`, `apple-touch-icon-180x180`, `maskable-icon-512x512` and
  `pwa-64/192/512` all move together — and they ship to every user through the
  service-worker precache, so it is never a quiet change.
