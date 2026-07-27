# MacroLeague

**A campus-first, socially competitive nutrition tracker.** Log what you eat, score your day against your own goals, climb a league table with people you actually know, and turn consistency into rewards you can redeem in the real world.

Built with Expo (iOS, Android, web) on a Supabase backend where the database — not the client — owns every number that matters.

---

## The problem

Nutrition tracking has a retention problem, not a data problem.

The category is full of apps that can tell you the macros in a chicken breast. What they can't do is make an 19-year-old open the app on day 12. The standard loop — log food, see a number, feel vaguely judged, close app — is solitary, joyless, and asks for effort every single day while paying out nothing until some distant, abstract body-composition goal. Most users churn within two weeks.

College students are the sharpest version of this. They are:

- eating most meals in a dining hall, from a rotating menu they didn't choose
- surrounded by peers whose habits directly influence their own
- highly responsive to status, rank, streaks, and group identity
- and largely unserved by tools designed for gym-bro macro precision or clinical weight management

There's a second, subtler problem: **most gamified health apps reward the wrong thing.** If you pay out points for every logged meal, you have built an app that rewards *logging*, not *eating well*. Users optimize for the metric. The incentive design is the product, and getting it wrong quietly makes the app useless at the thing it claims to do.

## The solution

MacroLeague turns nutrition into a **league** — a bounded, social, competitive season with a scoreboard and a payout.

The core loop:

```
log a meal → improve your daily nutrition score → earn XP + League Points
   → climb the leaderboard / win your challenge → redeem real rewards
```

Four design commitments make that loop work:

**1. Social density over raw scale.** The leaderboard is scoped to your university and your friends, not a global anonymous ranking. A leaderboard is only motivating when you recognize the names on it. The app is built around university identity and dining halls from the ground up — [`src/data/universityDining.ts`](src/data/universityDining.ts) ships verified residential dining halls for seven New Jersey schools, with Rutgers as the anchor launch campus.

**2. Bounded, health-aligned rewards.** Points accrue for consistency (streaks, hitting protein, balanced days, challenge completion) with hard caps on volume-based earning, so grinding meal logs is not a viable strategy. The economy is enforced in Postgres — daily meal-log windows and volume caps live in migration `0027`, and the anti-forfeit-bypass and late-join scoring bounds in `0028`. You cannot cheat the leaderboard from the client, because the client never submits a score.

**3. Rewards that are actually worth winning.** League Points redeem against a partner catalog — a discounted bowl, a free smoothie, coffee. Redemption issues a **server-generated 12-character code** ([`src/lib/rewardPass.ts`](src/lib/rewardPass.ts), migration `0022`) using an alphabet that omits `I` and `O` so a till operator can't misread it as `1` or `0`, displayed in `ABCD-EFGH-JKLM` blocks and validated server-side. This is built for a real cashier at a real counter, not a screenshot.

> **Partnerships:** we are in active conversation with several supermarket chains to extend the rewards catalog beyond campus food partners into grocery. Grocery redemption is the strategically important unlock — it moves the reward from "a free coffee" to "money off the food you were already going to buy," which both raises perceived value and pulls the incentive toward cooking and whole foods rather than campus retail.

**4. Estimates you correct, not answers you accept.** Meal entry is natural language ("grilled chicken breast with broccoli"), resolved against USDA FoodData Central and Open Food Facts, and presented as an **editable draft**. Nothing is ever auto-saved. The user confirms the numbers, and `meal_logs` snapshots them at insert time so re-mapping a food later never rewrites history.

## What the project aims to complete

**Near term — launch readiness.** Ship at one campus (Rutgers), to 3–5 dense micro-communities rather than the whole school: rec-center regulars, club sports teams, Greek houses, dorm friend groups. Activation is measured by *team density*, not raw signups, because the product's value is a function of how many of your friends are in it.

**Mid term:**

- Close the supermarket partnerships and expand the rewards catalog into grocery redemption
- Barcode scanning against Open Food Facts (schema support already exists — migration `0018`)
- Richer dining-hall integration: campus menus as first-class foods so a student picks their meal off the actual menu
- Ingredient-level composite parsing improvements and quantity understanding

**Long term.** Extend the league model past the first campus into a multi-school network, where inter-university competition becomes the retention mechanic that intra-campus rank was at launch.

**Explicitly not the goal:** becoming a general-purpose calorie counter. The product is a competitive social layer that happens to require nutrition data, and that ordering drives every architectural decision.

---

## Architecture

### The governing principle: the database is the source of truth

Every value a user could benefit from lying about — XP, League Points, streaks, challenge standings, reward balances — is computed and stored server-side. The client displays; it does not decide.

```
┌──────────────────────────────────────────────────────────┐
│  Expo app (iOS / Android / web)                          │
│  screens → services/ → lib/supabase → Supabase           │
│  Zustand for session state · pure logic in lib/          │
└────────────────────────┬─────────────────────────────────┘
                         │  user JWT (RLS enforced)
┌────────────────────────▼─────────────────────────────────┐
│  Supabase                                                │
│                                                          │
│  Postgres + RLS ── the authority                         │
│    · gamification_events (append-only trusted ledger)    │
│    · triggers award XP/points on confirmed meal logs     │
│    · RPCs derive standings, leaderboards, feeds          │
│    · 28 versioned migrations, rate limits, economy locks │
│                                                          │
│  Edge Functions (Deno) ── secret-holding perimeter       │
│    · estimate-meal   USDA + Open Food Facts + parser     │
│    · chat            MacroCoach advisor                  │
│    · account-lifecycle / purge-accounts / notifications  │
└────────────────────────┬─────────────────────────────────┘
                         │  server-only keys
              USDA FDC · Open Food Facts · OpenAI · Expo Push
```

