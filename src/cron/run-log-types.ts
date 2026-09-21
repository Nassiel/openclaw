/** Stable cron run-history wire shape and legacy JSONL migration input. */
import type { CronRunLogEntry as CronRunLogWireEntry } from "../../packages/gateway-protocol/src/schema/cron.types.js";
import type { CronDeliverySuppressionReason } from "./types.js";

/** Run-history record for a completed cron job execution. */
export type CronRunLogEntry = Omit<CronRunLogWireEntry, "deliverySuppressionReason"> & {
  deliverySuppressionReason?: CronDeliverySuppressionReason;
};
