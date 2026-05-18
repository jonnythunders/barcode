"use client";

import { useState, useRef } from "react";
import { Upload, Check, AlertCircle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/contexts/auth-context";

interface UploadResponse {
  uploadId: string;
  filename: string;
  rowCount: number;
  sourceKind: string;
  mapping: {
    fields: Record<string, string>;
    confidence: Record<string, number>;
    allHeaders: string[];
  };
  periodLabel: string | null;
  reconcileSummary?: {
    totalRows: number;
    autoLinked: number;
    autoCreated: number;
    needsReview: number;
    alreadyLinked: number;
  } | null;
}

const FIELD_LABELS: Record<string, string> = {
  brand_col: "Brand",
  category_col: "Category",
  sales_dollars_col: "Sales $",
  sales_units_col: "Sales units",
  period_col: "Period",
  yoy_growth_col: "YoY growth %",
};

/**
 * Nielsen upload + reconciliation UI.
 *
 * Flow:
 *   1. Drop file → POST /api/nielsen/upload (with autoReconcile=1 by default)
 *   2. Show detected mapping with confidence pills
 *   3. Show reconciliation summary
 *   4. "Generate Deep Dive" button → POST /api/nielsen/deep-dive
 */
export default function NielsenPage() {
  const { token } = useAuth();
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState<UploadResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deepDiveStatus, setDeepDiveStatus] = useState<string | null>(null);
  const [deepDiveResult, setDeepDiveResult] = useState<{ reportId?: string; summary?: Record<string, number> } | null>(null);
  const [recipientEmail, setRecipientEmail] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleUpload = async () => {
    if (!file || !token) return;
    setUploading(true);
    setError(null);
    setResult(null);
    setDeepDiveResult(null);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("autoReconcile", "1");
      const res = await fetch("/api/nielsen/upload", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Upload failed (${res.status})`);
      setResult(data as UploadResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  };

  const handleGenerateDeepDive = async () => {
    if (!result || !token) return;
    setDeepDiveStatus("Generating...");
    setDeepDiveResult(null);
    try {
      const res = await fetch("/api/nielsen/deep-dive", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          uploadId: result.uploadId,
          recipientEmail: recipientEmail || undefined,
          send: !!recipientEmail,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Generation failed");
      setDeepDiveStatus("Generated");
      setDeepDiveResult(data);
    } catch (err) {
      setDeepDiveStatus(`Failed: ${err instanceof Error ? err.message : "Unknown"}`);
    }
  };

  return (
    <div className="max-w-4xl mx-auto px-6 py-8 space-y-4">
      <div>
        <p className="text-xs uppercase tracking-widest text-slate-400">Nielsen / IRI / Circana</p>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900 mt-1">
          Upload retail scan data
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          CSV, TSV, or Excel. We auto-detect the column mapping and match brand names against your
          monitored brands. Anything ambiguous lands in the reconciliation queue.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>1. Upload file</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-3">
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              accept=".csv,.tsv,.xlsx,.xls,.xlsm"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
            <Button onClick={() => fileInputRef.current?.click()} variant="outline" className="gap-1.5">
              <Upload className="w-4 h-4" />
              Choose file
            </Button>
            {file && (
              <span className="text-sm text-slate-700">
                {file.name} · {(file.size / 1024).toFixed(1)} KB
              </span>
            )}
            <div className="flex-1" />
            <Button onClick={handleUpload} disabled={!file || uploading}>
              {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : "Upload + reconcile"}
            </Button>
          </div>
          {error && (
            <div className="mt-3 border border-red-200 bg-red-50 rounded-lg p-3 flex items-start gap-2">
              <AlertCircle className="w-4 h-4 text-red-600 mt-0.5 flex-shrink-0" />
              <p className="text-sm text-red-800">{error}</p>
            </div>
          )}
        </CardContent>
      </Card>

      {result && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>2. Detected mapping</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-xs text-slate-500 mb-3">
                Source: <span className="font-medium text-slate-700">{result.sourceKind}</span>
                {result.periodLabel && (
                  <>
                    {" "}
                    · Period: <span className="font-medium text-slate-700">{result.periodLabel}</span>
                  </>
                )}
                {" "}· {result.rowCount} row{result.rowCount === 1 ? "" : "s"}
              </p>
              <table className="w-full text-sm">
                <tbody>
                  {(Object.keys(FIELD_LABELS) as Array<keyof typeof FIELD_LABELS>).map((field) => {
                    const mapped = result.mapping.fields[field];
                    const conf = result.mapping.confidence[field];
                    return (
                      <tr key={field} className="border-b border-slate-100">
                        <td className="py-2 text-slate-500 w-32">{FIELD_LABELS[field]}</td>
                        <td className="py-2">
                          {mapped ? (
                            <span className="font-mono text-xs bg-slate-100 px-2 py-0.5 rounded">
                              {mapped}
                            </span>
                          ) : (
                            <span className="text-slate-400 italic">not detected</span>
                          )}
                        </td>
                        <td className="py-2 text-right w-24">
                          {conf != null && (
                            <span
                              className={`text-[10px] uppercase tracking-widest px-2 py-0.5 rounded-full ${
                                conf >= 0.85
                                  ? "bg-green-50 text-green-700"
                                  : conf >= 0.6
                                    ? "bg-amber-50 text-amber-700"
                                    : "bg-red-50 text-red-700"
                              }`}
                            >
                              {(conf * 100).toFixed(0)}% conf.
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </CardContent>
          </Card>

          {result.reconcileSummary && (
            <Card>
              <CardHeader>
                <CardTitle>3. Brand reconciliation</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-4 gap-3">
                  <Stat label="Auto-linked" value={result.reconcileSummary.autoLinked} color="text-green-600" />
                  <Stat label="Auto-created" value={result.reconcileSummary.autoCreated} color="text-blue-600" />
                  <Stat label="Needs review" value={result.reconcileSummary.needsReview} color="text-amber-600" />
                  <Stat label="Already linked" value={result.reconcileSummary.alreadyLinked} color="text-slate-500" />
                </div>
                {result.reconcileSummary.needsReview > 0 && (
                  <p className="text-xs text-slate-500 mt-3">
                    {result.reconcileSummary.needsReview} ambiguous row
                    {result.reconcileSummary.needsReview === 1 ? "" : "s"} need confirmation. (UI for this
                    queue is coming — for now, ask Barry &quot;show me ambiguous Nielsen rows&quot;.)
                  </p>
                )}
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle>4. Generate deep dive</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm text-slate-600">
                Build the category landscape report — quadrant analysis, top brands by quadrant,
                AI-generated narrative. Optionally email it.
              </p>
              <div className="flex items-center gap-3">
                <Input
                  type="email"
                  value={recipientEmail}
                  onChange={(e) => setRecipientEmail(e.target.value)}
                  placeholder="Email to send to (optional)"
                  className="flex-1 max-w-sm"
                />
                <Button onClick={handleGenerateDeepDive} disabled={deepDiveStatus === "Generating..."}>
                  {deepDiveStatus === "Generating..." ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : recipientEmail ? (
                    "Generate + email"
                  ) : (
                    "Generate"
                  )}
                </Button>
              </div>
              {deepDiveStatus && (
                <div
                  className={`text-sm flex items-center gap-2 ${
                    deepDiveStatus.startsWith("Failed") ? "text-red-700" : "text-green-700"
                  }`}
                >
                  {deepDiveStatus.startsWith("Failed") ? (
                    <AlertCircle className="w-4 h-4" />
                  ) : (
                    <Check className="w-4 h-4" />
                  )}
                  {deepDiveStatus}
                  {deepDiveResult?.reportId && (
                    <span className="text-slate-500"> — open it from /reports.</span>
                  )}
                </div>
              )}
              {deepDiveResult?.summary && (
                <div className="grid grid-cols-4 gap-3 pt-2">
                  <Stat label="Call now" value={deepDiveResult.summary.callNow ?? 0} color="text-green-600" />
                  <Stat label="Established" value={deepDiveResult.summary.established ?? 0} color="text-cyan-700" />
                  <Stat label="Incumbent" value={deepDiveResult.summary.incumbent ?? 0} color="text-slate-600" />
                  <Stat label="Skip" value={deepDiveResult.summary.skip ?? 0} color="text-slate-400" />
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="text-center">
      <p className={`text-2xl font-bold ${color}`}>{value}</p>
      <p className="text-[10px] uppercase tracking-widest text-slate-400 mt-1">{label}</p>
    </div>
  );
}
