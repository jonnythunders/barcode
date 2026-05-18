/**
 * Nielsen / IRI / Circana ingestion — column-mapping auto-detection.
 *
 * The problem: every retail-scan provider exports differently, and even
 * within Nielsen the column headers vary by category and account. We can't
 * hardcode a schema. Instead we:
 *
 *   1. Parse the file into a tabular structure (CSV → papaparse, XLSX → sheetjs)
 *   2. Find the header row — usually the first row where >50% of cells are
 *      non-empty strings and at least one resembles a known field label
 *   3. Score each header column against known field-label synonyms
 *      (e.g. "Brand", "Brand Name", "MFR/BRAND", "BRAND VALUE OWNER" all → brand_col)
 *   4. Pick the best match per known field; report confidence
 *   5. Hand the user the mapping for manual override before commit
 *
 * Confidence is per-column, 0-1. Anything <0.7 is shown in the UI as
 * "please confirm." Anything <0.4 we treat as "not detected" and leave
 * the field unmapped.
 *
 * Source kind detection: a soft fingerprint based on column header style.
 * Used only for the audit trail; it doesn't change the parse.
 */
import Papa from "papaparse";
import * as XLSX from "xlsx";

export type NielsenFieldKey =
  | "brand_col"
  | "category_col"
  | "sales_dollars_col"
  | "sales_units_col"
  | "period_col"
  | "yoy_growth_col";

export type SourceKind = "nielsen" | "iri" | "circana" | "unknown";

export interface ColumnMapping {
  /** Detected field → header text in the file. Some fields may be missing. */
  fields: Partial<Record<NielsenFieldKey, string>>;
  /** Per-field confidence (0-1). */
  confidence: Partial<Record<NielsenFieldKey, number>>;
  /** All header strings we found, in order. UI shows these in dropdowns for manual override. */
  allHeaders: string[];
  /** Best-effort fingerprint of which provider this came from. */
  sourceKind: SourceKind;
  /** Header row index (0-based) within the raw row array. */
  headerRowIndex: number;
}

export interface ParsedNielsenFile {
  filename: string;
  rowCount: number;
  rawRows: Record<string, unknown>[];
  mapping: ColumnMapping;
  /** Normalized rows ready for `nielsen_rows` insert. */
  normalizedRows: NormalizedNielsenRow[];
  /** Period inferred from the file (header text scan + first row sample). May be null. */
  periodLabel: string | null;
}

export interface NormalizedNielsenRow {
  brandNameRaw: string;
  categoryNameRaw: string | null;
  salesDollars: number | null;
  salesUnits: number | null;
  periodLabel: string | null;
  yoyGrowthPct: number | null;
  rawRow: Record<string, unknown>;
}

// =========================================================================
// Field-label synonyms (case- and punctuation-insensitive)
//
// Each known field maps to a list of label patterns we accept. We try
// "contains" matching after normalization. Order matters for tie-breaking
// (earlier = higher confidence).
// =========================================================================

const FIELD_SYNONYMS: Record<NielsenFieldKey, string[]> = {
  brand_col: [
    "brand value owner",
    "brand owner",
    "brand name",
    "mfr brand",
    "mfg brand",
    "manufacturer brand",
    "brand",
  ],
  category_col: [
    "category",
    "subcategory",
    "sub category",
    "department",
    "sub department",
    "segment",
  ],
  sales_dollars_col: [
    "dollar sales",
    "dollars sold",
    "$ sales",
    "$sales",
    "sales dollars",
    "dollar sale",
    "dollars",
    "revenue",
  ],
  sales_units_col: [
    "unit sales",
    "units sold",
    "sales units",
    "units",
    "eq units",
    "equivalent units",
  ],
  period_col: [
    "period",
    "period ending",
    "week ending",
    "latest",
    "time period",
    "timeframe",
  ],
  yoy_growth_col: [
    "yoy change",
    "yoy growth",
    "year over year",
    "vs ya",
    "vs year ago",
    "% chg ya",
    "% change ya",
    "ya % chg",
    "$ chg ya pct",
    "yago % chg",
  ],
};

