import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * `cn` — Tailwind-friendly className combiner.
 * Matches the shadcn/Adam convention so any shadcn components we import work out of the box.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Convert any string to a URL-safe slug.
 *   "Vacation Sunscreen!" -> "vacation-sunscreen"
 *   "Olipop (the prebiotic soda)" -> "olipop-the-prebiotic-soda"
 */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")    // strip punctuation
    .replace(/[\s_-]+/g, "-")    // collapse whitespace/underscores to single hyphen
    .replace(/^-+|-+$/g, "");    // trim leading/trailing hyphens
}

/**
 * Format a number with K/M/B suffix for follower-count style display.
 *   1234 -> "1.2K"
 *   1234567 -> "1.2M"
 */
export function formatCompactNumber(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return (n / 1_000_000_000).toFixed(1).replace(/\.0$/, "") + "B";
  if (abs >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (abs >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  return String(Math.round(n));
}

/**
 * Format a percentage delta with sign.
 *   0.123 -> "+12.3%"
 *   -0.05 -> "-5.0%"
 */
export function formatPctDelta(ratio: number | null | undefined): string {
  if (ratio == null || !Number.isFinite(ratio)) return "—";
  const pct = ratio * 100;
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(1)}%`;
}

/**
 * ISO timestamp helper — single source of truth so all timestamps match
 * (Adam convention).
 */
export function nowIso(): string {
  return new Date().toISOString();
}
