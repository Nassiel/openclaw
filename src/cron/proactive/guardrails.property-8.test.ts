// Property coverage for proactive guardrail totality and precedence.
//
// Feature: proactive-conversations, Property 8: Guardrail evaluation order is
// deterministic and total.
//
// The repo intentionally does not pull in `fast-check` (see
// src/cron/proactive/resolution-state.property-3.test.ts and
// src/gateway/http-common.fuzz.test.ts); this file follows the same established
// convention: a small deterministic PRNG (mulberry32) plus hand-rolled
// generators drive >=100 iterations, and every failure prints the seed-derived
// input so the counterexample is reproducible.
import { describe, expect, it } from "vitest";
import {
  clampProactiveGuardrailConfig,
  evaluateProactiveGuardrails,
  type ClampedProactiveGuardrailConfig,
  type GuardrailDecision,
  type ProactiveGuardrailState,
} from "./guardrails.js";

/** Minimum property iterations required by the design (>= 100). */
const ITERATIONS = 500;

const MS_PER_SECOND = 1000;
const MINUTES_PER_DAY = 24 * 60;
const MS_PER_MINUTE = 60_000;

/**
 * A fixed UTC day anchors quiet-hours timestamps so minute-of-day is fully
 * deterministic: in UTC the wall clock never shifts, so `DAY_START_MS + minute *
 * 60000` always resolves to exactly `minute` minutes past midnight in UTC.
 */
const DAY_START_MS = Date.UTC(2024, 0, 1, 0, 0, 0, 0);

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

/**
 * True when `minute` is inside the quiet window under the engine's own
 * convention: empty windows (start === end) are never quiet, and start > end
 * wraps across midnight. This is an INDEPENDENT reimplementation of the
 * condition so the property checks the engine against a separately computed
 * expectation rather than against itself.
 */
function minuteIsQuiet(minute: number, start: number, end: number): boolean {
  if (start === end) {
    return false;
  }
  return end > start ? minute >= start && minute < end : minute >= start || minute < end;
}

type GeneratedInput = {
  firingAtMs: number;
  state: ProactiveGuardrailState;
  config: ClampedProactiveGuardrailConfig;
  optedOut: boolean;
  /** Present only when the config carries a quiet window; used to compute the expected decision. */
  quietWindow?: { startMinuteOfDay: number; endMinuteOfDay: number };
  /** Minute-of-day the firing time lands on when a quiet window is present. */
  firingMinuteOfDay?: number;
};

/**
 * Generate a broad guardrail input covering the whole decision space: with and
 * without a quiet window (biased toward covering empty, normal, and wrapping
 * windows), with and without a prior opening message (min-interval basis, chosen
 * around the interval boundary), and both opt-out states. Firing time is always
 * anchored to a UTC minute-of-day so the independent quiet-hours check is exact.
 */
function generateInput(rng: () => number): GeneratedInput {
  const rawSeconds = randInt(rng, 0, 200_000);
  const maxUnanswered = randInt(rng, 0, 15);
  const hasQuietHours = rng() < 0.5;

  let quietWindow: { startMinuteOfDay: number; endMinuteOfDay: number } | undefined;
  if (hasQuietHours) {
    quietWindow = {
      startMinuteOfDay: randInt(rng, 0, MINUTES_PER_DAY - 1),
      endMinuteOfDay: randInt(rng, 0, MINUTES_PER_DAY - 1),
    };
  }

  const config = clampProactiveGuardrailConfig({
    quietHours: quietWindow ? { ...quietWindow, tz: "UTC" } : undefined,
    minIntervalSeconds: rawSeconds,
    maxUnanswered,
  });

  const firingMinuteOfDay = randInt(rng, 0, MINUTES_PER_DAY - 1);
  const firingAtMs = DAY_START_MS + firingMinuteOfDay * MS_PER_MINUTE;

  // With probability, attach a prior opening message so the min-interval branch
  // is reachable; place it around the interval boundary so both inside and
  // outside the interval are exercised.
  const intervalMs = config.minIntervalSeconds * MS_PER_SECOND;
  let state: ProactiveGuardrailState = {};
  if (rng() < 0.7) {
    const bucket = randInt(rng, 0, 2);
    let gapMs: number;
    if (bucket === 0) {
      gapMs = randInt(rng, 0, intervalMs - 1); // strictly inside
    } else if (bucket === 1) {
      gapMs = intervalMs; // exactly at boundary
    } else {
      gapMs = intervalMs + randInt(rng, 1, 10_000_000); // beyond
    }
    state = { lastOpeningMessageAtMs: firingAtMs - gapMs };
  }

  const optedOut = rng() < 0.5;

  return { firingAtMs, state, config, optedOut, quietWindow, firingMinuteOfDay };
}

