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
    <div className="w-40 bg-white flex flex-col flex-shrink-0 print:hidden">
      <div className="px-6 pt-6 pb-2">
        <p className="text-[11px] font-semibold uppercase tracking-widest text-slate-400">Barcode</p>
      </div>
      <nav className="flex-1 flex flex-col px-6 pt-4">
        <ul className="space-y-3">
          {NAV.map((item) => (
            <li key={item.path}>
              <button
                onClick={() => router.push(item.path)}
                className={`flex items-center gap-2.5 text-sm font-medium transition-opacity text-black ${
                  isActive(item.path) ? "opacity-100" : "opacity-35 hover:opacity-100"
                }`}
              >
                {item.icon}
                {item.label}
              </button>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}
