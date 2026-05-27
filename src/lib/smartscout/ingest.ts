/**
 * SmartScout ingestion — parser for the SmartScout monthly Amazon-velocity
 * export. Unlike Nielsen, SmartScout's column structure is fixed across
 * exports, so this parser is simpler: we expect specific column names and
 * fail loudly if they're missing.
 *
 * Expected sheet: "Data" (with "Pivot" as a fallback metadata sheet).
 * Expected columns (case-insensitive header match):
 *   - "Brand Name"
 *   - "Main Category"
 *   - "Primary Subcategory"
 *   - "Est. Monthly Revenue"
 *   - "Trailing 12 Months"          (= amazon_annual_sales)
 *   - "Est. Monthly Sales"          (= amazon_monthly_units)
 *   - "1 Month Growth"
 *   - "12 Month Growth"             (= amazon_yoy_growth_pct, as decimal)
 *
 * Output: one row per (brand, subcategory) combination from the file.
 * The aggregation step (grouping by brand across multiple subcategories,
 * summing TTM sales, weighting growth by revenue) happens at write-time
 * in the upload route — that keeps this parser dumb and testable.
 */
import * as XLSX from "xlsx";

export interface SmartScoutRawRow {
  brandName: string;
  mainCategory: string | null;
  primarySubcategory: string | null;
  estMonthlyRevenue: number | null;
  trailing12Months: number | null;
  estMonthlySales: number | null;
  oneMonthGrowth: number | null;
  twelveMonthGrowth: number | null;
  /** The original row, keyed by header text, for the audit trail. */
  raw: Record<string, unknown>;
}

export interface ParsedSmartScoutFile {
  filename: string;
  rowCount: number;
  rows: SmartScoutRawRow[];
  /** Distinct (mainCategory, primarySubcategory) pairs seen, for the upload's metadata. */
  categories: { mainCategory: string; primarySubcategory: string; rowCount: number }[];
  /** Period label if discoverable from the filename (e.g. "Apr 2026" from "April_Data_Dump"). */
  periodLabel: string | null;
}

/** Column-name aliases, in priority order. SmartScout's headers are stable
 *  but we tolerate light variation (extra whitespace, "/" vs " ", etc.). */
const COL_ALIASES: Record<keyof Omit<SmartScoutRawRow, "raw">, string[]> = {
  brandName: ["brand name", "brand"],
  mainCategory: ["main category", "category"],
  primarySubcategory: ["primary subcategory", "subcategory"],
  estMonthlyRevenue: ["est. monthly revenue", "est monthly revenue", "estimated monthly revenue"],
  trailing12Months: ["trailing 12 months", "ttm sales", "ttm", "trailing twelve months", "annual sales"],
  estMonthlySales: ["est. monthly sales", "est monthly sales", "estimated monthly sales", "monthly units"],
  oneMonthGrowth: ["1 month growth", "one month growth", "mom growth"],
  twelveMonthGrowth: ["12 month growth", "twelve month growth", "yoy growth", "year over year growth"],
};

function normalizeHeader(h: string): string {
  return h.toLowerCase().replace(/[._\-/]/g, " ").replace(/\s+/g, " ").trim();
}

function resolveHeaders(headers: string[]): Record<keyof Omit<SmartScoutRawRow, "raw">, string | null> {
  const out = {} as Record<keyof Omit<SmartScoutRawRow, "raw">, string | null>;
  for (const field of Object.keys(COL_ALIASES) as Array<keyof Omit<SmartScoutRawRow, "raw">>) {
    out[field] = null;
    const aliases = COL_ALIASES[field];
    for (const h of headers) {
      const norm = normalizeHeader(h);
      if (aliases.some((a) => norm === a)) { out[field] = h; break; }
    }
    if (!out[field]) {
      for (const h of headers) {
        const norm = normalizeHeader(h);
        if (aliases.some((a) => norm.includes(a))) { out[field] = h; break; }
      }
    }
  }
  return out;
}

function parseNumber(v: unknown): number | null {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  let s = String(v).trim();
  if (!s) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1); }
  s = s.replace(/[$,%\s]/g, "");
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

/** Parse a growth cell. SmartScout reports raw decimals (0.32 = 32%), but
 *  some exports use already-percent values (32 = 32%). Heuristic: if the
 *  absolute value is > 5 we assume it's already percent. */
function parseGrowth(v: unknown): number | null {
  const n = parseNumber(v);
  if (n == null) return null;
  return Math.abs(n) > 5 ? n / 100 : n;
}

/** Infer a period label from the filename, e.g. "April_Data_Dump_-_SmartScout-_04_28_2026.xlsx"
 *  → "Apr 2026". Best-effort only; falls back to null. */
