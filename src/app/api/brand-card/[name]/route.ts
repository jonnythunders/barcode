/**
 * GET /api/brand-card/[name]
 *
 * On-demand brand intelligence lookup. Returns the BrandCard JSON for the
 * given brand name. Triggers the full orchestration if the cache is stale
 * or missing.
 *
 * Query params:
 *   ?refresh=1                 — bypass cache, force fresh fetch
 *   ?tiktok=<handle>           — override TikTok handle resolution
 *   ?instagram=<handle>        — override IG handle resolution
 *   ?amazon=<brand>            — override Amazon brand-name search
 *   ?website=<url>             — override Shopify domain
 *
 * Auth:
 *   In V1 (no auth yet), this endpoint is open. When we add Supabase Auth,
 *   wrap with verifyAuthToken() like Adam/Juan do.
 *
 * Errors:
 *   - 400 if brand name missing
 *   - 500 if orchestrator throws an unrecoverable error (cache write failed,
 *     DB unreachable, etc.). Per-fetcher failures DO NOT produce a 500;
 *     they show up inside the BrandCard as `partial:true` + `errors:{...}`.
 */
import { NextResponse } from "next/server";
import { getBrandCard } from "@/lib/brand-card";
import { getDismissalForBrand } from "@/lib/deprioritize";

export const dynamic = "force-dynamic";
export const runtime = "nodejs"; // Playwright + snoowrap need Node, not Edge

export async function GET(
  request: Request,
  ctx: { params: Promise<{ name: string }> }
) {
  try {
    const { name } = await ctx.params;
    const brandName = decodeURIComponent(name).trim();
    if (!brandName) {
      return NextResponse.json({ error: "brand name required" }, { status: 400 });
    }

    const url = new URL(request.url);
    // NOTE: live fetchers (TikTok/IG/Amazon) require API credentials that are
    // not configured in this environment. Honoring ?refresh=1 would overwrite
    // the curated cached card with failed live fetches, so refresh is disabled
    // until those credentials are wired up. Remove this line to re-enable.
    const forceRefresh = false; // url.searchParams.get("refresh") === "1";

    const overrides = {
      tiktokHandle: url.searchParams.get("tiktok") || undefined,
      instagramHandle: url.searchParams.get("instagram") || undefined,
      amazonBrand: url.searchParams.get("amazon") || undefined,
      websiteUrl: url.searchParams.get("website") || undefined,
    };
    const hasAnyOverride = Object.values(overrides).some(Boolean);

    const card = await getBrandCard({
      brandName,
      forceRefresh,
      override: hasAnyOverride ? overrides : undefined,
    });

    // Attach current deprioritization state (if any) so the card can render the
    // dismissed banner + undo without a second request.
    const dismissal = card.brand?.id ? await getDismissalForBrand(card.brand.id) : null;
    const cardWithDismissal = { ...card, dismissal };

    return NextResponse.json(cardWithDismissal, {
      headers: {
        // 5-minute browser cache; longer is fine since the underlying cache
        // has a 6h TTL, but Brand Card consumers might want to refresh
        // quickly when they tweak handles.
        "Cache-Control": "private, max-age=300",
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`[/api/brand-card/[name]] ${message}`, err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
