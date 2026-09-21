// Property coverage for the proactive max-unanswered bound and auto-abandon.
//
// Feature: proactive-conversations, Property 2: Unanswered count never exceeds
// the configured maximum before abandon.
//
// The repo intentionally does not pull in `fast-check` (see
// src/gateway/http-common.fuzz.test.ts and
// src/cron/proactive/resolution-state.property-3.test.ts); this file follows
// the same established convention: a small deterministic PRNG (mulberry32) plus
// hand-rolled generators drive >=100 iterations, and every failure prints the
// seed-derived input so the counterexample is reproducible.
import { describe, expect, it } from "vitest";
import {
  applyDeliveredOpeningMessage,
  clampMaxUnanswered,
  type ProactiveRuntimeState,
} from "./resolution-state.js";

/** Minimum property iterations required by the design (>= 100). */
const ITERATIONS = 200;

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
 * A fresh pending state that has not yet received any opening message. This is
 * the state from which the max-unanswered streak accumulates.
 */
function freshPendingState(rng: () => number): ProactiveRuntimeState {
  const state: ProactiveRuntimeState = {
    resolutionState: "pending",
    unansweredCount: 0,
  };
  if (rng() < 0.5) {
    state.lastUserResponseAtMs = randInt(rng, 0, 4_000_000_000_000);
  }
  return state;
}

describe("Feature: proactive-conversations, Property 2", () => {
  // Property 2: Unanswered count never exceeds the configured maximum before
  // abandon. Repeatedly delivering opening messages without an intervening user
  // response increments the streak, which never overshoots the clamped
  // maximum; the resolution state becomes "abandoned" exactly when the count
  // reaches the clamped maximum.
  // Validates: Requirements 5.4, 5.5
  it("never exceeds the clamped maximum and abandons exactly when it is reached", () => {
    for (let i = 0; i < ITERATIONS; i += 1) {
      const seed = 0x20_00_00 + i;
      const rng = makeRng(seed);

      // Draw a maxUnanswered spanning the valid 1-10 policy range plus
      // out-of-range values so the clamp is exercised by the property too.
      const rawMax = randInt(rng, -5, 15);
      const cap = clampMaxUnanswered(rawMax);
      const ctx = `seed=${seed} rawMax=${rawMax} cap=${cap}`;

      let state = freshPendingState(rng);
      // Deliver more openings than the cap so we drive through the abandon
      // boundary and confirm the count never overshoots afterward.
      const deliveries = cap + randInt(rng, 1, 4);
      let deliveredAtMs = randInt(rng, 0, 1_000_000);
      let abandonedAtCount: number | undefined;

      for (let d = 1; d <= deliveries; d += 1) {
        deliveredAtMs += randInt(rng, 1, 100_000);
        const prev = state;
        state = applyDeliveredOpeningMessage(prev, rawMax, deliveredAtMs);

        // The unanswered streak never exceeds the clamped maximum.
        expect(
          state.unansweredCount <= cap,
          `${ctx} delivery=${d} count=${state.unansweredCount}`,
        ).toBe(true);

        if (state.resolutionState === "abandoned" && abandonedAtCount === undefined) {
          abandonedAtCount = state.unansweredCount;
          // Abandon happens exactly at the cap, never before, never above.
          expect(abandonedAtCount, `${ctx} delivery=${d}`).toBe(cap);
        }

        // While still pending the count strictly tracks the delivery number.
        if (state.resolutionState === "pending") {
          expect(state.unansweredCount, `${ctx} delivery=${d}`).toBe(d);
          expect(state.unansweredCount < cap, `${ctx} delivery=${d}`).toBe(true);
        }

        // Once abandoned, further deliveries are inert: the terminal state and
        // its count are frozen (no overshoot past the cap).
        if (prev.resolutionState === "abandoned") {
          expect(state, `${ctx} delivery=${d}`).toEqual(prev);
        }
      }

      // The abandon transition must have occurred, exactly at the cap.
      expect(abandonedAtCount, `${ctx} deliveries=${deliveries}`).toBe(cap);
      expect(state.resolutionState, ctx).toBe("abandoned");
      expect(state.unansweredCount, ctx).toBe(cap);
    }
  });

  it("stays pending with the count below the cap before the threshold is reached", () => {
    for (let i = 0; i < ITERATIONS; i += 1) {
      const seed = 0x30_00_00 + i;
      const rng = makeRng(seed);

      const rawMax = randInt(rng, 1, 10);
      const cap = clampMaxUnanswered(rawMax);
      const ctx = `seed=${seed} rawMax=${rawMax} cap=${cap}`;

      // Deliver strictly fewer than the cap: state must remain pending and the
      // count must equal the number of deliveries, never crossing the bound.
      const deliveries = randInt(rng, 0, cap - 1);
      let state = freshPendingState(rng);
      let deliveredAtMs = randInt(rng, 0, 1_000_000);

      for (let d = 1; d <= deliveries; d += 1) {
        deliveredAtMs += randInt(rng, 1, 100_000);
        state = applyDeliveredOpeningMessage(state, rawMax, deliveredAtMs);
        expect(state.resolutionState, `${ctx} delivery=${d}`).toBe("pending");
        expect(state.unansweredCount, `${ctx} delivery=${d}`).toBe(d);
        expect(state.lastOpeningMessageAtMs, `${ctx} delivery=${d}`).toBe(deliveredAtMs);
      }

      expect(state.unansweredCount <= cap, ctx).toBe(true);
      expect(state.unansweredCount, ctx).toBe(deliveries);
    }
  });
});
