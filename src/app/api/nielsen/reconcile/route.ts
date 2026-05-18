/**
 * POST /api/nielsen/reconcile
 *
 * Run brand reconciliation for a previously-uploaded Nielsen file.
 * Body: { uploadId, autoLinkThreshold?, autoCreateMissing? }
 *
 * Idempotent: re-running on an upload already reconciled is a no-op for
 * already-linked rows; it'll still pick up newly-added brands.
 */
import { NextResponse } from "next/server";
import { verifyAuthToken } from "@/lib/supabase-admin";
import { reconcileUploadBrands } from "@/lib/nielsen/reconcile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    await verifyAuthToken(request);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unauthorized" }, { status: 401 });
  }
  let body: { uploadId?: string; autoLinkThreshold?: number; autoCreateMissing?: boolean };
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  if (!body.uploadId) {
    return NextResponse.json({ error: "uploadId required" }, { status: 400 });
  }

  try {
    const result = await reconcileUploadBrands({
      uploadId: body.uploadId,
      autoLinkThreshold: body.autoLinkThreshold,
      autoCreateMissing: body.autoCreateMissing,
    });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}
