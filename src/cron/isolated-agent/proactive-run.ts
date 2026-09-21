/**
 * Trigger-time wiring for the `proactiveCheckIn` branch: recall -> decide ->
 * deliver -> run outcome + resolution-state write (task 6.5). This module is the
 * end of the branch. It consumes the typed `ProactiveDecision` produced by
 * `proactive-decision.ts` (which itself owns recall + guardrails + composition)
 * and turns it into the two facts the scheduler needs:
 *
 *   1. a `CronRunOutcome` whose `deliveryState` feeds the existing
 *      `delivery-dispatch.ts` / `run-finalize.ts` recording exactly as every
 *      other cron payload does — delivered / failed (retried up to 3 then the
 *      existing failure-notification) / not-delivered + reason (Req 3.1-3.4, 5.8);
 *   2. the next live `CronJobState.proactive` block after the run, applying the
 *      pure resolution-state transition on a delivered opening message
 *      (increment unansweredCount, stamp lastOpeningMessageAtMs, auto-abandon at
 *      maxUnanswered) and leaving it unchanged otherwise (Req 5.4, 5.5).
 *
 * Delivery goes through the real Delivery_Channel via the existing pipeline
 * owner (`delivery.ts`'s `sendCronAnnouncePayloadStrict`, which resolves the
 * target through `delivery-plan.ts` / `resolveDeliveryTarget` and sends via the
 * durable batch primitive that every cron announce shares), never the internal
 * "cron" channel (Req 3.2). The send itself is injected as `deliver` so the
 * recall/guardrail/outcome/state wiring is a pure function of its inputs and
 * directly testable (task 6.6) without the channel transport, the memory
 * runtime, or the scheduler clock. `buildRuntimeProactiveOpeningDelivery` is the
 * only piece that touches the pipeline: it closes over the run's config/deps and
 * returns the runtime `deliver` default the branch binds. Terminal
 * (`resolved`/`abandoned`) states are short-circuited by the scheduler before
 * this runs (task 9.1); this module assumes a live `pending` state and never
 * sends for a terminal one (the resolution helper also keeps that invariant,
 * returning terminal state unchanged).
 */
import type { CliDeps } from "../../cli/deps.types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { isInternalNonDeliveryChannel } from "../../utils/message-channel.js";
import type { CronDeliveryPlan } from "../delivery-plan.js";
import { sendCronAnnouncePayloadStrict } from "../delivery.js";
import {
  applyDeliveredOpeningMessage,
  clampMaxUnanswered,
  type ProactiveRuntimeState,
} from "../proactive/resolution-state.js";
import type {
  CronDeliverySuppressionReason,
  CronMessageChannel,
  CronResolvedDeliveryState,
  CronRunDiagnostics,
  CronRunOutcome,
  ProactiveGuardrailConfig,
} from "../types.js";
import type { ProactiveDecision, ProactiveOpeningMessage } from "./proactive-decision.js";

/**
 * Result of one opening-message send through the real Delivery_Channel. Mirrors
 * the delivered/failed facts the existing delivery pipeline records: `delivered`
 * true only for a confirmed send; `error` carries the final failure text after
 * the pipeline's retry/failure-notification handling has run.
 */
export type ProactiveDeliveryResult = {
  delivered: boolean;
  /** Final failure text when the send failed after the pipeline's retries. */
  error?: string;
};

/**
 * Injectable opening-message send. The runtime default routes through the
 * existing cron delivery pipeline to the resolved real channel; tests substitute
 * a deterministic function so the outcome/state wiring is covered without the
 * transport. The message carries its own `deliveryChannel` (never "cron").
 */
export type ProactiveOpeningDeliveryFn = (params: {
  message: ProactiveOpeningMessage;
  targetUser: string;
  firingAtMs: number;
}) => Promise<ProactiveDeliveryResult>;

/**
 * Outcome of the trigger-time procedure consumed by the scheduler. `outcome` is
 * the `CronRunOutcome` (+ resolved delivery fields) recorded on the run;
 * `proactiveState` is the next live `CronJobState.proactive` block to persist.
 * The state is always returned (unchanged on withhold/failed) so the caller has
 * a single authoritative value to write.
 */
