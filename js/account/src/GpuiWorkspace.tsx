import { useEffect, useRef, useState, type ReactNode } from "react";
import type { AgentEntry } from "nanocodex-react/agent";
import "./GpuiWorkspace.css";

export type GpuiSnapshot = {
  version: 1;
  scope: string;
  theme: "light" | "dark";
  connected: boolean;
  busy: boolean;
  error?: string;
  selectedId?: string;
  agents: Array<{ id: string; title: string; lastUserMessageAt: number; status: string; activity: string; prompt: string }>;
  messages: Array<{ id: string; role: string; text: string }>;
  draft: string;
  modelLabel: string;
  running: boolean;
  pending: Array<{ id: string; text: string; state: string }>;
  canLoadOlder: boolean;
};
export type GpuiAction =
  | { type: "select" | "cancel" | "older"; id: string }
  | { type: "new" | "refresh" | "theme" }
  | { type: "draft"; id: string; text: string }
  | { type: "send"; id: string; text: string; mode: "send" | "queue" | "steer" }
  | { type: "cancelPending"; id: string; pendingId: string }
  | { type: "navigate"; destination: "home" | "account" | "tools" };

export function projectGpuiMessages(entries: readonly AgentEntry[]): GpuiSnapshot["messages"] {
  return entries.map((entry) => ({ id: entry.id, role: entry.kind, text:
    entry.kind === "tool" ? `${entry.tool.name} · ${entry.tool.status}\n${entry.tool.arguments}${entry.tool.result ? `\n${entry.tool.result}` : ""}`
      : entry.kind === "plan" ? [entry.update.explanation, ...entry.update.plan.map((step) => `${step.status === "completed" ? "✓" : "·"} ${step.step}`)].filter(Boolean).join("\n")
        : entry.text,
  }));
}

/** Same-origin iframe gives each retained host exactly one disposable GPUI window. */
export function GpuiWorkspace({ snapshot, onAction, tools, children }: {
  snapshot: GpuiSnapshot;
  onAction(action: GpuiAction): void;
  tools: boolean;
  children: ReactNode;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const latest = useRef({ snapshot, onAction });
  latest.current = { snapshot, onAction };
  const [ready, setReady] = useState(false);
  const [failure, setFailure] = useState<string>();
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.origin !== location.origin) return;
      if (event.data?.type === "gpui:ready") {
        setReady(true);
        frame.current?.contentWindow?.postMessage({ type: "gpui:snapshot", snapshot: latest.current.snapshot }, location.origin);
      } else if (event.data?.type === "gpui:error") {
        setFailure(String(event.data.message));
      } else if (event.data?.type === "gpui:action" && event.data.action && typeof event.data.action.type === "string") {
        latest.current.onAction(event.data.action as GpuiAction);
      }
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, []);
  useEffect(() => {
    if (ready) frame.current?.contentWindow?.postMessage({ type: "gpui:snapshot", snapshot }, location.origin);
  }, [ready, snapshot]);
  return <div className="gpui-workspace">
    {!tools && <button type="button" className="gpui-accessible-tools" onClick={() => onAction({ type: "navigate", destination: "tools" })}>Use accessible web tools</button>}
    <iframe ref={frame} src="/gpui/index.html" title="Nanocodex Agents — GPUI" className="gpui-frame"
      allow="clipboard-read; clipboard-write" hidden={tools} />
    {(!ready || failure) && !tools && <div className="gpui-loading" role="status">{failure ? `GPUI could not start: ${failure}` : "Opening Agents…"}
      {failure && <button type="button" onClick={() => onAction({ type: "navigate", destination: "tools" })}>Open web tools</button>}
    </div>}
    <div className="gpui-tools" hidden={!tools}>
      <div className="gpui-tools-header"><strong>Agent tools</strong><span>Voice, attachments, models, schedules and full tool output</span>
        <button type="button" onClick={() => onAction({ type: "navigate", destination: "tools" })}>Back to Agents</button></div>
      {children}
    </div>
  </div>;
}
