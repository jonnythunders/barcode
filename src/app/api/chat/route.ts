/**
 * Agentic chat loop — SSE streaming. Adam pattern, Supabase-backed.
 *
 * Flow:
 *   1. Verify Supabase auth JWT from the Authorization header.
 *   2. Load: learnings, user profile, active prios, user's categories.
 *   3. Build the system prompt.
 *   4. Stream a loop of Anthropic .messages.create + tool execution, up to
 *      MAX_ITERATIONS. Each event (text delta, tool start, tool result,
 *      tool error) flushes to the client as an SSE event.
 *   5. Done.
 *
 * Notes:
 *   - Each tool call runs server-side via the admin Supabase client.
 *   - Errors inside a tool are caught and surfaced as `tool_error` events
 *     so the model can recover; the loop continues.
 *   - We use `nodejs` runtime (not Edge) because Playwright and snoowrap
 *     need Node.
 */
import Anthropic from "@anthropic-ai/sdk";
import { getServerEnv } from "@/lib/env";
import { getAdminSupabase, verifyAuthToken } from "@/lib/supabase-admin";
import { buildSystemPrompt } from "@/lib/prompts/system-prompt";
import { TOOL_DEFINITIONS, TOOL_LABELS, executeTool, type ToolContext } from "@/lib/tools";
import type { Prio, PrioStatus } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_ITERATIONS = 25;

export async function POST(request: Request) {
  let authUserId: string;
  let email: string | undefined;
  try {
    const auth = await verifyAuthToken(request);
    authUserId = auth.authUserId;
    email = auth.email;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unauthorized";
    return new Response(JSON.stringify({ error: msg }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const body = await request.json();
  const { messages, pageContext, attachments } = body as {
    messages: Array<{ role: string; content: string }>;
    pageContext?: string;
    attachments?: Array<{ name: string; type: string; data: string }>;
  };

  const db = getAdminSupabase();

  // ---- Pre-load context ----
  const [learningsRes, profileRes, priosRes] = await Promise.all([
    db.from("learnings").select("content").order("created_at", { ascending: false }).limit(50),
    db.from("user_profiles").select("display_name, notes, language").eq("auth_user_id", authUserId).maybeSingle(),
    db
      .from("prios")
      .select("id, auth_user_id, title, entity_type, entity_id, entity_name, status, created_at, updated_at")
      .eq("auth_user_id", authUserId)
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .limit(10),
  ]);

  const learnings: string[] = (learningsRes.data ?? []).map((r: { content: string }) => r.content);
  const profile = profileRes.data;

  const prios: Prio[] = (priosRes.data ?? []).map((r: Record<string, unknown>) => ({
    id: r.id as string,
    authUserId: r.auth_user_id as string,
    title: r.title as string,
    entityType: (r.entity_type as string | null) ?? null,
    entityId: (r.entity_id as string | null) ?? null,
    entityName: (r.entity_name as string | null) ?? null,
    status: r.status as PrioStatus,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  }));

  // Optional: pull the user's salesperson row to learn what categories they cover
  let userCategories: { id: string; displayName: string }[] = [];
  if (email) {
    const { data: sp } = await db
      .from("salespeople")
      .select("category_ids")
      .ilike("email", email)
      .maybeSingle();
    if (sp?.category_ids && Array.isArray(sp.category_ids) && sp.category_ids.length > 0) {
      const { data: cats } = await db
        .from("categories")
        .select("id, display_name")
        .in("id", sp.category_ids);
      userCategories = (cats ?? []).map((c) => ({ id: c.id, displayName: c.display_name }));
    }
  }

  const toolContext: ToolContext = {
    authUserId,
    displayName: profile?.display_name ?? null,
    email: email ?? null,
  };

  const systemPrompt = buildSystemPrompt({
    learnings,
    pageContext: pageContext || "Unknown",
    userName: profile?.display_name ?? undefined,
    userNotes: profile?.notes ?? undefined,
    userLanguage: profile?.language ?? "en",
    prios,
    userCategories,
  });

  // ---- Stream ----
  const env = getServerEnv();
  const client = new Anthropic({ apiKey: env.anthropicApiKey });
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const write = (type: string, data: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type, ...data })}\n\n`));
      };

      try {
        // Build API messages (mostly identical to Adam pattern)
        const apiMessages: Anthropic.MessageParam[] = messages.map((m, idx) => {
          const role = m.role as "user" | "assistant";
          if (role === "user" && idx === messages.length - 1 && attachments && attachments.length > 0) {
            const blocks: Anthropic.ContentBlockParam[] = [];
            for (const att of attachments) {
              if (att.type.startsWith("image/")) {
                blocks.push({
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: att.type as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
                    data: att.data,
                  },
                });
              } else if (att.type === "application/pdf") {
                blocks.push({
                  type: "document",
                  source: { type: "base64", media_type: "application/pdf", data: att.data },
                } as Anthropic.ContentBlockParam);
              }
            }
            if (m.content) blocks.push({ type: "text", text: m.content });
            return { role, content: blocks };
          }
          return { role, content: m.content };
        });

        // Agentic loop
        for (let i = 0; i < MAX_ITERATIONS; i++) {
          const response = await client.messages.create({
            model: "claude-sonnet-4-6",
            max_tokens: 4096,
            system: systemPrompt,
            messages: apiMessages,
            tools: TOOL_DEFINITIONS,
          });

          let hasToolUse = false;
          const toolResults: Anthropic.ToolResultBlockParam[] = [];

          for (const block of response.content) {
            if (block.type === "text") {
              write("text_delta", { text: block.text });
            } else if (block.type === "tool_use") {
              hasToolUse = true;
              const label = TOOL_LABELS[block.name] || block.name;
              write("tool_start", { tool_id: block.id, tool_name: block.name, label });

              try {
                const result = await executeTool(
                  block.name,
                  block.input as Record<string, unknown>,
                  toolContext
                );
                const resultStr = JSON.stringify(result);
                write("tool_result", {
                  tool_id: block.id,
                  tool_name: block.name,
                  result: resultStr,
                });
                toolResults.push({
                  type: "tool_result",
                  tool_use_id: block.id,
                  content: resultStr,
                });
              } catch (err) {
                const errorMsg = err instanceof Error ? err.message : "Unknown error";
                write("tool_error", { tool_id: block.id, tool_name: block.name, error: errorMsg });
                toolResults.push({
                  type: "tool_result",
                  tool_use_id: block.id,
                  is_error: true,
                  content: `Error: ${errorMsg}`,
                });
              }
            }
          }

          if (!hasToolUse || response.stop_reason === "end_turn") {
            break;
          }

          apiMessages.push({ role: "assistant", content: response.content });
          apiMessages.push({ role: "user", content: toolResults });
        }

        write("done", {});
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : "Unknown error";
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ type: "error", error: errorMsg })}\n\n`)
        );
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
