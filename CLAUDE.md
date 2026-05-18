# Barcode — Brand Intelligence Platform

> **For LLM agents (Claude Code, Cursor, etc.):** Read this file first. It's the primary entry point for understanding this codebase.

## What is this?

Barcode is an internal brand intelligence tool for **Barcode** (consumer goods rep group). It triangulates social signals (TikTok, Instagram), Amazon product data, retail scan data (Nielsen/IRI/Circana), and trend signals (Google Trends, Reddit, Exploding Topics) into actionable insights for their sales team — helping them find and pitch emerging brands before competing rep groups.

See `docs/00-architecture.md` for the architecture reference and `docs/01-prd.md` for the full product spec.

## Architecture

This project follows the **Adam/Juan agent pattern** (see `C:\Users\jpiep\projects\agents\adam\CLAUDE.md`) with one major substitution: **Supabase (Postgres) instead of Firebase**, because the data model is heavily time-series.

**Stack:** Next.js 16 (App Router), React 19, TypeScript 5, TailwindCSS 4, shadcn/ui, Supabase (Postgres + Auth), Anthropic Claude SDK, Resend, Playwright, Vercel (host + cron).

**Three modules** (PRD §2):
1. **Brand Card** — on-demand lookup: enter a brand name → instant snapshot of social, Amazon, trends, sentiment
2. **Weekly Scouting Report** — automated per-salesperson email surfacing emerging brands by Momentum Score
3. **Monthly Category Deep Dive** — semi-automated category landscape report (Nielsen upload → AI-narrated landscape with the "Call Now" quadrant)

**Three-panel layout** (same as Adam/Juan):
```
┌─────────────┬──────────────────┬────────────────────┐
│ LeftSidebar │ AgentChat        │ Content Area       │
│ (160px)     │ (420px)          │ (flex-1)           │
└─────────────┴──────────────────┴────────────────────┘
```

