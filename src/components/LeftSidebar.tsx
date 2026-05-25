"use client";

import { useRouter, usePathname } from "next/navigation";
import { LayoutDashboard, Search, Sparkles, FileText, Tag, Upload } from "lucide-react";

interface NavItem {
  path: string;
  label: string;
  icon: React.ReactNode;
}

const NAV: NavItem[] = [
  { path: "/dashboard", label: "Dashboard", icon: <LayoutDashboard className="w-4 h-4" /> },
  { path: "/brand-card", label: "Brand Card", icon: <Search className="w-4 h-4" /> },
  { path: "/discovery", label: "Discovery", icon: <Sparkles className="w-4 h-4" /> },
  { path: "/nielsen", label: "Nielsen", icon: <Upload className="w-4 h-4" /> },
  { path: "/reports", label: "Reports", icon: <FileText className="w-4 h-4" /> },
  { path: "/categories", label: "Categories", icon: <Tag className="w-4 h-4" /> },
];

export function LeftSidebar() {
  const router = useRouter();
  const pathname = usePathname();

  const isActive = (path: string) => {
    if (path === "/dashboard") return pathname === "/dashboard";
    return pathname === path || pathname.startsWith(path + "/");
  };

  return (
    <div className="w-44 bg-white flex flex-col flex-shrink-0 border-r border-slate-100 print:hidden">
      <div className="px-5 pt-6 pb-5">
        <div className="flex items-center gap-2.5">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/kestrel-mark.png" alt="Kestrel" className="h-7 w-7 object-contain" />
          <div className="leading-none">
            <p className="text-[13px] font-bold tracking-tight text-slate-900">Barcode</p>
            <p className="text-[9px] font-semibold uppercase tracking-[0.18em] text-teal-700 mt-0.5">Kestrel</p>
          </div>
        </div>
      </div>
      <nav className="flex-1 flex flex-col px-3 pt-2">
        <ul className="space-y-0.5">
          {NAV.map((item) => {
            const active = isActive(item.path);
            return (
              <li key={item.path}>
                <button
                  onClick={() => router.push(item.path)}
                  className={`group relative flex items-center gap-2.5 w-full rounded-lg pl-3 pr-2 py-2 text-sm font-medium transition-all ${
                    active
                      ? "bg-slate-900 text-white"
                      : "text-slate-500 hover:text-slate-900 hover:bg-slate-50"
                  }`}
                >
                  <span
                    className={`absolute left-0 top-1/2 -translate-y-1/2 h-5 w-[3px] rounded-full bg-teal-500 transition-opacity ${
                      active ? "opacity-100" : "opacity-0"
                    }`}
                    aria-hidden="true"
                  />
                  <span className={active ? "text-teal-300" : "text-slate-400 group-hover:text-slate-600"}>
                    {item.icon}
                  </span>
                  {item.label}
                </button>
              </li>
            );
          })}
        </ul>
      </nav>
      <div className="px-5 pb-5 pt-3">
        <div className="bc-rule" aria-hidden="true" />
      </div>
    </div>
  );
}
