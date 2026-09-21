// Property coverage for guardrail-withheld classification.
//
// Feature: proactive-conversations, Property 4: Guardrail-withheld runs are
// intentional non-deliveries, never failures.
//
// The repo intentionally does not pull in `fast-check` (see
// src/cron/proactive/guardrails.property-8.test.ts,
// src/cron/proactive/resolution-state.property-3.test.ts, and
// src/cron/isolated-agent/proactive-decision.property-6.test.ts); this file
// follows that same established convention rather than adding a new dependency:
// a small deterministic PRNG (mulberry32) plus hand-rolled generators drive
// >=100 iterations, and every failure prints the seed-derived input so the
// counterexample is reproducible.
//
// Property 4 has two clauses, checked against the two owners in the wiring:
//   1. For any fired occurrence a guardrail defers or withholds, the run
//      produced by runProactiveCheckIn (proactive-run.ts) has deliveryState
//      status `not-delivered` with a `deliverySuppressionReason` set, AND is
//      classified as an intentional non-delivery (`succeeded`) — never `failed`
//      — by the actual classification owner (completion-status.ts). We call
//      resolveCronCompletionStatus / resolveAdmittedCronCompletionStatus
//      directly, not a re-implementation (Req 3.6, 5.7, 5.8).
//   2. For any run where NO guardrail withholding occurred (delivered, delivery
//      failure, and recall-gap withholds — which are diagnostic-only), no
//      guardrail `deliverySuppressionReason` is recorded (Req 5.8).
import { describe, expect, it } from "vitest";
import type { MemorySearchResult } from "../../memory-host-sdk/host/types.js";
import {
  resolveAdmittedCronCompletionStatus,
  resolveCronCompletionStatus,
} from "../completion-status.js";
import type { ProactiveRuntimeState } from "../proactive/resolution-state.js";
import type {
  CronDeliverySuppressionReason,
  CronMessageChannel,
  ProactiveGuardrailConfig,
} from "../types.js";
import type { ProactiveDecision, ProactiveOpeningMessage } from "./proactive-decision.js";
import type { ProactiveRecallWithholdReason } from "./proactive-recall.js";
import {
  runProactiveCheckIn,
  type ProactiveDeliveryResult,
  type ProactiveOpeningDeliveryFn,
} from "./proactive-run.js";

/** Minimum property iterations required by the design (>= 100). */
const ITERATIONS = 300;

/** Deterministic 32-bit PRNG (mulberry32). */
function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randInt(rng: () => number, loInclusive: number, hiInclusive: number): number {
  return Math.floor(rng() * (hiInclusive - loInclusive + 1)) + loInclusive;
}

function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[randInt(rng, 0, items.length - 1)]!;
}

/** The three guardrail suppression reasons the engine can emit (defer/withhold). */
const GUARDRAIL_REASONS: readonly Extract<
  CronDeliverySuppressionReason,
  "quiet_hours" | "min_interval" | "opted_out"
>[] = ["quiet_hours", "min_interval", "opted_out"];

/** Recall gaps: diagnostic-only withholds that must NOT carry a suppression reason. */
const RECALL_WITHHOLD_REASONS: readonly ProactiveRecallWithholdReason[] = [
  "recall_timeout",
  "recall_error",
  "recall_empty",
];

const CHANNELS = ["slack", "discord", "telegram", "email", "sms"] as const;

function arbitraryState(rng: () => number): ProactiveRuntimeState {
  const state: ProactiveRuntimeState = {
    resolutionState: "pending",
    unansweredCount: randInt(rng, 0, 9),
  };
  if (rng() < 0.6) {
    state.lastOpeningMessageAtMs = randInt(rng, 0, 4_000_000_000_000);
  }
  if (rng() < 0.4) {
    state.lastUserResponseAtMs = randInt(rng, 0, 4_000_000_000_000);
  }
  return state;
}

function arbitraryGuardrails(rng: () => number): ProactiveGuardrailConfig {
  return {
    minIntervalSeconds: randInt(rng, 900, 86_400),
    maxUnanswered: randInt(rng, 1, 10),
  };
}