The AgentChat is named **"Barry"** (Barcode's agent). Users can ask Barry to look up a brand, draft a pitch email, queue a category report, etc. The agent calls tools that hit the same fetchers/DB the rest of the app uses.

## Data Model (Supabase / Postgres)

See `supabase/migrations/0001_initial_schema.sql` for the canonical schema. Quick reference:

- `brands` — canonical brand list (id, name, tiktok_handle, ig_handle, amazon_brand, shopify_url, primary_category, ...)
- `snapshots` — **time-series** of every metric we capture (brand_id, platform, metric, value, captured_at). This is the trend-line engine.
- `categories` — Barcode's product categories with seed hashtags + subreddits + Amazon category URLs
- `salespeople` — Barcode reps with assigned categories
- `reports` — generated weekly/monthly reports with delivery status
- `nielsen_uploads` — ingested Nielsen/IRI/Circana files (with brand-name → brand_id mappings)
- `brand_card_cache` — cached brand card results (TTL ~6h on read-only fields, refreshed on demand)
- `learnings` — agent memory (matches Adam's `config/adam.learnings`)
- `users` + `users.prios` — user profiles + per-user priorities

**Why Postgres and not Firestore**: The Momentum Score requires aggregations across `snapshots` (e.g., "TikTok follower growth MoM" = `(this_week.value - 4_weeks_ago.value) / 4_weeks_ago.value`). The quadrant analysis requires joining `nielsen_uploads` with `snapshots`. These are SQL-native operations. Firestore would require denormalization and client-side computation.

## Key Files

### Core infrastructure (rarely changes)
- `src/lib/supabase.ts` — Browser client (anon key)
- `src/lib/supabase-admin.ts` — Server client (service role) + `verifyAuthToken(request)`
- `src/lib/env.ts` — Typed env access + validation
- `src/lib/types.ts` — Shared domain types

### Data fetchers (one per source, fail independently)
- `src/lib/fetchers/google-trends.ts` — pytrends equivalent (`google-trends-api`)
- `src/lib/fetchers/amazon.ts` — Playwright-based public page scraper
- `src/lib/fetchers/shopify.ts` — `/collections/all?sort_by=best-selling` scraper
- `src/lib/fetchers/tiktok.ts` — TikTok Developer API + Commercial Content API (needs creds)
- `src/lib/fetchers/instagram.ts` — Meta Business Discovery API (needs creds)
- `src/lib/fetchers/reddit.ts` — `snoowrap` (needs creds)
- `src/lib/fetchers/handle-resolver.ts` — brand name → social handles via Google search + cached in DB

### Intelligence layer
- `src/lib/momentum.ts` — Momentum Score calculation (PRD §5.2 weights)
- `src/lib/sentiment.ts` — Claude API for structured sentiment on comment batches

### Agent (Adam pattern)
- `src/lib/prompts/soul.ts` — Barry's personality
- `src/lib/prompts/system-prompt.ts` — Dynamic prompt builder
- `src/lib/tools/index.ts` — Tool registry + executor + labels
- `src/lib/tools/brand-tools.ts` — Brand lookup, card generation, monitoring queue
- `src/lib/tools/report-tools.ts` — Weekly/monthly report triggers
- `src/lib/tools/learning-tools.ts` — Save/remove/get learnings
- `src/lib/tools/user-tools.ts` — Profile + language
- `src/lib/tools/prio-tools.ts` — Priority management
- `src/app/api/chat/route.ts` — Agentic loop endpoint (SSE)

### Routes
- `src/app/api/brand-card/[name]/route.ts` — Direct brand card lookup
- `src/app/api/cron/weekly-poll/route.ts` — Vercel Cron: weekly data collection
- `src/app/api/cron/weekly-report/route.ts` — Vercel Cron: weekly report send (Mon 7am)
- `src/app/api/nielsen/upload/route.ts` — Nielsen file ingestion

## Build Conventions

Inherited from Adam — read `C:\Users\jpiep\projects\agents\adam\CLAUDE.md` "Build Conventions" for the full list. Highlights:

- **Server-side data access** via `supabase-admin.ts` only. Never service-role key in client code.
- **SSE streaming** for all chat (matches Adam's `/api/chat/route.ts`).
- **Tool labels** in `TOOL_LABELS` ("Looking up brand..." not "lookup_brand").
- **Draft-then-approve** for all external comms (emails, exports).
- **ISO 8601** for all timestamps.
- **kebab-case** files, **PascalCase** components, `@/` path alias.

## Vercel Cron

Weekly polling (Saturday night) and weekly report send (Monday 7am) are configured in `vercel.json`. See PRD §5.3 for the schedule.

## Environment Variables

Copy `.env.example` to `.env.local` and fill in. Three tiers:

**Required to boot the app:**
- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
- `ANTHROPIC_API_KEY`

**Required for full functionality (gated APIs — see PRD §3):**
- `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`, `TIKTOK_COMMERCIAL_API_KEY` (~1–2 wk approval)
- `META_ACCESS_TOKEN`, `META_APP_ID`, `META_APP_SECRET` (~1–2 wk approval)
- `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, `REDDIT_USER_AGENT` (instant)
- `RESEND_API_KEY`, `RESEND_FROM_EMAIL`
- `SMARTSCOUT_API_KEY` (Barcode-provided, requires their Enterprise plan)
- `EXPLODING_TOPICS_API_KEY` (Barcode-provided, requires their Business plan)

**Cron auth:**
- `CRON_SECRET` (random string used to authenticate Vercel Cron calls)

## Build Order

See PRD §8. Current phase: **Phase 0 — Foundation** (this scaffold).

Roadmap:
- **Phase 0** ✅ Repo + schema + env + Supabase client + types
- **Phase 1** Brand Card MVP (no-auth fetchers: trends, amazon, shopify; handle resolver; `/brand-card` page)
- **Phase 2** Sentiment layer (Claude integration + Reddit comments)
- **Phase 3** Discovery engine (TikTok hashtag crawler + Amazon top 100 + Momentum Score)
- **Phase 4** Weekly Report v1 (cron + email template + per-rep delivery)
- **Phase 5** Nielsen ingestion + quadrant analysis
- **Phase 6** Monthly Deep Dive v1 (PDF/email output)
- **Phase 7** Expansion (Shopify, Exploding Topics, Grok/X, SmartScout if upgraded)
- **Phase A** Agent chat layer (Barry) — can layer in any time after Phase 1

## Commands

```bash
npm run dev          # Start development server (Next.js)
npm run build        # Production build
npm run lint         # ESLint
npm run db:push      # Push migrations to Supabase (uses supabase CLI)
npm run db:types     # Generate TS types from Supabase schema
npx tsx scripts/seed.ts  # Seed example brands & categories
```
