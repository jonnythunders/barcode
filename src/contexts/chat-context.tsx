/**
 * Chat context — manages SSE stream state, message history, and email drafts.
 *
 * Adam pattern with these adaptations:
 *   - WhatsApp removed (PRD says email-first for V1)
 *   - Emails carry an optional brand_slug (not contact_id)
 *   - Page context labels reflect Barcode's IA
 */
"use client";

import { createContext, useContext, useState, useCallback, useRef } from "react";
import { usePathname } from "next/navigation";
import { useAuth } from "@/contexts/auth-context";

// =========================================================================
// Types
// =========================================================================

interface ToolSegment {
  type: "tool";
  toolId: string;
  toolName: string;
  label: string;
  status: "running" | "done" | "error";
  result?: string;
}

interface TextSegment {
  type: "text";
  content: string;
}

export type MessageSegment = ToolSegment | TextSegment;

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  segments?: MessageSegment[];
  attachments?: { name: string; type: string }[];
}

export interface EmailDraft {
  to: string;
  subject: string;
  body: string;
  brandSlug: string | null;
}

interface ChatContextType {
  messages: ChatMessage[];
  isStreaming: boolean;
  sendMessage: (text: string, files?: File[]) => Promise<void>;
  clearChat: () => void;
  emailDraft: EmailDraft | null;
  sendEmailDraft: () => Promise<void>;
  dismissEmailDraft: () => void;
}

const ChatContext = createContext<ChatContextType>({
  messages: [],
  isStreaming: false,
  sendMessage: async () => {},
  clearChat: () => {},
  emailDraft: null,
  sendEmailDraft: async () => {},
  dismissEmailDraft: () => {},
});

// =========================================================================
// Page context strings
// =========================================================================

function getPageContext(pathname: string): string {
  if (pathname === "/dashboard") return "Dashboard — recent activity, top brands by momentum, active priorities.";
  if (pathname === "/brand-card") return "Brand Card lookup — user is about to enter a brand name to investigate.";

  const cardMatch = pathname.match(/^\/brand-card\/([^/]+)/);
  if (cardMatch)
    return `Brand Card detail — slug: ${cardMatch[1]}. Use get_brand_history if asked about trends.`;

  if (pathname === "/discovery") return "Discovery feed — newly found brands from the crawlers.";
  if (pathname === "/nielsen") return "Nielsen upload — user is uploading or reviewing a retail scan file. The list_nielsen_uploads and generate_deep_dive tools are especially relevant here.";
  if (pathname === "/reports") return "Reports archive — weekly scouting + monthly deep-dive reports.";
  if (pathname === "/categories") return "Categories admin — managing seed hashtags and subreddits.";

  return "Unknown page";
}

// =========================================================================
// Provider
// =========================================================================

