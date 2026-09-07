import type { Message, Usage } from "@earendil-works/pi-ai";
import type { ModelHandle } from "./ai-models.js";

/**
 * An all-zeros pi Usage record, for synthesizing assistant messages that were never actually
 * produced by a live model call (chat-history replay, compaction prompts).
 */
export function zeroUsage(): Usage {
  return {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/**
 * A failed model request, thrown by completeText() and the agent turn loop. pi never throws for
 * provider failures -- it reports them as a final assistant message with stopReason "error" --
 * so this converts that shape back into an exception for callers that expect one (the overseer's
 * turn error triage and the one-shot completion helpers).
 */
export class AgentTurnError extends Error {
  /** HTTP status of the failing request, when the handle observed a response for it. */
  readonly statusCode?: number;

  constructor(message: string, statusCode?: number) {
    super(message);
    this.statusCode = statusCode;
  }
}

/**
 * Best-effort HTTP status extraction for a failed request. pi reports provider failures as
 * error text only, and its onResponse callback never fires for a request the SDK failed (so
 * ModelHandle.lastResponse is unset then) -- but the provider SDKs' error messages conventionally
 * begin with the status code (e.g. "400 {...}"), which is enough for the overseer's triage
 * (report 5xx/unknown, skip expected 4xx).
 */
export function httpStatusFromError(errorMessage: string, handle: ModelHandle)
    : number | undefined {
  const match = /^(\d{3})\b/.exec(errorMessage.trim());
  if (match) return Number(match[1]);
  return handle.lastResponse?.status;
}

/** HTTP statuses that indicate a transient provider/gateway failure worth retrying. */
const RETRYABLE_PROVIDER_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

/**
 * True when a failed agent request is transient and an automatic retry is expected to help:
 * overload/rate-limit responses, gateway 5xx, and transport-level failures with no observed HTTP
 * status. 4xx responses (auth, quota/billing, malformed input) are deliberately not retryable.
 */
export function isRetryableProviderFailure(err: unknown): boolean {
  const statusCode = err instanceof AgentTurnError ? err.statusCode : undefined;
  if (statusCode !== undefined) {
    return RETRYABLE_PROVIDER_STATUSES.has(statusCode);
  }

  const flags = err as Record<string, unknown> | null | undefined;
  if (flags?.["overloaded"] === true || flags?.["retryable"] === true) {
    return true;
  }

  const message = err instanceof Error ? err.message : String(err ?? "");
  return /(?:^|\b)(?:408|429|500|502|503|504)\b/.test(message) ||
      /service unavailable|temporarily unavailable|rate limit|too many requests|timed? ?out|\bECONNRESET\b|\bECONNREFUSED\b|socket hang up|network error|upstream/i.test(message);
}

/**
 * Exponential backoff delay (with jitter) for an automatic provider retry. `attempt` is the
 * 0-based retry index (0 = the first retry after the initial failure).
 */
export function providerRetryDelayMs(attempt: number): number {
  const base = 1000;
  const exponent = Math.min(Math.max(attempt, 0), 4);
  const backoff = Math.min(base * 2 ** exponent, 15_000);
  const jitter = Math.floor(Math.random() * (backoff * 0.25));
  return backoff + jitter;
}

/**
 * Run a single non-streaming-style completion against a ModelHandle and return the response
 * text. Used for one-shot calls: title generation, binding naming, compaction summaries, and
 * LanguageModelBinding.run. Always requests thinking off (one-shots should be quick, and none
 * of them benefit from extended thinking; pre-pi, these calls never configured thinking either).
 * Throws AgentTurnError on provider failure, or the abort reason when `signal` fired.
 */
export async function completeText(handle: ModelHandle, args: {
  systemPrompt?: string;
  // Convenience: wraps into a single user message. Exactly one of `prompt`/`messages` required.
  prompt?: string;
  messages?: Message[];
  maxTokens?: number;
  signal?: AbortSignal;
}): Promise<string> {
  const messages: Message[] = args.messages ??
      [{ role: "user", content: args.prompt ?? "", timestamp: Date.now() }];
  const stream = await handle.stream(handle.model, {
    systemPrompt: args.systemPrompt,
    messages,
  }, {
    maxTokens: args.maxTokens,
    signal: args.signal,
    thinking: false,
  });
  const message = await stream.result();
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    // Surface a cancellation as the abort reason, like a directly-aborted request would.
    args.signal?.throwIfAborted();
    const errorMessage = message.errorMessage ?? "The model request failed.";
    throw new AgentTurnError(errorMessage, httpStatusFromError(errorMessage, handle));
  }
  return message.content
      .filter(block => block.type === "text")
      .map(block => block.text)
      .join("");
}
