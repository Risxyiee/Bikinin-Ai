// src/events.ts
// Single source of truth for the event stream shared by the CLI (stdout/JSONL)
// and the web UI (SSE). Keep in sync with section 8 of AGENTS.md.
import { z } from "zod";

export const PROTOCOL_VERSION = 1 as const;

/* ---------- shared pieces ---------- */

const Base = z.object({
  v: z.literal(PROTOCOL_VERSION),
  seq: z.number().int().nonnegative(), // strictly increasing per run, starts at 0
  ts: z.string(), // ISO 8601
  run_id: z.string(),
});

export const ToolName = z.enum([
  "list_dir",
  "read_file",
  "write_file",
  "edit_file",
  "run_command",
  "read_skill",
  "preview",
  "render_video",
]);

export const Totals = z.object({
  steps: z.number().int().nonnegative(),
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  cached_tokens: z.number().int().nonnegative(),
  cost_usd: z.number().nonnegative(), // computed from usage x PRICE_*_PER_M in env
});

export const RunStatus = z.enum([
  "completed",
  "stopped", // user pressed stop
  "error",
  "budget_exceeded", // cost or step limit hit; resumable
]);

/* ---------- events ---------- */

export const RunStarted = Base.extend({
  type: z.literal("run_started"),
  session_id: z.string(),
  model: z.string(),
  effort: z.enum(["sedang", "tinggi"]),
  user_message: z.string(),
  limits: z.object({ max_steps: z.number().int(), max_cost_usd: z.number() }),
});

export const TextDelta = Base.extend({
  type: z.literal("text_delta"),
  text: z.string(), // streamed assistant text, append-only
});

export const PlanUpdated = Base.extend({
  type: z.literal("plan_updated"),
  items: z.array(
    z.object({
      id: z.string(),
      text: z.string(),
      status: z.enum(["pending", "doing", "done"]),
    }),
  ),
});

export const ToolCallStarted = Base.extend({
  type: z.literal("tool_call_started"),
  call_id: z.string(),
  step: z.number().int().positive(), // 1-based, shown in the UI ring
  tool: ToolName,
  label: z.string(), // human label, e.g. "write_file index.html"
  args: z.record(z.unknown()), // redacted: never contains secrets
});

export const ToolCallFinished = Base.extend({
  type: z.literal("tool_call_finished"),
  call_id: z.string(),
  ok: z.boolean(),
  summary: z.string(), // one line, shown under the step label
  output_preview: z.string().optional(), // max 2000 chars
  truncated: z.boolean().default(false),
  duration_ms: z.number().int().nonnegative(),
});

export const ApprovalRequested = Base.extend({
  type: z.literal("approval_requested"),
  approval_id: z.string(),
  call_id: z.string(),
  tool: ToolName,
  command: z.string().optional(), // for run_command
  reason: z.string(),
  risk: z.enum(["low", "medium", "high"]),
});

export const ApprovalResolved = Base.extend({
  type: z.literal("approval_resolved"),
  approval_id: z.string(),
  decision: z.enum(["allow", "deny"]),
  by: z.enum(["user", "policy"]),
});

export const FileChanged = Base.extend({
  type: z.literal("file_changed"),
  path: z.string(), // relative to workspace, never absolute
  op: z.enum(["created", "modified", "deleted"]),
  bytes: z.number().int().nonnegative(),
  diff: z.string().optional(), // unified diff, truncated
});

export const Usage = Base.extend({
  type: z.literal("usage"),
  step: z.number().int().nonnegative(),
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  cached_tokens: z.number().int().nonnegative().default(0),
  cost_usd: z.number().nonnegative(),
  totals: Totals,
});

export const BudgetWarning = Base.extend({
  type: z.literal("budget_warning"),
  kind: z.enum(["steps", "cost"]),
  used: z.number(),
  limit: z.number(),
  percent: z.number(), // emitted at 80 and 100
});

export const PreviewReady = Base.extend({
  type: z.literal("preview_ready"),
  kind: z.enum(["web", "video"]),
  url: z.string(),
  title: z.string(),
});

export const ArtifactReady = Base.extend({
  type: z.literal("artifact_ready"),
  kind: z.enum(["zip", "video", "file"]),
  path: z.string(),
  mime: z.string(),
  bytes: z.number().int().nonnegative(),
});

export const ErrorEvent = Base.extend({
  type: z.literal("error"),
  code: z.enum([
    "provider_error", // upstream LLM API failed
    "rate_limited",
    "invalid_tool_args",
    "tool_failed",
    "path_blocked", // tried to leave the workspace
    "command_blocked",
    "internal",
  ]),
  message: z.string(),
  retryable: z.boolean(),
  call_id: z.string().optional(),
});

export const RunFinished = Base.extend({
  type: z.literal("run_finished"),
  status: RunStatus,
  summary: z.string(), // final message to the user
  totals: Totals,
  duration_ms: z.number().int().nonnegative(),
  resumable: z.boolean(),
});

export const AgentEvent = z.discriminatedUnion("type", [
  RunStarted,
  TextDelta,
  PlanUpdated,
  ToolCallStarted,
  ToolCallFinished,
  ApprovalRequested,
  ApprovalResolved,
  FileChanged,
  Usage,
  BudgetWarning,
  PreviewReady,
  ArtifactReady,
  ErrorEvent,
  RunFinished,
]);
export type AgentEvent = z.infer<typeof AgentEvent>;
export type EventType = AgentEvent["type"];

/* ---------- client -> server commands (HTTP bodies) ---------- */

export const StartRunBody = z.object({
  session_id: z.string().optional(), // omit to start a new session
  message: z.string().min(1).max(8000),
  attachment_ids: z.array(z.string()).max(6).default([]),
  model: z.string().optional(), // must be in the server allowlist
  effort: z.enum(["sedang", "tinggi"]).default("sedang"),
});

export const ApprovalBody = z.object({
  approval_id: z.string(),
  decision: z.enum(["allow", "deny"]),
});

/* ---------- helpers ---------- */

type Payload<T extends EventType> = Omit<
  Extract<AgentEvent, { type: T }>,
  "v" | "seq" | "ts" | "run_id" | "type"
>;

/** Creates an emitter that stamps envelope fields and validates every event. */
export function createEmitter(runId: string, sink: (e: AgentEvent) => void) {
  let seq = 0;
  return function emit<T extends EventType>(type: T, data: Payload<T>): AgentEvent {
    const event = AgentEvent.parse({
      v: PROTOCOL_VERSION,
      seq: seq++,
      ts: new Date().toISOString(),
      run_id: runId,
      type,
      ...data,
    });
    sink(event);
    return event;
  };
}

/** One JSON object per line: CLI stdout and the on-disk session log (.jsonl). */
export const toNDJSON = (e: AgentEvent): string => JSON.stringify(e) + "\n";

/** Server-Sent Events frame. `id` = seq so clients can resume via Last-Event-ID. */
export const toSSE = (e: AgentEvent): string =>
  `id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;