function arbitraryDetail(rng: () => number): MemorySearchResult {
  const startLine = randInt(rng, 1, 500);
  return {
    path: `sessions/topic-${randInt(rng, 0, 9999)}.md`,
    startLine,
    endLine: startLine + randInt(rng, 0, 20),
    score: randInt(rng, -50, 100) / 10,
    snippet: pick(rng, ["finish the deployment doc", "review the migration plan", ""]),
    source: rng() < 0.5 ? "memory" : "sessions",
  };
}

function arbitraryMessage(rng: () => number, channel: CronMessageChannel): ProactiveOpeningMessage {
  const detail = arbitraryDetail(rng);
  return {
    deliveryChannel: channel,
    text: `Earlier you mentioned: "${detail.snippet}". Want to pick that back up?`,
    referencedDetail: detail,
    recalledDetails: [detail],
  };
}

function makeDeliverFn(result: ProactiveDeliveryResult): ProactiveOpeningDeliveryFn {
  return async () => result;
}

/**
 * Classifies the run outcome the same way the runtime does, through the actual
 * completion-status owner. A proactive check-in delivers by default (delivery is
 * required, not best-effort), so both the general resolver and the admitted-job
 * resolver are exercised with `requiredDelivery: true` — the harder case where a
 * missing suppression reason would flip a not-delivered run to `failed`.
 */
function classify(outcome: {
  status: "ok" | "error" | "skipped";
  deliveryStatus: "delivered" | "not-delivered" | "unknown" | "not-requested";
  deliverySuppressionReason?: CronDeliverySuppressionReason;
}): {
  general: ReturnType<typeof resolveCronCompletionStatus>;
  admitted: ReturnType<typeof resolveAdmittedCronCompletionStatus>;
} {
  return {
    general: resolveCronCompletionStatus({
      status: outcome.status,
      deliveryStatus: outcome.deliveryStatus,
      deliverySuppressionReason: outcome.deliverySuppressionReason,
      requiredDelivery: true,
    }),
    // {} => delivery.bestEffort !== true, so an announce delivery is required.
    admitted: resolveAdmittedCronCompletionStatus(
      {},
      outcome.status,
      outcome.deliveryStatus,
      outcome.deliverySuppressionReason,
    ),
  };
}

