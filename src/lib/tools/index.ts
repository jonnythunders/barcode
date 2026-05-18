/**
 * Tool registry — Anthropic SDK Tool definitions + executor + UI labels.
 *
 * Matches Adam's `tools/index.ts` pattern. Adding a new tool means:
 *   1. Add the tool's `Tool` schema to TOOL_DEFINITIONS
 *   2. Add a human-friendly UI label to TOOL_LABELS
 *   3. Add a case to executeTool() that dispatches to the right module
 */
import type { Tool } from "@anthropic-ai/sdk/resources/messages";

import { executeSaveLearning, executeRemoveLearning, executeGetLearnings } from "./learning-tools";
import {
  executeLookupBrand,
  executeSearchBrands,
  executeGetBrandHistory,
  executeCompareBrands,
  executeMonitorBrand,
  executeRecomputeMomentum,
} from "./brand-tools";
import {
  executeQueueWeeklyReport,
  executeListRecentReports,
  executeGetReport,
} from "./report-tools";
import {
  executeGetUserProfile,
  executeUpdateUserNotes,
  executeUpdateUserLanguage,
  executeUpdateUserDisplayName,
} from "./user-tools";
import { executeGetPrios, executeCreatePrio, executeUpdatePrioStatus } from "./prio-tools";
import { runDiscoveryForAllCategories } from "@/lib/discovery/runner";
import { buildWeeklyReport } from "@/lib/weekly-report";
import { getAdminSupabase } from "@/lib/supabase-admin";
import {
  executeListNielsenUploads,
  executeReconcileUpload,
  executeListAmbiguousRows,
  executeConfirmRowBrand,
  executeGenerateDeepDive,
} from "./nielsen-tools";

export interface ToolContext {
  authUserId: string;
  displayName: string | null;
  email: string | null;
}

// =========================================================================
// UI labels
// =========================================================================

export const TOOL_LABELS: Record<string, string> = {
  // Learning
  save_learning: "Remembering something...",
  remove_learning: "Forgetting something...",
  get_learnings: "Retrieving memory...",

  // Brands
  lookup_brand: "Looking up brand...",
  search_brands: "Searching brands...",
  get_brand_history: "Pulling history...",
  compare_brands: "Comparing brands...",
  monitor_brand: "Updating monitoring...",
  recompute_momentum: "Recomputing momentum...",

  // Discovery
  run_discovery: "Running discovery crawlers...",

  // Reports
  queue_weekly_report: "Queueing weekly report...",
  list_recent_reports: "Listing recent reports...",
  get_report: "Fetching report...",
  preview_weekly_report: "Building report preview...",

  // Nielsen
  list_nielsen_uploads: "Listing Nielsen uploads...",
  reconcile_upload: "Reconciling brand names...",
  list_ambiguous_rows: "Finding ambiguous rows...",
  confirm_row_brand: "Linking row to brand...",
  generate_deep_dive: "Generating deep dive...",

  // Communication
  draft_email: "Drafting email...",

  // Users
  get_user_profile: "Fetching profile...",
  update_user_notes: "Updating notes...",
  update_user_language: "Updating language...",
  update_user_display_name: "Updating name...",

  // Prios
  get_prios: "Fetching priorities...",
  create_prio: "Creating priority...",
  update_prio_status: "Updating priority...",
};

// =========================================================================
// Tool definitions (schemas)
// =========================================================================

