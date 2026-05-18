# Barcode Brand Intelligence Platform

Internal tool for the **Barcode** consumer-goods rep group. Triangulates social signals (TikTok, Instagram, Reddit), Amazon product data, retail scan data (Nielsen/IRI/Circana), and trend signals (Google Trends, Exploding Topics) into actionable intelligence — helping their sales team discover emerging brands before competing rep groups.

→ See [`CLAUDE.md`](./CLAUDE.md) for the architecture overview (start here if you're an LLM agent).
→ See [`docs/01-prd.md`](./docs/01-prd.md) for the full product spec.
→ See [`docs/00-architecture.md`](./docs/00-architecture.md) for the technical reference.

## Stack

Next.js 16 (App Router) · React 19 · TypeScript 5 · TailwindCSS 4 · shadcn/ui · Supabase (Postgres + Auth) · Anthropic Claude SDK · Playwright · Resend · Vercel (host + cron).

## Prerequisites

- **Node.js 20+** and npm
- A **Supabase project** ([create one free](https://supabase.com/dashboard))
- An **Anthropic API key** ([console.anthropic.com](https://console.anthropic.com))
- (For full functionality) developer accounts for TikTok, Meta, Reddit, Resend — see [`.env.example`](./.env.example) for the full list and `docs/01-prd.md` §9 for the application process

## Local setup

### 1. Install dependencies

```bash
npm install
npx playwright install chromium
```

The Playwright step downloads the headless Chromium binary used by the Amazon scraper. It's ~150MB and takes a minute the first time.

### 2. Configure environment

```bash
cp .env.example .env.local
```

Fill in at minimum:
- `NEXT_PUBLIC_SUPABASE_URL` — from Supabase dashboard → Settings → API
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` — same place
- `SUPABASE_SERVICE_ROLE_KEY` — same place (keep secret; never commit)
- `ANTHROPIC_API_KEY` — from [console.anthropic.com](https://console.anthropic.com)
- `CRON_SECRET` — any random string (e.g. `openssl rand -hex 32`)

All other vars are optional; their respective features degrade gracefully when unset (the fetcher returns `{status: "not_configured"}` instead of failing the request).

### 3. Run the database migration

Two options depending on whether you want to use the Supabase CLI:

**Option A — paste into the dashboard (easiest first time):**
1. Open your Supabase project → SQL Editor → New query
2. Paste the contents of `supabase/migrations/0001_initial_schema.sql`
3. Run

**Option B — use the Supabase CLI:**
```bash
# One-time: link your local project to the remote
npx supabase link --project-ref <your-project-ref>

# Rename the migration to a CLI-compatible timestamp format (one-time):
mv supabase/migrations/0001_initial_schema.sql \
   supabase/migrations/20260517000000_initial_schema.sql

# Push
npm run db:push
```

After the migration, regenerate the typed Supabase client:

```bash
npm run db:types
```

This writes `src/lib/database.types.ts` with strict Row/Insert/Update types per table.

### 4. Start the dev server

```bash
npm run dev
```

Visit [http://localhost:3000](http://localhost:3000).

## Scripts

```bash
npm run dev       # Next.js dev server
npm run build     # Production build
npm run lint      # ESLint
npm run db:push   # Push pending migrations to Supabase
npm run db:types  # Regenerate TypeScript types from the live schema
npx tsx scripts/seed.ts   # Seed example brands + categories (Phase 1)
```

## Feature gating

Most external data sources require API credentials with various approval timelines. The app is built to fail gracefully when any one is missing:

| Source | Approval | Without it |
|---|---|---|
| Anthropic | 2 min | App won't boot |
| Supabase | 5 min | App won't boot |
| Google Trends (`pytrends` port) | none | Works immediately |
| Amazon (Playwright scraper) | none | Works immediately (subject to bot detection) |
| Shopify (public JSON) | none | Works immediately |
| TikTok Developer API | 1–2 wk | TikTok fields in Brand Card show "not configured" |
| TikTok Commercial Content API | ~2 days | TikTok ad signals show "not configured" |
| Meta Business Discovery | 1–2 wk | Instagram fields show "not configured" |
| Reddit (`snoowrap`) | instant | Reddit signals show "not configured" |
| Resend | 5 min | Weekly reports can't be emailed (still generated + stored in DB) |
| SmartScout (Enterprise) | from Barcode | Falls back to Amazon scraper |
| Exploding Topics (Business) | from Barcode | That signal is skipped in scouting reports |

Apply for the long-lead-time ones (TikTok, Meta) **as soon as possible** — they gate the most valuable signals.

## Project layout

See [`docs/00-architecture.md`](./docs/00-architecture.md) for the full file map. Quick summary:

```
src/
├── app/
│   ├── (views)/              Three-panel UI views (dashboard, brand-card, ...)
│   └── api/
│       ├── chat/             Agent (Barry) — SSE agentic loop
│       ├── brand-card/       On-demand Brand Card endpoint
│       ├── nielsen/upload/   Nielsen file ingestion
│       └── cron/             Vercel Cron handlers
├── components/               UI (AgentChat, LeftSidebar, BrandCard, ...)
├── contexts/                 Auth + chat React contexts
└── lib/
    ├── fetchers/             One module per data source (fail independently)
    ├── tools/                Agent tool registry + executors
    ├── prompts/              Soul + system prompt builder
    ├── supabase.ts           Browser client
    ├── supabase-admin.ts     Server client + auth verification
    ├── env.ts                Typed env access + feature flags
    └── types.ts              Domain types
```

## Engagement model

$1,000/month retainer to Barcode. First month free post-launch. Covers hosting, API costs, maintenance, ongoing development. See PRD §11.
