// Keeps runs in memory for the web UI: event buffer, live listeners, pending approvals, stop.
// One active run at a time, because all runs share one workspace.
import { randomUUID } from "node:crypto";
import {
  runAgent,
  type AgentDeps,
  type ApprovalRequest,
  type EmitFn,
} from "../agent/loop.js";
import type { Config } from "../config.js";
import type { z } from "zod";
import { createEmitter, StartRunBody, type AgentEvent } from "../events.js";
import type { LlmClient } from "../llm/client.js";
import { createFallbackLlm } from "../llm/fallback.js";
import { Catalog, CatalogError } from "../llm/catalog.js";
import { discoverModels, type FetchLike } from "../llm/discover.js";
import { probeProvider, type ProbeResult } from "../llm/probe.js";
import type { ProviderConfig } from "../llm/providers.js";
import { ProviderStore } from "../llm/store.js";
import { MAX_SESSIONS, SessionHistory } from "../agent/history.js";

export interface RunRecord {
  runId: string;
  sessionId: string;
  events: AgentEvent[];
  finished: boolean;
  listeners: Set<(e: AgentEvent) => void>;
  abort: AbortController;
  pending: Map<string, (allow: boolean) => void>;
}

export interface RunManagerOptions {
  workspace: string; // absolute realpath
  systemPrompt: string;
  llm?: LlmClient; // tests inject a fake; production uses the provider list
  catalog?: Catalog; // selectable models; defaults to the env providers only
  makeClient?: (p: ProviderConfig) => LlmClient; // tests intercept provider calls
  fetchImpl?: FetchLike; // tests intercept model discovery
}

export class UnknownModelError extends Error {}

export class BusyError extends Error {}

export class RunManager {
  private readonly runs = new Map<string, RunRecord>();
  private activeRunId: string | null = null;
  private readonly sessions = new Map<string, SessionHistory>();

  readonly catalog: Catalog;

  constructor(
    private readonly cfg: Config,
    private readonly opts: RunManagerOptions,
  ) {
    this.catalog =
      opts.catalog ?? new Catalog(cfg.providers, new ProviderStore(null));
  }

  /** Public, non-secret settings for the UI. Never includes keys or URLs. */
  info() {
    const def = this.catalog.resolve();
    return {
      model: def ? def.selected.model : this.cfg.providers[0].model,
      usd_idr: this.cfg.BIKININ_USD_IDR,
      max_steps: this.cfg.BIKININ_MAX_STEPS,
      max_cost_usd: this.cfg.BIKININ_MAX_COST_USD,
    };
  }

  /** Asks a user-added provider for its model ids. The key never leaves the server. */
  async discover(providerId: string): Promise<string[]> {
    const { baseUrl, apiKey } = this.catalog.credentials(providerId);
    return discoverModels(baseUrl, apiKey, this.opts.fetchImpl);
  }

  /** Runs the provider check (chat, streaming, usage, tool calling) for one of its models. */
  async probe(providerId: string, model?: string): Promise<ProbeResult> {
    const options = this.catalog
      .choices()
      .filter((c) => c.providerId === providerId);
    if (options.length === 0)
      throw new CatalogError(400, "Tambahkan minimal satu model dulu");
    const choice = model ? options.find((c) => c.model === model) : options[0];
    if (!choice) throw new CatalogError(400, "Model tidak ada di provider ini");
    return probeProvider(choice.config, this.opts.makeClient);
  }

  get(runId: string): RunRecord | undefined {
    return this.runs.get(runId);
  }

  start(body: z.infer<typeof StartRunBody>): {
    run_id: string;
    session_id: string;
  } {
    if (this.activeRunId !== null)
      throw new BusyError("masih ada run yang berjalan");

    const resolved = this.catalog.resolve(body.model);
    if (!resolved) throw new UnknownModelError("model tidak dikenal");

    const runId = `run_${randomUUID().slice(0, 8)}`;
    // Only reuse a session id this server issued; anything else starts a new session.
    const sessionId =
      body.session_id && this.sessions.has(body.session_id)
        ? body.session_id
        : `s_${randomUUID().slice(0, 8)}`;
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, new SessionHistory());
      while (this.sessions.size > MAX_SESSIONS) {
        const oldest = this.sessions.keys().next().value;
        if (oldest === undefined) break;
        this.sessions.delete(oldest);
      }
    }
    const rec: RunRecord = {
      runId,
      sessionId,
      events: [],
      finished: false,
      listeners: new Set(),
      abort: new AbortController(),
      pending: new Map(),
    };
    this.runs.set(runId, rec);
    this.activeRunId = runId;

    const emit: EmitFn = createEmitter(runId, (e) => {
      rec.events.push(e);
      if (e.type === "run_finished") rec.finished = true;
      for (const listener of rec.listeners) listener(e);
    });
    const approve = (req: ApprovalRequest) =>
      new Promise<boolean>((resolve) => {
        rec.pending.set(req.approvalId, resolve);
      });

    void this.execute(rec, body.message, emit, approve, resolved).finally(
      () => {
        for (const resolve of rec.pending.values()) resolve(false);
        rec.pending.clear();
        this.activeRunId = null;
      },
    );

    return { run_id: runId, session_id: sessionId };
  }

  private async execute(
    rec: RunRecord,
    message: string,
    emit: EmitFn,
    approve: AgentDeps["approve"],
    resolved: NonNullable<ReturnType<Catalog["resolve"]>>,
  ): Promise<void> {
    const primary = resolved.selected;
    const history = this.sessions.get(rec.sessionId);
    try {
      const result = await runAgent({
        llm:
          this.opts.llm ??
          createFallbackLlm(resolved.chain, {
            makeClient: this.opts.makeClient,
          }),
        model: primary.model,
        systemPrompt: this.opts.systemPrompt,
        message,
        sessionId: rec.sessionId,
        workspace: this.opts.workspace,
        limits: {
          maxSteps: this.cfg.BIKININ_MAX_STEPS,
          maxCostUsd: this.cfg.BIKININ_MAX_COST_USD,
        },
        prices: { inPerM: primary.inPerM, outPerM: primary.outPerM },
        emit,
        approve,
        signal: rec.abort.signal,
        history: history?.messages(),
      });
      history?.add(result.transcript);
    } catch (err) {
      // runAgent normally always emits run_finished; this is a last-resort guard.
      if (!rec.finished) {
        emit("error", {
          code: "internal",
          message: err instanceof Error ? err.message : String(err),
          retryable: false,
        });
        emit("run_finished", {
          status: "error",
          summary: "Run berhenti karena error internal.",
          totals: {
            steps: 0,
            input_tokens: 0,
            output_tokens: 0,
            cached_tokens: 0,
            cost_usd: 0,
          },
          duration_ms: 0,
          resumable: false,
        });
      }
    }
  }

  stop(runId: string): boolean {
    const rec = this.runs.get(runId);
    if (!rec) return false;
    if (rec.finished) return true;
    rec.abort.abort();
    for (const resolve of rec.pending.values()) resolve(false);
    rec.pending.clear();
    return true;
  }

  approve(
    runId: string,
    approvalId: string,
    decision: "allow" | "deny",
  ): boolean {
    const rec = this.runs.get(runId);
    const resolve = rec?.pending.get(approvalId);
    if (!rec || !resolve) return false;
    rec.pending.delete(approvalId);
    resolve(decision === "allow");
    return true;
  }
}