describe("Feature: proactive-conversations, Property 4", () => {
  // Property 4: Guardrail-withheld runs are intentional non-deliveries, never failures.
  // Validates: Requirements 3.6, 5.7, 5.8

  it("classifies any guardrail-withheld run as an intentional non-delivery (succeeded), never a failure", async () => {
    for (let i = 0; i < ITERATIONS; i += 1) {
      const seed = 0x40_00_00 + i;
      const rng = makeRng(seed);

      const reason = pick(rng, GUARDRAIL_REASONS);
      const decision: ProactiveDecision = {
        kind: "withhold",
        source: { kind: "guardrail", reason },
        deliverySuppressionReason: reason,
      };
      const state = arbitraryState(rng);

      const result = await runProactiveCheckIn({
        decision,
        state,
        guardrails: arbitraryGuardrails(rng),
        targetUser: `user-${randInt(rng, 0, 9999)}`,
        firingAtMs: randInt(rng, 0, 4_000_000_000_000),
        // A deliver fn that would report success — proving delivery is never
        // attempted for a withheld decision (the reason drives the outcome).
        deliver: makeDeliverFn({ delivered: true }),
      });

      const label = `seed=${seed} reason=${reason} outcome=${JSON.stringify(result.outcome)}`;

      // not-delivered + a guardrail suppression reason is recorded (Req 3.6, 5.8).
      expect(result.outcome.deliveryState.status, `${label} (not-delivered)`).toBe("not-delivered");
      expect(result.outcome.deliveryState.delivered, `${label} (not delivered flag)`).not.toBe(
        true,
      );
      expect(result.outcome.deliverySuppressionReason, `${label} (reason recorded)`).toBe(reason);
      expect(
        result.outcome.deliveryState.deliverySuppressionReason,
        `${label} (reason on delivery state)`,
      ).toBe(reason);
      // The run status is not an execution error — a withhold is an OK run.
      expect(result.outcome.status, `${label} (ok status)`).toBe("ok");

      // The ACTUAL classification owner treats not-delivered + reason as an
      // intentional non-delivery: succeeded, never failed (Req 5.8).
      const classified = classify({
        status: result.outcome.status,
        deliveryStatus: result.outcome.deliveryState.status,
        deliverySuppressionReason: result.outcome.deliverySuppressionReason,
      });
      expect(classified.general, `${label} (general classification)`).toBe("succeeded");
      expect(classified.admitted, `${label} (admitted classification)`).toBe("succeeded");
      expect(classified.general, `${label} (never failed - general)`).not.toBe("failed");
      expect(classified.admitted, `${label} (never failed - admitted)`).not.toBe("failed");

      // State is unchanged: a withheld occurrence never reached the user.
      expect(result.proactiveState, `${label} (state unchanged)`).toEqual(state);
    }
  });

  it("records no guardrail suppression reason when no guardrail withholding occurred", async () => {
    for (let i = 0; i < ITERATIONS; i += 1) {
      const seed = 0x41_00_00 + i;
      const rng = makeRng(seed);

      // Three non-guardrail-withhold run shapes: delivered, delivery failure, and
      // a recall-gap withhold (diagnostic-only). None must carry a guardrail
      // deliverySuppressionReason (Req 5.8).
      const shape = pick(rng, ["delivered", "failed", "recall_gap"] as const);
      const channel = pick(rng, CHANNELS);
      const state = arbitraryState(rng);

      let decision: ProactiveDecision;
      let deliver: ProactiveOpeningDeliveryFn;
      if (shape === "recall_gap") {
        const reason = pick(rng, RECALL_WITHHOLD_REASONS);
        decision = {
          kind: "withhold",
          source: { kind: "recall", reason },
          diagnostics: {
            summary: `proactive recall ${reason}`,
            entries: [
              {
                ts: randInt(rng, 0, 4_000_000_000_000),
                source: "cron-setup",
                severity: "warn",
                message: `proactive recall ${reason}`,
              },
            ],
          },
        };
        deliver = makeDeliverFn({ delivered: true });
      } else {
        decision = { kind: "deliver", message: arbitraryMessage(rng, channel) };
        deliver =
          shape === "delivered"
            ? makeDeliverFn({ delivered: true })
            : makeDeliverFn({ delivered: false, error: `send failed #${i}` });
      }

      const result = await runProactiveCheckIn({
        decision,
        state,
        guardrails: arbitraryGuardrails(rng),
        targetUser: `user-${randInt(rng, 0, 9999)}`,
        firingAtMs: randInt(rng, 0, 4_000_000_000_000),
        deliver,
      });

      const label = `seed=${seed} shape=${shape} outcome=${JSON.stringify(result.outcome)}`;

      // No guardrail withholding => no suppression reason anywhere on the run.
      expect(
        result.outcome.deliverySuppressionReason,
        `${label} (no suppression reason)`,
      ).toBeUndefined();
      expect(
        result.outcome.deliveryState.deliverySuppressionReason,
        `${label} (no suppression reason on delivery state)`,
      ).toBeUndefined();

      // And the classification owner must NOT treat these as intentional
      // non-deliveries via a guardrail reason:
      //  - a genuine delivery failure classifies as failed (no reason to rescue it);
      //  - a delivered run classifies as succeeded;
      //  - a recall gap is not-delivered with no reason, so a required delivery
      //    classifies as failed (a recall gap is diagnostic-only, and this test
      //    only asserts no guardrail reason masks it — the recall-gap policy is
      //    Property 6's concern).
      const classified = classify({
        status: result.outcome.status,
        deliveryStatus: result.outcome.deliveryState.status,
        deliverySuppressionReason: result.outcome.deliverySuppressionReason,
      });
      if (shape === "delivered") {
        expect(classified.general, `${label} (delivered succeeds)`).toBe("succeeded");
        expect(classified.admitted, `${label} (delivered succeeds admitted)`).toBe("succeeded");
      } else {
        // No guardrail reason present, so the run is never rescued to succeeded
        // by an intentional-non-delivery classification.
        expect(classified.general, `${label} (not rescued - general)`).not.toBe("succeeded");
        expect(classified.admitted, `${label} (not rescued - admitted)`).not.toBe("succeeded");
      }
    }
  });
});
