/**
 * Trigger-time decision flow for the `proactiveCheckIn` branch: recall ->
 * guardrails -> compose (tasks 6.1, 4.1, 6.3). This module owns the middle of
 * the branch — it consumes the recall outcome produced by `proactive-recall.ts`,
 * runs the guardrail engine (`proactive/guardrails.ts`), and, when outreach is
 * allowed, composes the Opening_Message plan that references at least one
 * specific recalled detail (Req 2.6). Delivery + run-outcome recording (task
 * 6.5) consumes the typed result produced here; this module performs the
 * decision only and never sends.
 *
 * Everything here is a pure function of its inputs: the firing time, the recall
 * outcome, the guardrail policy, the live proactive state, and the
 * already-resolved opt-out flag are all parameters. That keeps the whole
 * decision deterministic and directly property-testable (task 6.4) without the
 * memory runtime, the scheduler clock, or the channel transport.
 *
 * Opt-out is NOT re-implemented here. The guardrail engine reads it as a
 * resolved boolean, and the caller passes that boolean in via `resolveOptedOut`
 * (the existing channel/user opt-out contract). The default resolver treats the
 * target as not opted out so a caller that has no opt-out source wired yet still
 * gets a correct, conservative decision.
 */
import type { MemorySearchResult } from "../../memory-host-sdk/host/types.js";
import {
  clampProactiveGuardrailConfig,
  evaluateProactiveGuardrails,
  type ClampedProactiveGuardrailConfig,
  type ProactiveGuardrailState,
} from "../proactive/guardrails.js";
import type {
  CronDeliverySuppressionReason,
  CronMessageChannel,
  CronRunDiagnostics,
  ProactiveGuardrailConfig,
} from "../types.js";
import type { ProactiveRecallOutcome, ProactiveRecallWithholdReason } from "./proactive-recall.js";

/**
 * The composed Opening_Message plan handed to delivery (task 6.5). It carries
 * the text to send, the delivery channel, and — for traceability and the
 * "reference at least one recalled detail" invariant (Req 2.6) — the specific
 * recalled detail the message was built around plus the full recalled set.
 */
export type ProactiveOpeningMessage = {
  /** Target user-facing channel the message is delivered through (never "cron"). */
  deliveryChannel: CronMessageChannel;
  /** Composed opening text; references `referencedDetail` (Req 2.6). */
  text: string;
  /** The specific recalled detail the message references (Req 2.6). */
  referencedDetail: MemorySearchResult;
  /** Full recalled context, in case delivery/turn wants richer grounding. */
  recalledDetails: MemorySearchResult[];
};

/**
 * Reason a proactive trigger did not deliver. Recall gaps
 * (`ProactiveRecallWithholdReason`) are recorded as diagnostics only and are not
 * `CronDeliverySuppressionReason`s (they are recall I/O outcomes, Req 2.3-2.5);
 * guardrail withholds carry a `CronDeliverySuppressionReason` so the run is
 * classified as an intentional non-delivery (Req 3.6, 5.7, 5.8).
 */
export type ProactiveWithholdSource =
  | { kind: "recall"; reason: ProactiveRecallWithholdReason }
  | {
      kind: "guardrail";
      reason: Extract<CronDeliverySuppressionReason, "quiet_hours" | "min_interval" | "opted_out">;
    };

/**
 * Typed outcome of the recall -> guardrails -> compose flow consumed by task
 * 6.5. `deliver` carries the composed Opening_Message; `withhold` carries the
 * source (recall gap vs guardrail), the `deliverySuppressionReason` to record
 * for guardrail withholds, and any diagnostics to persist on the run.
 */
export type ProactiveDecision =
  | { kind: "deliver"; message: ProactiveOpeningMessage }
  | {
      kind: "withhold";
      source: ProactiveWithholdSource;
      /**
       * The reason recorded on the run as a `deliverySuppressionReason`. Present
       * only for guardrail withholds (Req 5.8); undefined for recall gaps, which
       * are recorded via diagnostics rather than a suppression reason.
       */
      deliverySuppressionReason?: CronDeliverySuppressionReason;
      /** Diagnostics to record before withholding (recall paths, Req 2.3-2.5). */
      diagnostics?: CronRunDiagnostics;
    };

/**
 * Resolves whether the target user has opted out of proactive outreach for the
 * delivery channel, through the existing channel/user opt-out contract. Injected
 * so the decision stays pure and testable; the default is "not opted out" so a
 * caller without an opt-out source wired still produces a conservative decision.
 */
export type ProactiveOptOutResolver = (params: {
  targetUser: string;
  deliveryChannel: CronMessageChannel;
}) => boolean;

const notOptedOut: ProactiveOptOutResolver = () => false;

/** Max characters of a recalled snippet echoed into the opening message. */
const REFERENCED_SNIPPET_MAX_CHARS = 240;

/**
 * Picks the single recalled detail the opening message references. The recall
 * step already returns hits ranked by score (highest first); the first hit is
 * the most relevant, so the message is grounded in it (Req 2.6). Callers only
 * reach here with a non-empty list (the `proceed` recall outcome guarantees it).
 */
