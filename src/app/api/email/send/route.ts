/**
 * POST /api/email/send
 *
 * Sends a previously-approved email draft via Resend. Called by the chat UI
 * when the user clicks Send on an email preview card.
 *
 * Body: { to, subject, body, brand_slug? }
 * Auth: Bearer Supabase JWT
 *
 * Resend is optional. If RESEND_API_KEY is unset we return a 503 with a
 * clear message rather than 500 — the rest of the app should keep working.
 */
import { NextResponse } from "next/server";
import { Resend } from "resend";
import { getServerEnv, getFeatureFlags } from "@/lib/env";
import { verifyAuthToken } from "@/lib/supabase-admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    await verifyAuthToken(request);
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const env = getServerEnv();
  const flags = getFeatureFlags(env);
  if (!flags.emailEnabled) {
    return NextResponse.json(
      { error: "Email not configured. Set RESEND_API_KEY in .env.local." },
      { status: 503 }
    );
  }

  let body: { to?: string; subject?: string; body?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.to || !body.subject || !body.body) {
    return NextResponse.json({ error: "Missing to/subject/body" }, { status: 400 });
  }

  const resend = new Resend(env.resendApiKey);

  try {
    const { data, error } = await resend.emails.send({
      from: env.resendFromEmail,
      to: body.to,
      subject: body.subject,
      text: body.body,
    });
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({ success: true, id: data?.id });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
