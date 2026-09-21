import type { StateLeaseProcessOwner } from "../infra/state-lease-process-owner.js";
import type { OpenClawStateLeaseIdentity } from "./openclaw-state-lease-store.js";

export const LEASE_HEARTBEAT_START_TIMEOUT_MS = 5_000;

export const leaseHeartbeatState = {
  status: 0,
  request: 1,
  ack: 2,
  expiresAt: 3,
  startupPhase: 4,
  starting: 0n,
  ready: 1n,
  closed: 2n,
  lost: 3n,
} as const;

// Startup observations never grant readiness or lease authority.
export const leaseHeartbeatStartupPhase = {
  "entry-not-observed": 0n,
  "body-entry": 1n,
  "open-complete": 2n,
  "initial-renew-start": 3n,
  "initial-renew-returned": 4n,
} as const;

export type LeaseHeartbeatWorkerData = {
  path: string;
  existingOnly?: boolean;
  /** Private parent retains the actual lifecycle coordinator until native worker exit. */
  parentCoordinatorRetained?: true;
  identity: OpenClawStateLeaseIdentity;
  leaseMs: number;
  heartbeatMs: number;
  processOwner?: { identity: StateLeaseProcessOwner; env: NodeJS.ProcessEnv };
  shared: SharedArrayBuffer;
};
