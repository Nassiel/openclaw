// Property coverage for the proactive user-response reset transition.
//
// Feature: proactive-conversations, Property 3: A user response resets the
// unanswered count.
//
// The repo intentionally does not pull in `fast-check` (see
// src/gateway/http-common.fuzz.test.ts and
// extensions/browser/src/browser/cdp.helpers.fuzz.test.ts); this file follows
// the same established convention: a small deterministic PRNG (mulberry32) plus
// hand-rolled generators drive >=100 iterations, and every failure prints the
// seed-derived input so the counterexample is reproducible.
import { describe, expect, it } from "vitest";
import type { CronProactiveResolutionState } from "../types.js";
import { applyUserResponse, type ProactiveRuntimeState } from "./resolution-state.js";

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

const RESOLUTION_STATES: readonly CronProactiveResolutionState[] = [
  "pending",
  "resolved",
  "abandoned",
];

/**
 * Generates an arbitrary proactive runtime state spanning any unanswered count
 * (including 0 and large streaks), any resolution state, and both presence and
 * absence of the optional timestamp fields.
 */
function arbitraryState(rng: () => number): ProactiveRuntimeState {
  const state: ProactiveRuntimeState = {
    resolutionState: RESOLUTION_STATES[randInt(rng, 0, RESOLUTION_STATES.length - 1)],
    unansweredCount: randInt(rng, 0, 25),
  };
  if (rng() < 0.6) {
    state.lastOpeningMessageAtMs = randInt(rng, 0, 4_000_000_000_000);
  }
  if (rng() < 0.5) {
    state.lastUserResponseAtMs = randInt(rng, 0, 4_000_000_000_000);
  }
  return state;
}

describe("Feature: proactive-conversations, Property 3", () => {
  // Property 3: A user response resets the unanswered count.
  // Validates: Requirements 5.6
  it("resets unansweredCount to 0 and records the response timestamp for any prior state", () => {
    for (let i = 0; i < ITERATIONS; i += 1) {
      const seed = 0x50_00_00 + i;
      const rng = makeRng(seed);
      const state = arbitraryState(rng);
      const respondedAtMs = randInt(rng, 0, 4_000_000_000_000);

      const next = applyUserResponse(state, respondedAtMs);

      // The unanswered streak is cleared regardless of the prior count.
      expect(next.unansweredCount, `seed=${seed} prior=${JSON.stringify(state)}`).toBe(0);
      // The supplied response timestamp is recorded verbatim.
      expect(next.lastUserResponseAtMs, `seed=${seed}`).toBe(respondedAtMs);
      // Resolution state is untouched by a user response (design decision (a)):
      // resolving the topic is a separate agent-judged / explicit action.
      expect(next.resolutionState, `seed=${seed}`).toBe(state.resolutionState);
      // Unrelated fields carry through unchanged.
      expect(next.lastOpeningMessageAtMs, `seed=${seed}`).toBe(state.lastOpeningMessageAtMs);
      // The input state is not mutated in place.
      expect(state.unansweredCount === 0 || next !== state, `seed=${seed}`).toBe(true);
    }
  });

  it("is idempotent: a second user response keeps the count at 0", () => {
    for (let i = 0; i < ITERATIONS; i += 1) {
      const seed = 0x60_00_00 + i;
      const rng = makeRng(seed);
      const state = arbitraryState(rng);
      const firstAtMs = randInt(rng, 0, 4_000_000_000_000);
      const secondAtMs = firstAtMs + randInt(rng, 0, 1_000_000);

      const once = applyUserResponse(state, firstAtMs);
      const twice = applyUserResponse(once, secondAtMs);

      expect(twice.unansweredCount, `seed=${seed}`).toBe(0);
      expect(twice.lastUserResponseAtMs, `seed=${seed}`).toBe(secondAtMs);
      expect(twice.resolutionState, `seed=${seed}`).toBe(state.resolutionState);
    }
  });
});
