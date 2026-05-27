/**
 * Shared domain types for Barcode Brand Intelligence Platform.
 *
 * Database row types should be auto-generated from Supabase:
 *   npm run db:types
 * That will produce `src/lib/database.types.ts` with strict Row/Insert/Update
 * types per table. Until then, the types below are hand-written from the
 * migration schema and should match.
 */

// ============================================================================
// Enum mirrors (must match supabase/migrations/0001_initial_schema.sql)
// ============================================================================

export type PlatformKind =
  | "tiktok"
  | "instagram"
  | "amazon"
  | "google_trends"
  | "reddit"
  | "shopify"
  | "exploding_topics"
  | "smartscout"
  | "nielsen"
  | "derived";

export type ReportKind = "weekly_scouting" | "monthly_deep_dive" | "brand_card_export";
export type ReportStatus = "pending" | "generating" | "sent" | "failed";
export type PrioStatus = "active" | "completed" | "dismissed";
export type DiscoverySource =
  | "manual"
  | "tiktok_hashtag"
  | "amazon_top100"
  | "reddit_mention"
  | "shopify_bestseller"
  | "exploding_topics"
  | "nielsen_upload";

// ============================================================================
// Core entities
// ============================================================================

export interface Brand {
  id: string;
  name: string;
  slug: string;
  tiktokHandle: string | null;
  instagramHandle: string | null;
  amazonBrand: string | null;
  amazonAsinSeed: string | null;
  shopifyUrl: string | null;
  websiteUrl: string | null;
  primaryCategoryId: string | null;
  discoverySource: DiscoverySource;
  firstSeenAt: string; // ISO
  tags: string[];
  notes: string | null;
  isMonitored: boolean;
  isArchived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Category {
  id: string;
  slug: string;
  displayName: string;
  description: string | null;
  tiktokHashtags: string[];
  subreddits: string[];
  amazonCategoryUrls: string[];
  googleTrendsKeywords: string[];
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Snapshot {
  id: number;
  brandId: string;
  platform: PlatformKind;
  metric: string;
  valueNumeric: number | null;
  valueText: string | null;
  valueJson: unknown | null;
  capturedAt: string;
  sourceUrl: string | null;
  fetcherRunId: string | null;
}

export interface Salesperson {
  id: string;
  authUserId: string | null;
  displayName: string;
  email: string;
  categoryIds: string[];
  isActive: boolean;
  weeklyReportEnabled: boolean;
  weeklyReportDay: number;
  weeklyReportHour: number;
  timezone: string;
  createdAt: string;
  updatedAt: string;
}

export interface Report {
  id: string;
  kind: ReportKind;
  salespersonId: string | null;
  categoryId: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  payload: unknown;
  renderedHtml: string | null;
  status: ReportStatus;
  sentAt: string | null;
  recipientEmail: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Prio {
  id: string;
  authUserId: string;
  title: string;
  entityType: string | null;
  entityId: string | null;
  entityName: string | null;
  status: PrioStatus;
  createdAt: string;
  updatedAt: string;
}

// ============================================================================
// Brand Card — the canonical Brand Card output shape (PRD §4.5)
//
// This is what the Brand Card endpoint returns, what the agent's
// `lookup_brand` tool returns, and what we cache in `brand_card_cache.payload`.
// ============================================================================

export interface BrandCard {
  brand: {
    id: string;
    name: string;
    slug: string;
    primaryCategory: string | null;
  };
  resolved: {
    tiktokHandle: string | null;
    instagramHandle: string | null;
    amazonBrand: string | null;
    websiteUrl: string | null;
    resolutionConfidence: "high" | "medium" | "low" | "manual" | "unresolved";
  };
  tiktok: PlatformBlock & {
    followerCount?: number;
    followingCount?: number;
    likesCount?: number;
    videoCount?: number;
    bio?: string;
    isVerified?: boolean;
    engagementRate?: number;        // % across recent N videos
    topVideos?: TikTokVideoSummary[];
    adPresence?: TikTokAdSummary;
  };
  instagram: PlatformBlock & {
    followerCount?: number;
    postCount?: number;
    bio?: string;
    followerTrend?: TrendPoint[];   // from internal snapshot history
  };
  amazon: PlatformBlock & {
    starRating?: number;
    reviewCount?: number;
    bsrRank?: number;
    bsrCategory?: string;
    boughtPastMonth?: string;       // e.g. "1,000+"
    productUrl?: string;
  };
  googleTrends: PlatformBlock & {
    searchVolumeTrend?: TrendPoint[];
    yoyChangePct?: number;
  };
  reddit: PlatformBlock & {
    mentionCount?: number;          // last 30d
    velocity?: number;              // mentions/week vs 4-wk avg, %
    topThreads?: RedditThreadSummary[];
  };
  sentiment: PlatformBlock & {
    overallScore?: number;          // -1 to 1
    positiveThemes?: string[];
    negativeThemes?: string[];
    sampleSize?: number;
  };
  /**
   * Real commerce signals sourced from SmartScout (Amazon) and Nielsen
   * (retail scan) data. These are the figures we can stand behind today —
   * deliberately distinct from the social/sentiment platform blocks, which
   * are sample data in the preview build. Rendered as the card's hero.
   */
  commerce?: {
    amazonAnnualSales?: number;
    amazonYoyGrowthPct?: number;
    amazonMonthlyUnits?: number;
    retailAnnualSales?: number;
    retailYoyGrowthPct?: number | null;
    retailPresence?: "None" | "Minimal" | "Emerging" | "Established";
    /** e.g. "SmartScout × Nielsen xAOC · Apr 2026" */
    sourceLabel?: string;
  };
  momentumScore: {
    score: number | null;           // 0–100, null if insufficient data
    breakdown?: Record<string, number>;
    asOf: string;                   // ISO
    /** What the score is actually computed from, for honest disclosure. */
    basis?: "commerce" | "commerce_plus_social";
  };
  narrative: string | null;         // 2–3 sentence AI summary (Claude)
  recommendedAction: "call_now" | "watch" | "skip" | null;
  generatedAt: string;
  partial: boolean;                 // true if any platform fetch failed
  errors: Record<string, string>;   // platform -> error message
}

export interface PlatformBlock {
  status: "ok" | "not_configured" | "error" | "not_found" | "skipped";
  capturedAt?: string;
  error?: string;
  /**
   * Data provenance, for honest labeling in the UI.
   *   "sourced" — derived from a real connected data source (SmartScout, Nielsen)
   *   "sample"  — representative sample data shown in preview; NOT yet a live feed
   * When omitted, the UI treats the block as "sample" (fail-safe: never imply
   * a number is real unless we explicitly say so).
   */
  provenance?: "sourced" | "sample";
  /** Short source label shown when provenance==="sourced", e.g. "SmartScout". */
  sourceLabel?: string;
}

export interface TikTokVideoSummary {
  id: string;
  url?: string;
  views: number;
  likes: number;
  shares: number;
  comments: number;
  postedAt?: string;
}

export interface TikTokAdSummary {
  hasActiveAds: boolean;
  estimatedReach?: string;          // e.g. "100K–500K"
  adCount?: number;
}

export interface RedditThreadSummary {
  title: string;
  subreddit: string;
  upvotes: number;
  commentCount: number;
  url: string;
  postedAt: string;
}

export interface TrendPoint {
  date: string;                     // ISO date
  value: number;
}

// ============================================================================
// Momentum Score (PRD §5.2)
// ============================================================================

export interface MomentumWeights {
  tiktokGrowth: number;       // default 0.25
  tiktokEngagement: number;   // default 0.15
  instagramGrowth: number;    // default 0.15
  amazonVelocity: number;     // default 0.20
  googleTrendsGrowth: number; // default 0.10
  redditVelocity: number;     // default 0.10
  sentiment: number;          // default 0.05
}

export const DEFAULT_MOMENTUM_WEIGHTS: MomentumWeights = {
  tiktokGrowth: 0.25,
  tiktokEngagement: 0.15,
  instagramGrowth: 0.15,
  amazonVelocity: 0.20,
  googleTrendsGrowth: 0.10,
  redditVelocity: 0.10,
  sentiment: 0.05,
};

export interface MomentumScoreResult {
  brandId: string;
  score: number | null;             // 0–100, null if too little data
  components: Partial<Record<keyof MomentumWeights, number>>;
  notInRetail: boolean;             // bonus signal: present in social/amazon, absent from nielsen
  computedAt: string;
}

// ============================================================================
// Quadrant analysis (PRD §6.3)
// ============================================================================

export type Quadrant =
  | "call_now"          // HIGH social, LOW retail
  | "established"       // HIGH social, HIGH retail
  | "incumbent"         // LOW social, HIGH retail
  | "skip";             // LOW social, LOW retail

export interface QuadrantEntry {
  brandId: string;
  brandName: string;
  socialMomentum: number;           // 0–100
  retailVelocity: number;           // 0–100
  quadrant: Quadrant;
}

// ============================================================================
// Fetcher results (what each fetcher returns)
// ============================================================================

export interface FetcherResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
  capturedAt: string;
  sourceUrl?: string;
}
