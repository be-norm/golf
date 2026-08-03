# Shipping Golf to the App Store (and Play)

Plan of record for turning the PWA at golf.mainspring.fyi into a store-distributed app
**without a second codebase**. Decisions taken: Capacitor, iOS first, selective native
polish, no paid OTA service for now.

## Why Capacitor

Capacitor 8 wraps the existing Vite build in a real native project (`ios/`, `android/`)
and exposes device APIs as JS plugins. The entire `src/` tree ships unchanged; the native
projects are ~200 lines of generated config you commit and rarely touch.

The alternatives, briefly, so this doesn't get relitigated:

- **React Native / Expo** — a rewrite of every screen in `src/features/`. Only
  `src/engine/**` (pure TS, no DOM) would port cleanly. It buys native scroll physics and
  system controls, which this app doesn't use: the whole UI is a custom pixel-art design
  system. Wrong trade.
- **Tauri 2 mobile** — thinner plugin ecosystem, worse store tooling, and the Rust layer
  buys nothing for an IndexedDB-backed scorekeeper.
- **PWABuilder / TWA** — viable on Android, but its iOS output is a bare WKWebView shell
  that Apple routinely rejects under guideline 4.2 (minimum functionality).

The PWA stays live either way. It remains the fastest inner loop (`pnpm dev` in a browser)
and the fallback for anyone who won't install from a store.

---

## Phase 0 — open the accounts today (blocking, has lead time)

Both of these have waits that will otherwise stall the end of the project.

1. **Apple Developer Program — $99/yr.** Enrollment takes anywhere from hours to a week
   (identity verification). Nothing device-side can be tested for more than 7 days at a
   time until this clears.
2. **Google Play Console — $25 one-time.** Enroll *now* even though Android lands second.
   A new **personal** account created after 13 Nov 2023 must run a closed test with
   **12 testers opted in for 14 consecutive days** before it can apply for production
   access. That clock can't start until the account exists and has a build. (An
   *organization* account is exempt — worth considering if you have an entity to register,
   though it requires a D-U-N-S number.)

Also decide the **store name** now: "Golf" is certainly taken on the App Store. Something
like *Golf Money Games* or *Skins & Nassau* for the listing; the home-screen name under the
icon stays "Golf" (`CFBundleDisplayName` is separate from the store title).

---

## Phase 1 — the native shell

```sh
pnpm add @capacitor/core && pnpm add -D @capacitor/cli
npx cap init Golf fyi.mainspring.golf --web-dir dist
pnpm add @capacitor/ios && npx cap add ios
```

Bundle id `fyi.mainspring.golf` (reverse of the domain you already own — keeps the door
open for Universal Links later).

### The one real incompatibility: service workers

**Service workers do not run in Capacitor's iOS WKWebView** (custom `capacitor://` scheme).
They work on Android, but there's no reason to run one there either — the native shell
already ships every asset locally, which was the SW's entire job.

So the native build must not register one. Three touch points:

- **`vite.config.ts`** — drop the `VitePWA` plugin when building for native, and alias
  `virtual:pwa-register/react` to a stub so `UpdateToast` still compiles. That stub already
  exists as `src/test/pwa-register-stub.ts` (vitest uses the same alias) — promote it to
  `src/pwa/register-stub.ts` and point both configs at it. Gate on an env var:
  `pnpm build:native` → `CAP_BUILD=1 vite build`.
- **`src/platform/native.ts`** (new) — one export, `isNative = Capacitor.isNativePlatform()`.
- **Gate the PWA-only UI on it**: `InstallHint` (`HomeScreen.tsx:58`) is meaningless in an
  installed app; `ensurePersistentStorage` (`src/pwa/diagnostics.ts:54`) is a no-op in
  WKWebView; `UpdateToast` renders nothing.

Everything else survives the transition untouched:

- `createBrowserRouter` with `basename: ''` (BASE_URL is `/`) works fine under the custom
  scheme — no hash router needed.
