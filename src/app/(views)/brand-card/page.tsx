"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { slugify } from "@/lib/utils";

/**
 * Brand Card lookup — enter a brand name, get a card.
 *
 * Submitting navigates to /brand-card/[slug], which fetches /api/brand-card/[name]
 * and renders the BrandCard component.
 */
export default function BrandCardLookupPage() {
  const router = useRouter();
  const [name, setName] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    router.push(`/brand-card/${slugify(trimmed)}?q=${encodeURIComponent(trimmed)}`);
  };

  return (
    <div className="max-w-3xl mx-auto px-6 py-8 space-y-6">
      <div>
        <p className="text-xs uppercase tracking-widest text-slate-400">Brand Card</p>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900 mt-1">
          On-demand brand intelligence
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          Enter a brand name and we&apos;ll triangulate TikTok, Instagram, Amazon, Reddit, Google
          Trends, and sentiment in one snapshot.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="flex items-stretch gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Try: Olipop, Vacation Sunscreen, Magic Spoon..."
            className="pl-9"
            autoFocus
          />
        </div>
        <Button type="submit">Look up</Button>
      </form>

      <div className="bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-sm text-slate-600">
        <p className="font-medium text-slate-900 mb-1">Tip</p>
        <p>You can also ask Barry directly in the chat panel. Try “What&apos;s the latest on Liquid Death?” or “Compare Olipop and Spindrift.”</p>
      </div>
    </div>
  );
}
