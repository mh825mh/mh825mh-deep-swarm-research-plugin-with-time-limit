// src/utils/llm.ts
import { LMStudioClient } from "@lmstudio/sdk";
import { z } from "zod";
import { LlmCallBudget, RunWatchdog, ContextIsolationMode } from "../types";
import { extractQwenJson, ReasoningEffort } from "./qwen-parser";

/**
 * Bounded semaphore so parallel swarm workers never fire more concurrent
 * predictions at LM Studio than it can safely multiplex. Local 7B–14B models
 * are typically served by a single kv-cache slot, so the default is 1; a run
 * may raise it via the `llmConcurrency` config.
 */
export class LlmSemaphore {
  private readonly maxActive: number;
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(maxActive: number) {
    this.maxActive = Math.max(1, Math.floor(maxActive) || 1);
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active < this.maxActive) {
      this.active++;
      try {
        return await fn();
      } finally {
        this.active--;
        this.pump();
      }
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    return this.run(fn);
  }

  get activeCount(): number {
    return this.active;
  }

  private pump(): void {
    while (this.active < this.maxActive && this.waiters.length > 0) {
      const next = this.waiters.shift();
      if (next) next();
    }
  }
}

let llmSemaphore = new LlmSemaphore(1);

/** Set the global LLM prediction concurrency cap. Call once per run. */
export function setLlmConcurrency(maxConcurrent: number): void {
  llmSemaphore = new LlmSemaphore(maxConcurrent);
}

export interface AskModelOptions {
  readonly system?: string;
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /** Granular thinking control for Qwen-style models. `none` disables reasoning. */
  readonly reasoningEffort?: ReasoningEffort;
  /** Hard switch that disables thinking tokens entirely. */
  readonly disableThinking?: boolean;
}

export interface AskStructuredOptions extends AskModelOptions {
  /** Plain JSON Schema (draft-07 subset) handed to LM Studio structured output. */
  readonly jsonSchema: Record<string, unknown>;
}

/** Extra prediction-payload fields that carry thinking-control directives. */
type ReasoningPayload = Record<string, unknown>;

/**
 * True when thinking must be turned off: either an explicit `disableThinking`
 * flag or `reasoningEffort: 'none'` (used for repetitive / extraction tasks).
 */
function thinkingDisabled(opts: {
  reasoningEffort?: ReasoningEffort;
  disableThinking?: boolean;
}): boolean {
  return opts.disableThinking === true || opts.reasoningEffort === "none";
}

/**
 * Builds the extra prediction-config fields for thinking control.
 *
 * The LM Studio JS SDK only exposes the experimental `enableThinking` boolean,
 * so we set that (guaranteed to work) and additionally pass the raw
 * `chat_template_kwargs: { enable_thinking: false }` + `reasoning` fields via an
 * untyped payload for runtimes that accept them.
 */
function buildReasoningConfig(opts: {
  reasoningEffort?: ReasoningEffort;
  disableThinking?: boolean;
}): ReasoningPayload {
  if (thinkingDisabled(opts)) {
    return {
      enableThinking: false,
      chat_template_kwargs: { enable_thinking: false },
      reasoning: "off",
    };
  }
  if (opts.reasoningEffort) {
    return {
      enableThinking: true,
      chat_template_kwargs: { enable_thinking: true },
      reasoning: opts.reasoningEffort,
    };
  }
  return {};
}

/**
 * Appends the Qwen `/no_think` soft-switch to the last user message as a
 * fallback directive for templates that ignore the API-level flag.
 */
function applyNoThink<T extends { role: string; content: string }>(
  messages: ReadonlyArray<T>,
  disabled: boolean,
): ReadonlyArray<T> {
  if (!disabled) return messages;
  const copy = [...messages];
  for (let i = copy.length - 1; i >= 0; i--) {
    if (copy[i].role === "user") {
      copy[i] = { ...copy[i], content: `${copy[i].content}\n/no_think` };
      break;
    }
  }
  return copy;
}

export interface PredictionConfigOptions {
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly structured?: unknown;
  readonly reasoningEffort?: ReasoningEffort;
  readonly disableThinking?: boolean;
}

/**
 * Assembles a full `model.respond` prediction config, including the thinking
 * directives. Shared by the central helpers and the direct `model.respond`
 * call sites (synthesis, gatekeeper) so reasoning controls stay consistent.
 */
