"use client";

import { useState } from "react";
import { LogOut, User as UserIcon } from "lucide-react";
import { useAuth } from "@/contexts/auth-context";

export function ProfileDropdown() {
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);

  if (!user) return null;

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-8 h-8 rounded-full bg-slate-900 text-white flex items-center justify-center hover:bg-slate-800 transition-colors"
        aria-label="Open profile menu"
      >
        <UserIcon className="w-4 h-4" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute top-full right-0 mt-2 w-56 bg-white border border-slate-200 rounded-lg shadow-lg z-20 overflow-hidden">
            <div className="px-3 py-2 border-b border-slate-100">
              <p className="text-xs text-slate-500">Signed in as</p>
              <p className="text-sm font-medium text-slate-900 truncate">{user.email}</p>
            </div>
            <button
              onClick={async () => {
                setOpen(false);
                await logout();
              }}
              className="flex items-center gap-2 w-full px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 transition-colors"
            >
              <LogOut className="w-4 h-4" />
              Sign out
            </button>
          </div>
        </>
      )}
    </div>
  );
}