export type ProactiveRunResult = {
  outcome: CronRunOutcome & {
    deliveryState: CronResolvedDeliveryState;
    delivered?: boolean;
    deliveryAttempted: boolean;
    deliveryError?: string;
    deliverySuppressionReason?: CronDeliverySuppressionReason;
  };
  proactiveState: ProactiveRuntimeState;
};

/** Builds a not-requested failure-notification stub for a proactive run's delivery state. */
function noFailureNotification(): CronResolvedDeliveryState["failureNotification"] {
  return { status: "not-requested" };
}

/**
 * Records a withheld run: no send happened, so `deliveryState.status` is
 * `not-delivered` and the run is an intentional non-delivery. Guardrail
 * withholds carry a `deliverySuppressionReason` so `completion-status.ts`
 * classifies them as succeeded, never failed (Req 3.6, 5.8); recall gaps carry
 * only diagnostics (Req 2.3-2.5). The proactive state is unchanged — a withheld
 * occurrence never reached the user, so `unansweredCount` must not move.
 */
function buildWithheldResult(params: {
  state: ProactiveRuntimeState;
  deliverySuppressionReason?: CronDeliverySuppressionReason;
  diagnostics?: CronRunDiagnostics;
}): ProactiveRunResult {
  return {
    outcome: {
      status: "ok",
      delivered: false,
      deliveryAttempted: false,
      deliveryState: {
        status: "not-delivered",
        delivered: false,
        deliverySuppressionReason: params.deliverySuppressionReason,
        failureNotification: noFailureNotification(),
      },
      deliverySuppressionReason: params.deliverySuppressionReason,
      ...(params.diagnostics ? { diagnostics: params.diagnostics } : {}),
    },
    proactiveState: params.state,
  };
}

/**
 * Runs the delivery + outcome + state-write tail of the proactive branch.
 *
 * - withhold -> not-delivered outcome carrying the guardrail suppression reason
 *   or recall diagnostics; state unchanged (Req 3.6, 5.8, 2.3-2.5);
 * - deliver + send succeeds -> delivered outcome; apply
 *   `applyDeliveredOpeningMessage` to increment `unansweredCount`, stamp
 *   `lastOpeningMessageAtMs`, and auto-abandon at `maxUnanswered` (Req 3.3, 5.4,
 *   5.5);
 * - deliver + send fails -> failed outcome (the pipeline already retried up to 3
 *   and fired the failure notification, Req 3.4); state unchanged because no
 *   opening message reached the user, so the unanswered streak must not advance.
 *
 * `maxUnanswered` is clamped to its 1-10 policy range at the transition boundary
 * (via the resolution helper) so a malformed policy can never suppress abandon.
 */
export async function runProactiveCheckIn(params: {
  decision: ProactiveDecision;
  state: ProactiveRuntimeState;
  guardrails: Pick<ProactiveGuardrailConfig, "maxUnanswered">;
  targetUser: string;
  firingAtMs: number;
  deliver: ProactiveOpeningDeliveryFn;
}): Promise<ProactiveRunResult> {
  const { decision } = params;
  if (decision.kind === "withhold") {
    return buildWithheldResult({
      state: params.state,
      deliverySuppressionReason: decision.deliverySuppressionReason,
      diagnostics: decision.diagnostics,
    });
  }

  const delivery = await params.deliver({
    message: decision.message,
    targetUser: params.targetUser,
    firingAtMs: params.firingAtMs,
  });

  if (!delivery.delivered) {
    // A failed send is a run failure, not an intentional non-delivery: no
    // deliverySuppressionReason, so the failure-notification path applies
    // (Req 3.4). The unanswered streak does not advance — nothing reached the
    // user.
    return {
      outcome: {
        status: "error",
        error: delivery.error,
        errorKind: "delivery-target",
        delivered: false,
        deliveryAttempted: true,
        deliveryError: delivery.error,
        deliveryState: {
          status: "not-delivered",
          delivered: false,
          error: delivery.error,
          failureNotification: noFailureNotification(),
        },
      },
      proactiveState: params.state,
    };
  }

  // Delivered: advance the resolution/unanswered state machine (Req 3.3, 5.4,
  // 5.5). The clamp is applied inside applyDeliveredOpeningMessage; passing the
  // configured value keeps this call the single owner of the transition.
  const proactiveState = applyDeliveredOpeningMessage(
    params.state,
    clampMaxUnanswered(params.guardrails.maxUnanswered),
    params.firingAtMs,
  );
  return {
    outcome: {
      status: "ok",
      delivered: true,
      deliveryAttempted: true,
      deliveryState: {
        status: "delivered",
        delivered: true,
        failureNotification: noFailureNotification(),
      },
    },
    proactiveState,
  };
}

