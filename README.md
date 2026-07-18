# ⛳ Golf

A minimal, fast, offline-first way to track golf money games between friends.
Pick a game (Skins, Nassau, Wolf, Vegas — more coming), enter players and handicaps,
score hole-by-hole on one phone. The app does all the math.

**Live:** https://be-norm.github.io/golf/ — open on your phone and Add to Home Screen.

## Development

```sh
pnpm install
pnpm dev        # dev server
pnpm test       # engine + app tests
pnpm build      # typecheck + production build
```

Built with Vite, React, TypeScript, Tailwind, Dexie (IndexedDB), and an event-sourced
pure-TypeScript game engine. See `CLAUDE.md` for architecture invariants.

## Course data

Course scorecards include data from [OpenGolfAPI](https://opengolfapi.org),
made available under the [Open Database License (ODbL)](https://opendatacommons.org/licenses/odbl/1-0/).
