-- ============================================================================
-- Barcode Brand Intelligence Platform — Initial Schema
-- Migration 0001 — Initial schema
-- ============================================================================
--
-- Design notes:
--   * Single-tenant (Barcode itself). No tenant_id stamping.
--   * `snapshots` is the time-series workhorse. Indexed for (brand_id, metric, captured_at).
--     Every weekly poll writes new rows here; we NEVER overwrite. Trend lines come
--     from window functions over this table.
--   * `brands` is the canonical entity. Handle resolution writes here; everything
--     downstream foreign-keys to brand_id.
--   * `brand_card_cache` stores the latest rendered Brand Card JSON for fast reads.
--     Refreshed on demand or by the weekly poll.
--   * RLS is enabled but permissive for the service-role key. Anon/auth users
--     only see their own user row + report deliveries addressed to them.
--     (Tighten later when we add real user roles.)
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Extensions
-- ---------------------------------------------------------------------------
create extension if not exists "uuid-ossp";
create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- ENUM types
-- ---------------------------------------------------------------------------
create type platform_kind as enum (
  'tiktok',
  'instagram',
  'amazon',
  'google_trends',
  'reddit',
  'shopify',
  'exploding_topics',
  'smartscout',
  'nielsen',
  'derived'  -- composite metrics computed from other platforms (e.g. momentum_score)
);

create type report_kind as enum ('weekly_scouting', 'monthly_deep_dive', 'brand_card_export');
create type report_status as enum ('pending', 'generating', 'sent', 'failed');
create type prio_status as enum ('active', 'completed', 'dismissed');
create type discovery_source as enum (
  'manual',           -- entered by Barcode rep or seeded
  'tiktok_hashtag',
  'amazon_top100',
  'reddit_mention',
  'shopify_bestseller',
  'exploding_topics',
  'nielsen_upload'
);

