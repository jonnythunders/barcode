-- SmartScout ingestion tables.
--
-- Mirrors the nielsen_uploads / nielsen_rows pattern but for SmartScout's
-- Amazon-velocity exports. The SmartScout column structure is fixed (unlike
-- Nielsen, which varies per provider), so we don't need a column-mapping
-- column — but we keep an upload header for the audit trail and so the
-- reconciliation queue knows which file a row came from.
--
-- Apply by pasting into the Supabase SQL editor, or via:
--   npx supabase db push   (if you have the CLI linked)

CREATE TABLE IF NOT EXISTS smartscout_uploads (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  filename        TEXT NOT NULL,
  uploaded_by     UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  uploaded_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  row_count       INTEGER NOT NULL,
  period_label    TEXT,                          -- e.g. "April 2026 dump"
  metadata        JSONB                          -- categories present, totals, etc.
);

CREATE INDEX IF NOT EXISTS idx_smartscout_uploads_uploaded_at
  ON smartscout_uploads (uploaded_at DESC);

CREATE TABLE IF NOT EXISTS smartscout_rows (
  id                    BIGSERIAL PRIMARY KEY,
  upload_id             UUID NOT NULL REFERENCES smartscout_uploads(id) ON DELETE CASCADE,
  brand_name_raw        TEXT NOT NULL,
  main_category         TEXT,
  primary_subcategory   TEXT,
  est_monthly_revenue   NUMERIC,
  trailing_12_months    NUMERIC,                 -- = amazon_annual_sales
  est_monthly_sales     NUMERIC,                 -- = amazon_monthly_units
  one_month_growth      NUMERIC,                 -- raw decimal (0.05 = 5%)
  twelve_month_growth   NUMERIC,                 -- raw decimal (1.32 = 132%)
  raw_row               JSONB,
  matched_brand_id      UUID REFERENCES brands(id) ON DELETE SET NULL,
  match_confidence      TEXT CHECK (match_confidence IN ('high','medium','low','manual','unresolved')),
  reconciled_at         TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_smartscout_rows_upload    ON smartscout_rows (upload_id);
CREATE INDEX IF NOT EXISTS idx_smartscout_rows_brand     ON smartscout_rows (matched_brand_id);
CREATE INDEX IF NOT EXISTS idx_smartscout_rows_name_lc   ON smartscout_rows (lower(brand_name_raw));

-- RLS: only authenticated users can read; service role has full access.
ALTER TABLE smartscout_uploads ENABLE ROW LEVEL SECURITY;
ALTER TABLE smartscout_rows    ENABLE ROW LEVEL SECURITY;

CREATE POLICY "smartscout_uploads_read_auth" ON smartscout_uploads
  FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "smartscout_rows_read_auth" ON smartscout_rows
  FOR SELECT USING (auth.role() = 'authenticated');
