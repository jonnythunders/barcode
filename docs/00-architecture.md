# Barcode Architecture Reference

> Companion to the PRD (`01-prd.md`). This doc explains *how* the platform is built; the PRD explains *what* it does. Read both before making structural changes.

## Stack at a glance

| Layer | Choice | Why |
|---|---|---|
| Frontend / Backend | Next.js 16 (App Router), React 19, TypeScript 5 | Matches Adam/Juan; we know the pattern |
| UI | TailwindCSS 4 + shadcn/ui + Geist + lucide | Same as Adam — components compose cleanly |
| Database | **Supabase (Postgres)** | Time-series + aggregations are SQL-native. Different from Juan/Adam (Firebase). |
| Auth | Supabase Auth (email + magic link) | Tightly coupled to the DB; one less integration |
| AI | Anthropic Claude SDK | Same agentic loop as Adam; powers sentiment + the agent |
| Email | Resend | Same as Adam |
| Scraping | Playwright (Node) | Headless Chromium for Amazon, TikTok hashtag pages, etc. |
| Hosting | Vercel | Same as Adam; native Cron + edge functions when needed |
| Cron | Vercel Cron (`vercel.json`) | No separate scheduler infra |

## Why Supabase, not Firebase

We diverge from Juan/Adam here. The PRD's central data structure is a **weekly time-series of metrics per brand** (followers, engagement, BSR rank, review counts, sentiment scores). Two read patterns drive everything:

1. **Trend computation**: "What is brand X's TikTok follower growth MoM?" — needs window functions / lag(), grouped by month.
2. **Quadrant analysis**: "Show me brands appearing in social/Amazon with strong momentum but absent from this Nielsen upload" — needs left-joins between snapshots, brands, and nielsen_rows.

Both are trivial in Postgres and painful in Firestore. We also already use Supabase elsewhere, and the user prefers it for this workload.

What we lose by leaving Firebase:
- The real-time subscriptions Juan uses for the chat UI — Supabase has Realtime channels which cover the same need, just with different ergonomics.
- The custom-claims-based multi-tenancy from Juan — irrelevant here, this is single-tenant.

## Three modules (matches PRD §2)

```
                ┌──────────────────┐
                │   Data sources   │
                └──────────────────┘
TikTok  Instagram  Amazon  GTrends  Reddit  Shopify  Exploding  SmartScout  Nielsen
   │       │        │       │       │        │         │           │        │
   └───────┴────────┴───────┴───────┴────────┴─────────┴───────────┴────────┘
                                │
                          ┌─────▼─────┐
                          │ fetchers/ │  one module per source — fail independently
                          └─────┬─────┘
                                │
                  ┌─────────────┴─────────────┐
                  │      snapshots table       │  append-only time series
                  └─────────────┬──────────────┘
                                │
   ┌───────────────────────┬────┴───────────────────┬───────────────────────┐
   ▼                       ▼                        ▼                       ▼
Module 1: Brand Card  Module 2: Weekly       Module 3: Monthly         Agent (Barry)
 (on-demand lookup)    Scouting Report          Deep Dive              chat layer
                                                                       calls tools
                                                                       that read all
                                                                       of the above
```

## File layout

```
barcode/
├── src/
│   ├── app/
│   │   ├── layout.tsx              # Root layout (Geist fonts)
│   │   ├── page.tsx                # Landing → redirects to /dashboard once auth is in
│   │   ├── globals.css             # Tailwind + design tokens
│   │   ├── login/page.tsx          # Supabase magic-link login (Phase A)
│   │   ├── (views)/
│   │   │   ├── layout.tsx          # Three-panel layout (LeftSidebar | AgentChat | content)
│   │   │   ├── dashboard/page.tsx
│   │   │   ├── brand-card/page.tsx       # Lookup form
│   │   │   ├── brand-card/[slug]/page.tsx  # Rendered Brand Card
│   │   │   ├── discovery/page.tsx        # Discovery feed (new brands found by crawler)
│   │   │   ├── reports/page.tsx          # Weekly/monthly reports archive
│   │   │   └── categories/page.tsx       # Category admin (seed hashtags etc.)
│   │   └── api/
│   │       ├── chat/route.ts             # Agentic loop (SSE) — Adam pattern
│   │       ├── brand-card/[name]/route.ts  # On-demand Brand Card JSON
│   │       ├── nielsen/upload/route.ts   # Nielsen file ingestion
│   │       ├── cron/
│   │       │   ├── weekly-poll/route.ts  # Saturday night: poll all monitored brands
│   │       │   ├── weekly-report/route.ts # Monday 7am: send per-rep reports
│   │       │   └── monthly-deepdive/route.ts
│   │       └── email/send/route.ts       # Resend wrapper
│   ├── components/
│   │   ├── AgentChat.tsx                 # Adam-style chat panel (rename: "Barry")
│   │   ├── LeftSidebar.tsx
│   │   ├── ProtectedRoute.tsx
│   │   ├── BrandCard.tsx                 # Renders BrandCard JSON
│   │   ├── MomentumBadge.tsx
│   │   └── ui/                           # shadcn primitives
│   ├── contexts/
│   │   ├── auth-context.tsx              # Supabase Auth state
│   │   └── chat-context.tsx              # Chat SSE parsing (carry from Adam)
│   ├── lib/
│   │   ├── supabase.ts                   # Browser client
│   │   ├── supabase-admin.ts             # Server client + verifyAuthToken
│   │   ├── env.ts                        # Typed env access + feature flags
│   │   ├── types.ts                      # Domain types
│   │   ├── utils.ts                      # cn(), slugify(), formatters
│   │   ├── database.types.ts             # Generated (npm run db:types)
│   │   ├── fetchers/
│   │   │   ├── google-trends.ts
│   │   │   ├── amazon.ts
│   │   │   ├── shopify.ts
│   │   │   ├── tiktok.ts
│   │   │   ├── instagram.ts
│   │   │   ├── reddit.ts
│   │   │   ├── exploding-topics.ts
│   │   │   ├── smartscout.ts
│   │   │   └── handle-resolver.ts
│   │   ├── momentum.ts                   # Momentum Score computation
│   │   ├── sentiment.ts                  # Claude-based sentiment
│   │   ├── nielsen-ingest.ts             # File parser
│   │   ├── prompts/
│   │   │   ├── soul.ts                   # Barry's personality
│   │   │   └── system-prompt.ts
│   │   └── tools/
│   │       ├── index.ts                  # Tool registry + executor
│   │       ├── brand-tools.ts
│   │       ├── report-tools.ts
│   │       ├── learning-tools.ts
│   │       ├── user-tools.ts
│   │       └── prio-tools.ts
│   └── types/
│       └── speech.d.ts                   # carry from Adam if we add voice input
├── supabase/
│   └── migrations/
│       └── 0001_initial_schema.sql
├── scripts/
│   ├── seed.ts                           # Seed Barcode's known brands + categories
│   └── poll-once.ts                      # Manual one-shot of the weekly poll
├── docs/
│   ├── 00-architecture.md                # this file
│   └── 01-prd.md                         # The PRD
├── CLAUDE.md
├── README.md
├── package.json
├── tsconfig.json
├── next.config.ts
├── postcss.config.mjs
├── eslint.config.mjs
├── components.json
├── vercel.json
├── .env.example
└── .gitignore
```

