-- RECOMMENDATION FEEDBACK — per-rep thumbs up/down on a brand's recommendation.
-- Internal diagnostic tool: surfaces where the engine's recommendation/data
-- disagrees with what the rep sees on the ground, attributed to the individual
-- rep so the owner can follow up with them directly. Captures the recommendation
-- context AT VOTE TIME so a vote is anchored to what was actually shown.
create table if not exists recommendation_feedback (
  id uuid primary key default uuid_generate_v4(),
  brand_id uuid not null references brands(id) on delete cascade,
  -- Who voted. FK to auth.users (like prios.auth_user_id). Individual rep
  -- attribution is the point — votes are per-person, not team-scoped.
  auth_user_id uuid not null references auth.users(id),
  vote smallint not null check (vote in (-1, 1)),         -- -1 down, +1 up
  -- Snapshot of what the card showed when the vote was cast. This is what makes
  -- the feedback diagnostic rather than bare sentiment: lets the owner ask
  -- "which call_now / high-score recs did reps mark wrong, and why".
  recommended_action text,                                 -- call_now | watch | skip | null
  momentum_score int,
  brand_type text,                                         -- dtc_brand | retail_brand | amazon_supplier | unknown
  -- Optional free-text — the diagnostic payload ("already in 400 Targets",
  -- "this is an FBA reseller"). Especially valuable on down-votes.
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- One current vote per rep per brand. Re-voting updates; toggling off deletes.
  unique (brand_id, auth_user_id)
);

create index if not exists idx_rec_feedback_brand on recommendation_feedback (brand_id);
create index if not exists idx_rec_feedback_user  on recommendation_feedback (auth_user_id);
create index if not exists idx_rec_feedback_vote  on recommendation_feedback (vote);

alter table recommendation_feedback enable row level security;

-- Match the existing app's RLS posture (authenticated can read; writes go
-- through the service-role admin client server-side, as with prios/learnings).
create policy "auth read recommendation_feedback" on recommendation_feedback
  for select to authenticated using (true);
