"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/contexts/auth-context";
import { getSupabaseClient } from "@/lib/supabase";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Eye } from "lucide-react";

interface ReportRow {
  id: string;
  kind: string;
  period_start: string | null;
  period_end: string | null;
  status: string;
  sent_at: string | null;
  recipient_email: string | null;
  rendered_html: string | null;
  created_at: string;
}

export default function ReportsPage() {
  const [reports, setReports] = useState<ReportRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const { token } = useAuth();

  useEffect(() => {
    const supabase = getSupabaseClient();
    supabase
      .from("reports")
      .select("id, kind, period_start, period_end, status, sent_at, recipient_email, rendered_html, created_at")
      .order("created_at", { ascending: false })
      .limit(50)
      .then(({ data }) => {
        setReports((data ?? []) as ReportRow[]);
        setLoading(false);
      });
  }, []);

  const handlePreview = async (id: string) => {
    if (!token) return;
    setPreviewId(id);
    setPreviewHtml(null);
    setPreviewLoading(true);
    try {
      const res = await fetch(`/api/reports/${id}/html`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        setPreviewHtml(`<p style="padding:24px;font-family:sans-serif;color:#dc2626">Failed to load (${res.status})</p>`);
      } else {
        setPreviewHtml(await res.text());
      }
    } finally {
      setPreviewLoading(false);
    }
  };

  return (
    <div className="max-w-4xl mx-auto px-6 py-8 space-y-4">
      <div>
        <p className="text-xs uppercase tracking-widest text-slate-400">Reports</p>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900 mt-1">
          Weekly + monthly intelligence reports
        </h1>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Recent</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-sm text-slate-400">Loading...</p>
          ) : reports.length === 0 ? (
            <p className="text-sm text-slate-500">
              No reports yet. Ask Barry to “queue a weekly report” or wait for Monday morning&apos;s cron.
            </p>
          ) : (
            <ul className="divide-y divide-slate-100 -mx-5">
              {reports.map((r) => (
                <li key={r.id} className="px-5 py-2.5 flex items-center justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-slate-900">{r.kind.replace(/_/g, " ")}</p>
                    <p className="text-xs text-slate-500 truncate">
                      {r.period_start && r.period_end
                        ? `${r.period_start} → ${r.period_end}`
                        : new Date(r.created_at).toLocaleString()}
                      {r.recipient_email ? ` · ${r.recipient_email}` : ""}
                    </p>
                  </div>
                  <span
                    className={`text-[10px] uppercase tracking-widest px-2 py-1 rounded-full ${
                      r.status === "sent"
                        ? "bg-green-50 text-green-700"
                        : r.status === "failed"
                          ? "bg-red-50 text-red-700"
                          : "bg-slate-100 text-slate-600"
                    }`}
                  >
                    {r.status}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handlePreview(r.id)}
                    className="gap-1.5"
                    disabled={r.status === "failed"}
                  >
                    <Eye className="w-3.5 h-3.5" />
                    Preview
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {previewId && (
        <Card>
          <CardHeader className="flex items-center justify-between flex-row">
            <CardTitle>Preview</CardTitle>
            <button
              onClick={() => {
                setPreviewId(null);
                setPreviewHtml(null);
              }}
              className="text-xs text-slate-500 hover:text-slate-900 transition-colors"
            >
              Close
            </button>
          </CardHeader>
          <CardContent className="p-0">
            {previewLoading ? (
              <p className="text-sm text-slate-400 p-6">Loading…</p>
            ) : previewHtml ? (
              <iframe
                title="report preview"
                srcDoc={previewHtml}
                sandbox=""
                className="w-full h-[700px] border-0 rounded-b-xl"
              />
            ) : (
              <p className="text-sm text-slate-500 p-6">No preview available.</p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