## Data flow — Brand Card (Module 1)

1. User enters brand name (or agent calls `lookup_brand` tool).
2. `/api/brand-card/[name]` is hit (or tool execution runs `getBrandCard(name)`).
3. We check `brand_card_cache` for a fresh entry (≤ 6h old). If found, return immediately.
4. Otherwise:
   a. Resolve brand name → handles via `handle-resolver.ts` (checks `brands` table first, then `handle_resolutions` cache, then runs Google search strategies).
   b. Fan out to every configured fetcher in parallel: `tiktok.ts`, `instagram.ts`, `amazon.ts`, `google-trends.ts`, `reddit.ts`, `sentiment.ts`.
   c. Each fetcher writes its result to `snapshots` (so the trend line builds over time) AND returns its slice of the Brand Card.
   d. `momentum.ts` reads recent snapshots and computes the Momentum Score.
   e. Claude generates the 2–3 sentence narrative.
   f. Assemble the full `BrandCard` object, write it to `brand_card_cache`, return.

Failures in any fetcher are isolated — the Brand Card returns `partial: true` with per-platform error messages, and the rest of the fields render normally.

## Data flow — Weekly Scouting Report (Module 2)

**Saturday night (Vercel Cron @ 23:00 UTC)**: `/api/cron/weekly-poll`
1. Pull all `brands WHERE is_monitored = true AND is_archived = false`.
2. For each, run all configured fetchers and append to `snapshots`.
3. Run the discovery engine: TikTok hashtag crawler, Amazon top-100 scrape — write any new brands found to `brands` with `discovery_source` set.
4. Compute Momentum Scores into a derived `snapshots` row per brand.

**Monday 7am local (Vercel Cron @ 12:00 UTC, adjust per timezone)**: `/api/cron/weekly-report`
1. For each active `salesperson`, gather top brands by Momentum Score in their assigned categories.
2. Render the email via the report template.
3. Send via Resend. Record in `reports`.

## Data flow — Monthly Deep Dive (Module 3)

1. User uploads Nielsen/IRI/Circana file via `/api/nielsen/upload`.
2. `nielsen-ingest.ts` auto-detects column mapping, parses rows into `nielsen_rows`, attempts to map `brand_name_raw` → `brand_id` against known brands.
3. Triggered manually (or via `/api/cron/monthly-deepdive`):
   - Pull latest snapshots per brand
   - Compute social momentum vs retail velocity → quadrant assignment
   - Claude narrates the "Call Now" quadrant
   - Render report → `reports` row + downloadable PDF

## The agent (Barry) — Adam pattern, lightly adapted

`src/app/api/chat/route.ts` is functionally identical to Adam's chat route. The agentic loop runs up to 25 iterations, streams SSE, executes tools server-side. The only differences:

- `verifyAuthToken` uses Supabase Auth instead of Firebase Auth
- `learnings` are read from `learnings` table instead of `config/adam`
- `prios` are read from `prios` table
- Tools are domain-specific (brand-tools, report-tools instead of contact-tools)

Tools in scope for V1:
- `lookup_brand(name)` — runs the Brand Card pipeline
- `search_brands(query, category?, min_momentum?)` — DB search
- `get_brand_history(brand_id, platform, metric, days)` — trend over time
- `queue_weekly_report(salesperson_id)` — manually trigger a report
- `compare_brands(brand_ids[])` — side-by-side momentum + signals
- `draft_email(to, subject, body)` — Adam-style draft/approve
- `save_learning`, `remove_learning`, `get_learnings` — Adam universal
- `get_prios`, `create_prio`, `update_prio_status` — Adam universal

## Conventions (carry from Adam)

- **Server-side data access** only — service-role Supabase client in tool files and API routes
- **SSE streaming** for chat (text deltas, tool_start, tool_result, tool_error, done)
- **TOOL_LABELS** for every tool ("Looking up brand..." not "lookup_brand")
- **ISO 8601** timestamps everywhere via `nowIso()` helper
- **Draft-then-approve** for external comms (email exports)
- **kebab-case** files, **PascalCase** components, `@/` path alias
