/**
 * Typed environment variable access + boot-time validation.
 *
 * We split env vars into three tiers:
 *   - `required`: app won't boot without these (Supabase + Anthropic).
 *   - `serverOnly`: required server-side for specific features; missing ones
 *      are logged once at boot but don't crash the app.
 *   - `public`: NEXT_PUBLIC_* — safe to expose to the browser.
 *
 * Why not zod schemas with .parse()? Because Next.js builds run this file
 * before .env.local is loaded in some contexts. We just want a fail-fast
 * read at module load time on the server and a soft warning for optional
 * server-only vars.
 */

function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v || v.length === 0) {
    throw new Error(
      `[barcode] Missing required environment variable: ${key}. ` +
        `Copy .env.example to .env.local and fill it in.`
    );
  }
  return v;
}

function optionalEnv(key: string): string | undefined {
  const v = process.env[key];
  return v && v.length > 0 ? v : undefined;
}

/**
 * `env.public` — variables safe to read on both client and server.
 * Must be `NEXT_PUBLIC_*` prefixed.
 */
export const publicEnv = {
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL || "",
  supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "",
  appUrl: process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000",
};

/**
 * `env.server` — server-only variables. Accessing this on the client throws.
 *
 * Use `getServerEnv()` inside route handlers / server components to avoid
 * pulling secrets into client bundles even by accident.
 */
let _serverEnvCache: ServerEnv | null = null;

export interface ServerEnv {
  // Core (required)
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  anthropicApiKey: string;
  // Cron
  cronSecret: string | undefined;
  // Email (optional but recommended for V1)
  resendApiKey: string | undefined;
  resendFromEmail: string;
  // Gated APIs (optional — features degrade gracefully without them)
  tiktokClientKey: string | undefined;
  tiktokClientSecret: string | undefined;
  tiktokCommercialApiKey: string | undefined;
  metaAppId: string | undefined;
  metaAppSecret: string | undefined;
  metaAccessToken: string | undefined;
  redditClientId: string | undefined;
  redditClientSecret: string | undefined;
  redditUsername: string | undefined;
  redditPassword: string | undefined;
  redditUserAgent: string;
  smartscoutApiKey: string | undefined;
  explodingTopicsApiKey: string | undefined;
  openaiApiKey: string | undefined;
}

export function getServerEnv(): ServerEnv {
  if (typeof window !== "undefined") {
    throw new Error("[barcode] getServerEnv() called from the browser. This must run server-side only.");
  }
  if (_serverEnvCache) return _serverEnvCache;

  _serverEnvCache = {
    supabaseUrl: requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    supabaseServiceRoleKey: requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    anthropicApiKey: requireEnv("ANTHROPIC_API_KEY"),
    cronSecret: optionalEnv("CRON_SECRET"),
    resendApiKey: optionalEnv("RESEND_API_KEY"),
    resendFromEmail: optionalEnv("RESEND_FROM_EMAIL") || "Barcode Intel <onboarding@resend.dev>",
    tiktokClientKey: optionalEnv("TIKTOK_CLIENT_KEY"),
    tiktokClientSecret: optionalEnv("TIKTOK_CLIENT_SECRET"),
    tiktokCommercialApiKey: optionalEnv("TIKTOK_COMMERCIAL_API_KEY"),
    metaAppId: optionalEnv("META_APP_ID"),
    metaAppSecret: optionalEnv("META_APP_SECRET"),
    metaAccessToken: optionalEnv("META_ACCESS_TOKEN"),
    redditClientId: optionalEnv("REDDIT_CLIENT_ID"),
    redditClientSecret: optionalEnv("REDDIT_CLIENT_SECRET"),
    redditUsername: optionalEnv("REDDIT_USERNAME"),
    redditPassword: optionalEnv("REDDIT_PASSWORD"),
    redditUserAgent: optionalEnv("REDDIT_USER_AGENT") || "barcode-brand-intel/0.1.0",
    smartscoutApiKey: optionalEnv("SMARTSCOUT_API_KEY"),
    explodingTopicsApiKey: optionalEnv("EXPLODING_TOPICS_API_KEY"),
    openaiApiKey: optionalEnv("OPENAI_API_KEY"),
  };
  return _serverEnvCache;
}

/**
 * Feature flags derived from which env vars are configured.
 * Use in fetcher modules to decide whether to make real API calls or
 * return a "not configured" stub.
 */
export interface FeatureFlags {
  tiktokEnabled: boolean;
  tiktokAdsEnabled: boolean;
  instagramEnabled: boolean;
  redditEnabled: boolean;
  smartscoutEnabled: boolean;
  explodingTopicsEnabled: boolean;
  emailEnabled: boolean;
}

export function getFeatureFlags(env: ServerEnv = getServerEnv()): FeatureFlags {
  return {
    tiktokEnabled: !!(env.tiktokClientKey && env.tiktokClientSecret),
    tiktokAdsEnabled: !!env.tiktokCommercialApiKey,
    instagramEnabled: !!env.metaAccessToken,
    redditEnabled: !!(env.redditClientId && env.redditClientSecret),
    smartscoutEnabled: !!env.smartscoutApiKey,
    explodingTopicsEnabled: !!env.explodingTopicsApiKey,
    emailEnabled: !!env.resendApiKey,
  };
}
