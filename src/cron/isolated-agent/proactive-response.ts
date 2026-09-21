/**
 * Resolution write path for the `proactiveCheckIn` branch (task 9.2): the
 * transition a proactive turn records when it *processes a user response*, and
 * the transition an *explicit resolve/abandon action* records directly on the
 * job.
 *
 * This is the sibling of `proactive-run.ts`. Where that module owns the outbound
 * opening-message run (recall -> guardrails -> deliver -> outcome), this module
 * owns the inbound resolution write: it turns an agent judgment about a user
 * reply — or an explicit resolve/abandon action — into the two facts the
 * scheduler needs:
 *
 *   1. the next live `CronJobState.proactive` block to persist (the
 *      `resolutionState` transition plus, for a user response, the
 *      `unansweredCount` reset and `lastUserResponseAtMs` stamp), and
 *   2. a `CronRunOutcome` recording the transition as part of the same state
 *      write path that records delivery outcome — a user-response turn sends no
 *      opening message, so it is a `not-delivered` intentional non-delivery, not
 *      a failure.
 *
 * Everything here is a pure function of its inputs (the live state, the agent's
 * judgment, an optional explicit action, and the response timestamp). All state
 * transitions reuse the pure state-machine helpers in
 * `../proactive/resolution-state.ts` (task 5.1) — this module adds no competing
 * writer; it composes those helpers and shapes the run outcome.
 *
 * Precedence (design decision (a), Req 4.1, 4.4): an explicit resolve/abandon
 * action is authoritative and overrides agent judgment. Agent judgment applies
 * only when there is no explicit action.
 */
import {
  applyResolutionTransition,
  applyUserResponse,
  type ProactiveResolutionTransition,
  type ProactiveRuntimeState,
} from "../proactive/resolution-state.js";
import type { CronRunOutcome } from "../types.js";

/**
 * An explicit user/agent action that sets the resolution state directly, taking
 * precedence over agent judgment (Req 4.1, 4.4). Distinct from a plain reply:
 * this is the "mark done" / "drop this" signal, not a message the agent judges.
 */
export type ProactiveExplicitResolutionAction = "resolve" | "abandon";

/**
 * Result of a resolution write: the next `CronJobState.proactive` block to
 * persist and the `CronRunOutcome` that carries it through the same state-write
 * path that records delivery outcome. A resolution turn never sends an opening
 * message, so `deliveryState.status` is `not-delivered` with `delivered: false`
 * and no `deliverySuppressionReason` — it is an ordinary successful turn whose
 * effect is the persisted state transition, not a guardrail-withheld delivery.
 */
export type ProactiveResolutionResult = {
  outcome: CronRunOutcome & {
    delivered: false;
    deliveryAttempted: false;
    deliveryState: {
      status: "not-delivered";
      delivered: false;
      failureNotification: { status: "not-requested" };
    };
  };
  proactiveState: ProactiveRuntimeState;
};

/** Shapes the shared not-delivered run outcome for a resolution write. */
function buildResolutionOutcome(proactiveState: ProactiveRuntimeState): ProactiveResolutionResult {
  return {
    outcome: {
      status: "ok",
      delivered: false,
      deliveryAttempted: false,
      deliveryState: {
        status: "not-delivered",
        delivered: false,
        failureNotification: { status: "not-requested" },
      },
    },
    proactiveState,
  };
}

/**
 * Records a proactive turn that processed a *user response* to the pending topic
 * (Req 4.1, 5.6).
 *
 * Two things happen, in order, both through the pure state-machine owner:
 *   1. the unanswered streak is reset and `lastUserResponseAtMs` is stamped
 *      (`applyUserResponse`, Req 5.6) — a reply always resets the count,
 *      regardless of whether it resolves the topic; then
 *   2. the resolution transition is applied. An explicit resolve/abandon action,
 *      when present, is authoritative and overrides the agent's judgment
 *      (Req 4.1, 4.4). Otherwise the agent's judgment decides: `topicComplete`
 *      marks the topic `resolved` (Req 4.1), and a reply the agent judges
 *      incomplete leaves it `pending` so a recurring schedule keeps nudging
 *      (Req 4.3).
 *
 * The result carries the next state and a `not-delivered` outcome so the caller
 * persists the transition through the same `CronRunOutcome` state write that
 * records delivery outcome — one owner, one write path.
 *
 * @param params.state live proactive state before the response
 * @param params.respondedAtMs user-response timestamp in epoch milliseconds
 * @param params.topicComplete the agent's judgment that the reply resolves the topic
 * @param params.explicitAction an explicit resolve/abandon that overrides judgment
 */
export function applyProactiveUserResponse(params: {
  state: ProactiveRuntimeState;
  respondedAtMs: number;
  topicComplete: boolean;
  explicitAction?: ProactiveExplicitResolutionAction;
}): ProactiveResolutionResult {
  const afterReset = applyUserResponse(params.state, params.respondedAtMs);
  const transition = resolveTransition({
    explicitAction: params.explicitAction,
    topicComplete: params.topicComplete,
  });
  return buildResolutionOutcome(applyResolutionTransition(afterReset, transition));
}

/**
 * Records an *explicit* resolve/abandon action performed directly on the job
 * (Req 4.1, 4.4), independent of any user reply the agent judges. This is the
 * authoritative path: "mark this done" sets `resolved`, "drop this" sets
 * `abandoned`. It does not touch `unansweredCount` (there is no reply to reset)
 * and writes through the same state path so the scheduler reads the terminal
 * state on the next occurrence (Req 4.2, 4.5) and after restart (Req 4.7).
 *
 * @param params.state live proactive state before the action
 * @param params.action the explicit resolution action to record
 */
export function applyProactiveExplicitAction(params: {
  state: ProactiveRuntimeState;
  action: ProactiveExplicitResolutionAction;
}): ProactiveResolutionResult {
  return buildResolutionOutcome(applyResolutionTransition(params.state, params.action));
}

/**
 * Precedence between an explicit action and agent judgment (Req 4.1, 4.4). An
 * explicit resolve/abandon always wins; otherwise the agent's `topicComplete`
 * judgment resolves the topic, and an incomplete reply is a no-op transition.
 */
function resolveTransition(params: {
  explicitAction?: ProactiveExplicitResolutionAction;
  topicComplete: boolean;
}): ProactiveResolutionTransition {
  if (params.explicitAction) {
    return params.explicitAction;
  }
  return params.topicComplete ? "resolve" : "none";
}