function pickReferencedDetail(details: MemorySearchResult[]): MemorySearchResult {
  let best = details[0]!;
  for (const detail of details) {
    if (
      typeof detail.score === "number" &&
      detail.score > (best.score ?? Number.NEGATIVE_INFINITY)
    ) {
      best = detail;
    }
  }
  return best;
}

/** Collapses whitespace and trims a recalled snippet to a bounded, single-line reference. */
function normalizeReferencedSnippet(snippet: string): string {
  const collapsed = snippet.replace(/\s+/gu, " ").trim();
  if (collapsed.length <= REFERENCED_SNIPPET_MAX_CHARS) {
    return collapsed;
  }
  return `${collapsed.slice(0, REFERENCED_SNIPPET_MAX_CHARS - 1).trimEnd()}…`;
}

/**
 * Composes the Opening_Message from the recalled context. The composed text
 * references the specific recalled detail (its snippet) so the outreach is about
 * the pending topic, not generic (Req 2.6). This is the deterministic grounding
 * the agent turn delivers; richer model-authored phrasing layers on top of it in
 * task 6.5, but the recalled detail is always carried through and referenced.
 */
export function composeProactiveOpeningMessage(params: {
  deliveryChannel: CronMessageChannel;
  pendingTopicRef: string;
  recalledDetails: MemorySearchResult[];
}): ProactiveOpeningMessage {
  const referencedDetail = pickReferencedDetail(params.recalledDetails);
  const snippet = normalizeReferencedSnippet(referencedDetail.snippet);
  const text =
    snippet.length > 0
      ? `Earlier you mentioned: "${snippet}". Want to pick that back up?`
      : `Earlier you mentioned ${params.pendingTopicRef}. Want to pick that back up?`;
  return {
    deliveryChannel: params.deliveryChannel,
    text,
    referencedDetail,
    recalledDetails: params.recalledDetails,
  };
}

/**
 * Runs the guardrail engine against the recall result and composes the opening
 * message when outreach is allowed. Precedence and totality live in the engine;
 * this maps its decision onto the branch's typed result:
 * - recall `withhold` -> withhold (recall source, diagnostics carried, no
 *   suppression reason — recall gaps are diagnostic-only, Req 2.3-2.5);
 * - guardrail `defer`/`withhold` -> withhold (guardrail source, the matching
 *   `deliverySuppressionReason` recorded, Req 3.6, 5.1, 5.3, 5.7, 5.8);
 * - guardrail `allow` -> deliver, composing the Opening_Message (Req 2.6).
 *
 * The caller is expected to have already short-circuited terminal
 * (`resolved`/`abandoned`) states before invoking this (Req 3.5, 4.6).
 */
export function decideProactiveOutreach(params: {
  firingAtMs: number;
  recall: ProactiveRecallOutcome;
  pendingTopicRef: string;
  targetUser: string;
  deliveryChannel: CronMessageChannel;
  guardrails: ProactiveGuardrailConfig | ClampedProactiveGuardrailConfig;
  state: ProactiveGuardrailState;
  resolveOptedOut?: ProactiveOptOutResolver;
}): ProactiveDecision {
  // Recall gaps withhold before any guardrail runs: there is nothing to ground a
  // message in, so outreach is withheld and the recall diagnostic is recorded
  // (Req 2.3-2.5). These are not guardrail suppressions, so no
  // deliverySuppressionReason is attached.
  if (params.recall.kind === "withhold") {
    return {
      kind: "withhold",
      source: { kind: "recall", reason: params.recall.reason },
      diagnostics: params.recall.diagnostics,
    };
  }

  const config = clampGuardrailConfig(params.guardrails);
  const optedOut = (params.resolveOptedOut ?? notOptedOut)({
    targetUser: params.targetUser,
    deliveryChannel: params.deliveryChannel,
  });
  const decision = evaluateProactiveGuardrails({
    firingAtMs: params.firingAtMs,
    state: params.state,
    config,
    optedOut,
  });

  if (decision.kind !== "allow") {
    // `defer` (quiet-hours) and `withhold` (opt-out / min-interval) both withhold
    // this trigger and record the guardrail reason as the deliverySuppressionReason
    // so the run is an intentional non-delivery, never a failure (Req 5.8).
    return {
      kind: "withhold",
      source: { kind: "guardrail", reason: decision.reason },
      deliverySuppressionReason: decision.reason,
    };
  }

  return {
    kind: "deliver",
    message: composeProactiveOpeningMessage({
      deliveryChannel: params.deliveryChannel,
      pendingTopicRef: params.pendingTopicRef,
      recalledDetails: params.recall.details,
    }),
  };
}

/** Clamp policy at the decision boundary, tolerating an already-clamped config. */
function clampGuardrailConfig(
  guardrails: ProactiveGuardrailConfig | ClampedProactiveGuardrailConfig,
): ClampedProactiveGuardrailConfig {
  return clampProactiveGuardrailConfig(guardrails);
}
