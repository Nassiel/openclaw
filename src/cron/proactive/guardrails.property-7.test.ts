// Property coverage for the proactive quiet-hours guardrail.
//
// Feature: proactive-conversations, Property 7: Quiet-hours firing defers to the
// next occurrence outside the window.
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
const ITERATIONS = 400;

/**
 * The chronological-sweep property evaluates a full day of occurrences per
 * iteration, so it uses a smaller (still >= 100) iteration count to stay fast
 * while retaining broad window/start coverage.
 */
const SWEEP_ITERATIONS = 120;

const MINUTES_PER_DAY = 24 * 60;
const MS_PER_MINUTE = 60_000;

/**
 * A fixed UTC day anchors the timestamps so minute-of-day is fully deterministic:
 * in UTC the wall clock never shifts, so `dayStart + minute * 60000` always
 * resolves to exactly `minute` minutes past midnight in the configured tz.
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

/** Firing timestamp (epoch ms) whose UTC minute-of-day equals `minute`. */
function firingAtMinute(minute: number): number {
  return DAY_START_MS + minute * MS_PER_MINUTE;
}

/**
 * True when `minute` is inside the quiet window under the module's own
 * convention: empty windows (start === end) are never quiet, and start > end
 * wraps across midnight.
 */
function minuteIsQuiet(minute: number, start: number, end: number): boolean {
  if (start === end) {
    return false;
  }
  return end > start ? minute >= start && minute < end : minute >= start || minute < end;
}

type QuietWindow = { startMinuteOfDay: number; endMinuteOfDay: number };

/**
 * Generates a quiet window in UTC that is neither empty nor full-day, biased to
 * produce both normal (start < end) and midnight-wrapping (start > end) windows
 * with roughly even frequency.
 */
function arbitraryQuietWindow(rng: () => number): QuietWindow {
  for (;;) {
    const start = randInt(rng, 0, MINUTES_PER_DAY - 1);
    const end = randInt(rng, 0, MINUTES_PER_DAY - 1);
    if (start === end) {
      continue; // empty window is never quiet; skip so the property is meaningful.
    }
    return { startMinuteOfDay: start, endMinuteOfDay: end };
  }
}

/** A clamped guardrail config that only exercises quiet-hours: no min-interval basis. */
function quietOnlyConfig(window: QuietWindow): ClampedProactiveGuardrailConfig {
  return clampProactiveGuardrailConfig({
    quietHours: {
      startMinuteOfDay: window.startMinuteOfDay,
      endMinuteOfDay: window.endMinuteOfDay,
      tz: "UTC",
    },
    minIntervalSeconds: 3600,
    maxUnanswered: 3,
  });
}

describe("Feature: proactive-conversations, Property 7", () => {
  // Property 7: Quiet-hours firing defers to the next occurrence outside the window.
  // Validates: Requirements 5.1
  it("defers with reason quiet_hours inside the window and does not defer outside it", () => {
    for (let i = 0; i < ITERATIONS; i += 1) {
      const seed = 0x70_00_00 + i;
      const rng = makeRng(seed);
      const window = arbitraryQuietWindow(rng);
      const config = quietOnlyConfig(window);
      const minute = randInt(rng, 0, MINUTES_PER_DAY - 1);
      const firingAtMs = firingAtMinute(minute);

      const decision = evaluateProactiveGuardrails({
        firingAtMs,
        // No prior opening message: min-interval cannot withhold, so a
        // non-quiet firing must reach `allow`, isolating quiet-hours behavior.
        state: {},
        config,
        optedOut: false,
      });

      const label = `seed=${seed} window=${JSON.stringify(window)} minute=${minute}`;
      if (minuteIsQuiet(minute, window.startMinuteOfDay, window.endMinuteOfDay)) {
        // Inside the window: withhold via defer{quiet_hours} (Req 5.1).
        expect(decision, label).toEqual({ kind: "defer", reason: "quiet_hours" });
      } else {
        // Outside the window: quiet-hours must not defer; with no min-interval
        // basis and no opt-out the occurrence proceeds to allow.
        expect(decision, label).toEqual({ kind: "allow" });
      }
    }
  });

  it("delivers on the first occurrence outside the window when consecutive occurrences fire", () => {
    // Model a recurring schedule as a monotonically advancing wall clock: each
    // occurrence fires `stepMinutes` after the previous one, so occurrences are
    // visited in true chronological order. Property 7 requires that every
    // occurrence up to (but excluding) the first delivered one was inside the
    // quiet window, and the first delivered occurrence is outside it.
    for (let i = 0; i < SWEEP_ITERATIONS; i += 1) {
      const seed = 0x71_00_00 + i;
      const rng = makeRng(seed);
      const window = arbitraryQuietWindow(rng);
      const config = quietOnlyConfig(window);
      const startMinute = randInt(rng, 0, MINUTES_PER_DAY - 1);
      // Step minute-by-minute so the chronological walk cannot skip over a
      // narrow open slot in a near-full-day wrapping window; this still faithfully
      // models consecutive occurrences visited in true time order for Property 7.
      const stepMinutes = 1;

      let firstAllowedMinuteOfDay: number | null = null;
      let deferredBeforeFirstAllowed = 0;
      // Sweep across a bit more than a full day so any non-full-day window is
      // guaranteed an exit within the walk.
      const totalOccurrences = MINUTES_PER_DAY + 2;
      for (let n = 0; n < totalOccurrences; n += 1) {
        const absoluteMinute = startMinute + n * stepMinutes;
        const minuteOfDay = absoluteMinute % MINUTES_PER_DAY;
        const decision = evaluateProactiveGuardrails({
          firingAtMs: firingAtMinute(absoluteMinute),
          state: {},
          config,
          optedOut: false,
        });
        const label = `seed=${seed} window=${JSON.stringify(window)} minuteOfDay=${minuteOfDay} n=${n}`;
        const quiet = minuteIsQuiet(minuteOfDay, window.startMinuteOfDay, window.endMinuteOfDay);
        if (quiet) {
          // Inside the window: always defer (Req 5.1).
          expect(decision, label).toEqual({ kind: "defer", reason: "quiet_hours" });
          if (firstAllowedMinuteOfDay === null) {
            deferredBeforeFirstAllowed += 1;
          }
        } else {
          expect(decision, label).toEqual({ kind: "allow" });
          if (firstAllowedMinuteOfDay === null) {
            firstAllowedMinuteOfDay = minuteOfDay;
          }
        }
      }

      // A non-empty, non-full-day window always leaves at least one minute
      // outside it, so a delivered occurrence is guaranteed within the sweep.
      expect(
        firstAllowedMinuteOfDay,
        `seed=${seed} window=${JSON.stringify(window)}: no occurrence delivered outside window`,
      ).not.toBeNull();
      // The first delivered occurrence lands outside the quiet window (Property 7);
      // every occurrence chronologically before it was deferred for quiet_hours.
      expect(
        minuteIsQuiet(
          firstAllowedMinuteOfDay as number,
          window.startMinuteOfDay,
          window.endMinuteOfDay,
        ),
        `seed=${seed} firstAllowedMinuteOfDay=${firstAllowedMinuteOfDay} deferredBefore=${deferredBeforeFirstAllowed}`,
      ).toBe(false);
    }
  });
});
