import type { CronJob, CronJobState, CronProactiveResolutionState } from "../types.js";

/**
 * Pure resolution / unanswered state machine for a proactive check-in.
 *
 * These helpers are the single owner of the transitions on
 * `CronJobState.proactive` that the trigger-time turn and the guardrail engine
 * depend on: incrementing `unansweredCount` on a delivered opening message,
 * resetting it on a user response, and auto-abandoning once the count reaches
 * the configured maximum (design "Resolution & unanswered tracking",
 * Req 5.4-5.6). They are pure input-state -> new-state functions: every
 * timestamp is passed in by the caller and there is no clock or I/O access, so
 * they are directly property-testable.
 */

/** Live proactive runtime block persisted on `CronJobState.proactive`. */
export type ProactiveRuntimeState = NonNullable<CronJobState["proactive"]>;

/**
 * The next proactive state after a *delivered* opening message.
 *
 * Increments `unansweredCount` (only delivered messages that reached the user
 * count) and stamps `lastOpeningMessageAtMs` for the min-interval guardrail.
 * When the incremented count reaches `maxUnanswered` the topic auto-abandons
 * (Req 5.4, 5.5); `maxUnanswered` is clamped to its 1-10 policy range so a
 * malformed policy can never suppress or defer the abandon transition. An
 * already-terminal (`resolved`/`abandoned`) state is returned unchanged: a
 * delivery should never have fired for it, and this keeps the function total.
 *
 * @param state current live proactive state
 * @param maxUnanswered configured maximum consecutive unanswered messages (1-10)
 * @param deliveredAtMs delivery timestamp in epoch milliseconds
 */
export function applyDeliveredOpeningMessage(
  state: ProactiveRuntimeState,
  maxUnanswered: number,
  deliveredAtMs: number,
): ProactiveRuntimeState {
  if (state.resolutionState !== "pending") {
    return state;
  }
  const cap = clampMaxUnanswered(maxUnanswered);
  const unansweredCount = state.unansweredCount + 1;
  const resolutionState: CronProactiveResolutionState =
    unansweredCount >= cap ? "abandoned" : "pending";
  return {
    ...state,
    resolutionState,
    unansweredCount,
    lastOpeningMessageAtMs: deliveredAtMs,
  };
}

/**
 * The next proactive state after a user responds to the pending topic.
 *
 * Resets `unansweredCount` to 0 and records `lastUserResponseAtMs` (Req 5.6).
 * Resolution state is untouched here: whether the reply resolves the topic is
 * an agent-judged / explicit-action decision recorded separately (design
 * decision (a)); this helper only clears the unanswered streak.
 *
 * @param state current live proactive state
 * @param respondedAtMs user-response timestamp in epoch milliseconds
 */
export function applyUserResponse(
  state: ProactiveRuntimeState,
  respondedAtMs: number,
): ProactiveRuntimeState {
  return {
    ...state,
    unansweredCount: 0,
    lastUserResponseAtMs: respondedAtMs,
  };
}

/**
 * Resolves the authoritative live resolution state for a proactive check-in job.
 *
 * The live value on `CronJobState.proactive.resolutionState` is authoritative
 * over the payload's initial `resolutionState` (design "New persisted state
 * fields"): the scheduler reads it on each occurrence and after restart so a
 * `resolved`/`abandoned` job never resumes outreach (Req 4.7). A legacy
 * proactive row that predates the additive `proactive` migration lacks the
 * live block; its persisted payload `resolutionState` is the fallback so a
 * pre-migration `resolved`/`abandoned` job is still suppressed. Returns
 * `undefined` for a non-proactive job so callers can leave other kinds
 * untouched.
 *
 * @param job the cron job whose live resolution state is read
 */
export function resolveProactiveResolutionState(
  job: CronJob,
): CronProactiveResolutionState | undefined {
  if (job.payload.kind !== "proactiveCheckIn") {
    return undefined;
  }
  return job.state.proactive?.resolutionState ?? job.payload.resolutionState;
}

/**
 * Whether a proactive check-in occurrence must be short-circuited (cancelled
 * with no turn and no send) because its live resolution state is terminal.
 * A `resolved` or `abandoned` topic never nudges again (Req 3.5, 4.2, 4.5,
 * 4.6, 4.7); a `pending` topic continues to be evaluated each occurrence
 * (Req 4.3). Non-proactive jobs are never short-circuited here.
 *
 * @param job the cron job evaluated for the current occurrence
 */
export function isProactiveOccurrenceSuppressed(job: CronJob): boolean {
  const resolutionState = resolveProactiveResolutionState(job);
  return resolutionState === "resolved" || resolutionState === "abandoned";
}

/**
 * A resolution transition applied to a pending topic. `resolve` marks the topic
 * complete (Req 4.1); `abandon` drops it without completion (Req 4.4); `none`
 * leaves the resolution state as-is (the reply did not resolve the topic).
 */
export type ProactiveResolutionTransition = "resolve" | "abandon" | "none";

/**
 * Applies a resolution transition to the live proactive state (Req 4.1, 4.4).
 *
 * This is the single owner of the user-driven `resolutionState` transition, kept
 * beside the delivered/user-response transitions so every mutation of the
 * `proactive` block flows through one pure module. `resolve` sets `resolved`,
 * `abandon` sets `abandoned`, and `none` returns the state unchanged (identity).
 * An already-terminal state is returned unchanged: once `resolved`/`abandoned`
 * the topic no longer transitions, which keeps the function total and idempotent
 * (repeated resolve/abandon is a no-op). `unansweredCount` and the timestamps are
 * untouched here; resetting the streak on a user response is a separate concern
 * owned by {@link applyUserResponse}.
 *
 * @param state current live proactive state
 * @param transition the resolution transition to apply
 */
export function applyResolutionTransition(
  state: ProactiveRuntimeState,
  transition: ProactiveResolutionTransition,
): ProactiveRuntimeState {
  if (transition === "none" || state.resolutionState !== "pending") {
    return state;
  }
  return {
    ...state,
    resolutionState: transition === "resolve" ? "resolved" : "abandoned",
  };
}

/**
 * Clamps a configured `maxUnanswered` to its policy range of 1-10 (Req 5.4).
 * Non-finite input falls back to the default of 3. Applied at the transition
 * boundary so the abandon threshold is always a valid bound regardless of how
 * the policy was persisted.
 */
export function clampMaxUnanswered(maxUnanswered: number): number {
  if (!Number.isFinite(maxUnanswered)) {
    return 3;
  }
  return Math.min(10, Math.max(1, Math.trunc(maxUnanswered)));
}
