// Pure, runtime-free guardrail engine for proactive check-ins. Given the fired
// occurrence time, the job's live proactive state, the guardrail policy, and the
// (already-resolved) opt-out flag, it returns exactly one decision following the
// fixed precedence opt-out -> quiet-hours -> min-interval -> allow (Req 5.1, 5.2,
// 5.3, 5.7, 5.8; design "Guardrail evaluation order"). The engine performs no I/O
// and reads no clock: the firing time is a parameter so the decision is
// deterministic and directly property-testable. Opt-out is NOT re-implemented
// here; the caller reads it through the existing channel/user opt-out contract
// and passes the result in as `optedOut`.

import type { ProactiveGuardrailConfig } from "../types.js";

/** Guardrail suppression reasons the engine may emit; a subset of CronDeliverySuppressionReason. */
export type ProactiveSuppressionReason = "quiet_hours" | "min_interval" | "opted_out";

/**
 * Exactly one decision per evaluation. `defer` is reserved for quiet-hours
 * (outreach retries on the next occurrence outside the window, Req 5.1); other
 * suppressions `withhold` for this trigger. Both `defer` and `withhold` carry a
 * suppression reason the run records as a deliverySuppressionReason (Req 5.8).
 */
export type GuardrailDecision =
  | { kind: "allow" }
  | { kind: "defer"; reason: "quiet_hours" }
  | { kind: "withhold"; reason: ProactiveSuppressionReason };

/** Live per-run counters the engine reads to enforce min-interval (Req 5.2, 5.3). */
export type ProactiveGuardrailState = {
  /** Timestamp of the last delivered opening message, if any. */
  lastOpeningMessageAtMs?: number;
};

/** Inclusive lower / exclusive upper bounds for the clamped guardrail knobs. */
const MIN_INTERVAL_SECONDS_MIN = 900;
const MIN_INTERVAL_SECONDS_MAX = 86400;
const MAX_UNANSWERED_MIN = 1;
const MAX_UNANSWERED_MAX = 10;

const MS_PER_SECOND = 1000;
const MINUTES_PER_DAY = 24 * 60;

/** Guardrail knobs after boundary clamping; the engine operates on these. */
export type ClampedProactiveGuardrailConfig = {
  quietHours?: ProactiveGuardrailConfig["quietHours"];
  minIntervalSeconds: number;
  maxUnanswered: number;
};

function clampInt(value: number, min: number, max: number, fallback: number): number {
  // Non-finite/NaN inputs collapse to the documented default before clamping so
  // a malformed knob can never widen the effective bound.
  const base = Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.min(max, Math.max(min, base));
}

/**
 * Clamp guardrail knobs to their documented ranges at the config boundary:
 * minIntervalSeconds to 900-86400 (default 3600) and maxUnanswered to 1-10
 * (default 3). Callers clamp once when admitting policy so downstream evaluation
 * and abandon logic never see an out-of-range knob (Req 5.2, 5.4).
 */
export function clampProactiveGuardrailConfig(
  config: ProactiveGuardrailConfig,
): ClampedProactiveGuardrailConfig {
  return {
    quietHours: config.quietHours,
    minIntervalSeconds: clampInt(
      config.minIntervalSeconds,
      MIN_INTERVAL_SECONDS_MIN,
      MIN_INTERVAL_SECONDS_MAX,
      3600,
    ),
    maxUnanswered: clampInt(config.maxUnanswered, MAX_UNANSWERED_MIN, MAX_UNANSWERED_MAX, 3),
  };
}

/**
 * Minute-of-day (0-1439) for `instantMs` in the given IANA time zone, or null
 * when the zone is unrecognized. Mirrors the heartbeat active-hours resolver so
 * quiet windows use the same wall-clock interpretation.
 */
function minuteOfDayInTimeZone(instantMs: number, tz: string): number | null {
  if (!Number.isFinite(instantMs)) {
    return null;
  }
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(instantMs));
    let hour: number | undefined;
    let minute: number | undefined;
    for (const part of parts) {
      if (part.type === "hour") {
        hour = Number(part.value);
      } else if (part.type === "minute") {
        minute = Number(part.value);
      }
    }
    if (
      hour === undefined ||
      minute === undefined ||
      !Number.isFinite(hour) ||
      !Number.isFinite(minute)
    ) {
      return null;
    }
    return hour * 60 + minute;
  } catch {
    return null;
  }
}

/**
 * True when `firingAtMs` falls inside the quiet window. An empty window
 * (start === end) is never quiet; a window whose start is after its end wraps
 * across midnight, matching the heartbeat active-hours convention. An
 * unresolvable time zone yields false so a bad zone never silently suppresses
 * outreach.
 */
function isWithinQuietHours(
  firingAtMs: number,
  quietHours: NonNullable<ProactiveGuardrailConfig["quietHours"]>,
): boolean {
  const start = quietHours.startMinuteOfDay;
  const end = quietHours.endMinuteOfDay;
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    start >= MINUTES_PER_DAY ||
    end < 0 ||
    end > MINUTES_PER_DAY
  ) {
    return false;
  }
  if (start === end) {
    return false;
  }
  const current = minuteOfDayInTimeZone(firingAtMs, quietHours.tz);
  if (current === null) {
    return false;
  }
  return end > start ? current >= start && current < end : current >= start || current < end;
}

/**
 * Decide whether a fired proactive occurrence should deliver, defer, or be
 * withheld. Evaluated only when live resolutionState is `pending` (the caller
 * short-circuits terminal states before invoking this). Precedence is fixed and
 * total: opt-out -> quiet-hours -> min-interval -> allow.
 */
export function evaluateProactiveGuardrails(params: {
  /** Occurrence firing time in epoch ms. */
  firingAtMs: number;
  /** Live proactive counters (min-interval basis). */
  state: ProactiveGuardrailState;
  /** Guardrail policy; clamped at the boundary before evaluation. */
  config: ClampedProactiveGuardrailConfig;
  /** Result of the existing channel/user opt-out contract for this target. */
  optedOut: boolean;
}): GuardrailDecision {
  const { firingAtMs, state, config, optedOut } = params;

  // 1. Opt-out (Req 5.7) — highest precedence; withheld for this trigger.
  if (optedOut) {
    return { kind: "withhold", reason: "opted_out" };
  }

  // 2. Quiet hours (Req 5.1) — defer to the next occurrence outside the window.
  if (config.quietHours && isWithinQuietHours(firingAtMs, config.quietHours)) {
    return { kind: "defer", reason: "quiet_hours" };
  }

  // 3. Minimum interval (Req 5.2, 5.3) — withhold when fired too soon after the
  //    last delivered opening message.
  const last = state.lastOpeningMessageAtMs;
  if (last !== undefined && Number.isFinite(last)) {
    const elapsedMs = firingAtMs - last;
    if (elapsedMs < config.minIntervalSeconds * MS_PER_SECOND) {
      return { kind: "withhold", reason: "min_interval" };
    }
  }

  // 4. Allow — compose and deliver the opening message.
  return { kind: "allow" };
}