// =========================================================================
// Public entry points
// =========================================================================

/**
 * Parse a buffer + filename into a normalized payload + column mapping.
 * Format detected by extension.
 */
export function parseNielsenFile(
  buffer: ArrayBuffer | Buffer,
  filename: string,
  manualOverrides?: Partial<Record<NielsenFieldKey, string>>
): ParsedNielsenFile {
  const ext = filename.toLowerCase().split(".").pop() ?? "";

  let rows: unknown[][];
  if (ext === "csv" || ext === "tsv") {
    rows = parseDelimited(buffer, ext === "tsv");
  } else if (ext === "xlsx" || ext === "xls" || ext === "xlsm") {
    rows = parseSpreadsheet(buffer);
  } else {
    throw new Error(`Unsupported file extension ".${ext}". Use .csv, .tsv, .xlsx, or .xls.`);
  }

  if (rows.length === 0) {
    throw new Error("File is empty");
  }

  // Detect header row + headers
  const { headerRowIndex, headers } = detectHeaderRow(rows);

  // Build mapping (with manual overrides applied)
  const detected = detectColumnMapping(headers);
  const fields: Partial<Record<NielsenFieldKey, string>> = { ...detected.fields };
  const confidence: Partial<Record<NielsenFieldKey, number>> = { ...detected.confidence };
  for (const [k, v] of Object.entries(manualOverrides ?? {})) {
    if (v && headers.includes(v)) {
      fields[k as NielsenFieldKey] = v;
      confidence[k as NielsenFieldKey] = 1.0; // manual = certain
    }
  }

  // Convert remaining rows into objects keyed by header
  const dataRows = rows.slice(headerRowIndex + 1);
  const rawRows: Record<string, unknown>[] = [];
  for (const row of dataRows) {
    if (!row || row.length === 0) continue;
    if (row.every((c) => c == null || String(c).trim() === "")) continue;
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < headers.length; i++) {
      obj[headers[i]] = row[i] ?? null;
    }
    rawRows.push(obj);
  }

  const sourceKind = fingerprintSource(headers);
  const periodLabel = inferPeriod(headers, rawRows[0]);

  const mapping: ColumnMapping = {
    fields,
    confidence,
    allHeaders: headers,
    sourceKind,
    headerRowIndex,
  };

  const normalizedRows = rawRows.map((r) => normalizeRow(r, mapping, periodLabel));

  return {
    filename,
    rowCount: normalizedRows.length,
    rawRows,
    mapping,
    normalizedRows,
    periodLabel,
  };
}

// =========================================================================
// Format-specific parsers
// =========================================================================

function parseDelimited(buffer: ArrayBuffer | Buffer, isTsv: boolean): unknown[][] {
  const text = buffer instanceof Buffer ? buffer.toString("utf-8") : new TextDecoder().decode(buffer);
  const result = Papa.parse<unknown[]>(text, {
    header: false,
    skipEmptyLines: true,
    delimiter: isTsv ? "\t" : undefined,
    dynamicTyping: false, // keep everything as strings; we type-cast on normalize
  });
  return (result.data ?? []) as unknown[][];
}

function parseSpreadsheet(buffer: ArrayBuffer | Buffer): unknown[][] {
  const wb = XLSX.read(buffer, { type: buffer instanceof Buffer ? "buffer" : "array" });
  // Use the first sheet by default. Real Nielsen exports often have a
  // "Cover" sheet first — we look at the first sheet that has >5 rows of
  // data, with the first sheet as fallback.
  let sheetName = wb.SheetNames[0];
  for (const candidate of wb.SheetNames) {
    const sheet = wb.Sheets[candidate];
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: null }) as unknown[][];
    if (rows.length > 5) {
      sheetName = candidate;
      break;
    }
  }
  const sheet = wb.Sheets[sheetName];
  return XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: null }) as unknown[][];
}

