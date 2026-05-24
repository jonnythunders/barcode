"use client";

import ProtectedRoute from "@/components/ProtectedRoute";
import { ChatProvider } from "@/contexts/chat-context";
import { LeftSidebar } from "@/components/LeftSidebar";
import { AgentChat } from "@/components/AgentChat";
import { ProfileDropdown } from "@/components/ProfileDropdown";

/**
 * Three-panel layout. Same shape as Adam/Juan:
 *   LeftSidebar (160px) | AgentChat (420px) | Content (flex-1)
 */
function ViewWrapper({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex-1 overflow-hidden relative">
      <div className="absolute top-4 right-6 z-10">
        <ProfileDropdown />
      </div>
      <div className="h-full overflow-y-auto">
        <div className="h-[80px] shrink-0" aria-hidden="true" />
        {children}
      </div>
    </div>
  );
}

export default function ViewsLayout({ children }: { children: React.ReactNode }) {
  return (
    <ProtectedRoute>
      <ChatProvider>
        <div className="h-screen flex overflow-hidden bc-page-texture">
          <LeftSidebar />
          <div className="w-[420px] flex-shrink-0 pt-2.5 pl-2.5 pb-2.5 print:hidden">
            <div className="h-full">
              <AgentChat />
            </div>
          </div>
          <ViewWrapper>{children}</ViewWrapper>
        </div>
      </ChatProvider>
    </ProtectedRoute>
  );
}