export function buildPredictionOptions(
  opts: PredictionConfigOptions,
): Record<string, unknown> {
  const cfg: Record<string, unknown> = {};
  if (opts.maxTokens !== undefined) cfg.maxTokens = opts.maxTokens;
  if (opts.temperature !== undefined) cfg.temperature = opts.temperature;
  if (opts.structured !== undefined) cfg.structured = opts.structured;
  Object.assign(cfg, buildReasoningConfig(opts));
  return cfg;
}

/**
 * Applies the `/no_think` directive to a message array when thinking is off.
 * Exposed so direct call sites build an isolated, directive-tagged prompt.
 */
export function withThinkingDirective<T extends { role: string; content: string }>(
  messages: ReadonlyArray<T>,
  opts: { reasoningEffort?: ReasoningEffort; disableThinking?: boolean },
): ReadonlyArray<T> {
  return applyNoThink(messages, thinkingDisabled(opts));
}

export async function requestPrediction(
  messages: ReadonlyArray<{ role: "system" | "user"; content: string }>,
  opts: {
    maxTokens?: number;
    temperature?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
    reasoningEffort?: ReasoningEffort;
    disableThinking?: boolean;
  },
): Promise<string | null> {
  if (opts.signal?.aborted) return null;
  const { maxTokens = 400, temperature = 0.7, timeoutMs = 60_000 } = opts;
  try {
    const client = new LMStudioClient();
    const models = await Promise.race([
      client.llm.listLoaded(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), timeoutMs),
      ),
    ]);
    if (!Array.isArray(models) || models.length === 0) return null;
    const model = await client.llm.model(models[0].identifier);
    const prepared = applyNoThink(messages, thinkingDisabled(opts));
    const stream = model.respond(
      prepared as never,
      buildPredictionOptions({ maxTokens, temperature, ...opts }) as never,
    );
    let result = "";
    for await (const chunk of stream) result += chunk.content ?? "";
    return result.trim() || null;
  } catch {
    return null;
  }
}

export async function askLoadedModel(
  prompt: string,
  options: AskModelOptions = {},
): Promise<string | null> {
  const { system, ...rest } = options;
  const messages: ReadonlyArray<{ role: "system" | "user"; content: string }> =
    system
      ? [
          { role: "system", content: system },
          { role: "user", content: prompt },
        ]
      : [{ role: "user", content: prompt }];
  return llmSemaphore.run(() => requestPrediction(messages, rest));
}

/**
 * Best-effort structured prediction (item 4). Routes through LM Studio's native
 * structured output when the server supports it; on any failure/interrupt the
 * caller falls back to its deterministic path (the run never breaks on older
 * servers). The returned value is schema-validated by zod before being trusted.
 */
export async function askStructured<S extends z.ZodTypeAny>(
  prompt: string,
  schema: S,
  options: AskStructuredOptions,
): Promise<z.output<S> | null> {
  const {
    system,
    jsonSchema,
    maxTokens = 800,
    temperature = 0.3,
    timeoutMs = 30_000,
    signal,
    reasoningEffort,
    disableThinking,
  } = options;
  const messages: ReadonlyArray<{ role: "system" | "user"; content: string }> =
    system
      ? [
          { role: "system", content: system },
          { role: "user", content: prompt },
        ]
      : [{ role: "user", content: prompt }];

  return llmSemaphore.run(async () => {
    if (signal?.aborted) return null;
    try {
      const client = new LMStudioClient();
      const models = await Promise.race([
        client.llm.listLoaded(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), timeoutMs),
        ),
      ]);
      if (!Array.isArray(models) || models.length === 0) return null;
      const model = await client.llm.model(models[0].identifier);
      const prepared = applyNoThink(
        messages,
        thinkingDisabled({ reasoningEffort, disableThinking }),
      );
      const stream = model.respond(
        prepared as never,
        buildPredictionOptions({
          maxTokens,
          temperature,
          structured: { type: "json", jsonSchema },
          reasoningEffort,
          disableThinking,
        }) as never,
      );
      let result = "";
      for await (const chunk of stream) result += chunk.content ?? "";
      if (!result.trim()) return null;
      // extractQwenJson strips <think> blocks + Markdown fences and locates the
      // JSON boundaries; any failure falls through to the caller's fallback.
      return schema.parse(extractQwenJson(result));
    } catch {
      return null;
    }
  });
}

/**
 * Cheap probe: returns true only if LM Studio has at least one model loaded.
 * Used before consuming an expensive LLM call-budget slot so a research run
 * without a running model doesn't burn its budget on no-op mutation calls.
 */
