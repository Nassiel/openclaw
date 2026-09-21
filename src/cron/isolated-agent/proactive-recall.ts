/**
 * Trigger-time recall step for the `proactiveCheckIn` branch (Req 2.1-2.6).
 *
 * When a proactive check-in fires, the agent must recall the pending topic from
 * Memory *before* composing the opening message, bounded to 5 seconds. This
 * module owns that single step and nothing else: guardrail evaluation +
 * opening-message composition (task 6.3) and real-channel delivery (task 6.5)
 * consume the typed outcome produced here.
 *
 * The recall is read through the existing Memory recall interface
 * (`getActiveMemorySearchManagerCore` + `MemorySearchManager.search`, the same
 * owner `memory-search.ts` configures and `talk/fast-context-runtime.ts`
 * consumes) scoped to the target user's session. No new context store is
 * introduced (Req 2.2).
 *
 * The outcome mapping is a pure function of the recall result so the four I/O
 * paths (timeout / error / empty / non-empty) are directly example-testable
 * with a mocked recall interface (task 6.2): the runtime clock and manager are
 * injected, never read inside the mapper.
 */
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { withTimeout } from "../../infra/fs-safe.js";
import type { MemorySearchResult } from "../../memory-host-sdk/host/types.js";
import {
  createCronRunDiagnosticsFromError,
  normalizeCronRunDiagnostics,
} from "../run-diagnostics.js";
import type { CronRunDiagnostics } from "../types.js";

/** Hard upper bound on the recall call before the trigger withholds (Req 2.3). */
export const PROACTIVE_RECALL_TIMEOUT_MS = 5_000;

/**
 * Why recall did not yield usable context for this trigger. Each maps onto a
 * recorded run diagnostic and a withheld opening message (Req 2.3-2.5).
 */
export type ProactiveRecallWithholdReason = "recall_timeout" | "recall_error" | "recall_empty";

/**
 * Typed result of the recall step consumed by the later guardrail/compose and
 * delivery tasks. `proceed` carries the recalled details so composition can
 * reference at least one specific detail (Req 2.6); `withhold` carries the
 * reason and the diagnostics the run must record before withholding.
 */
export type ProactiveRecallOutcome =
  | { kind: "proceed"; details: MemorySearchResult[] }
  | {
      kind: "withhold";
      reason: ProactiveRecallWithholdReason;
      diagnostics: CronRunDiagnostics | undefined;
    };

/**
 * Raw result of one bounded recall attempt, before outcome mapping. `timeout`
 * is distinguished from `error` because a recall that exceeds the 5s bound is a
 * different diagnostic (Req 2.3 vs 2.4). `ok` carries whatever the recall
 * interface returned, including the empty case (Req 2.5).
 */
export type ProactiveRecallAttempt =
  | { status: "ok"; details: MemorySearchResult[] }
  | { status: "timeout" }
  | { status: "error"; error: unknown };

/**
 * Injectable recall interface. The runtime implementation
 * (`runtimeProactiveRecall`) reads the active memory manager; tests substitute a
 * deterministic function so the recall I/O paths are covered without the memory
 * runtime (task 6.2).
 */
export type ProactiveRecallFn = (params: {
  cfg: OpenClawConfig;
  agentId: string;
  /** Target user's session the recall is scoped to (Req 2.1). */
  sessionKey: string;
  /** Pending topic reference resolved into the recall query. */
  pendingTopicRef: string;
  signal?: AbortSignal;
}) => Promise<ProactiveRecallAttempt>;

/** Bounded query size mirrors the memory-search default result cap. */
const RECALL_MAX_RESULTS = 6;

/**
 * Runtime recall interface: reads the active memory manager for the agent and
 * searches the target user's session transcript for the pending topic, bounded
 * to 5 seconds via the shared `withTimeout` helper (Req 2.1-2.3). Timeout and
 * manager errors are reported as distinct statuses; the caller maps them to
 * diagnostics. This never introduces a separate context store (Req 2.2).
 */