### Client

| Layer | Location | Responsibility |
|---|---|---|
| Screens | [`src/screens/`](src/screens/) | Home, MealLogger, Leaderboard, Challenges, Rewards, Coach, Profile, onboarding |
| Services | [`src/services/`](src/services/) | The only code that talks to Supabase. One module per domain. |
| Pure logic | [`src/lib/`](src/lib/) | Scoring, leveling, dates, reward codes, error mapping — no I/O, fully unit-tested |
| UI primitives | [`src/components/ui/`](src/components/ui/) | Themed design-system components behind a barrel export |
| State | [`src/store/userStore.ts`](src/store/userStore.ts) | Zustand; session and profile snapshot only |

The split between `services/` and `lib/` is deliberate and load-bearing: anything worth testing lives in `lib/` as a pure function, so the service layer stays a thin transport shell. Jest runs in a `node` environment where importing the Supabase client would throw on missing env — pure logic sidesteps that entirely.

**Scoring.** [`computeNutritionScore`](src/lib/nutritionScore.ts) averages calorie/protein/carb adherence into 0–100. Overshoot is penalized symmetrically with undershoot (150% of goal scores the same as 50%), so massive overeating never reads as a perfect day. Unset goals are skipped rather than counted as zero, so a partial setup still scores fairly.

**Timezones.** Daily activity buckets by the user's profile timezone ([`src/lib/dates.ts`](src/lib/dates.ts)); challenges are UTC-anchored so every participant's window opens and closes simultaneously. The two conventions are different on purpose.

### Nutrition pipeline

Detailed in [`docs/nutrition-architecture.md`](docs/nutrition-architecture.md).

```
description → estimate-meal (authenticated, rate-limited)
    ├─ cache check (food_search_cache, 7-day TTL)
    ├─ DIRECT: whole-query search against USDA FDC / Open Food Facts
    └─ COMPOSITE (only when OPENAI_API_KEY is set):
         ├─ LLM extracts INGREDIENT STRUCTURE ONLY — never macros
         ├─ per-component source search
         └─ deterministic gram scaling + summing
  ← editable candidates → user confirms → meal_logs (snapshot)
```

The critical constraint: **the language model never produces a nutrition number.** Its strict JSON schema has no nutrition fields, and every response is re-validated server-side. All macros come from USDA or Open Food Facts. The model decomposes "2 eggs and toast" into components; arithmetic is deterministic code. When no key is configured, the composite path simply doesn't exist and the whole-query search is the fallback — clean degradation, not a broken feature.

The client never calls USDA, Open Food Facts, or OpenAI directly, and never reads the cache tables. All external calls and all secrets live in edge functions.

### Security posture

Audited and empirically verified against the live database. Highlights:

- **RLS on every user-scoped table**; cross-user reads go through `SECURITY DEFINER` RPCs that return only whitelisted columns
- **Anon role locked out of RPCs** (`0026`) after an audit found a leaderboard PII exposure
- **Per-user rate limits** on every edge function, with burst and daily windows bounding both abuse and API spend
- **Input bounds before parsing** — body size caps, query length caps, message-count and total-character caps on chat
- **Append-only gamification ledger** — standings are derived by summing trusted events over a window, never written by a client
- **Soft delete + scheduled purge** with deactivated-account freezes so a deleted user can't distort a live challenge
- **Secrets are server-side only.** `EXPO_PUBLIC_*` variables are inlined into the client bundle at build time and are public by definition; USDA, OpenAI, and FatSecret keys are Supabase function secrets and never appear in the app.

### Testing

```bash
npm test          # Jest — pure logic + service layer
npm run test:db   # all 28 migrations against real Postgres via PGlite (no Docker)
npm run typecheck # tsc --noEmit
npm run lint      # eslint
```

The migration harness runs the full migration chain against an actual Postgres instance in-process, so schema changes are verified before they reach the hosted database.

---

## Getting started

```bash
npm install
cp .env.example .env      # fill in Supabase URL + anon key
npm start                 # Expo dev server
```

| Variable | Required | Notes |
|---|---|---|
| `EXPO_PUBLIC_SUPABASE_URL` | yes | Client-visible |
| `EXPO_PUBLIC_SUPABASE_ANON_KEY` | yes | Client-visible; RLS is what protects data |
| `EXPO_PUBLIC_AMPLITUDE_API_KEY` | no | Analytics no-ops when unset |
| `EXPO_PUBLIC_TELEMETRYDECK_APP_ID` | no | Analytics no-ops when unset |

Server-side secrets (`USDA_FDC_API_KEY`, `OPENAI_API_KEY`, `FATSECRET_KEY`) are set with `supabase secrets set` and must never be given an `EXPO_PUBLIC_` prefix.

### Web deployment

```bash
npx expo export --platform web   # → dist/
```

Deployed on Vercel with build command `npx expo export --platform web` and output directory `dist`. See [`docs/deployment.md`](docs/deployment.md).

## Stack

Expo SDK 56 · React Native 0.85 · React 19 · TypeScript · Zustand · React Navigation · Supabase (Postgres + RLS + Deno edge functions) · Sentry · Jest · PGlite