// =========================================================================
// Header detection
// =========================================================================

/**
 * Find the most likely header row.
 *
 * Strategy: scan the first 25 rows, score each by:
 *   - fraction of non-empty cells
 *   - whether any cell looks like a known field synonym
 *   - whether the row BELOW it has at least one numeric value (a real
 *     header is followed by data, not more headers)
 *
 * The highest-scoring row wins.
 */
function detectHeaderRow(rows: unknown[][]): { headerRowIndex: number; headers: string[] } {
  const limit = Math.min(rows.length, 25);
  let bestIndex = 0;
  let bestScore = -Infinity;

  for (let i = 0; i < limit; i++) {
    const row = rows[i];
    if (!row) continue;
    const cells = row.map((c) => (c == null ? "" : String(c).trim()));
    const nonEmpty = cells.filter((c) => c.length > 0);
    if (nonEmpty.length < 3) continue;

    let score = nonEmpty.length / Math.max(cells.length, 1);

    // Bonus for any cell matching a known synonym
    for (const cell of nonEmpty) {
      const norm = normalizeLabel(cell);
      for (const key of Object.keys(FIELD_SYNONYMS) as NielsenFieldKey[]) {
        for (const syn of FIELD_SYNONYMS[key]) {
          if (norm.includes(syn)) {
            score += 0.5;
            break;
          }
        }
      }
    }

    // Bonus if the row below has at least one numeric value
    const nextRow = rows[i + 1];
    if (nextRow) {
      const hasNumeric = nextRow.some((c) => {
        const s = String(c ?? "").replace(/[$,()% ]/g, "");
        return s.length > 0 && !isNaN(Number(s));
      });
      if (hasNumeric) score += 0.5;
    }

    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }

  const headerRow = rows[bestIndex] ?? [];
  // Dedupe blank/duplicate headers — they'd collide as object keys
  const seen = new Map<string, number>();
  const headers: string[] = [];
  for (let i = 0; i < headerRow.length; i++) {
    let h = headerRow[i] == null ? "" : String(headerRow[i]).trim();
    if (!h) h = `__col_${i}`;
    if (seen.has(h)) {
      const count = (seen.get(h) ?? 0) + 1;
      seen.set(h, count);
      h = `${h}_${count}`;
    } else {
      seen.set(h, 0);
    }
    headers.push(h);
  }
  return { headerRowIndex: bestIndex, headers };
}

// =========================================================================
// Column → field mapping
// =========================================================================

function detectColumnMapping(headers: string[]): { fields: Partial<Record<NielsenFieldKey, string>>; confidence: Partial<Record<NielsenFieldKey, number>> } {
  const fields: Partial<Record<NielsenFieldKey, string>> = {};
  const confidence: Partial<Record<NielsenFieldKey, number>> = {};

  for (const field of Object.keys(FIELD_SYNONYMS) as NielsenFieldKey[]) {
    const synonyms = FIELD_SYNONYMS[field];
    let bestHeader: string | null = null;
    let bestScore = 0;
    for (const h of headers) {
      const norm = normalizeLabel(h);
      // Score is the synonym's rank inverse (earlier synonyms = higher score)
      for (let i = 0; i < synonyms.length; i++) {
        const syn = synonyms[i];
        if (norm === syn) {
          const score = 1.0 - i * 0.05;
          if (score > bestScore) { bestScore = score; bestHeader = h; }
        } else if (norm.includes(syn)) {
          const score = 0.7 - i * 0.05;
          if (score > bestScore) { bestScore = score; bestHeader = h; }
        }
      }
    }
    if (bestHeader && bestScore >= 0.4) {
      fields[field] = bestHeader;
      confidence[field] = Math.min(1.0, bestScore);
    }
  }

  return { fields, confidence };
}

