/**
 * Barry — the agent chat panel.
 *
 * Adam pattern, simplified: no voice input (deferred), no WhatsApp preview.
 * Email draft preview is preserved.
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AlertCircle, Check, Loader2, Mail, Paperclip, Send, X } from "lucide-react";
import {
  useChat,
  type ChatMessage,
  type EmailDraft,
  type MessageSegment,
} from "@/contexts/chat-context";

const PAGE_LABELS: Record<string, string> = {
  "/dashboard": "Dashboard",
  "/brand-card": "Brand Card",
  "/discovery": "Discovery",
  "/reports": "Reports",
  "/categories": "Categories",
};

function getContextLabel(pathname: string): string | null {
  for (const [path, label] of Object.entries(PAGE_LABELS)) {
    if (pathname === path || pathname.startsWith(path + "/")) return label;
  }
  return null;
}

export function AgentChat() {
  const {
    messages,
    isStreaming,
    sendMessage,
    clearChat,
    emailDraft,
    sendEmailDraft,
    dismissEmailDraft,
  } = useChat();
  const pathname = usePathname();
  const [input, setInput] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const contextLabel = getContextLabel(pathname);

  // Context-aware sample prompts shown in the empty state. Clicking one sends
  // it straight to Barry — gives people an obvious way to start.
  const samplePrompts: string[] = (() => {
    if (pathname.startsWith("/discovery"))
      return [
        "Why is HomLand scored so high?",
        "Which brands aren’t in retail yet?",
        "Summarize this week’s top prospects",
      ];
    if (pathname.startsWith("/reports"))
      return [
        "Queue a weekly scouting report",
        "What changed since last week?",
        "Draft an intro email to SEED",
      ];
    if (pathname.startsWith("/brand-card"))
      return [
        "Look up SEED",
        "Compare Momentous and Summer Fridays",
        "Is this brand worth calling?",
      ];
    if (pathname.startsWith("/nielsen"))
      return [
        "Which categories are heating up?",
        "Show brands missing from retail",
        "Compare SEED to the category average",
      ];
    // Dashboard / default
    return [
      "Look up SEED",
      "Compare Momentous and Summer Fridays",
      "Which brands should I call first?",
    ];
  })();

  const sendPrompt = useCallback(
    (text: string) => {
      if (isStreaming) return;
      sendMessage(text);
    },
    [isStreaming, sendMessage]
  );

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    const ta = textareaRef.current;
    if (ta) {
      ta.style.height = "auto";
      ta.style.height = Math.min(ta.scrollHeight, 150) + "px";
    }
  }, [input]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text && files.length === 0) return;
    setInput("");
    setFiles([]);
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    await sendMessage(text, files.length > 0 ? files : undefined);
  }, [input, files, sendMessage]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div
      className="flex flex-col h-full border border-slate-200 rounded-lg bg-white relative"
      onDragOver={(e) => {
        e.preventDefault();
        setIsDragOver(true);
      }}
      onDragLeave={() => setIsDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setIsDragOver(false);
        setFiles((prev) => [...prev, ...Array.from(e.dataTransfer.files)]);
      }}
    >
      {/* Header */}
      <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-full bg-slate-900 flex items-center justify-center">
            <span className="text-xs font-bold text-white">B</span>
          </div>
          <span className="text-sm font-medium text-slate-900">Barry</span>
          {contextLabel && (
            <span className="px-2 py-0.5 text-xs bg-slate-100 rounded-full text-slate-500">
              {contextLabel}
            </span>
          )}
        </div>
        {messages.length > 0 && (
          <button
            onClick={clearChat}
            className="text-[11px] text-slate-400 hover:text-slate-600 transition-colors"
          >
            Clear
          </button>
        )}
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-center px-2">
            <div className="w-12 h-12 rounded-full bg-slate-900 flex items-center justify-center mb-3">
              <span className="text-lg font-bold text-white">B</span>
            </div>
            <p className="text-sm text-slate-600 max-w-[260px]">
              I&apos;m Barry, the analyst inside Barcode Kestrel. Ask me to look up a brand,
              compare a few, or queue a report.
            </p>
            <div className="mt-5 w-full max-w-[280px] space-y-2">
              <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-400">
                Try asking
              </p>
              {samplePrompts.map((p) => (
                <button
                  key={p}
                  onClick={() => sendPrompt(p)}
                  disabled={isStreaming}
                  className="group flex w-full items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-left text-[13px] text-slate-700 transition-all hover:border-teal-300 hover:bg-teal-50/50 disabled:opacity-50"
                >
                  <span className="text-teal-600 group-hover:translate-x-0.5 transition-transform">→</span>
                  <span className="flex-1">{p}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg, i) => (
          <MessageBubble key={i} message={msg} />
        ))}

        {isStreaming &&
          messages[messages.length - 1]?.role === "assistant" &&
          !messages[messages.length - 1]?.content &&
          !messages[messages.length - 1]?.segments?.length && (
            <div className="flex items-center gap-1 pl-2">
              <div className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
              <div className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
              <div className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
            </div>
          )}

        {emailDraft && (
          <EmailPreviewCard
            draft={emailDraft}
            onSend={sendEmailDraft}
            onCancel={dismissEmailDraft}
          />
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Drag overlay */}
      {isDragOver && (
        <div className="absolute inset-0 bg-blue-50/90 border-2 border-dashed border-blue-300 rounded-lg flex items-center justify-center z-10">
          <p className="text-blue-600 font-medium">Drop files here</p>
        </div>
      )}

      {/* Input */}
      <div className="px-3 pb-3 pt-2">
        <div className="border border-slate-200 rounded-2xl bg-slate-50 focus-within:bg-white focus-within:border-slate-300 focus-within:shadow-sm transition-all">
          {files.length > 0 && (
            <div className="px-3 pt-3 pb-1 flex flex-wrap gap-1">
              {files.map((f, i) => (
                <span key={i} className="inline-flex items-center gap-1 px-2 py-0.5 bg-slate-100 rounded text-xs text-slate-600">
                  {f.name.length > 20 ? f.name.slice(0, 20) + "..." : f.name}
                  <button onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))} className="hover:text-slate-900">
                    <X className="w-3 h-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask Barry to look up a brand..."
            rows={1}
            className="w-full bg-transparent border-none focus:outline-none resize-none px-4 pt-3 pb-1 text-sm placeholder:text-slate-400"
            disabled={isStreaming}
          />
          <div className="flex items-center justify-between px-2 pb-2">
            <div className="flex items-center gap-0.5">
              <button onClick={() => fileInputRef.current?.click()} className="p-1.5 text-slate-400 hover:text-slate-600 transition-colors">
                <Paperclip className="w-4 h-4" />
              </button>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={(e) => {
                  if (e.target.files) setFiles((prev) => [...prev, ...Array.from(e.target.files!)]);
                }}
                accept="image/*,.pdf,.csv,.xlsx"
              />
            </div>
            <button
              onClick={handleSend}
              disabled={isStreaming || (!input.trim() && files.length === 0)}
              className="p-1.5 text-slate-400 hover:text-slate-900 transition-colors disabled:opacity-30"
            >
              {isStreaming ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// =========================================================================
// Sub-components
// =========================================================================

function MessageBubble({ message }: { message: ChatMessage }) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] bg-slate-900 text-white px-3 py-2 rounded-xl rounded-br-sm text-sm">
          {message.content}
          {message.attachments && message.attachments.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {message.attachments.map((a, i) => (
                <span key={i} className="text-xs bg-white/20 px-1.5 py-0.5 rounded">
                  {a.name}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }
  return (
    <div className="flex justify-start">
      <div className="max-w-[90%] space-y-2">
        {message.segments?.map((seg, i) => <SegmentBlock key={i} segment={seg} />)}
        {(!message.segments || message.segments.length === 0) && message.content && (
          <div className="bg-slate-100 px-3 py-2 rounded-xl rounded-bl-sm text-sm prose prose-sm prose-slate max-w-none">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
          </div>
        )}
      </div>
    </div>
  );
}

function SegmentBlock({ segment }: { segment: MessageSegment }) {
  if (segment.type === "text") {
    return (
      <div className="bg-slate-100 px-3 py-2 rounded-xl rounded-bl-sm text-sm prose prose-sm prose-slate max-w-none">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{segment.content}</ReactMarkdown>
      </div>
    );
  }
  const icon =
    segment.status === "running" ? (
      <Loader2 className="w-3 h-3 animate-spin text-amber-600" />
    ) : segment.status === "done" ? (
      <Check className="w-3 h-3 text-green-600" />
    ) : (
      <AlertCircle className="w-3 h-3 text-red-600" />
    );
  return (
    <div className="flex items-center gap-1.5 px-2 py-1 bg-slate-50 rounded-lg border border-slate-100">
      {icon}
      <span className="text-xs text-slate-500">{segment.label}</span>
    </div>
  );
}

function EmailPreviewCard({
  draft,
  onSend,
  onCancel,
}: {
  draft: EmailDraft;
  onSend: () => void;
  onCancel: () => void;
}) {
  const [sending, setSending] = useState(false);
  return (
    <div className="bg-white border border-blue-200 rounded-xl overflow-hidden shadow-sm">
      <div className="flex items-center gap-2 px-4 py-2.5 bg-blue-50 border-b border-blue-100">
        <Mail className="w-4 h-4 text-blue-600" />
        <span className="text-sm font-medium text-blue-900">Email Preview</span>
      </div>
      <div className="px-4 py-3 space-y-2">
        <div className="flex items-center gap-2 text-xs">
          <span className="text-slate-400 w-10">To</span>
          <span className="text-slate-700">{draft.to}</span>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <span className="text-slate-400 w-10">Subject</span>
          <span className="text-slate-700 font-medium">{draft.subject}</span>
        </div>
        <div className="border-t border-slate-100 pt-2 mt-2">
          <p className="text-sm text-slate-700 whitespace-pre-line leading-relaxed">{draft.body}</p>
        </div>
      </div>
      <div className="flex items-center justify-between px-4 py-2.5 bg-slate-50 border-t border-slate-100">
        <p className="text-xs text-slate-400">You can chat to ask for changes</p>
        <div className="flex gap-2">
          <button onClick={onCancel} className="px-3 py-1.5 text-xs font-medium text-slate-600 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors">
            Cancel
          </button>
          <button
            onClick={async () => {
              setSending(true);
              await onSend();
              setSending(false);
            }}
            disabled={sending}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50"
          >
            <Send className="w-3 h-3" />
            {sending ? "Sending..." : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}