export const TOOL_DEFINITIONS: Tool[] = [
  // ---------- Learning ----------
  {
    name: "save_learning",
    description:
      "Save something Barry should remember for future conversations. Use this when you discover a recurring preference, business rule, or disambiguation that should persist.",
    input_schema: {
      type: "object" as const,
      properties: { learning: { type: "string", description: "What to remember (≤2000 chars)" } },
      required: ["learning"],
    },
  },
  {
    name: "remove_learning",
    description: "Remove something from Barry's memory if it's no longer accurate.",
    input_schema: {
      type: "object" as const,
      properties: { learning: { type: "string", description: "Text of the learning to remove (exact or partial)" } },
      required: ["learning"],
    },
  },
  {
    name: "get_learnings",
    description: "Retrieve all saved learnings.",
    input_schema: { type: "object" as const, properties: {} },
  },

  // ---------- Brands ----------
  {
    name: "lookup_brand",
    description:
      "Look up a brand and return its full Brand Card: TikTok/IG/Amazon/Reddit/Trends signals, Momentum Score, sentiment, and a recommendation. Use this whenever the user asks about a specific brand. Result is cached for 6h; pass force_refresh=true to bypass cache.",
    input_schema: {
      type: "object" as const,
      properties: {
        brand_name: { type: "string", description: "The brand name as the user said it" },
        force_refresh: { type: "boolean", description: "Bypass the 6h cache and re-fetch everything" },
      },
      required: ["brand_name"],
    },
  },
  {
    name: "search_brands",
    description:
      "Search the brand database by name fragment, category, momentum threshold, or 'not in retail' filter. Returns brands ranked by latest Momentum Score (desc). Use this for queries like 'top snack brands' or 'high-momentum DTC brands not in retail yet'.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Optional name fragment to match" },
        category_slug: { type: "string", description: "Restrict to a category (e.g. 'functional-beverages')" },
        min_momentum: { type: "number", description: "Only return brands with Momentum Score >= this" },
        not_in_retail: { type: "boolean", description: "Only return brands absent from Nielsen retail data" },
        limit: { type: "number", description: "Max results (default 25, cap 100)" },
      },
    },
  },
  {
    name: "get_brand_history",
    description:
      "Get the time-series of a specific metric for a brand. Useful for 'how has X's TikTok followers trended' or 'what's Y's Amazon BSR over the past month'. Returns the raw points plus a summary delta.",
    input_schema: {
      type: "object" as const,
      properties: {
        brand_slug: { type: "string", description: "Brand slug (URL-safe). Pass this OR brand_id." },
        brand_id: { type: "string", description: "Brand UUID. Pass this OR brand_slug." },
        platform: {
          type: "string",
          description: "Platform: tiktok, instagram, amazon, google_trends, reddit, derived",
        },
        metric: {
          type: "string",
          description:
            "Metric name. Common: follower_count (tiktok/instagram), review_count/bsr_rank/star_rating (amazon), search_volume_latest (google_trends), mention_count_30d (reddit), momentum_score/sentiment_score (derived)",
        },
        days: { type: "number", description: "Lookback window in days (default 90, max 365)" },
      },
      required: ["platform", "metric"],
    },
  },
  {
    name: "compare_brands",
    description:
      "Pull Brand Cards for several brands in parallel and return a side-by-side comparison. Use when the user wants to evaluate multiple brands together.",
    input_schema: {
      type: "object" as const,
      properties: {
        brand_names: {
          type: "array",
          items: { type: "string" },
          description: "List of brand names to compare (2-6 recommended)",
        },
      },
      required: ["brand_names"],
    },
  },
  {
    name: "monitor_brand",
    description:
      "Add a brand to weekly monitoring (auto-creates if it doesn't exist) or remove it. Monitored brands are polled every Saturday night.",
    input_schema: {
      type: "object" as const,
      properties: {
        brand_name: { type: "string", description: "Brand name" },
        monitor: { type: "boolean", description: "true to enable monitoring, false to disable" },
      },
      required: ["brand_name", "monitor"],
    },
  },
  {
    name: "recompute_momentum",
    description:
      "Force a fresh Momentum Score computation from the brand's latest snapshots, without re-fetching external sources. Useful after manual data adjustments.",
    input_schema: {
      type: "object" as const,
      properties: { brand_name: { type: "string", description: "Brand name" } },
      required: ["brand_name"],
    },
  },

  // ---------- Discovery ----------
  {
    name: "run_discovery",
    description:
      "Manually trigger the discovery crawlers (TikTok hashtags + Amazon top-100 per category). Returns counts of new + re-activated brands. Use sparingly — this is also scheduled to run automatically every Saturday night.",
    input_schema: { type: "object" as const, properties: {} },
  },

  // ---------- Reports ----------
  {
    name: "queue_weekly_report",
    description:
      "Queue a weekly scouting report for a salesperson. The cron job sends it on its next run, or it can be triggered manually with the CRON_SECRET.",
    input_schema: {
      type: "object" as const,
      properties: {
        salesperson_email: { type: "string", description: "Salesperson email; omit to queue a general report" },
        category_slugs: {
          type: "array",
          items: { type: "string" },
          description: "Limit report to specific categories",
        },
      },
    },
  },
  {
    name: "list_recent_reports",
    description: "List recently generated reports.",
    input_schema: {
      type: "object" as const,
      properties: {
        kind: {
          type: "string",
          enum: ["weekly_scouting", "monthly_deep_dive", "brand_card_export"],
        },
        salesperson_email: { type: "string" },
        limit: { type: "number", description: "Default 10, cap 50" },
      },
    },
  },
  {
    name: "get_report",
    description: "Fetch a single report by ID, including its full payload.",
    input_schema: {
      type: "object" as const,
      properties: { report_id: { type: "string", description: "Report UUID" } },
      required: ["report_id"],
    },
  },
  {
    name: "preview_weekly_report",
    description:
      "Build (but DO NOT send) a weekly scouting report payload right now for inspection. Returns the structured payload only — top brands, radar, notable signals. Useful for 'show me what would go out this week' without committing to send.",
    input_schema: {
      type: "object" as const,
      properties: {
        salesperson_email: {
          type: "string",
          description: "Salesperson email; omit to preview the unscoped (all-categories) report",
        },
      },
    },
  },

  // ---------- Nielsen ----------
  {
    name: "list_nielsen_uploads",
    description: "List recent Nielsen/IRI/Circana file uploads.",
    input_schema: {
      type: "object" as const,
      properties: { limit: { type: "number", description: "Default 10, cap 50" } },
    },
  },
  {
    name: "reconcile_upload",
    description:
      "Re-run brand-name reconciliation against a Nielsen upload. Auto-links high-confidence matches; surfaces ambiguous rows for review.",
    input_schema: {
      type: "object" as const,
      properties: {
        upload_id: { type: "string", description: "Upload UUID" },
        auto_create_missing: {
          type: "boolean",
          description: "Auto-create brand rows for unmatched names. Default true.",
        },
      },
      required: ["upload_id"],
    },
  },
  {
    name: "list_ambiguous_rows",
    description:
      "List Nielsen rows where reconciliation couldn't confidently pick a brand. Use after reconcile_upload to drill into review work.",
    input_schema: {
      type: "object" as const,
      properties: {
        upload_id: { type: "string", description: "Upload UUID" },
        limit: { type: "number" },
      },
      required: ["upload_id"],
    },
  },
  {
    name: "confirm_row_brand",
    description: "Confirm a Nielsen row → brand mapping (manual override).",
    input_schema: {
      type: "object" as const,
      properties: {
        row_id: { type: "number", description: "nielsen_rows.id" },
        brand_name: { type: "string", description: "Brand name to link to" },
      },
      required: ["row_id", "brand_name"],
    },
  },
  {
    name: "generate_deep_dive",
    description:
      "Generate the monthly category Deep Dive report from a Nielsen upload. Returns a digest — quadrant counts, top Call-Now brands, AI narrative. The full report is stored and viewable on the /reports page.",
    input_schema: {
      type: "object" as const,
      properties: {
        upload_id: { type: "string", description: "Upload UUID" },
        category_slugs: {
          type: "array",
          items: { type: "string" },
          description: "Restrict to specific categories",
        },
      },
      required: ["upload_id"],
    },
  },

  // ---------- Communication ----------
  {
    name: "draft_email",
    description:
      "Draft an email for user review before sending. The user sees a preview card with Send/Cancel buttons. Use for pitch emails, brand-card share-outs, internal heads-ups.",
    input_schema: {
      type: "object" as const,
      properties: {
        to: { type: "string", description: "Recipient email address" },
        subject: { type: "string", description: "Subject line" },
        body: { type: "string", description: "Email body (plain text with newlines; markdown OK)" },
        brand_slug: { type: "string", description: "Slug of the brand this email is about, if applicable" },
      },
      required: ["to", "subject", "body"],
    },
  },

  // ---------- Users ----------
  {
    name: "get_user_profile",
    description: "Retrieve the current user's profile (display name, notes, language).",
    input_schema: { type: "object" as const, properties: {} },
  },
  {
    name: "update_user_notes",
    description: "Update the current user's notes field.",
    input_schema: {
      type: "object" as const,
      properties: { notes: { type: "string" } },
      required: ["notes"],
    },
  },
  {
    name: "update_user_language",
    description: "Set the current user's preferred language ('en' or 'es').",
    input_schema: {
      type: "object" as const,
      properties: { language: { type: "string", enum: ["en", "es"] } },
      required: ["language"],
    },
  },
  {
    name: "update_user_display_name",
    description: "Set the current user's display name.",
    input_schema: {
      type: "object" as const,
      properties: { display_name: { type: "string" } },
      required: ["display_name"],
    },
  },

  // ---------- Prios ----------
  {
    name: "get_prios",
    description: "Retrieve the current user's active priorities.",
    input_schema: { type: "object" as const, properties: {} },
  },
  {
    name: "create_prio",
    description:
      "Create a new priority for the current user. Use when the user says something like 'remind me to follow up on Olipop next week'.",
    input_schema: {
      type: "object" as const,
      properties: {
        title: { type: "string", description: "Short actionable description" },
        entity_type: { type: "string", enum: ["brand", "category", "report"], description: "Related entity kind" },
        entity_id: { type: "string", description: "Related entity ID" },
        entity_name: { type: "string", description: "Display name of the related entity" },
      },
      required: ["title"],
    },
  },
  {
    name: "update_prio_status",
    description: "Mark a priority as completed or dismissed.",
    input_schema: {
      type: "object" as const,
      properties: {
        prio_id: { type: "string", description: "Priority ID" },
        status: { type: "string", enum: ["completed", "dismissed"] },
      },
      required: ["prio_id", "status"],
    },
  },
];