function normalizeLabel(s: string): string {
  return s
    .toLowerCase()
    .replace(/[._\-/]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// =========================================================================
// Source fingerprinting (best-effort, for the audit trail only)
// =========================================================================

function fingerprintSource(headers: string[]): SourceKind {
  const joined = headers.map(normalizeLabel).join(" | ");
  if (/brand value owner/.test(joined)) return "nielsen";
  if (/projected dollars|projected units/.test(joined)) return "iri";
  if (/circana/.test(joined)) return "circana";
  return "unknown";
}

// =========================================================================
// Period inference
// =========================================================================

function inferPeriod(headers: string[], firstRow: Record<string, unknown> | undefined): string | null {
  // Look for a header like "Latest 52 Weeks" or "L52W"
  const periodHeaderRe = /(?:l|latest)\s*(\d+)\s*(?:w|wk|weeks?)/i;
  for (const h of headers) {
    const m = periodHeaderRe.exec(h);
    if (m) return `L${m[1]}W`;
  }
  // Fall back to a "Week Ending" or "Period" cell in the first row
  if (firstRow) {
    for (const [k, v] of Object.entries(firstRow)) {
      if (/period|week ending|ending/i.test(k) && v) {
        return String(v).trim();
      }
    }
  }
  return null;
}

// =========================================================================
// Row normalization
// =========================================================================

function normalizeRow(
  row: Record<string, unknown>,
  mapping: ColumnMapping,
  defaultPeriodLabel: string | null
): NormalizedNielsenRow {
  const brandCol = mapping.fields.brand_col;
  const categoryCol = mapping.fields.category_col;
  const dollarsCol = mapping.fields.sales_dollars_col;
  const unitsCol = mapping.fields.sales_units_col;
  const periodCol = mapping.fields.period_col;
  const yoyCol = mapping.fields.yoy_growth_col;

  const brandRaw = brandCol ? String(row[brandCol] ?? "").trim() : "";
  const categoryRaw = categoryCol ? String(row[categoryCol] ?? "").trim() : "";
  const period = periodCol ? String(row[periodCol] ?? "").trim() : defaultPeriodLabel ?? null;

  return {
    brandNameRaw: brandRaw,
    categoryNameRaw: categoryRaw || null,
    salesDollars: dollarsCol ? parseNumber(row[dollarsCol]) : null,
    salesUnits: unitsCol ? parseNumber(row[unitsCol]) : null,
    periodLabel: period,
    yoyGrowthPct: yoyCol ? parsePercent(row[yoyCol]) : null,
    rawRow: row,
  };
}

/**
 * Parse a numeric-ish cell. Handles "$1,234.56", "(1,234.56)" (negative
 * accounting convention), "1.2K", "1.2M", and plain numbers.
 */
function parseNumber(v: unknown): number | null {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  let s = String(v).trim();
  if (!s) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1); }
  const suffix = s.match(/([KMBkmb])$/);
  const multiplier = suffix
    ? { k: 1e3, m: 1e6, b: 1e9 }[suffix[1].toLowerCase() as "k" | "m" | "b"]
    : 1;
  s = s.replace(/[$,%\sKMBkmb]/g, "");
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return (negative ? -n : n) * multiplier;
}

/**
 * Parse a percentage cell. "12.3%" → 0.123. "+8" → 0.08. Already-decimal
 * values (>1 or <-1 with a "%" sign, vs e.g. "0.08") are treated as
 * percent if the original string contained "%".
 */
function parsePercent(v: unknown): number | null {
  if (v == null || v === "") return null;
  if (typeof v === "number") {
    // Heuristic: if the absolute value is > 2 we assume it's already a
    // percent figure (e.g. 12.3 means 12.3%).
    return Math.abs(v) > 2 ? v / 100 : v;
  }
  const s = String(v).trim();
  if (!s) return null;
  const hasPercent = s.includes("%");
  const n = parseNumber(s);
  if (n == null) return null;
  return hasPercent || Math.abs(n) > 2 ? n / 100 : n;
}
