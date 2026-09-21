import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GitCheckoutContext } from "../infra/git-read-operations.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { roleScopesAllow } from "../shared/operator-scope-compat.js";
import { getSessionRepositoryWorkspaceStore } from "../state/session-repository-workspaces.js";
import { readUserProfileAliasRevision } from "../state/user-profile-events.js";
import { resolveUserProfileId } from "../state/user-profiles.js";
import { parseGitHubRemoteUrl } from "./github-remote.js";
import { hasCurrentGatewayOperatorAccess } from "./operator-access-policy.js";
import {
  authorizeCurrentOperatorRoleScopes,
  resolveGatewayOperatorRoleActor,
} from "./operator-role-policy.js";
import { READ_SCOPE } from "./operator-scopes.js";
import { isGatewayClientProfilePending } from "./server-methods/gateway-client-identity.js";
import type { GatewayClient } from "./server-methods/types.js";
import { resolveRequestedSessionAgentId } from "./session-request-agent.js";
import { createSessionListEntryFilter } from "./session-sharing.js";
import { loadGatewaySessionEntryReadOnly } from "./session-utils-store.js";

type SelectedSession = Pick<
  ReturnType<typeof loadGatewaySessionEntryReadOnly>,
  "cfg" | "agentId" | "canonicalKey" | "storePath" | "readSource" | "entry"
>;

export type ControlUiSessionPrTarget = {
  params: { sessionKey: string; agentId: string };
  identity: string;
  source: string | GitCheckoutContext | null;
};

/** Git facts and cached snapshots belong to the recorded session and workspace source. */
export function resolveControlUiSessionPrTarget(
  selected: SelectedSession,
): ControlUiSessionPrTarget | undefined {
  const { cfg, agentId, canonicalKey, storePath, readSource, entry } = selected;
  if (!entry?.sessionId || !storePath) {
    return undefined;
  }
  let source: ControlUiSessionPrTarget["source"];
  if (entry.repositoryWorkspaceId) {
    const repository = getSessionRepositoryWorkspaceStore().get(entry.repositoryWorkspaceId);
    const remote =
      repository?.agentId === agentId && repository.sessionKey === canonicalKey
        ? parseGitHubRemoteUrl(repository.url)
        : null;
    source = remote && repository ? { ...remote, branch: repository.branch } : null;
  } else {
    source =
      normalizeOptionalString(entry.spawnedCwd) ??
      normalizeOptionalString(entry.spawnedWorkspaceDir) ??
      normalizeOptionalString(resolveAgentWorkspaceDir(cfg, agentId)) ??
      null;
  }
  return {
    params: { sessionKey: canonicalKey, agentId },
    identity: JSON.stringify([
      agentId,
      canonicalKey,
      storePath,
      readSource?.agentId,
      readSource?.path,
      entry.sessionId,
      entry.lifecycleRevision,
      entry.repositoryWorkspaceId,
      entry.worktree?.id,
      source,
    ]),
    source,
  };
}

export type ControlUiSessionPrRead = () => ControlUiSessionPrTarget | undefined;

/** A watcher may follow a replaced target, but never a replacement person or access grant. */
export function prepareControlUiSessionPrRead(params: {
  client: GatewayClient;
  watchKey: string;
  getRuntimeConfig: () => OpenClawConfig;
  isCurrentClient: () => boolean;
}): ControlUiSessionPrRead | undefined {
  const { client, watchKey, getRuntimeConfig, isCurrentClient } = params;
  const parsed = parseAgentSessionKey(watchKey);
  const globalAgentId = parsed?.rest === "global" ? parsed.agentId : undefined;
  const sessionKey = globalAgentId ? "global" : watchKey;
  const actor = resolveGatewayOperatorRoleActor(client);
  const actorKind = actor?.kind;
  const actorProfile = actor?.kind === "operator" ? actor.profileId : undefined;
  const profileInput = client.authenticatedUserProfile?.profileId;
  const userInput = client.authenticatedUserId;
  const scopes = [...(client.connect.scopes ?? [])].toSorted().join("\0");
  const access = client.internal?.operatorAccessAuthority;
  const connectionSignal = client.connectionSignal;
  let aliasRevision = -1;
  const readCurrent = () => {
    try {
      const currentActor = resolveGatewayOperatorRoleActor(client);
      if (
        !isCurrentClient() ||
        client.invalidated ||
        (client.connect.role ?? "operator") !== "operator" ||
        client.connectionSignal !== connectionSignal ||
        connectionSignal?.aborted ||
        isGatewayClientProfilePending(client) ||
        client.authenticatedUserProfile?.profileId !== profileInput ||
        client.authenticatedUserId !== userInput ||
        currentActor?.kind !== actorKind ||
        (currentActor?.kind === "operator" ? currentActor.profileId : undefined) !== actorProfile ||
        [...(client.connect.scopes ?? [])].toSorted().join("\0") !== scopes ||
        client.internal?.operatorAccessAuthority !== access ||
        !hasCurrentGatewayOperatorAccess(access)
      ) {
        return undefined;
      }
      const currentAliasRevision = readUserProfileAliasRevision();
      if (currentAliasRevision !== aliasRevision) {
        if (actorProfile && resolveUserProfileId(actorProfile) !== actorProfile) {
          return undefined;
        }
        aliasRevision = currentAliasRevision;
      }
      const cfg = getRuntimeConfig();
      if (
        authorizeCurrentOperatorRoleScopes(client, cfg) ||
        !roleScopesAllow({
          role: "operator",
          requestedScopes: [READ_SCOPE],
          allowedScopes: client.connect.scopes ?? [],
        })
      ) {
        return undefined;
      }
      const requested = resolveRequestedSessionAgentId(cfg, sessionKey, globalAgentId);
      if (!requested.ok) {
        return undefined;
      }
      const selected = loadGatewaySessionEntryReadOnly(sessionKey, {
        agentId: requested.agentId,
        clone: false,
        projection: "list",
      });
      if (
        !selected.entry ||
        createSessionListEntryFilter({ cfg, client })?.(selected.canonicalKey, selected.entry) ===
          false
      ) {
        return undefined;
      }
      return resolveControlUiSessionPrTarget(selected);
    } catch {
      return undefined;
    }
  };
  return readCurrent() ? readCurrent : undefined;
}
