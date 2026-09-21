// Property coverage for the proactive resolved/abandoned occurrence short-circuit.
//
// Feature: proactive-conversations, Property 1: Resolved or abandoned check-ins
// never send. For any proactive check-in whose live Resolution_State is
// `resolved` or `abandoned`, and any fired occurrence evaluated after that
// state, occurrence evaluation cancels without composing or delivering an
// Opening_Message (Req 3.5, 4.2, 4.5, 4.6, 4.7).
//
// The occurrence short-circuit is owned by resolveProactiveResolutionState /
// isProactiveOccurrenceSuppressed and gated inside isRunnableJob, the single
// occurrence-evaluation gate shared by live scheduling and restart catch-up.
// This property tests through that owner (isRunnableJob): a resolved/abandoned
// proactive job that is otherwise fully due is never runnable, while an
// identically-scheduled pending job is, so the suppression is what cancels the
// occurrence rather than any scheduling coincidence.
//
// The repo intentionally does not pull in `fast-check` (see
// src/gateway/http-common.fuzz.test.ts and the sibling proactive property
// tests such as resolution-state.property-3.test.ts); this file follows the
// same established convention: a small deterministic PRNG (mulberry32) plus
// hand-rolled generators drive >=100 iterations, and every failure prints the
// seed-derived input so the counterexample is reproducible.
import { describe, expect, it } from "vitest";
import type { CronJob, CronProactiveResolutionState } from "../types.js";
import type { CronServiceState } from "./state.js";
import { isRunnableJob } from "./timer-runnable.js";

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

function pick<T>(rng: () => number, values: readonly T[]): T {
  return values[randInt(rng, 0, values.length - 1)];
}

/**
 * isRunnableJob reads only params.job / params.nowMs / params.skip* off the
 * arguments; the CronServiceState is threaded through but not consulted by the
 * gate under test, so an empty state stands in for the occurrence-evaluation
 * caller without pulling in the full service runtime.
 */
const EMPTY_STATE = {} as unknown as CronServiceState;

const RESOLUTION_STATES: readonly CronProactiveResolutionState[] = [
  "pending",
  "resolved",
  "abandoned",
];

const TERMINAL_STATES: readonly CronProactiveResolutionState[] = ["resolved", "abandoned"];

type ResolutionSource = "live" | "legacy-payload";

/**
 * Builds a proactive check-in job that is enabled, time-scheduled, has no
 * active run, and whose scheduled slot is already due at `nowMs` (an `every`
 * schedule with a past nextRunAtMs). Absent the resolution short-circuit this
 * job WOULD be runnable, so a non-runnable result isolates the suppression.
 *
 * `source` selects where the resolution state lives: the live `proactive`
 * block (authoritative post-migration) or, for a legacy row without that
 * block, the payload's initial resolutionState fallback.
 */
function dueProactiveJob(params: {
  rng: () => number;
  nowMs: number;
  resolutionState: CronProactiveResolutionState;
  source: ResolutionSource;
}): CronJob {
  const { rng, nowMs, resolutionState, source } = params;
  const everyMs = randInt(rng, 1_000, 3_600_000);
  // A slot strictly in the past so nowMs >= nextRunAtMs (the occurrence fired).
  const nextRunAtMs = nowMs - randInt(rng, 1, 5_000_000);
  const state: CronJob["state"] =
    source === "live"
      ? {
          nextRunAtMs,
          proactive: {
            resolutionState,
            unansweredCount: randInt(rng, 0, 5),
          },
        }
      : { nextRunAtMs };
  return {
    id: `proactive-${randInt(rng, 0, 1_000_000)}`,
    name: "proactive check-in",
    enabled: true,
    createdAtMs: Math.max(0, nextRunAtMs - everyMs),
    updatedAtMs: Math.max(0, nextRunAtMs - everyMs),
    schedule: { kind: "every", everyMs, anchorMs: Math.max(0, nextRunAtMs - everyMs) },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: {
      kind: "proactiveCheckIn",
      pendingTopicRef: "topic-deploy-doc",
      targetUser: "user-1",
      deliveryChannel: pick(rng, ["discord", "telegram", "slack"] as const),
      // For the legacy-payload source the payload value is the only resolution
      // signal; for the live source it is deliberately independent so the test
      // proves the live block is authoritative.
      resolutionState: source === "legacy-payload" ? resolutionState : pick(rng, RESOLUTION_STATES),
      guardrails: { minIntervalSeconds: 3600, maxUnanswered: 3 },
    },
    state,
  } as unknown as CronJob;
}