function inferPeriodFromFilename(filename: string): string | null {
  const stem = filename.replace(/\.[^.]+$/, "");
  // Look for MM_DD_YYYY or MM-DD-YYYY
  const m = stem.match(/(\d{1,2})[_\-](\d{1,2})[_\-](20\d{2})/);
  if (m) {
    const monthNames = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const mi = parseInt(m[1], 10) - 1;
    if (mi >= 0 && mi < 12) return `${monthNames[mi]} ${m[3]}`;
  }
  // Look for a month name in the filename
  const months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  for (let i = 0; i < months.length; i++) {
    if (new RegExp(months[i], "i").test(stem)) {
      const year = stem.match(/20\d{2}/);
      return year ? `${months[i].slice(0,3)} ${year[0]}` : months[i].slice(0,3);
    }
  }
  return null;
}

export function parseSmartScoutFile(buffer: ArrayBuffer | Buffer, filename: string): ParsedSmartScoutFile {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  if (ext !== "xlsx" && ext !== "xls" && ext !== "xlsm") {
    throw new Error(`Unsupported file extension ".${ext}". SmartScout exports are .xlsx.`);
  }

  const wb = XLSX.read(buffer, { type: buffer instanceof Buffer ? "buffer" : "array" });
  // Prefer the "Data" sheet (SmartScout's canonical sheet); fall back to the
  // first sheet with >10 rows.
  let sheetName = wb.SheetNames.find((n) => /^data$/i.test(n));
  if (!sheetName) {
    for (const candidate of wb.SheetNames) {
      const sheet = wb.Sheets[candidate];
      const rowCount = (XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: null }) as unknown[][]).length;
      if (rowCount > 10) { sheetName = candidate; break; }
    }
  }
  if (!sheetName) throw new Error("No sheet with data found. Expected a 'Data' sheet.");

  const sheet = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: null });
  if (rows.length === 0) throw new Error(`Sheet "${sheetName}" is empty.`);

  const headers = Object.keys(rows[0]);
  const colMap = resolveHeaders(headers);

  // Brand Name is the one column we absolutely require. Trailing 12 Months
  // is the one numeric column we require (everything else is optional).
  if (!colMap.brandName) {
    throw new Error(
      `Could not find a "Brand Name" column. Found headers: ${headers.slice(0, 8).join(", ")}${headers.length > 8 ? "..." : ""}`
    );
  }
  if (!colMap.trailing12Months) {
    throw new Error(
      `Could not find a "Trailing 12 Months" sales column. Found headers: ${headers.slice(0, 8).join(", ")}${headers.length > 8 ? "..." : ""}`
    );
  }

  const parsedRows: SmartScoutRawRow[] = [];
  for (const r of rows) {
    const brandName = String(r[colMap.brandName!] ?? "").trim();
    if (!brandName) continue;
    parsedRows.push({
      brandName,
      mainCategory: colMap.mainCategory ? (r[colMap.mainCategory] ? String(r[colMap.mainCategory]).trim() : null) : null,
      primarySubcategory: colMap.primarySubcategory ? (r[colMap.primarySubcategory] ? String(r[colMap.primarySubcategory]).trim() : null) : null,
      estMonthlyRevenue: parseNumber(r[colMap.estMonthlyRevenue!]),
      trailing12Months: parseNumber(r[colMap.trailing12Months!]),
      estMonthlySales: colMap.estMonthlySales ? parseNumber(r[colMap.estMonthlySales]) : null,
      oneMonthGrowth: colMap.oneMonthGrowth ? parseGrowth(r[colMap.oneMonthGrowth]) : null,
      twelveMonthGrowth: colMap.twelveMonthGrowth ? parseGrowth(r[colMap.twelveMonthGrowth]) : null,
      raw: r,
    });
  }

  // Category summary
  const catMap = new Map<string, { mainCategory: string; primarySubcategory: string; rowCount: number }>();
  for (const r of parsedRows) {
    if (!r.mainCategory || !r.primarySubcategory) continue;
    const key = `${r.mainCategory}|||${r.primarySubcategory}`;
    const existing = catMap.get(key);
    if (existing) existing.rowCount++;
    else catMap.set(key, { mainCategory: r.mainCategory, primarySubcategory: r.primarySubcategory, rowCount: 1 });
  }
  const categories = Array.from(catMap.values()).sort((a, b) => b.rowCount - a.rowCount);

  return {
    filename,
    rowCount: parsedRows.length,
    rows: parsedRows,
    categories,
    periodLabel: inferPeriodFromFilename(filename),
  };
}