/**
 * Delivery plan for a proactive opening message: an announce to the resolved
 * real Delivery_Channel. The internal "cron" channel is never a valid target
 * (Req 3.2); creation-time validation already rejects such jobs, and the channel
 * carried on the composed message is the user-facing one the job was created
 * with. This plan is what the runtime delivery adapter feeds the existing
 * pipeline.
 */
export function buildProactiveDeliveryPlan(params: {
  channel: CronMessageChannel;
  to: string;
}): CronDeliveryPlan {
  return {
    mode: "announce",
    channel: params.channel,
    to: params.to,
    source: "delivery",
    requested: true,
  };
}

/**
 * Runtime context the branch supplies once per proactive run so the delivery
 * default can reach the real channel. It is the config/deps/identity/abort the
 * existing announce owner (`sendCronAnnouncePayloadStrict`) already requires;
 * nothing here is proactive-specific beyond the target user and topic session.
 */
export type ProactiveOpeningDeliveryRuntime = {
  cfg: OpenClawConfig;
  deps: CliDeps;
  agentId: string;
  jobId: string;
  /** Target user's session key, so delivery resolves the same conversation. */
  sessionKey?: string;
  abortSignal: AbortSignal;
};

/**
 * Builds the runtime `deliver` default for the proactive branch. It routes the
 * composed Opening_Message through the existing cron announce owner
 * (`delivery.ts`'s `sendCronAnnouncePayloadStrict`) — the same resolve-target +
 * durable-send pipeline every other cron announce uses — so this is not a
 * competing delivery path. Two facts are enforced here:
 *
 * - The internal "cron" channel (and any internal non-delivery channel) is never
 *   a valid target (Req 3.2). Creation-time validation already rejects such
 *   jobs, but the runtime send refuses defensively so a corrupted payload can
 *   never route an opening message to a non-delivery surface. A refusal is a
 *   send failure (`delivered: false`), not an intentional non-delivery: guardrail
 *   withholds are the only intentional non-deliveries, and they are decided
 *   before delivery is ever attempted.
 * - The announce owner sends durably and throws on channel failure after its own
 *   retry handling; a throw maps to `delivered: false` with the failure text so
 *   the outcome wiring records `failed` and the existing failure-notification
 *   path applies (Req 3.3, 3.4).
 *
 * The returned function is a plain `ProactiveOpeningDeliveryFn`, so
 * `runProactiveCheckIn` stays a pure function of its inputs and its tests keep
 * substituting a deterministic `deliver` (task 6.6).
 */
export function buildRuntimeProactiveOpeningDelivery(
  runtime: ProactiveOpeningDeliveryRuntime,
): ProactiveOpeningDeliveryFn {
  return async ({ message }): Promise<ProactiveDeliveryResult> => {
    if (isInternalNonDeliveryChannel(message.deliveryChannel)) {
      // Never deliver an opening message to the internal "cron" (or any
      // internal non-delivery) channel (Req 3.2). This is a failure, not a
      // guardrail withhold.
      return {
        delivered: false,
        error: `proactive opening message cannot be delivered to the internal non-delivery channel "${message.deliveryChannel}"`,
      };
    }
    try {
      await sendCronAnnouncePayloadStrict({
        deps: runtime.deps,
        cfg: runtime.cfg,
        agentId: runtime.agentId,
        jobId: runtime.jobId,
        target: {
          channel: message.deliveryChannel,
          sessionKey: runtime.sessionKey,
        },
        payload: { text: message.text },
        abortSignal: runtime.abortSignal,
      });
      return { delivered: true };
    } catch (error) {
      return { delivered: false, error: formatErrorMessage(error) };
    }
  };
}
