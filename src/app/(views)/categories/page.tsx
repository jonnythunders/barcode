"use client";

import { useEffect, useState } from "react";
import { getSupabaseClient } from "@/lib/supabase";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface CategoryRow {
  id: string;
  slug: string;
  display_name: string;
  description: string | null;
  tiktok_hashtags: string[];
  subreddits: string[];
  amazon_category_urls: string[];
  google_trends_keywords: string[];
  is_active: boolean;
}

export default function CategoriesPage() {
  const [cats, setCats] = useState<CategoryRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const supabase = getSupabaseClient();
    supabase
      .from("categories")
      .select("*")
      .order("display_name")
      .then(({ data }) => {
        setCats(data ?? []);
        setLoading(false);
      });
  }, []);

  return (
    <div className="max-w-4xl mx-auto px-6 py-8 space-y-4">
      <div>
        <p className="text-xs uppercase tracking-widest text-slate-400">Categories</p>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900 mt-1">
          Discovery seeds per category
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          Hashtags and subreddits below drive the discovery engine. Edit in Supabase directly
          for now (a UI editor is coming after Phase 5).
        </p>
      </div>

      {loading ? (
        <p className="text-sm text-slate-400">Loading...</p>
      ) : (
        cats.map((c) => (
          <Card key={c.id}>
            <CardHeader>
              <CardTitle>{c.display_name}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              {c.description && <p className="text-slate-600">{c.description}</p>}
              {c.tiktok_hashtags.length > 0 && (
                <div>
                  <p className="text-[10px] uppercase tracking-widest text-slate-400 mb-1">TikTok hashtags</p>
                  <div className="flex flex-wrap gap-1">
                    {c.tiktok_hashtags.map((h) => (
                      <span key={h} className="px-2 py-0.5 text-xs bg-slate-100 text-slate-700 rounded-full">
                        #{h}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {c.subreddits.length > 0 && (
                <div>
                  <p className="text-[10px] uppercase tracking-widest text-slate-400 mb-1">Subreddits</p>
                  <div className="flex flex-wrap gap-1">
                    {c.subreddits.map((s) => (
                      <span key={s} className="px-2 py-0.5 text-xs bg-slate-100 text-slate-700 rounded-full">
                        r/{s}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {c.google_trends_keywords.length > 0 && (
                <div>
                  <p className="text-[10px] uppercase tracking-widest text-slate-400 mb-1">Trends keywords</p>
                  <div className="flex flex-wrap gap-1">
                    {c.google_trends_keywords.map((k) => (
                      <span key={k} className="px-2 py-0.5 text-xs bg-slate-100 text-slate-700 rounded-full">
                        {k}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}
