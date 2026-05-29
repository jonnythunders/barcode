/**
 * Small flags for brand list/triage views (dashboard, discovery).
 *
 * These exist so a rep can scan a list and instantly see WHAT each brand is and
 * whether it's already been dealt with — without opening the card. The detail
 * card is for digging in; these flags are for triage at a glance.
 */
import { Archive } from "lucide-react";

export type BrandTypeValue = "dtc_brand" | "retail_brand" | "amazon_supplier" | "unknown" | null;

/** Compact brand-type flag. Returns null for unknown/missing so lists stay clean. */
export function BrandTypeFlag({ type }: { type: BrandTypeValue }) {
  if (!type || type === "unknown") return null;
  const cfg = {
    dtc_brand: { label: "DTC", cls: "bg-teal-50 text-teal-700" },
    retail_brand: { label: "In retail", cls: "bg-indigo-50 text-indigo-700" },
    amazon_supplier: { label: "Amazon supplier", cls: "bg-slate-200 text-slate-600" },
  }[type];
  return (
    <span className={`text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full font-medium flex-shrink-0 ${cfg.cls}`}>
      {cfg.label}
    </span>
  );
}

/** "Deprioritized" flag for brands the team has buried (kept visible-but-dimmed
 *  in browse views, hidden only from the weekly to-do). */
export function DeprioritizedFlag() {
  return (
    <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full font-medium bg-slate-100 text-slate-500 flex-shrink-0">
      <Archive className="w-2.5 h-2.5" />
      Deprioritized
    </span>
  );
}