// =========================================================================
// Executor
// =========================================================================

export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  context: ToolContext
): Promise<unknown> {
  switch (name) {
    // Learning
    case "save_learning":
      return executeSaveLearning(input.learning as string);
    case "remove_learning":
      return executeRemoveLearning(input.learning as string);
    case "get_learnings":
      return executeGetLearnings();

    // Brands
    case "lookup_brand":
      return executeLookupBrand({
        brand_name: input.brand_name as string,
        force_refresh: input.force_refresh as boolean | undefined,
      });
    case "search_brands":
      return executeSearchBrands({
        query: input.query as string | undefined,
        category_slug: input.category_slug as string | undefined,
        min_momentum: input.min_momentum as number | undefined,
        not_in_retail: input.not_in_retail as boolean | undefined,
        limit: input.limit as number | undefined,
      });
    case "get_brand_history":
      return executeGetBrandHistory({
        brand_slug: input.brand_slug as string | undefined,
        brand_id: input.brand_id as string | undefined,
        platform: input.platform as string,
        metric: input.metric as string,
        days: input.days as number | undefined,
      });
    case "compare_brands":
      return executeCompareBrands({ brand_names: input.brand_names as string[] });
    case "monitor_brand":
      return executeMonitorBrand({
        brand_name: input.brand_name as string,
        monitor: input.monitor as boolean,
      });
    case "recompute_momentum":
      return executeRecomputeMomentum({ brand_name: input.brand_name as string });

    // Discovery
    case "run_discovery":
      return runDiscoveryForAllCategories("on_demand");

    // Reports
    case "queue_weekly_report":
      return executeQueueWeeklyReport({
        salesperson_email: input.salesperson_email as string | undefined,
        category_slugs: input.category_slugs as string[] | undefined,
      });
    case "list_recent_reports":
      return executeListRecentReports({
        kind: input.kind as "weekly_scouting" | "monthly_deep_dive" | "brand_card_export" | undefined,
        salesperson_email: input.salesperson_email as string | undefined,
        limit: input.limit as number | undefined,
      });
    case "get_report":
      return executeGetReport({ report_id: input.report_id as string });
    case "preview_weekly_report": {
      const email = input.salesperson_email as string | undefined;
      let salespersonId: string | null = null;
      if (email) {
        const db = getAdminSupabase();
        const { data } = await db.from("salespeople").select("id").ilike("email", email).maybeSingle();
        if (!data) return { error: `No salesperson with email "${email}"` };
        salespersonId = data.id;
      }
      const payload = await buildWeeklyReport({ salespersonId });
      return {
        periodStart: payload.periodStart,
        periodEnd: payload.periodEnd,
        salesperson: payload.salesperson,
        categories: payload.categories,
        brandsConsidered: payload.brandsConsidered,
        topBrands: payload.topBrands,
        notableSignals: payload.notableSignals,
        radarCount: payload.radarBrands.length,
      };
    }

    // Nielsen
    case "list_nielsen_uploads":
      return executeListNielsenUploads({ limit: input.limit as number | undefined });
    case "reconcile_upload":
      return executeReconcileUpload({
        upload_id: input.upload_id as string,
        auto_create_missing: input.auto_create_missing as boolean | undefined,
      });
    case "list_ambiguous_rows":
      return executeListAmbiguousRows({
        upload_id: input.upload_id as string,
        limit: input.limit as number | undefined,
      });
    case "confirm_row_brand":
      return executeConfirmRowBrand({
        row_id: input.row_id as number,
        brand_name: input.brand_name as string,
      });
    case "generate_deep_dive":
      return executeGenerateDeepDive({
        upload_id: input.upload_id as string,
        category_slugs: input.category_slugs as string[] | undefined,
      });

    // Communication
    case "draft_email":
      return {
        draft: true,
        type: "email",
        to: input.to as string,
        subject: input.subject as string,
        body: input.body as string,
        brand_slug: (input.brand_slug as string | undefined) ?? null,
      };

    // Users
    case "get_user_profile":
      return executeGetUserProfile(context.authUserId);
    case "update_user_notes":
      return executeUpdateUserNotes(context.authUserId, input.notes as string);
    case "update_user_language":
      return executeUpdateUserLanguage(context.authUserId, input.language as string);
    case "update_user_display_name":
      return executeUpdateUserDisplayName(context.authUserId, input.display_name as string);

    // Prios
    case "get_prios":
      return executeGetPrios(context.authUserId);
    case "create_prio":
      return executeCreatePrio(context.authUserId, {
        title: input.title as string,
        entityType: input.entity_type as string | undefined,
        entityId: input.entity_id as string | undefined,
        entityName: input.entity_name as string | undefined,
      });
    case "update_prio_status":
      return executeUpdatePrioStatus(
        context.authUserId,
        input.prio_id as string,
        input.status as "completed" | "dismissed"
      );

    default:
      return { error: `Unknown tool: ${name}` };
  }
}