describe("Feature: proactive-conversations, Property 1", () => {
  // Property 1: Resolved or abandoned check-ins never send.
  // Validates: Requirements 3.5, 4.2, 4.5, 4.6, 4.7
  it("never runs a due occurrence once the live resolution state is resolved or abandoned", () => {
    for (let i = 0; i < ITERATIONS; i += 1) {
      const seed = 0x1_00_00 + i;
      const rng = makeRng(seed);
      const nowMs = randInt(rng, 5_000_001, 4_000_000_000_000);
      const resolutionState = pick(rng, TERMINAL_STATES);
      const source = pick(rng, ["live", "legacy-payload"] as const);
      const job = dueProactiveJob({ rng, nowMs, resolutionState, source });

      // The occurrence has fired (nowMs >= nextRunAtMs) yet must be cancelled:
      // no turn, no send. The single occurrence-evaluation gate expresses that
      // cancellation as "not runnable".
      const runnable = isRunnableJob({ state: EMPTY_STATE, job, nowMs });
      expect(
        runnable,
        `seed=${seed} resolutionState=${resolutionState} source=${source} nextRunAtMs=${job.state.nextRunAtMs} nowMs=${nowMs}`,
      ).toBe(false);
    }
  });

  it("keeps evaluating a due occurrence while still pending (proves suppression, not scheduling, cancels)", () => {
    for (let i = 0; i < ITERATIONS; i += 1) {
      const seed = 0x2_00_00 + i;
      const rng = makeRng(seed);
      const nowMs = randInt(rng, 5_000_001, 4_000_000_000_000);
      const source = pick(rng, ["live", "legacy-payload"] as const);
      const job = dueProactiveJob({ rng, nowMs, resolutionState: "pending", source });

      // An identically-scheduled pending job IS runnable, so a resolved/abandoned
      // job's non-runnable result above is caused by the resolution short-circuit
      // rather than the schedule or job shape (Req 4.3).
      const runnable = isRunnableJob({ state: EMPTY_STATE, job, nowMs });
      expect(
        runnable,
        `seed=${seed} source=${source} nextRunAtMs=${job.state.nextRunAtMs} nowMs=${nowMs}`,
      ).toBe(true);
    }
  });

  it("suppression survives the catch-up path too (allowCronMissedRunByLastRun)", () => {
    for (let i = 0; i < ITERATIONS; i += 1) {
      const seed = 0x3_00_00 + i;
      const rng = makeRng(seed);
      const nowMs = randInt(rng, 5_000_001, 4_000_000_000_000);
      const resolutionState = pick(rng, TERMINAL_STATES);
      const source = pick(rng, ["live", "legacy-payload"] as const);
      const job = dueProactiveJob({ rng, nowMs, resolutionState, source });

      // Restart catch-up shares this gate. A resolved/abandoned job must not
      // resume outreach even when missed-run replay is enabled (Req 4.2, 4.7).
      const runnable = isRunnableJob({
        state: EMPTY_STATE,
        job,
        nowMs,
        allowCronMissedRunByLastRun: true,
      });
      expect(
        runnable,
        `seed=${seed} resolutionState=${resolutionState} source=${source} nextRunAtMs=${job.state.nextRunAtMs} nowMs=${nowMs}`,
      ).toBe(false);
    }
  });
});
