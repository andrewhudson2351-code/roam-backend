# CLAUDE.md — Roam Backend

Orientation guide for future sessions (human or AI). Roam is a nightlife app: venues, busy scores, crowd reports, stories, deals, friends/location sharing, and paid venue plans.

## Tech stack

- **Runtime:** Node.js + Express 4 (CommonJS). Entry point `src/index.js`; `npm start` / `npm run dev` (nodemon). No build step, no tests, no linter.
- **Database:** Supabase Postgres, project **"roam"** (`prtrrqfxrutnogbzqtye`, us-west-2). A second inactive Supabase project exists — ignore it. Accessed exclusively through `@supabase/supabase-js` with the **service-role key** (bypasses RLS). No direct `pg` connection.
- **Auth:** Custom JWT (`jsonwebtoken`, 30-day expiry, signed with `JWT_SECRET`), passwords hashed with bcryptjs (cost 12) in a `users` table. **Not** Supabase Auth.
- **Payments:** Stripe subscriptions for venue plans (`free` / `pro` / `premium`), webhook-driven sync.
- **Email:** Resend API (password reset). Falls back to logging the reset link if `RESEND_API_KEY` is unset.
- **Jobs:** `node-cron` inside the web process — `refresh_busy_scores` every 15 min (`src/jobs/refreshBusyScores.js`).
- **Frontend:** separate repo at `C:\Users\andre\roam-frontend` (Vite/React, `src/App.jsx` is the bulk of it). Maps are **Mapbox** (react-map-gl v8) — Google Maps was removed after the HeatmapLayer deprecation caused an outage. Never suggest Google Maps APIs.

## Layout

```
src/
  index.js          Express app, CORS, rate limiting, route mounting, cron
  config/
    supabase.js     Shared Supabase client + syncSubscription/downgradeToFree
    stripe.js       Stripe client, webhook secret, price IDs
  middleware/auth.js JWT Bearer verification → req.user {id, email, username}
  routes/           auth, venues, stories, deals, friends, dashboard, stripe, webhooks
database/           empty — schema lives only in Supabase (use MCP list_tables)
```

## Key architectural decisions (July 2026)

1. **Single Supabase client** (commit `bbf82b2`): everything imports from `src/config/supabase.js`, which uses `SUPABASE_SERVICE_ROLE_KEY` and throws at startup if unset. The old `src/supabase.js` (which used `SUPABASE_SERVICE_KEY`) was deleted. Do not recreate per-file clients.
2. **RLS: deny-all on all 17 public tables** (migration `enable_rls_deny_all`, 2026-07-03): RLS enabled with **zero policies**, so the anon/authenticated keys see nothing — this is intentional (App Store security requirement; `password_hash` was previously exposed via PostgREST). The backend is unaffected (service role bypasses RLS). Consequences:
   - Any future frontend-direct Supabase access requires writing policies first.
   - **Every new table must get `ENABLE ROW LEVEL SECURITY` at creation.**
   - `venue_subscription_status` view is `security_invoker = true`.
3. **Rate limiting** (commit `816b95e`): global 500 req/15 min per IP (`src/index.js`), plus 10/15 min **per user** on crowd reports (`src/routes/venues.js`, keyed on `req.user.id`) and 5/15 min per IP on forgot-password. `trust proxy` is set to `1` for Railway.
4. **Server-side authorization is the only enforcement layer**: friends-only story visibility (`27f649f`), location staleness/privacy wipe (`6aa6201`), account deletion cancelling Stripe subs (`722191b`) are all enforced in Express routes — the client is never trusted.
5. **`venues.plan` is canonical, `venues.tier` is dead.** The table has both columns (same constraint, default `'free'`); code was standardized on `plan` after silent billing write failures. The `subscriptions` table legitimately uses `tier`. Always verify column names against the live schema (Supabase MCP `list_tables`) before writing inserts/updates — this project has a history of code referencing columns that don't exist.
6. **Stripe webhook mounted before `express.json`** with `express.raw` so signature verification works. Keep it that way.

## Schema gotchas

- `venues.category` check constraint: only `'Bar' | 'Club' | 'Venue' | 'Restaurant' | 'Event'`.
- `venue_analytics` is a daily rollup (date, visitor_count, deal_redemptions, story_count, profile_views) — no busy_score. Time-series scores live in `busy_score_history` (FK ON DELETE CASCADE).
- `venue_claims.venue_id` is unique by itself — upserts must use `onConflict: 'venue_id'`.
- FKs to venues are mostly CASCADE; `friend_locations` is ON DELETE SET NULL.

## Known open issues (from the July 2026 audit — not yet fixed)

- **CORS is `origin: "*"`** (`src/index.js:21`) — should be locked to the real frontend origins before launch.
- **No security headers** — helmet (or equivalent) is not installed.
- **Rate limiters use the default in-memory store** — counters reset on every deploy/restart and aren't shared if Railway ever runs multiple instances.
- **JWTs live 30 days with no revocation** — logout/password-change does not invalidate existing tokens (password reset does not kill old sessions).
- **No input validation layer** — no email-format check on register, no schema validation anywhere; routes destructure `req.body` directly. `express.json` body limit is a generous 10 MB.
- **`venues.tier` dead column** still exists in the schema; safe to drop eventually, after confirming nothing reads it.
- **No tests, empty README** — verification is manual (hit endpoints against the live API).
- Cron runs in-process: multiple Railway instances would double-run `refresh_busy_scores`.

## Environment variables

Required (startup throws or features break without them):

| Variable | Used in |
|---|---|
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | `src/config/supabase.js` (throws if unset) |
| `JWT_SECRET` | auth middleware + token signing |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Stripe client + webhook verification |
| `STRIPE_PRICE_PRO`, `STRIPE_PRICE_PREMIUM` | checkout + webhook tier mapping |
| `STRIPE_SUCCESS_URL`, `STRIPE_CANCEL_URL`, `FRONTEND_URL` | checkout redirects |
| `RESEND_API_KEY` | password-reset email (optional — logs link if unset) |
| `APP_BASE_URL` | reset-link base (defaults to `https://app.roaman.app`) |
| `PORT` | defaults to 3000 |

Frontend needs `VITE_MAPBOX_TOKEN` (Vercel dashboard + local `.env` in roam-frontend).

`.env` is gitignored; there is no `.env.example` — this table is the source of truth.

## Deployment

- **Backend:** Railway, deploys from `main` of `github.com/andrewhudson2351-code/roam-backend` via `npm start`. No railway.json/Procfile — default Node detection. Env vars live in the Railway dashboard.
- **Frontend:** Vercel, deploys from the roam-frontend repo.
- **Mobile:** Codemagic builds the mobile wrapper from the frontend repo.
- Pushing to `main` on either repo triggers a deploy — there is no staging environment.

## Working conventions

- **Never `git add -A` or `git add .`** in the roam repos — stage files by name and check `git status` first.
- Verify Supabase schema via MCP (`list_tables`) before writing queries; don't trust column names in older code or docs.