- Dexie/IndexedDB persists in the app container, and is **not** subject to Safari's 7-day
  eviction. It's cleared only if the user deletes the app. (Signed-in users' completed
  rounds are already covered by the outbox sync; guest data is not — same as today.)
- `navigator.onLine`, `visibilitychange`, `localStorage` all behave.

### Config

`capacitor.config.ts`: `backgroundColor: '#052e16'` (felt-950, so no white flash),
`ios.contentInset: 'never'`, `ios.scrollEnabled` left default. `AppLayout.tsx:12` already
uses `env(safe-area-inset-*)`, which is what Capacitor 8's edge-to-edge mode expects — but
verify the top inset against the real status bar on device; the CRT scanline overlay is
`fixed inset-0` and should cover the full screen including insets (it currently does).

---

## Phase 2 — native polish

This is what separates "app" from "wrapped website", and it's also the defense against
guideline 4.2. Each of these is a small, contained change:

| Plugin | Where | What it buys |
|---|---|---|
| `@capacitor/splash-screen` | config + generated assets | Branded launch, no white flash |
| `@capacitor/status-bar` | `AppLayout` | Dark status bar over felt-950 |
| `@capacitor/haptics` | `Stepper.tsx`, `ScoreRow.tsx` | Tick on each stroke; heavier thump when a hole decides (skin won, press triggered) |
| `@capacitor/keep-awake` | `ScoringScreen.tsx` | **Screen stays on during a live round.** The single most useful one on-course — currently the phone sleeps between holes |
| `@capacitor/camera` | `ScanButton.tsx` | Native multi-shot picker for scorecard scan, replacing the `<input type=file>` workaround documented at `ScanButton.tsx:47` |
| `@capacitor/share` | `settle/shareImage.ts` | Native share sheet for the round summary PNG → iMessage to the group. **Already built web-first** (MAI-35): `shareImage.ts` is the only file touching `navigator.share`, so this is a one-file swap. The image itself is canvas-painted, not a DOM capture, so nothing about it depends on the web runtime |
| `@capacitor/app` | `AppLayout` | Android hardware back → router back; `appStateChange` resume → `syncNow` (more reliable than `visibilitychange`) |

`@capacitor/assets` generates every icon and splash size from one 1024×1024 source — you'll
need to render one at that size (existing art tops out at 512).

Camera needs `NSCameraUsageDescription` + `NSPhotoLibraryUsageDescription` in `Info.plist`,
with copy that names the actual purpose ("to read a scorecard's par and stroke index").
Vague strings are a rejection reason.

---

## Phase 3 — store compliance (the part that actually bites)

These are not optional, and they're where a first submission usually fails.

### 3.1 In-app account deletion — **mandatory**

Guideline 5.1.1(v): any app that creates accounts must let users delete them **in the app**.
You have `signUpWithPassword` (`AuthProvider.tsx:92`), so this applies. There is currently
no account UI at all, let alone deletion.

- New Edge Function `supabase/functions/delete-account` (service-role key): delete
  `round_archives` + `players` rows for the uid, then `auth.admin.deleteUser`.
- New `/account` route (or a section on Home): shows the signed-in email, sign-out, and a
  confirm-guarded **Delete account**. On success, wipe the local Dexie DB and drop to guest.
- Note this sits outside the append-only event invariant by design — same carve-out
  `CLAUDE.md` already documents for whole-round deletion.

### 3.2 Auth already avoids email links — keep it that way

**No change needed.** Confirmation is off (`supabase/config.toml`: `enable_confirmations =
false`), so `signUp` returns a session immediately and sends no email. There's no
password-reset flow either — nothing on `AuthValue` sends mail. Nothing generates a link, so
nothing breaks natively. Email confirmation is not an App Store requirement.

The `needsConfirmation` branch in `AuthProvider.tsx` and the "Check your email" state in
`AuthSheet.tsx` are dead code today. Harmless, and correct if confirmations are ever enabled.

**The constraint to remember:** a link cannot return a session to `capacitor://localhost`.
So if email confirmation, password reset, or email change is ever added, use a 6-digit code
(`{{ .Token }}` in the template + `verifyOtp`) rather than a link. That's cheaper than
Associated Domains + `apple-app-site-association`, and behaves identically on web and native.