-- ---------------------------------------------------------------------------
-- Helper: updated_at trigger
-- ---------------------------------------------------------------------------
create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- CATEGORIES — Barcode's product category seeds
--   Drives hashtag crawling, subreddit monitoring, Amazon category scrape.
-- ---------------------------------------------------------------------------
create table categories (
  id              uuid primary key default uuid_generate_v4(),
  slug            text not null unique,                    -- e.g. 'better-for-you-snacks'
  display_name    text not null,                           -- e.g. 'Better-for-You Snacks'
  description     text,
  tiktok_hashtags text[] not null default '{}',            -- ['healthysnacks', 'cleansnacking', ...]
  subreddits      text[] not null default '{}',            -- ['EatCheapAndHealthy', 'vegan', ...]
  amazon_category_urls text[] not null default '{}',       -- top-100 category page URLs
  google_trends_keywords text[] not null default '{}',
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create trigger categories_updated_at before update on categories
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- BRANDS — canonical brand list
-- ---------------------------------------------------------------------------
create table brands (
  id               uuid primary key default uuid_generate_v4(),
  name             text not null,                          -- display name, e.g. 'Vacation Sunscreen'
  slug             text not null unique,                   -- 'vacation-sunscreen' for URLs
  -- Resolved handles (filled by handle resolver; NULL until resolved)
  tiktok_handle    text,                                   -- without leading @
  instagram_handle text,
  amazon_brand     text,                                   -- brand name as it appears on Amazon
  amazon_asin_seed text,                                   -- one known ASIN, optional, to anchor lookups
  shopify_url      text,                                   -- root domain if known
  website_url      text,
  -- Categorization
  primary_category_id uuid references categories(id) on delete set null,
  -- Discovery / provenance
  discovery_source discovery_source not null default 'manual',
  first_seen_at    timestamptz not null default now(),
  -- Free-form metadata + tags
  tags             text[] not null default '{}',
  notes            text,
  -- Lifecycle
  is_monitored     boolean not null default true,          -- include in weekly poll
  is_archived      boolean not null default false,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create unique index brands_name_lower_idx on brands (lower(name));
create index brands_tiktok_handle_idx    on brands (lower(tiktok_handle))    where tiktok_handle is not null;
create index brands_instagram_handle_idx on brands (lower(instagram_handle)) where instagram_handle is not null;
create index brands_amazon_brand_idx     on brands (lower(amazon_brand))     where amazon_brand is not null;
create index brands_monitored_idx        on brands (is_monitored, is_archived);
create trigger brands_updated_at before update on brands
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- SNAPSHOTS — time-series of every metric we capture (THE trend engine)
--   We append-only. Never update. Indexed for (brand_id, metric, captured_at).
-- ---------------------------------------------------------------------------
create table snapshots (
  id            bigserial primary key,
  brand_id      uuid not null references brands(id) on delete cascade,
  platform      platform_kind not null,
  metric        text not null,             -- 'followers', 'engagement_rate', 'review_count',
                                           -- 'bsr_rank', 'star_rating', 'search_volume', etc.
  value_numeric numeric,                   -- for counts / scores / rates
  value_text    text,                      -- for non-numeric values (e.g. 'verified', sentiment label)
  value_json    jsonb,                     -- for structured payloads (e.g. top videos array)
  captured_at   timestamptz not null default now(),
  -- Provenance / debug
  source_url    text,                      -- exact URL we pulled from, if applicable
  fetcher_run_id uuid                      -- ties snapshots from one fetcher run together
);
create index snapshots_brand_metric_time_idx
  on snapshots (brand_id, platform, metric, captured_at desc);
create index snapshots_captured_at_idx on snapshots (captured_at desc);
create index snapshots_fetcher_run_idx on snapshots (fetcher_run_id);

-- ---------------------------------------------------------------------------
-- BRAND_CARD_CACHE — latest rendered Brand Card JSON per brand
--   Read path for `/brand-card/[slug]` and the agent's brand_lookup tool.
--   Regenerated on demand (TTL ~6h) or by the weekly poll.
-- ---------------------------------------------------------------------------
create table brand_card_cache (
  brand_id    uuid primary key references brands(id) on delete cascade,
  payload     jsonb not null,                       -- full Brand Card object (see types.ts BrandCard)
  generated_at timestamptz not null default now(),
  ttl_seconds integer not null default 21600        -- 6h default
);
create index brand_card_cache_generated_at_idx on brand_card_cache (generated_at);

-- ---------------------------------------------------------------------------
-- SALESPEOPLE — Barcode reps with assigned categories
--   Drives per-rep Weekly Scouting Report personalization.
-- ---------------------------------------------------------------------------
create table salespeople (
  id              uuid primary key default uuid_generate_v4(),
  -- Linked to Supabase Auth (auth.users) when the rep has a login.
  -- NULL until they sign in; we can still send them reports by email.
  auth_user_id    uuid unique references auth.users(id) on delete set null,
  display_name    text not null,
  email           text not null unique,
  category_ids    uuid[] not null default '{}',         -- their assigned categories
  is_active       boolean not null default true,
  -- Delivery preferences
  weekly_report_enabled boolean not null default true,
  weekly_report_day     smallint not null default 1,    -- 1 = Monday (ISO)
  weekly_report_hour    smallint not null default 7,    -- 7am local
  timezone        text not null default 'America/Chicago',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create trigger salespeople_updated_at before update on salespeople
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- REPORTS — generated weekly/monthly reports + delivery tracking
-- ---------------------------------------------------------------------------
create table reports (
  id             uuid primary key default uuid_generate_v4(),
  kind           report_kind not null,
  salesperson_id uuid references salespeople(id) on delete set null,
  category_id    uuid references categories(id) on delete set null,
  period_start   date,                                -- e.g. week start, month start
  period_end     date,
  payload        jsonb not null,                      -- full report data (top brands, narrative, etc.)
  rendered_html  text,                                -- email-ready HTML if applicable
  status         report_status not null default 'pending',
  sent_at        timestamptz,
  recipient_email text,                                -- denormalized for audit
  error_message  text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index reports_kind_period_idx on reports (kind, period_start desc);
create index reports_salesperson_idx on reports (salesperson_id, created_at desc);
create trigger reports_updated_at before update on reports
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- NIELSEN_UPLOADS — ingested Nielsen/IRI/Circana files
--   The raw rows live in `nielsen_rows`. The upload record carries metadata
--   and the auto-detected column mapping the parser used.
-- ---------------------------------------------------------------------------
create table nielsen_uploads (
  id             uuid primary key default uuid_generate_v4(),
  filename       text not null,
  uploaded_by    uuid references auth.users(id) on delete set null,
  source_kind    text,                                -- 'nielsen', 'iri', 'circana', 'unknown'
  period_start   date,
  period_end     date,
  row_count      integer not null default 0,
  column_mapping jsonb,                               -- detected mapping: {brand_col:..., units_col:...}
  notes          text,
  created_at     timestamptz not null default now()
);

create table nielsen_rows (
  id              bigserial primary key,
  upload_id       uuid not null references nielsen_uploads(id) on delete cascade,
  -- Normalized fields (what the parser pulled out)
  brand_name_raw  text not null,                      -- as it appears in the file
  brand_id        uuid references brands(id) on delete set null,  -- mapped after ingestion
  category_name_raw text,
  category_id     uuid references categories(id) on delete set null,
  -- Sales metrics (nullable — files vary in what they include)
  sales_dollars   numeric,
  sales_units     numeric,
  period_label    text,                               -- e.g. 'L52W', 'L13W', '3M'
  yoy_growth_pct  numeric,
  -- The full original row preserved for audit / re-mapping
  raw_row         jsonb not null
);
create index nielsen_rows_upload_idx on nielsen_rows (upload_id);
create index nielsen_rows_brand_idx on nielsen_rows (brand_id) where brand_id is not null;
create index nielsen_rows_brand_name_lower_idx on nielsen_rows (lower(brand_name_raw));

-- ---------------------------------------------------------------------------
-- FETCHER_RUNS — log of every data-collection run (for debugging + ops)
-- ---------------------------------------------------------------------------
create table fetcher_runs (
  id            uuid primary key default uuid_generate_v4(),
  fetcher_name  text not null,                        -- 'amazon', 'tiktok', 'weekly_poll', ...
  trigger_kind  text not null,                        -- 'manual', 'cron', 'on_demand'
  brand_id      uuid references brands(id) on delete set null,
  category_id   uuid references categories(id) on delete set null,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  status        text not null default 'running',     -- 'running' | 'success' | 'partial' | 'error'
  snapshots_written integer not null default 0,
  error_message text,
  metadata      jsonb
);
create index fetcher_runs_started_idx on fetcher_runs (started_at desc);
create index fetcher_runs_status_idx on fetcher_runs (status, started_at desc);

-- ---------------------------------------------------------------------------
-- HANDLE_RESOLUTIONS — cache of brand name → social handle lookups
--   Avoids repeatedly hitting Google Search for the same brand.
-- ---------------------------------------------------------------------------
create table handle_resolutions (
  id              uuid primary key default uuid_generate_v4(),
  brand_name_query text not null,                     -- exactly what the user typed
  brand_id        uuid references brands(id) on delete cascade,
  tiktok_handle   text,
  instagram_handle text,
  amazon_brand    text,
  confidence      text,                               -- 'high' | 'medium' | 'low' | 'manual'
  resolution_log  jsonb,                              -- which strategy worked, candidates considered
  created_at      timestamptz not null default now()
);
create index handle_resolutions_query_idx on handle_resolutions (lower(brand_name_query));

-- ---------------------------------------------------------------------------
-- LEARNINGS — agent memory (matches Adam's config/adam.learnings)
-- ---------------------------------------------------------------------------
create table learnings (
  id         uuid primary key default uuid_generate_v4(),
  content    text not null,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- PRIOS — per-user priorities (matches Adam's users/{uid}/prios)
-- ---------------------------------------------------------------------------
create table prios (
  id           uuid primary key default uuid_generate_v4(),
  auth_user_id uuid not null references auth.users(id) on delete cascade,
  title        text not null,
  entity_type  text,                                  -- 'brand' | 'category' | 'report' | null
  entity_id    text,
  entity_name  text,                                  -- denormalized for display
  status       prio_status not null default 'active',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index prios_user_active_idx on prios (auth_user_id, status, created_at desc);
create trigger prios_updated_at before update on prios
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- USER_PROFILES — extra user fields beyond auth.users
-- ---------------------------------------------------------------------------
create table user_profiles (
  auth_user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  notes        text,
  language     text not null default 'en',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create trigger user_profiles_updated_at before update on user_profiles
  for each row execute function set_updated_at();

-- ============================================================================
-- Row Level Security
-- ============================================================================
-- Service-role key bypasses RLS, so server-side code (API routes, cron) works
-- unchanged. Anon/auth users need explicit policies.
-- For V1 this is permissive — Barcode is a small internal team. Tighten when
-- we add role-based access (e.g. limit reps to seeing their own reports).
-- ============================================================================

alter table categories         enable row level security;
alter table brands             enable row level security;
alter table snapshots          enable row level security;
alter table brand_card_cache   enable row level security;
alter table salespeople        enable row level security;
alter table reports            enable row level security;
alter table nielsen_uploads    enable row level security;
alter table nielsen_rows       enable row level security;
alter table fetcher_runs       enable row level security;
alter table handle_resolutions enable row level security;
alter table learnings          enable row level security;
alter table prios              enable row level security;
alter table user_profiles      enable row level security;

-- Authenticated users can read most operational data
create policy "auth read categories"   on categories         for select to authenticated using (true);
create policy "auth read brands"       on brands             for select to authenticated using (true);
create policy "auth read snapshots"    on snapshots          for select to authenticated using (true);
create policy "auth read brand_card_cache" on brand_card_cache for select to authenticated using (true);
create policy "auth read salespeople"  on salespeople        for select to authenticated using (true);
create policy "auth read reports"      on reports            for select to authenticated using (true);
create policy "auth read categories2"  on nielsen_uploads    for select to authenticated using (true);
create policy "auth read nielsen_rows" on nielsen_rows       for select to authenticated using (true);
create policy "auth read fetcher_runs" on fetcher_runs       for select to authenticated using (true);
create policy "auth read learnings"    on learnings          for select to authenticated using (true);

-- Users manage their own prios + profile
create policy "users manage own prios"
  on prios for all to authenticated
  using (auth_user_id = auth.uid())
  with check (auth_user_id = auth.uid());

create policy "users manage own profile"
  on user_profiles for all to authenticated
  using (auth_user_id = auth.uid())
  with check (auth_user_id = auth.uid());

-- All writes for non-profile tables go through service-role (server-side only).
-- No insert/update/delete policies for authenticated role on those tables.

-- ============================================================================
-- Seed: a couple of starter categories so the system isn't empty
-- (Replace with Barcode's real categories once they confirm.)
-- ============================================================================
insert into categories (slug, display_name, description, tiktok_hashtags, subreddits, google_trends_keywords) values
  ('better-for-you-snacks', 'Better-for-You Snacks',
   'Healthy, clean-label, functional snacks (protein bars, crackers, jerky, etc.)',
   array['healthysnacks','cleansnacking','snacktok','healthyfood'],
   array['EatCheapAndHealthy','HealthyFood','vegan','glutenfree'],
   array['healthy snacks','protein bars','clean label snacks']),
  ('clean-beauty-skincare', 'Clean Beauty / Skincare',
   'Clean-ingredient skincare, sunscreen, body care',
   array['skincare','cleanbeauty','sunscreen','skintok'],
   array['SkincareAddiction','30PlusSkinCare','tretinoin'],
   array['clean beauty','reef safe sunscreen','skincare routine']),
  ('functional-beverages', 'Functional Beverages',
   'Functional / better-for-you drinks (gut, energy, hydration, sparkling)',
   array['functionaldrinks','gutHealth','beveragetok','hydration'],
   array['supplements','BuyItForLife','Hydration'],
   array['gut health drink','prebiotic soda','functional beverage'])
on conflict (slug) do nothing;
