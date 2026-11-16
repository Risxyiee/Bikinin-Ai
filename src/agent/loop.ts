// Agent loop: model call -> tool calls -> results back to model, until done or a budget stops it.
// Every observable step goes through emit(); this file never prints.
import { randomUUID } from "node:crypto";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { AgentEvent, createEmitter } from "../events.js";
import { AgentError, type ErrorCode } from "../errors.js";
import type { ChatResult, LlmClient, ToolCallReq } from "../llm/client.js";
import { costUsd, type Prices } from "../llm/pricing.js";
import { Budget } from "../safety/budget.js";
import { getTool, TOOLS, toolSpecsForLlm } from "../tools/registry.js";
import {
  truncate,
  type ParsedOk,
  type RegisteredTool,
  type ToolResult,
} from "../tools/types.js";

export type EmitFn = ReturnType<typeof createEmitter>;
type RunFinished = Extract<AgentEvent, { type: "run_finished" }>;
type Totals = RunFinished["totals"];
type RunStatus = RunFinished["status"];

export interface ApprovalRequest {
  command: string;
  reason: string;
  risk: "low" | "medium" | "high";
}

export interface AgentDeps {
  llm: LlmClient;
  model: string;
  systemPrompt: string;
  message: string;
  sessionId: string;
  workspace: string; // absolute realpath
  limits: { maxSteps: number; maxCostUsd: number };
  prices: Prices;
  emit: EmitFn;
  approve: (req: ApprovalRequest) => Promise<boolean>;
  signal?: AbortSignal;
}

export interface AgentResult {
  status: RunStatus;
  summary: string;
  totals: Totals;
  durationMs: number;
  filesCreated: string[];
  filesChanged: string[];
}

interface ToolOutput {
  id: string;
  content: string;
}

interface Job {
  call: ToolCallReq;
  callId: string;
  tool: RegisteredTool;
  parsed: ParsedOk;
  startedMs: number;
}

const PREVIEW_LIMIT = 2000;

function parseArgs(raw: string): unknown {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return undefined;
  }
}

function errorInfo(err: unknown): { code: ErrorCode; message: string } {
  if (err instanceof AgentError)
    return { code: err.code, message: err.message };
  return {
    code: "internal",
    message: err instanceof Error ? err.message : String(err),
  };
}