Worth noting separately: the app has **no password recovery at all** right now. That's a real
product gap, but it's independent of native packaging — don't let the store work be the
reason it gets addressed.

### 3.3 Keep Google sign-in off for v1

Guideline 4.8: ship a third-party social login and you must also offer **Sign in with
Apple**. `VITE_GOOGLE_AUTH` is already off (`.env`), and the memory note about Google OAuth
not returning a session to an installed iOS PWA points the same direction. Ship email +
guest. If Google comes back later, budget SiWA alongside it (including the REST token-revoke
call on account deletion).

### 3.4 Privacy paperwork

- **Privacy policy URL** and **support URL** are required listing fields. Add `/privacy` and
  `/support` pages to the web app — golf.mainspring.fyi already exists to host them.
- **App Privacy nutrition label**: email (account management), no tracking, no third-party
  ads. Note the Anthropic vision call in `extract-scorecard` — user-submitted photos leave
  the device; disclose it.
- **`PrivacyInfo.xcprivacy`** (required privacy manifest): declare UserDefaults access
  (reason `CA92.1`) and any file-timestamp APIs. Capacitor core ships its own; you add the
  app-level one.

### 3.5 Known review risk: the gambling question

The app tallies **money games**. It processes no payments and settles nothing — it's a
scorekeeper for bets between friends, in the same category as 18Birdies and Golf GameBook,
which both ship skins and nassau on the App Store. Expect a possible question anyway.
Prepare a reviewer note up front: no real-money transactions, no payment processing, no
house, amounts are user-entered tallies. Age rating will likely land at 17+ if you declare
"Contests" — check the questionnaire honestly rather than optimistically; a wrong rating is
a re-submission.

### 3.6 ODbL attribution

Store distribution is distribution. The OpenGolfAPI attribution currently lives in the
README — surface it in-app (an About section on the account/settings screen).

---

## Phase 4 — the test loop, without TestFlight ceremony

You asked to avoid TestFlight. Worth separating two things that get conflated:

- **Internal TestFlight testing has no review gate.** Up to 100 people with an App Store
  Connect role get every build minutes after upload — no Beta App Review, no waiting. It's
  **external** testing (public links, up to 10,000) that requires review on the first build
  of each version. For a handful of golf buddies, internal TestFlight *is* the frictionless
  path, and once your Apple account clears it's one `npx cap build ios` + upload.
- **For your own device, you don't need TestFlight at all:**

```sh
npx cap run ios --target <your-iphone>     # builds straight to the phone over USB/wifi
```

With the paid account that install lasts a year (a free Apple ID re-signs every 7 days).

**Fastest inner loop — live reload on device.** The CLI supports this directly, so no config
hack is needed (and nothing that could accidentally ship):

```sh
pnpm dev --host                                    # vite on the LAN
npx cap run ios --target <your-iphone> -l --host 192.168.x.x
```

