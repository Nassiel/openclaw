import type { WorkerCredentialRecord } from "./credential.js";
import type { WorkerEnvironmentRecord } from "./environment-record.js";
import type {
  WorkerEnvironmentCommitAdmission,
  WorkerEnvironmentFacts,
} from "./store-worker-contract.js";

/** Equality facts only; transfer admission still checks the current owner and capability. */
export function encodeWorkerEnvironmentTransferAuthority(
  environment:
    | Pick<
        WorkerEnvironmentRecord,
        "state" | "ownerEpoch" | "destroyRequestedAtMs" | "attachedSessionIds"
      >
    | undefined,
  credential: Pick<WorkerCredentialRecord, "ownerEpoch" | "sessionId"> | undefined,
): string {
  // Workspace capabilities retain their own TTL across RPC credential rotation and expiry.
  return JSON.stringify([
    environment
      ? [
          environment.state,
          environment.ownerEpoch,
          environment.destroyRequestedAtMs,
          environment.attachedSessionIds,
        ]
      : null,
    credential ? [credential.ownerEpoch, credential.sessionId] : null,
  ]);
}

export function createWorkerEnvironmentCommitAdmission(
  facts: WorkerEnvironmentFacts,
): WorkerEnvironmentCommitAdmission {
  const environments = new Map(facts.environments.map((row) => [row.environmentId, row]));
  const credentials = new Map(facts.credentials.map((row) => [row.environmentId, row]));
  return facts.ids.map((environmentId) => ({
    environmentId,
    transferAuthority: encodeWorkerEnvironmentTransferAuthority(
      environments.get(environmentId),
      credentials.get(environmentId),
    ),
  }));
}
