/**
 * Ordered create-time validation for the `proactiveCheckIn` cron payload
 * (Req 1.1-1.7, 3.2). The automations tool calls {@link validateProactiveCheckInCreate}
 * on the normalized job right before `cron.add`; every rejection throws before
 * any partial job is created, so creation stays atomic (Req 1.3-1.6).
 *
 * The checks here are pure and runtime-free (per src/agents/AGENTS.md hot-path
 * guidance): schedule-form and topic checks read the normalized job, and the
 * delivery-channel check uses the shared pure channel classifiers
 * (`normalizeMessageChannel`, `isInternalNonDeliveryChannel`,
 * `isDeliverableMessageChannel`, `INTERNAL_MESSAGE_CHANNEL`) rather than loading
 * channel plugin runtime. Full account-level resolution stays at the gateway
 * `cron.add` boundary; this layer rejects the shapes the design names as
 * distinct create errors so the model gets an actionable message.
 */
import { isRecord } from "../../utils.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  isDeliverableMessageChannel,
  isInternalNonDeliveryChannel,
  normalizeMessageChannel,
} from "../../utils/message-channel.js";

/** Schedule forms a proactive check-in accepts; it reuses the existing forms (Req 1.2). */
const PROACTIVE_SCHEDULE_FORMS = ["at", "every", "cron"] as const;

function isProactiveScheduleForm(kind: unknown): kind is (typeof PROACTIVE_SCHEDULE_FORMS)[number] {
  return typeof kind === "string" && (PROACTIVE_SCHEDULE_FORMS as readonly string[]).includes(kind);
}

function readNonBlankString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** Reads the candidate delivery channel from the payload or the job delivery block. */
function readCandidateDeliveryChannel(job: Record<string, unknown>): string | undefined {
  const payload = isRecord(job.payload) ? job.payload : undefined;
  const fromPayload = readNonBlankString(payload?.deliveryChannel);
  if (fromPayload) {
    return fromPayload;
  }
  const delivery = isRecord(job.delivery) ? job.delivery : undefined;
  return readNonBlankString(delivery?.channel);
}

/**
 * Outcome of successful validation: the resolved real Delivery_Channel id. The
 * caller stamps it onto both `payload.deliveryChannel` and the announce
 * `delivery` block so the immutable spec and the delivery pipeline agree.
 */
export type ProactiveCheckInCreateResolution = {
  deliveryChannel: string;
};

/**
 * Validate a normalized `proactiveCheckIn` create job in fixed order:
 *   1. exactly one `at`/`every`/`cron` schedule form (Req 1.2, 1.3);
 *   2. `pendingTopicRef` present (Req 1.6);
 *   3. a Delivery_Channel present or inferable (Req 1.4);
 *   4. the channel resolves to a real, user-facing channel and is not an
 *      internal non-delivery channel (never the internal "cron" channel)
 *      (Req 1.5, 3.2).
 *
 * `inferredDeliveryChannel` is the channel resolved from the requesting
 * conversation (via `resolveCronCreationDelivery`) when the request omitted one;
 * pass `undefined` when nothing could be inferred. Throws on the first failing
 * check; returns the resolved channel on success.
 */
export function validateProactiveCheckInCreate(params: {
  job: Record<string, unknown>;
  inferredDeliveryChannel?: string;
}): ProactiveCheckInCreateResolution {
  const { job, inferredDeliveryChannel } = params;

  // 1. Schedule form — exactly one of at/every/cron (Req 1.2, 1.3).
  const schedule = isRecord(job.schedule) ? job.schedule : undefined;
  const scheduleKind = schedule?.kind;
  if (!isProactiveScheduleForm(scheduleKind)) {
    const named =
      typeof scheduleKind === "string" && scheduleKind.trim().length > 0
        ? `"${scheduleKind.trim()}"`
        : "none";
    throw new Error(
      `proactiveCheckIn requires exactly one schedule form of at, every, or cron; got ${named}`,
    );
  }

  // 2. Pending topic (Req 1.6).
  const payload = isRecord(job.payload) ? job.payload : undefined;
  if (!readNonBlankString(payload?.pendingTopicRef)) {
    throw new Error("proactiveCheckIn requires a pendingTopicRef identifying the pending topic");
  }

  // 3. Delivery channel present or inferable (Req 1.4).
  const candidate =
    readCandidateDeliveryChannel(job) ?? readNonBlankString(inferredDeliveryChannel);
  if (!candidate) {
    throw new Error(
      "proactiveCheckIn requires a delivery channel; none supplied and none could be inferred from the conversation",
    );
  }

  // 4. Channel resolves to a real, user-facing channel (Req 1.5, 3.2). Reject the
  //    internal webchat channel and any internal non-delivery channel (never the
  //    internal "cron" channel) with an error distinct from the missing-channel
  //    error above.
  const normalized = normalizeMessageChannel(candidate);
  if (
    !normalized ||
    normalized === INTERNAL_MESSAGE_CHANNEL ||
    isInternalNonDeliveryChannel(normalized) ||
    !isDeliverableMessageChannel(normalized)
  ) {
    throw new Error(
      `proactiveCheckIn delivery channel "${candidate}" is not a real user-facing channel`,
    );
  }

  return { deliveryChannel: normalized };
}
