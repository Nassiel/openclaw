import type { DatabasePathIdentity } from "../../../infra/sqlite-worker-identity.js";
import { openClawStateDatabaseCache } from "../../../state/openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "../../../state/openclaw-state-db.paths.js";
import type { OpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.types.js";
import type { SubagentRunReadRecord } from "./subagent-registry-read.types.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import type { SubagentSessionReadLookup } from "./subagent-session-read-scope.js";

export type SubagentRunChange<T> = { entry: T | undefined; committed: boolean };
type SubagentRunsCacheState<T extends SubagentRunReadRecord> = (
  | { snapshot: Map<string, T>; lookup?: SubagentSessionReadLookup; replacementPending?: true }
  | { snapshot?: undefined; lookup?: never; replacementPending?: never }
) & {
  changes?: Map<string, SubagentRunChange<T>>;
  context?: OpenClawStateWorkerContext;
  retiredPublicationIdentity?: DatabasePathIdentity;
};

export type SubagentRunsCache<T extends SubagentRunReadRecord> = {
  state: SubagentRunsCacheState<T>;
  captureContext?: () => OpenClawStateWorkerContext;
  load: () => Map<string, T>;
  copy: (entry: SubagentRunRecord) => T;
  project: (entry: SubagentRunRecord) => T;
};

export function matchesSubagentCacheContext(
  previous: OpenClawStateWorkerContext | undefined,
  current: OpenClawStateWorkerContext | undefined,
): boolean {
  if (!previous) {
    return true;
  }
  if (
    !current ||
    previous.admission.identity.key !== current.admission.identity.key ||
    previous.maintenanceScope !== current.maintenanceScope
  ) {
    return false;
  }
  try {
    previous.admission.assertCurrent();
    return true;
  } catch {
    return false;
  }
}

/** Read selection cannot consume or clear another database owner's publication. */
export function selectSubagentCacheStateForRead<T extends SubagentRunReadRecord>(
  state: SubagentRunsCacheState<T>,
  preparedContext?: OpenClawStateWorkerContext,
): SubagentRunsCacheState<T> {
  const stateIdentity = state.retiredPublicationIdentity ?? state.context?.admission.identity;
  const matchesOwner = preparedContext
    ? !state.retiredPublicationIdentity &&
      matchesSubagentCacheContext(state.context, preparedContext)
    : !stateIdentity ||
      stateIdentity ===
        openClawStateDatabaseCache.getKnownOpenClawStateDatabaseIdentity(
          resolveOpenClawStateSqlitePath(),
        );
  return matchesOwner ? state : {};
}