/**
 * Independently compute the expected decision by applying the documented
 * precedence opt-out -> quiet-hours -> min-interval -> allow. This mirrors the
 * design's fixed order but is written separately from the engine so the property
 * genuinely cross-checks the implementation.
 */
function expectedDecision(input: GeneratedInput): GuardrailDecision {
  // 1. Opt-out (highest precedence).
  if (input.optedOut) {
    return { kind: "withhold", reason: "opted_out" };
  }
  // 2. Quiet hours.
  if (
    input.quietWindow &&
    input.firingMinuteOfDay !== undefined &&
    minuteIsQuiet(
      input.firingMinuteOfDay,
      input.quietWindow.startMinuteOfDay,
      input.quietWindow.endMinuteOfDay,
    )
  ) {
    return { kind: "defer", reason: "quiet_hours" };
  }
  // 3. Minimum interval.
  const last = input.state.lastOpeningMessageAtMs;
  if (last !== undefined && Number.isFinite(last)) {
    const elapsedMs = input.firingAtMs - last;
    if (elapsedMs < input.config.minIntervalSeconds * MS_PER_SECOND) {
      return { kind: "withhold", reason: "min_interval" };
    }
  }
  // 4. Allow.
  return { kind: "allow" };
}

/** A decision is well-formed iff it is exactly one of the three tagged shapes with a valid reason. */
function isWellFormed(decision: GuardrailDecision): boolean {
  if (decision.kind === "allow") {
    return Object.keys(decision).length === 1;
  }
  if (decision.kind === "defer") {
    return decision.reason === "quiet_hours";
  }
  if (decision.kind === "withhold") {
    return (
      decision.reason === "quiet_hours" ||
      decision.reason === "min_interval" ||
      decision.reason === "opted_out"
    );
  }
  return false;
}

describe("Feature: proactive-conversations, Property 8", () => {
  // Property 8: Guardrail evaluation order is deterministic and total.
  // Validates: Requirements 5.1, 5.2, 5.3, 5.7, 5.8
  it("returns exactly one well-formed decision matching the fixed precedence for any input", () => {
    for (let i = 0; i < ITERATIONS; i += 1) {
      const seed = 0x80_00_00 + i;
      const rng = makeRng(seed);
      const input = generateInput(rng);

      const decision = evaluateProactiveGuardrails({
        firingAtMs: input.firingAtMs,
        state: input.state,
        config: input.config,
        optedOut: input.optedOut,
      });

      const label = `seed=${seed} input=${JSON.stringify({
        firingAtMs: input.firingAtMs,
        firingMinuteOfDay: input.firingMinuteOfDay,
        state: input.state,
        quietWindow: input.quietWindow,
        minIntervalSeconds: input.config.minIntervalSeconds,
        optedOut: input.optedOut,
      })} decision=${JSON.stringify(decision)}`;

      // Totality: the engine always returns exactly one well-formed decision.
      expect(isWellFormed(decision), `${label} (well-formed)`).toBe(true);

      // Precedence: the decision equals the highest-precedence satisfied
      // condition, computed independently (opt-out -> quiet -> min-interval -> allow).
      expect(decision, `${label} (precedence)`).toEqual(expectedDecision(input));
    }
  });

  it("is deterministic: repeated evaluations of the same input return the same decision", () => {
    for (let i = 0; i < ITERATIONS; i += 1) {
      const seed = 0x81_00_00 + i;
      const rng = makeRng(seed);
      const input = generateInput(rng);

      const params = {
        firingAtMs: input.firingAtMs,
        state: input.state,
        config: input.config,
        optedOut: input.optedOut,
      };
      const first = evaluateProactiveGuardrails(params);
      const second = evaluateProactiveGuardrails(params);
      const third = evaluateProactiveGuardrails(params);

      const label = `seed=${seed} first=${JSON.stringify(first)}`;
      expect(second, label).toEqual(first);
      expect(third, label).toEqual(first);
    }
  });

  it("enforces opt-out precedence over quiet-hours and min-interval regardless of other conditions", () => {
    for (let i = 0; i < ITERATIONS; i += 1) {
      const seed = 0x82_00_00 + i;
      const rng = makeRng(seed);
      const input = generateInput(rng);

      // Force opt-out on: it must dominate every lower-precedence condition.
      const decision = evaluateProactiveGuardrails({
        firingAtMs: input.firingAtMs,
        state: input.state,
        config: input.config,
        optedOut: true,
      });

      expect(decision, `seed=${seed}`).toEqual({ kind: "withhold", reason: "opted_out" });
    }
  });
});