export async function runAgent(d: AgentDeps): Promise<AgentResult> {
  const startedAt = Date.now();
  const budget = new Budget(d.limits.maxSteps, d.limits.maxCostUsd);
  const tokens = { input: 0, output: 0, cached: 0 };
  const created = new Set<string>();
  const changed = new Set<string>();
  const emit = d.emit;

  // Strip absolute workspace paths before anything leaves the loop.
  const sanitize = (s: string) => s.split(d.workspace).join("<workspace>");
  const oneLine = (s: string) => s.split("\n")[0].slice(0, 200);

  const totals = (): Totals => ({
    steps: budget.steps,
    input_tokens: tokens.input,
    output_tokens: tokens.output,
    cached_tokens: tokens.cached,
    cost_usd: budget.costUsd,
  });

  const flushAlerts = () => {
    for (const a of budget.takeAlerts()) {
      emit("budget_warning", {
        kind: a.kind,
        used: a.used,
        limit: a.limit,
        percent: a.percent,
      });
    }
  };

  const finish = (status: RunStatus, summary: string): AgentResult => {
    const durationMs = Date.now() - startedAt;
    const t = totals();
    emit("run_finished", {
      status,
      summary,
      totals: t,
      duration_ms: durationMs,
      resumable: status === "budget_exceeded",
    });
    return {
      status,
      summary,
      totals: t,
      durationMs,
      filesCreated: [...created],
      filesChanged: [...changed],
    };
  };

  const emitFinished = (
    callId: string,
    ok: boolean,
    summary: string,
    output: string,
    startedMs: number,
  ) => {
    emit("tool_call_finished", {
      call_id: callId,
      ok,
      summary: oneLine(summary),
      output_preview: sanitize(output).slice(0, PREVIEW_LIMIT),
      truncated: output.length > PREVIEW_LIMIT,
      duration_ms: Date.now() - startedMs,
    });
  };

  const runJob = async (job: Job): Promise<ToolOutput> => {
    const { call, callId, tool, parsed, startedMs } = job;
    const verdict = parsed.gate;

    if (verdict.decision === "block") {
      emit("error", {
        code: "command_blocked",
        message: verdict.reason,
        retryable: true,
        call_id: callId,
      });
      emitFinished(callId, false, `diblokir: ${verdict.reason}`, "", startedMs);
      return {
        id: call.id,
        content: `ERROR: diblokir kebijakan keamanan: ${verdict.reason}`,
      };
    }

    if (verdict.decision === "confirm") {
      const approvalId = randomUUID().slice(0, 8);
      emit("approval_requested", {
        approval_id: approvalId,
        call_id: callId,
        tool: tool.name,
        command: verdict.command,
        reason: verdict.reason,
        risk: verdict.risk,
      });
      const approved = await d.approve({
        command: verdict.command,
        reason: verdict.reason,
        risk: verdict.risk,
      });
      emit("approval_resolved", {
        approval_id: approvalId,
        decision: approved ? "allow" : "deny",
        by: "user",
      });
      if (!approved) {
        emitFinished(callId, false, "ditolak pengguna", "", startedMs);
        return {
          id: call.id,
          content:
            "ERROR: pengguna menolak perintah ini. Cari cara lain atau tanyakan pengguna.",
        };
      }
    }

    try {
      const res: ToolResult = await parsed.execute({ workspace: d.workspace });
      for (const c of res.changes) {
        emit("file_changed", { path: c.path, op: c.op, bytes: c.bytes });
        (c.op === "created" ? created : changed).add(c.path);
      }
      const output = sanitize(res.output);
      emitFinished(callId, res.ok, res.summary, output, startedMs);
      return {
        id: call.id,
        content: `${res.ok ? "OK" : "GAGAL"}: ${res.summary}\n${truncate(output).text}`,
      };
    } catch (err) {
      const { code, message: raw } = errorInfo(err);
      const message = sanitize(raw);
      if (code === "path_blocked" || code === "command_blocked") {
        emit("error", { code, message, retryable: true, call_id: callId });
      }
      emitFinished(callId, false, message, "", startedMs);
      return { id: call.id, content: `ERROR: ${message}` };
    }
  };

  const runToolCalls = async (calls: ToolCallReq[]): Promise<ToolOutput[]> => {
    const results = new Map<string, ToolOutput>();
    const jobs: Job[] = [];

    for (const call of calls) {
      const tool = getTool(call.function.name);
      if (!tool) {
        emit("error", {
          code: "invalid_tool_args",
          message: `tool tidak dikenal: ${call.function.name}`,
          retryable: true,
        });
        results.set(call.id, {
          id: call.id,
          content: `ERROR: tool "${call.function.name}" tidak tersedia. Pilih dari: ${TOOLS.map((t) => t.name).join(", ")}`,
        });
        continue;
      }

      budget.steps += 1;
      const callId = randomUUID().slice(0, 8);
      const startedMs = Date.now();
      const parsed = tool.parse(parseArgs(call.function.arguments));

      if (!parsed.ok) {
        emit("tool_call_started", {
          call_id: callId,
          step: budget.steps,
          tool: tool.name,
          label: tool.name,
          args: {},
        });
        emit("error", {
          code: "invalid_tool_args",
          message: parsed.error,
          retryable: true,
          call_id: callId,
        });
        emitFinished(
          callId,
          false,
          "argumen tidak valid",
          parsed.error,
          startedMs,
        );
        results.set(call.id, {
          id: call.id,
          content: `ERROR: argumen tidak valid: ${parsed.error}`,
        });
        continue;
      }

      emit("tool_call_started", {
        call_id: callId,
        step: budget.steps,
        tool: tool.name,
        label: parsed.label,
        args: parsed.publicArgs,
      });
      jobs.push({ call, callId, tool, parsed, startedMs });
    }

    // Read-only tools run in parallel; anything that mutates runs in order.
    if (jobs.every((j) => j.tool.readOnly)) {
      const outs = await Promise.all(jobs.map(runJob));
      for (const o of outs) results.set(o.id, o);
    } else {
      for (const job of jobs) results.set(job.call.id, await runJob(job));
    }

    return calls.map(
      (c) => results.get(c.id) ?? { id: c.id, content: "ERROR: internal" },
    );
  };

  emit("run_started", {
    session_id: d.sessionId,
    model: d.model,
    effort: "sedang",
    user_message: d.message,
    limits: { max_steps: d.limits.maxSteps, max_cost_usd: d.limits.maxCostUsd },
  });

  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: d.systemPrompt },
    { role: "user", content: d.message },
  ];
  const tools = toolSpecsForLlm();

  try {
    for (;;) {
      if (d.signal?.aborted) return finish("stopped", "Dihentikan pengguna.");
      if (budget.stepsExceeded()) {
        flushAlerts();
        return finish(
          "budget_exceeded",
          `Batas ${budget.maxSteps} langkah tercapai.`,
        );
      }

      let res: ChatResult;
      try {
        res = await d.llm.chat({
          model: d.model,
          messages,
          tools,
          signal: d.signal,
          onText: (text) => emit("text_delta", { text }),
        });
      } catch (err) {
        if (d.signal?.aborted) return finish("stopped", "Dihentikan pengguna.");
        const info = errorInfo(err);
        emit("error", {
          code: info.code,
          message: info.message,
          retryable: false,
        });
        return finish("error", info.message);
      }

      tokens.input += res.usage.input_tokens;
      tokens.output += res.usage.output_tokens;
      tokens.cached += res.usage.cached_tokens;
      const cost = res.costUsd ?? costUsd(res.usage, d.prices);
      budget.addCost(cost);
      emit("usage", {
        step: budget.steps,
        input_tokens: res.usage.input_tokens,
        output_tokens: res.usage.output_tokens,
        cached_tokens: res.usage.cached_tokens,
        cost_usd: cost,
        totals: totals(),
      });
      flushAlerts();

      if (res.toolCalls.length === 0) {
        return finish("completed", res.text.trim() || "Selesai.");
      }
      if (budget.costExceeded()) {
        return finish(
          "budget_exceeded",
          `Batas biaya $${budget.maxCostUsd} tercapai.`,
        );
      }
      if (budget.steps + res.toolCalls.length > budget.maxSteps) {
        return finish(
          "budget_exceeded",
          `Batas ${budget.maxSteps} langkah tercapai.`,
        );
      }

      messages.push({
        role: "assistant",
        content: res.text || null,
        tool_calls: res.toolCalls,
      });
      const outputs = await runToolCalls(res.toolCalls);
      for (const o of outputs) {
        messages.push({ role: "tool", tool_call_id: o.id, content: o.content });
      }
      flushAlerts();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emit("error", { code: "internal", message, retryable: false });
    return finish("error", message);
  }
}
