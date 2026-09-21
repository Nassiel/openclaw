import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { roleScopesAllow } from "../shared/operator-scope-compat.js";
import {
  decodeGitHubPublicationRequester,
  type GitHubPublicationRequesterSnapshot,
} from "../state/github-publication-requester.js";
import { readUserProfileEmailBindingIds, resolveUserProfileId } from "../state/user-profiles.js";
import { GitHubPublicationRequesterUnavailableError } from "./github-publication-failure.js";
import {
  GatewayOperatorAccessDeniedError,
  resumeGatewayOperatorAccessGrant,
} from "./operator-access-policy.js";
import {
  authorizeCurrentOperatorRoleScopes,
  resolveGatewayOperatorRoleActor,
} from "./operator-role-policy.js";
import { captureGatewayOperatorRunAuthority } from "./operator-run-authority.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";
import { authorizeResolvedSessionMutation } from "./session-sharing-policy.js";

type PublicationSession = { sessionKey: string; agentId: string };

export type GitHubPublicationRequester = Readonly<{
  snapshot: GitHubPublicationRequesterSnapshot;
  assertCurrent: () => void;
}>;

function prepareRequesterPolicy(
  snapshot: GitHubPublicationRequesterSnapshot,
  session: PublicationSession,
  getCommittedRuntimeConfig: () => OpenClawConfig,
) {
  const client = createSyntheticPluginRuntimeClient({
    operatorRoleActor: snapshot.actor,
    scopes: [...snapshot.scopes],
  });
  const assertIdentity = () => {
    if (snapshot.actor.kind !== "operator") {
      return;
    }
    if (resolveUserProfileId(snapshot.actor.profileId) !== snapshot.actor.profileId) {
      throw new GitHubPublicationRequesterUnavailableError();
    }
    if (snapshot.grant) {
      const bindings = new Set(readUserProfileEmailBindingIds(snapshot.actor.profileId));
      if (snapshot.grant.aliasBindingIds.some((id) => !bindings.has(id))) {
        throw new GitHubPublicationRequesterUnavailableError();
      }
    }
  };
  return () => {
    const config = getCommittedRuntimeConfig();
    assertIdentity();
    if (
      !roleScopesAllow({
        role: "operator",
        requestedScopes: ["operator.sessions.write"],
        allowedScopes: snapshot.scopes,
      }) ||
      authorizeCurrentOperatorRoleScopes(client, config) ||
      authorizeResolvedSessionMutation({ cfg: config, client, ...session })
    ) {
      throw new GitHubPublicationRequesterUnavailableError();
    }
    if (snapshot.actor.kind === "operator") {
      try {
        resumeGatewayOperatorAccessGrant(snapshot.actor.profileId, config, snapshot.grant);
      } catch (error) {
        if (error instanceof GatewayOperatorAccessDeniedError) {
          throw new GitHubPublicationRequesterUnavailableError();
        }
        throw error;
      }
      // A policy callback can synchronously change aliases before this guard returns.
      assertIdentity();
    }
  };
}

/** Capture from the admitted caller, never request arguments, publisher, or session attribution. */
export function captureGitHubPublicationRequester(
  options: Parameters<typeof captureGatewayOperatorRunAuthority>[0] &
    Pick<GatewayRequestHandlerOptions, "signal" | "sessionMutationAuthorization">,
  session: PublicationSession,
): { requester: GitHubPublicationRequester; release: () => void } {
  options.signal?.throwIfAborted();
  options.sessionMutationAuthorization?.assertCurrent();
  const source = captureGatewayOperatorRunAuthority(options);
  try {
    const actor = source
      ? { kind: "operator" as const, profileId: source.authority.profileId }
      : resolveGatewayOperatorRoleActor(options.client);
    const system =
      actor?.kind === "system" ||
      options.client?.authenticatedUserProfile?.profileId === GATEWAY_OWNER_PROFILE_ID;
    if (
      (!source && !system) ||
      options.client?.connect.role !== "operator" ||
      (source && source.authority.gatewayAccessGrant === undefined)
    ) {
      throw new GitHubPublicationRequesterUnavailableError();
    }
    const grant = source?.authority.gatewayAccessGrant;
    const snapshot: GitHubPublicationRequesterSnapshot = Object.freeze({
      version: 1,
      actor: Object.freeze(
        source
          ? { kind: "operator" as const, profileId: source.authority.profileId }
          : { kind: "system" as const },
      ),
      scopes: Object.freeze([...(source?.authority.scopes ?? options.client.connect.scopes ?? [])]),
      grant:
        source && grant
          ? Object.freeze({
              ...grant,
              aliasBindingIds: Object.freeze(
                readUserProfileEmailBindingIds(source.authority.profileId).toSorted(),
              ),
            })
          : null,
    });
    const assertPolicy = prepareRequesterPolicy(
      snapshot,
      session,
      options.context.getCommittedRuntimeConfig ?? options.context.getRuntimeConfig,
    );
    const requester = Object.freeze({
      snapshot,
      assertCurrent: () => {
        try {
          options.signal?.throwIfAborted();
          if (options.hasCurrentClientAuthority?.() === false) {
            throw new GitHubPublicationRequesterUnavailableError();
          }
          options.sessionMutationAuthorization?.assertCurrent();
          source?.authority.assertCurrent();
        } catch {
          throw new GitHubPublicationRequesterUnavailableError();
        }
        assertPolicy();
      },
    });
    requester.assertCurrent();
    return { requester, release: source?.release ?? (() => {}) };
  } catch (error) {
    source?.release();
    throw error;
  }
}

/** Restoration rechecks the original immutable basis; a new role or invitation cannot replace it. */
export function restoreGitHubPublicationRequester(
  json: string | null | undefined,
  session: PublicationSession,
  getCommittedRuntimeConfig: () => OpenClawConfig,
): GitHubPublicationRequester {
  const snapshot = decodeGitHubPublicationRequester(json);
  if (!snapshot) {
    throw new GitHubPublicationRequesterUnavailableError();
  }
  const assertPolicy = prepareRequesterPolicy(snapshot, session, getCommittedRuntimeConfig);
  const requester = Object.freeze({
    snapshot,
    assertCurrent: assertPolicy,
  });
  requester.assertCurrent();
  return requester;
}
