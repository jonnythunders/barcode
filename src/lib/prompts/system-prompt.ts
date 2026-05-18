/**
 * Dynamic system-prompt builder — composes Barry's soul with runtime context.
 *
 * Matches Adam's `system-prompt.ts` pattern:
 *   soul + language + user + page context + learnings + active prios + tool guidance + current time
 *
 * The function takes everything pre-loaded by the route handler so prompt
 * construction is deterministic and synchronous.
 */
import { BARRY_SOUL } from "./soul";
import type { Prio } from "@/lib/types";

export interface SystemPromptOptions {
  learnings: string[];
  pageContext: string;
  userName?: string;
  userNotes?: string;
  userLanguage?: string;
  prios?: Prio[];
  // Optional: list of categories the current rep covers — sets default scope
  // for ambiguous queries ("show me top brands this week" → their categories).
  userCategories?: { id: string; displayName: string }[];
}

export function buildSystemPrompt(options: SystemPromptOptions): string {
  const { learnings, pageContext, userName, userNotes, userLanguage, prios, userCategories } = options;

  let prompt = BARRY_SOUL;

  // ---- Language ----
  const langCode = userLanguage || "en";
  // Barcode is US-based — we don't realistically need other languages yet, but
  // we keep the slot in case international reps join.
  const langName = langCode === "es" ? "Spanish" : "English";
  prompt += `\n\n## Language\nAlways respond in ${langName}.`;

  // ---- Current user ----
  prompt += `\n\n## Current user`;
  if (userName) prompt += `\nName: ${userName}`;
  if (userNotes) prompt += `\nNotes: ${userNotes}`;
  if (userCategories && userCategories.length > 0) {
    prompt += `\nCovers categories: ${userCategories.map((c) => c.displayName).join(", ")}`;
    prompt += `\nWhen the user asks for "top brands" or "what's new this week" without specifying a category, default to these.`;
  }

  // ---- Page context ----
  prompt += `\n\n## Current page\nThe user is viewing: ${pageContext}`;

  // ---- Learnings ----
  if (learnings.length > 0) {
    prompt += `\n\n## Learned items (remembered from previous conversations)\n`;
    prompt += learnings.map((l) => `- ${l}`).join("\n");
    prompt += `\nApply these when relevant. If a learning is no longer accurate, use remove_learning to delete it.`;
  }

  // ---- Active prios ----
  if (prios && prios.length > 0) {
    prompt += `\n\n## Active priorities for this user`;
    for (const p of prios) {
      const age = Math.floor((Date.now() - new Date(p.createdAt).getTime()) / (1000 * 60 * 60 * 24));
      const ageStr = age === 0 ? "today" : `${age}d ago`;
      const entity = p.entityName ? ` (${p.entityType}: ${p.entityName})` : "";
      prompt += `\n- [${p.id}] ${p.title}${entity} — created ${ageStr}`;
    }
    prompt += `\nWhen one of these priorities is addressed during the conversation, use update_prio_status to mark it as completed.`;
  }

  // ---- Tool guidance ----
  prompt += `\n\n## Tool usage

You have tools for looking up brands, reading time-series history, comparing
brands, drafting emails, managing reports, and managing the user's own state
(learnings, priorities, profile).

General rules:
- ALWAYS use tools to look up data — don't make up numbers or invent brands.
- If you're going to look up a brand the user just named, do it immediately.
  Don't ask "shall I look it up?" — just call lookup_brand.
- For brand lookups: prefer the brand name the user typed. Only use a slug if
  you got it from search_brands or get_brand_history.
- After creating data (a priority, a saved learning, a queued report), briefly
  confirm what you did.
- If you learn a process preference, ask whether to save it as a learning.
- For external comms: draft_email surfaces a Send/Cancel card. Never claim you
  sent something you only drafted.

Brand lookups:
- "Look up X" / "What's the latest on X" / "Tell me about X" → lookup_brand
- "How has X been trending" → get_brand_history with platform+metric
- "Compare X and Y" → compare_brands
- "Find brands like X in [category]" → search_brands

Reports:
- "Run my weekly report" / "Send me the scouting report" → queue_weekly_report
- "What did last week's report look like" → list_recent_reports

Current date/time: ${new Date().toISOString()}`;

  return prompt;
}