export async function runtimeProactiveRecall(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  pendingTopicRef: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<ProactiveRecallAttempt> {
  const timeoutMs = params.timeoutMs ?? PROACTIVE_RECALL_TIMEOUT_MS;
  try {
    const details = await withTimeout(
      (async (): Promise<MemorySearchResult[]> => {
        // The memory runtime owns whether search is active for this agent. The
        // proactive turn only consumes the current manager when available.
        const { getActiveMemorySearchManagerCore } =
          await import("../../plugins/memory-runtime.js");
        const memory = await getActiveMemorySearchManagerCore({
          cfg: params.cfg,
          agentId: params.agentId,
        });
        if (!memory.manager) {
          throw new Error(memory.error ?? "no active memory manager");
        }
        try {
          return await memory.manager.search(params.pendingTopicRef, {
            maxResults: RECALL_MAX_RESULTS,
            sessionKey: params.sessionKey,
            signal: params.signal,
          });
        } finally {
          await memory.manager.close?.().catch(() => {});
        }
      })(),
      timeoutMs,
      { createError: () => new ProactiveRecallTimeoutError(timeoutMs) },
    );
    return { status: "ok", details };
  } catch (error) {
    if (error instanceof ProactiveRecallTimeoutError) {
      return { status: "timeout" };
    }
    return { status: "error", error };
  }
}

/** Marker error so the outcome mapper distinguishes a 5s bound from a manager error. */
class ProactiveRecallTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`proactive recall timed out after ${timeoutMs}ms`);
    this.name = "ProactiveRecallTimeoutError";
  }
}

/**
 * Pure mapping from a recall attempt to the trigger-time outcome (Req 2.3-2.6):
 * - timeout -> withhold `recall_timeout` with a recorded diagnostic;
 * - error   -> withhold `recall_error` with the failure diagnostic;
 * - empty   -> withhold `recall_empty` with an empty-context diagnostic;
 * - non-empty -> proceed, carrying the recalled details for composition.
 *
 * Diagnostics use the existing `run-diagnostics.ts` helpers so recall entries
 * are bounded, redacted, and merged like every other cron run diagnostic. The
 * clock is injected (`nowMs`) to keep the mapper deterministic and testable.
 */
export function mapProactiveRecallOutcome(
  attempt: ProactiveRecallAttempt,
  opts?: { nowMs?: () => number },
): ProactiveRecallOutcome {
  const nowMs = opts?.nowMs;
  switch (attempt.status) {
    case "timeout":
      return {
        kind: "withhold",
        reason: "recall_timeout",
        diagnostics: createCronRunDiagnosticsFromError(
          "cron-setup",
          `proactive recall timed out after ${PROACTIVE_RECALL_TIMEOUT_MS}ms`,
          { severity: "warn", nowMs },
        ),
      };
    case "error":
      return {
        kind: "withhold",
        reason: "recall_error",
        diagnostics: createCronRunDiagnosticsFromError(
          "cron-setup",
          `proactive recall failed: ${formatErrorMessage(attempt.error)}`,
          { severity: "warn", nowMs },
        ),
      };
    case "ok":
      if (attempt.details.length === 0) {
        return {
          kind: "withhold",
          reason: "recall_empty",
          diagnostics: normalizeCronRunDiagnostics(
            {
              summary: "proactive recall returned no context for the pending topic",
              entries: [
                {
                  ts: nowMs?.() ?? Date.now(),
                  source: "cron-setup",
                  severity: "warn",
                  message: "proactive recall returned no context for the pending topic",
                },
              ],
            },
            { nowMs },
          ),
        };
      }
      return { kind: "proceed", details: attempt.details };
  }
}

/**
 * Runs the bounded recall step and maps its result to a typed outcome in one
 * call. The recall function is injected so tests can substitute a deterministic
 * implementation; the runtime default reads the active memory manager.
 */
export async function performProactiveRecall(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  pendingTopicRef: string;
  signal?: AbortSignal;
  recall?: ProactiveRecallFn;
  nowMs?: () => number;
}): Promise<ProactiveRecallOutcome> {
  const recall = params.recall ?? runtimeProactiveRecall;
  const attempt = await recall({
    cfg: params.cfg,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    pendingTopicRef: params.pendingTopicRef,
    signal: params.signal,
  });
  return mapProactiveRecallOutcome(attempt, { nowMs: params.nowMs });
}