export function ChatProvider({ children }: { children: React.ReactNode }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [emailDraft, setEmailDraft] = useState<EmailDraft | null>(null);
  const { token } = useAuth();
  const pathname = usePathname();
  const abortRef = useRef<AbortController | null>(null);
  const apiMessagesRef = useRef<Array<{ role: string; content: string }>>([]);

  const sendMessage = useCallback(
    async (text: string, files?: File[]) => {
      if (!token || isStreaming) return;

      const userMsg: ChatMessage = {
        role: "user",
        content: text,
        attachments: files?.map((f) => ({ name: f.name, type: f.type })),
      };
      setMessages((prev) => [...prev, userMsg]);
      apiMessagesRef.current.push({ role: "user", content: text });

      const assistantMsg: ChatMessage = { role: "assistant", content: "", segments: [] };
      setMessages((prev) => [...prev, assistantMsg]);
      setIsStreaming(true);

      const abortController = new AbortController();
      abortRef.current = abortController;

      try {
        const body: Record<string, unknown> = {
          messages: apiMessagesRef.current,
          pageContext: getPageContext(pathname),
        };

        if (files && files.length > 0) {
          const attachments = await Promise.all(
            files.map(async (f) => {
              const buffer = await f.arrayBuffer();
              const base64 = btoa(
                new Uint8Array(buffer).reduce((data, byte) => data + String.fromCharCode(byte), "")
              );
              return { name: f.name, type: f.type, data: base64 };
            })
          );
          body.attachments = attachments;
        }

        const response = await fetch("/api/chat", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(body),
          signal: abortController.signal,
        });

        if (!response.ok) throw new Error("Chat request failed");

        const reader = response.body?.getReader();
        if (!reader) throw new Error("No response body");

        const decoder = new TextDecoder();
        let buffer = "";
        const currentSegments: MessageSegment[] = [];
        let fullText = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const data = line.slice(6);
            if (data === "[DONE]") continue;

            try {
              const event = JSON.parse(data);

              if (event.type === "text_delta") {
                fullText += event.text;
                const lastSeg = currentSegments[currentSegments.length - 1];
                if (lastSeg && lastSeg.type === "text") {
                  lastSeg.content = fullText;
                } else {
                  currentSegments.push({ type: "text", content: fullText });
                }
              } else if (event.type === "tool_start") {
                currentSegments.push({
                  type: "tool",
                  toolId: event.tool_id,
                  toolName: event.tool_name,
                  label: event.label || event.tool_name,
                  status: "running",
                });
              } else if (event.type === "tool_result") {
                const seg = currentSegments.find(
                  (s) => s.type === "tool" && s.toolId === event.tool_id
                ) as ToolSegment | undefined;
                if (seg) {
                  seg.status = "done";
                  seg.result = event.result;
                  if (seg.toolName === "draft_email" && event.result) {
                    try {
                      const draft = JSON.parse(event.result);
                      if (draft.draft && draft.type === "email") {
                        setEmailDraft({
                          to: draft.to,
                          subject: draft.subject,
                          body: draft.body,
                          brandSlug: draft.brand_slug ?? null,
                        });
                      }
                    } catch {
                      // ignore parse errors
                    }
                  }
                }
                fullText = "";
              } else if (event.type === "tool_error") {
                const seg = currentSegments.find(
                  (s) => s.type === "tool" && s.toolId === event.tool_id
                ) as ToolSegment | undefined;
                if (seg) {
                  seg.status = "error";
                  seg.result = event.error;
                }
                fullText = "";
              }

              setMessages((prev) => {
                const updated = [...prev];
                const last = updated[updated.length - 1];
                if (last && last.role === "assistant") {
                  last.segments = [...currentSegments];
                  last.content = currentSegments
                    .filter((s) => s.type === "text")
                    .map((s) => (s as TextSegment).content)
                    .join("");
                }
                return updated;
              });
            } catch {
              // skip unparseable lines
            }
          }
        }

        // Capture full assistant turn (text + tool results) into the API history
        const parts: string[] = [];
        for (const seg of currentSegments) {
          if (seg.type === "tool" && seg.status === "done" && seg.result) {
            parts.push(`[Tool ${seg.toolName} result: ${seg.result}]`);
          } else if (seg.type === "text" && seg.content) {
            parts.push(seg.content);
          }
        }
        const finalContent = parts.join("\n\n");
        if (finalContent) {
          apiMessagesRef.current.push({ role: "assistant", content: finalContent });
        }
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          setMessages((prev) => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            if (last && last.role === "assistant") {
              last.content = "An error occurred. Please try again.";
              last.segments = [{ type: "text", content: last.content }];
            }
            return updated;
          });
        }
      } finally {
        setIsStreaming(false);
        abortRef.current = null;
      }
    },
    [token, pathname, isStreaming]
  );

  const clearChat = useCallback(() => {
    setMessages([]);
    apiMessagesRef.current = [];
    setEmailDraft(null);
  }, []);

  const sendEmailDraft = useCallback(async () => {
    if (!emailDraft || !token) return;
    try {
      const res = await fetch("/api/email/send", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          to: emailDraft.to,
          subject: emailDraft.subject,
          body: emailDraft.body,
          brand_slug: emailDraft.brandSlug,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: "Failed" }));
        throw new Error(data.error || "Failed to send");
      }
      const note = `Email sent to ${emailDraft.to}.`;
      setMessages((prev) => [...prev, { role: "assistant", content: note, segments: [{ type: "text", content: note }] }]);
      apiMessagesRef.current.push({
        role: "assistant",
        content: `[Email sent to ${emailDraft.to}: "${emailDraft.subject}"]`,
      });
    } catch (err) {
      const msg = `Failed to send email: ${(err as Error).message}`;
      setMessages((prev) => [...prev, { role: "assistant", content: msg, segments: [{ type: "text", content: msg }] }]);
    } finally {
      setEmailDraft(null);
    }
  }, [emailDraft, token]);

  const dismissEmailDraft = useCallback(() => {
    setEmailDraft(null);
    const note = "Email cancelled.";
    setMessages((prev) => [...prev, { role: "assistant", content: note, segments: [{ type: "text", content: note }] }]);
    apiMessagesRef.current.push({ role: "assistant", content: "[Email draft cancelled by user]" });
  }, []);

  return (
    <ChatContext.Provider
      value={{ messages, isStreaming, sendMessage, clearChat, emailDraft, sendEmailDraft, dismissEmailDraft }}
    >
      {children}
    </ChatContext.Provider>
  );
}

export function useChat() {
  return useContext(ChatContext);
}