export async function hasLoadedModel(timeoutMs = 5_000): Promise<boolean> {
  try {
    const client = new LMStudioClient();
    const models = await Promise.race([
      client.llm.listLoaded(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), timeoutMs),
      ),
    ]);
    return Array.isArray(models) && models.length > 0;
  } catch {
    return false;
  }
}

const BUDGETS: Record<string, LlmCallBudget> = {
  compact: { mode: "compact", maxGlobalCalls: 20, maxCallsPerWorker: 3, maxRuntimeMs: 10 * 60 * 1000, warningThresholdMs: 8 * 60 * 1000 },
  standard: { mode: "standard", maxGlobalCalls: 45, maxCallsPerWorker: 5, maxRuntimeMs: 20 * 60 * 1000, warningThresholdMs: 15 * 60 * 1000 },
  deep: { mode: "deep", maxGlobalCalls: 80, maxCallsPerWorker: 8, maxRuntimeMs: 30 * 60 * 1000, warningThresholdMs: 25 * 60 * 1000 },
  extended: { mode: "extended", maxGlobalCalls: 120, maxCallsPerWorker: 10, maxRuntimeMs: 45 * 60 * 1000, warningThresholdMs: 40 * 60 * 1000 },
};

export class LlmCallManager {
  public budget: LlmCallBudget;
  public watchdog: RunWatchdog;
  public isolationMode: ContextIsolationMode;
  private readonly _abortController: AbortController;

  constructor(mode: string = "standard", isolationMode: ContextIsolationMode = "strict") {
    this.budget = BUDGETS[mode] || BUDGETS.standard;
    this.isolationMode = isolationMode;
    this._abortController = new AbortController();
    this.watchdog = {
      llmCallsMade: 0,
      workerCalls: new Map(),
      startTime: Date.now(),
      stalled: false,
      lastProgressTime: Date.now(),
    };
  }

  public get signal(): AbortSignal {
    return this._abortController.signal;
  }

  public abort(): void {
    if (!this._abortController.signal.aborted) {
      this._abortController.abort();
      this.watchdog.stalled = true;
    }
  }

  public canCall(workerId: string): boolean {
    if (this.watchdog.stalled) return false;
    if (this.watchdog.llmCallsMade >= this.budget.maxGlobalCalls) return false;
    
    const workerCalls = this.watchdog.workerCalls.get(workerId) ?? 0;
    if (workerCalls >= this.budget.maxCallsPerWorker) return false;

    if (Date.now() - this.watchdog.startTime > this.budget.maxRuntimeMs) return false;

    return true;
  }

  public recordCall(workerId: string) {
    this.watchdog.llmCallsMade++;
    this.watchdog.workerCalls.set(workerId, (this.watchdog.workerCalls.get(workerId) ?? 0) + 1);
  }

  public recordProgress() {
    this.watchdog.lastProgressTime = Date.now();
    this.watchdog.stalled = false;
  }

  public checkStall(): boolean {
    // Stall if no progress for 2 minutes
    if (Date.now() - this.watchdog.lastProgressTime > 2 * 60 * 1000) {
      this.watchdog.stalled = true;
      return true;
    }
    return false;
  }

  public shouldStop(): boolean {
    if (this.watchdog.stalled) return true;
    if (this.watchdog.llmCallsMade >= this.budget.maxGlobalCalls) return true;
    if (Date.now() - this.watchdog.startTime > this.budget.maxRuntimeMs) return true;
    return false;
  }

  public getReport(): string {
    const elapsedMs = Date.now() - this.watchdog.startTime;
    const elapsedMin = Math.floor(elapsedMs / 60000);
    
    return `
══════════════════════════════════════════════════════════════
RUN CONTROL & WATCHDOG REPORT
══════════════════════════════════════════════════════════════
- Selected mode: ${this.budget.mode}
- Runtime limit: ${this.budget.maxRuntimeMs / 60000} min
- Runtime elapsed: ${elapsedMin} min
- LLM call budget: ${this.budget.maxGlobalCalls}
- LLM calls used: ${this.watchdog.llmCallsMade}
- Worker calls: ${JSON.stringify(Object.fromEntries(this.watchdog.workerCalls))}
- Stall detector state: ${this.watchdog.stalled ? "STALLED" : "HEALTHY"}
- Context Isolation: ${this.isolationMode}
══════════════════════════════════════════════════════════════
`;
  }
}