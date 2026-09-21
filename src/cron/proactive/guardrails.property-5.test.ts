// Property coverage for the proactive minimum-interval guardrail.
//
// Feature: proactive-conversations, Property 5: Minimum interval holds between
// consecutive opening messages.
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
} from "./guardrails.js";

/** Minimum property iterations required by the design (>= 100). */
const ITERATIONS = 300;

const MS_PER_SECOND = 1000;
/** Documented min-interval clamp range (Req 5.2). */
const MIN_INTERVAL_SECONDS_MIN = 900;
const MIN_INTERVAL_SECONDS_MAX = 86400;

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
 * A min-interval config inside the documented range. Quiet-hours is left unset
 * so the min-interval branch is reached whenever opt-out is false (the higher
 * precedence guards do not fire), isolating Property 5.
 */
function arbitraryConfig(rng: () => number): ClampedProactiveGuardrailConfig {
  // Feed a value spanning below/within/above the documented range through the
  // boundary clamp so the effective knob is always a legal 900-86400 value.
  const rawSeconds = randInt(rng, 0, 200000);
  return clampProactiveGuardrailConfig({
    minIntervalSeconds: rawSeconds,
    maxUnanswered: randInt(rng, 1, 10),
  });
}

describe("Feature: proactive-conversations, Property 5", () => {
  // Property 5: Minimum interval holds between consecutive opening messages.
  // Validates: Requirements 5.2, 5.3
  it("withholds min_interval strictly inside the interval and allows at or beyond it", () => {
    for (let i = 0; i < ITERATIONS; i += 1) {
      const seed = 0x50_50_00 + i;
      const rng = makeRng(seed);
      const config = arbitraryConfig(rng);

      // Effective interval is always within the documented clamp range.
      expect(config.minIntervalSeconds, `seed=${seed}`).toBeGreaterThanOrEqual(
        MIN_INTERVAL_SECONDS_MIN,
      );
      expect(config.minIntervalSeconds, `seed=${seed}`).toBeLessThanOrEqual(
        MIN_INTERVAL_SECONDS_MAX,
      );

      const intervalMs = config.minIntervalSeconds * MS_PER_SECOND;
      const lastOpeningMessageAtMs = randInt(rng, 0, 4_000_000_000_000);

      // Choose a gap around the boundary so both sides are exercised: sometimes
      // strictly inside [0, interval), sometimes exactly at the interval, and
      // sometimes beyond it.
      const bucket = randInt(rng, 0, 2);
      let gapMs: number;
      if (bucket === 0) {
        // Strictly inside the interval -> must withhold.
        gapMs = randInt(rng, 0, intervalMs - 1);
      } else if (bucket === 1) {
        // Exactly at the boundary -> must allow (elapsed == interval is not < interval).
        gapMs = intervalMs;
      } else {
        // Beyond the interval -> must allow.
        gapMs = intervalMs + randInt(rng, 1, 10_000_000);
      }
      const firingAtMs = lastOpeningMessageAtMs + gapMs;

      const decision = evaluateProactiveGuardrails({
        firingAtMs,
        state: { lastOpeningMessageAtMs },
        config,
        optedOut: false,
      });

      const label = `seed=${seed} intervalMs=${intervalMs} gapMs=${gapMs} decision=${JSON.stringify(decision)}`;
      if (gapMs < intervalMs) {
        // Req 5.3: a trigger earlier than the interval is withheld with min_interval.
        expect(decision, label).toEqual({ kind: "withhold", reason: "min_interval" });
      } else {
        // Req 5.2: at or beyond the interval the opening message is allowed.
        expect(decision, label).toEqual({ kind: "allow" });
      }
    }
  });

  it("allows when no prior opening message has been recorded", () => {
    for (let i = 0; i < ITERATIONS; i += 1) {
      const seed = 0x51_50_00 + i;
      const rng = makeRng(seed);
      const config = arbitraryConfig(rng);
      const firingAtMs = randInt(rng, 0, 4_000_000_000_000);

      // No lastOpeningMessageAtMs -> there is no prior message to space from,
      // so the min-interval guard cannot fire (Req 5.3 applies only once a
      // previous Opening_Message exists).
      const decision = evaluateProactiveGuardrails({
        firingAtMs,
        state: {},
        config,
        optedOut: false,
      });

      expect(decision, `seed=${seed}`).toEqual({ kind: "allow" });
    }
  });

  it("simulates consecutive deliveries: the enforced spacing is never below the interval", () => {
    for (let i = 0; i < ITERATIONS; i += 1) {
      const seed = 0x52_50_00 + i;
      const rng = makeRng(seed);
      const config = arbitraryConfig(rng);
      const intervalMs = config.minIntervalSeconds * MS_PER_SECOND;

      // Walk a chain of trigger firings; a delivery only happens when the guard
      // allows, and each allowed delivery advances lastOpeningMessageAtMs. The
      // gap between any two consecutive *delivered* messages must be >= interval.
      let lastDeliveredAtMs: number | undefined;
      let firingAtMs = randInt(rng, 0, 1_000_000_000_000);
      const steps = randInt(rng, 5, 30);
      for (let step = 0; step < steps; step += 1) {
        const decision = evaluateProactiveGuardrails({
          firingAtMs,
          state: { lastOpeningMessageAtMs: lastDeliveredAtMs },
          config,
          optedOut: false,
        });
        if (decision.kind === "allow") {
          if (lastDeliveredAtMs !== undefined) {
            expect(
              firingAtMs - lastDeliveredAtMs,
              `seed=${seed} step=${step} intervalMs=${intervalMs}`,
            ).toBeGreaterThanOrEqual(intervalMs);
          }
          lastDeliveredAtMs = firingAtMs;
        } else {
          // Any non-allow while pending, non-opted-out, no quiet hours must be
          // the min-interval withhold.
          expect(decision, `seed=${seed} step=${step}`).toEqual({
            kind: "withhold",
            reason: "min_interval",
          });
        }
        // Advance the clock by an arbitrary positive amount (sometimes small
        // enough to stay inside the interval, sometimes past it).
        firingAtMs += randInt(rng, 1, intervalMs * 2);
      }
    }
  });
});
