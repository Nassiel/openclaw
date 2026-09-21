// Gateway hook payload type aliases.
// Keeps hook-facing channel ids on public plugin channel contracts.
import type { ChannelId } from "../channels/plugins/types.public.js";
import type { CronDeliverySuppressionReason } from "../cron/types.js";

// Gateway hooks use public channel ids so hook payloads stay aligned with plugin
// channel contracts instead of internal runtime ids.
/** Public channel id type carried by gateway hook payloads. */
export type HookMessageChannel = ChannelId;

export type HookAgentCompletion = {
  status: "ok" | "error" | "skipped";
  replyDisposition: "visible" | "silent" | "empty";
  delivered?: boolean;
  deliveryAttempted?: boolean;
  deliveryError?: "delivery-failed";
  deliverySuppressionReason?: CronDeliverySuppressionReason;
};

export type HookAgentDispatchSuccess = {
  ok: true;
  runId: string;
  completion: Promise<HookAgentCompletion>;
};

export type HookAgentDispatchResult =
  | HookAgentDispatchSuccess
  | { ok: false; statusCode: 400 | 409 | 502 | 503; error: string; runId?: string };