JS/CSS edits now hot-reload on the physical phone with no rebuild. See
[§ Internal test loop](#internal-test-loop-day-to-day) for what this mode does and does not
exercise — it has one sharp edge around IndexedDB.

**Android**, when you get there, is trivial: `npx cap run android`, or hand someone the APK
directly. No signing ceremony, no review.

**OTA (Capgo, ~$12–25/mo)** stays available if the rebuild loop annoys you later — it pushes
JS-only bundles to installed builds. Deferred per your call. Note Ionic's Appflow is winding
down (service ends 2027), so Capgo is the mature independent option if you revisit this.

---

## Internal test loop (day-to-day)

<a id="internal-test-loop-day-to-day"></a>

How *you* verify a feature before pushing. Capacitor adds two tiers on top of the existing
loop; it doesn't change anything below them.

**Tier 0 — `pnpm test`.** Unchanged and still the primary gate. Mock `@capacitor/core` in the
`app` project to cover the `isNative` branches.

**Tier 1 — `pnpm dev` in a browser.** Unchanged, and still ~90% of feature work. Engine
changes, new screens, scoring flows never need a native shell. The deployed PWA stays the
zero-build way to pull the app up on any phone.

**Tier 2 — iOS Simulator.** `npx cap run ios --list` then `--target <sim-id>`. Free, no
signing, boots in seconds. Catches WKWebView-only behavior: safe-area insets against a real
notch, overscroll, `min-h-dvh` under the status bar. No camera, silent haptics, meaningless
performance.

**Tier 3 — real device, live reload.** The daily driver for native work (command above).
Test haptics, keep-awake, camera, share sheet, and one-handed feel on course. Debug with
Safari → Develop → \<your iPhone\> for a full Web Inspector (console, network, IndexedDB);
enable Settings → Safari → Advanced → Web Inspector on the phone first. Only debug builds
are inspectable. Native-side errors go to the Xcode console.

> **Trap:** in live-reload mode the webview origin is `http://192.168.x.x:5173`, not
> `capacitor://localhost`. IndexedDB is origin-scoped, so **live reload sees a separate,
> empty database.** Rounds created here don't exist in the real app, and you cannot test
> against real on-device data. Anything touching Dexie schema or migrations must go to Tier 4.

**Tier 4 — real build on device.** The pre-push gate:
`pnpm build:native && npx cap sync ios && npx cap run ios --target <your-iphone>`.
Only this tier exercises the `CAP_BUILD=1` vite branch (dropped `VitePWA` + the
`virtual:pwa-register/react` alias — otherwise unexercised between releases and prone to
rot), cold start from bundled assets, asset paths under the custom scheme, the production
bundle, **Dexie upgrades against real data** (install the current release, use it, install the
branch on top, confirm history survives), and a full offline round in airplane mode.

`npx cap sync` is needed after adding a plugin or editing `capacitor.config.ts`, icons, or
`Info.plist` — never for pure JS/CSS. Xcode is only for signing setup, plist edits, and native
logs.

| Change | Stop at |
|---|---|
| Engine, game rules, scoring math | Tier 0 + 1 |
| New screen, layout, styling | Tier 1, spot-check Tier 2 |
| Anything using a Capacitor plugin | Tier 3 |
| Dexie schema / migration | **Tier 4, mandatory** |
| Auth, sync, outbox | Tier 3 + offline pass at Tier 4 |
| Release | Tier 4 + full offline round |

Add `pnpm build:native` to CI next to the web build, so a broken native config branch fails a
PR rather than surfacing on submission day.

---

## Phase 5 — submission

- Screenshots at Apple's required sizes (6.9" and 6.5" iPhone at minimum). The retro pixel
  aesthetic will photograph well — lead with a live scoring screen and a settlement.
- Wire `package.json` `version` (currently 0.2.1) → `CFBundleShortVersionString`; keep a
  monotonic build number. `__APP_VERSION__` already flows from package.json into the app, so
  the Diagnostics screen keeps working.
- Commit `ios/` to the repo. Add `npx cap sync` to the build script. CI can keep doing
  web-only builds initially; a macOS runner for native builds is a later optimization.

---

## Phase 6 — Android

Everything above is platform-agnostic except icons and Info.plist. Add the platform, verify
edge-to-edge (Capacitor 8 handles system bar insets automatically), hardware back button,
and ship into closed testing to start the 12-tester / 14-day clock.

---

## Effort

| Phase | Estimate |
|---|---|
| 1 — shell + SW split | half a day |
| 2 — native polish (7 plugins) | 1–2 days |
| 3 — compliance (deletion, privacy pages, manifests) | 1–2 days |
| 4 — device loop | folded into 1 |
| 5 — assets + submission | 1 day, then 1–3 days of review latency |
| 6 — Android | half a day + the 14-day tester clock |

**Suggested order:** Phase 0 today (accounts have lead time) → Phase 1 → get it on your
phone → Phase 2 → Phase 3 → submit. Phase 3 is the one to not leave until the end; account
deletion is a real feature, not paperwork.
