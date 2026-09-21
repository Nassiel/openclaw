import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { roleScopesAllow } from "../shared/operator-scope-compat.js";
import {
  decodeGitHubPublicationRequester,
  type GitHubPublicationRequesterSnapshot,
} from "../state/github-publication-requester.js";
import { prepareUserProfileIdentity } from "../state/user-profile-list.js";
import { GitHubPublicationRequesterUnavailableError } from "./github-publication-failure.js";
import { GitHubPublicationRecoveryPendingError } from "./github-publication-git-index.js";
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
type PreparedProfileIdentity = Awaited<ReturnType<typeof prepareUserProfileIdentity>>;

export type GitHubPublicationRequesterPolicy = Readonly<{
  snapshot: GitHubPublicationRequesterSnapshot;
  assertCurrent: () => void;
}>;

export type GitHubPublicationRequester = GitHubPublicationRequesterPolicy &
  Readonly<{
    /** An accepted row keeps its own policy while the current invocation retains its fences. */
    assertInvocationCurrent: () => void;
  }>;

function prepareRequesterPolicy(
  snapshot: GitHubPublicationRequesterSnapshot,
  session: PublicationSession,
  getCommittedRuntimeConfig: () => OpenClawConfig,
  identity: PreparedProfileIdentity | undefined,
) {
  const client = createSyntheticPluginRuntimeClient({
    operatorRoleActor: snapshot.actor,
    scopes: [...snapshot.scopes],
  });
  const assertIdentity = () => {
    if (snapshot.actor.kind !== "operator") {
      return;
    }
    try {
      if (!identity) {
        throw new GitHubPublicationRequesterUnavailableError();
      }
      identity.assertCurrent(snapshot.grant?.aliasBindingIds);
    } catch {
      throw new GitHubPublicationRequesterUnavailableError();
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
export async function captureGitHubPublicationRequester(
  options: Parameters<typeof captureGatewayOperatorRunAuthority>[0] &
    Pick<GatewayRequestHandlerOptions, "signal" | "sessionMutationAuthorization">,
  session: PublicationSession,
): Promise<{ requester: GitHubPublicationRequester; release: () => void }> {
  options.signal?.throwIfAborted();
  options.sessionMutationAuthorization?.assertCurrent();
  const source = captureGatewayOperatorRunAuthority(options);
  let identity: PreparedProfileIdentity | undefined;
  const release = () => {
    identity?.release();
    source?.release();
  };
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
    let grant: GitHubPublicationRequesterSnapshot["grant"] = null;
    if (source) {
      identity = await prepareUserProfileIdentity(source.authority.profileId);
      if (source.authority.gatewayAccessGrant) {
        grant = Object.freeze({
          ...source.authority.gatewayAccessGrant,
          aliasBindingIds: identity.emailBindingIds,
        });
      }
    }
    const snapshot: GitHubPublicationRequesterSnapshot = Object.freeze({
      version: 1,
      actor: Object.freeze(
        source
          ? { kind: "operator" as const, profileId: source.authority.profileId }
          : { kind: "system" as const },
      ),
      scopes: Object.freeze([...(source?.authority.scopes ?? options.client.connect.scopes ?? [])]),
      grant,
    });
    const assertPolicy = prepareRequesterPolicy(
      snapshot,
      session,
      options.context.getCommittedRuntimeConfig ?? options.context.getRuntimeConfig,
      identity,
    );
    const assertInvocationCurrent = () => {
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
    };
    const requester = Object.freeze({
      snapshot,
      assertInvocationCurrent,
      assertCurrent: () => {
        assertInvocationCurrent();
        assertPolicy();
      },
    });
    requester.assertCurrent();
    return { requester, release };
  } catch (error) {
    release();
    throw error;
  }
}

/** Restoration rechecks the original immutable basis; a new role or invitation cannot replace it. */
export async function restoreGitHubPublicationRequester(
  json: string | null | undefined,
  session: PublicationSession,
  getCommittedRuntimeConfig: () => OpenClawConfig,
): Promise<GitHubPublicationRequesterPolicy & { release: () => void }> {
  const snapshot = decodeGitHubPublicationRequester(json);
  if (!snapshot) {
    throw new GitHubPublicationRequesterUnavailableError();
  }
  let identity: PreparedProfileIdentity | undefined;
  if (snapshot.actor.kind === "operator") {
    try {
      identity = await prepareUserProfileIdentity(snapshot.actor.profileId);
    } catch (error) {
      throw new GitHubPublicationRecoveryPendingError(
        "GitHub publication requester identity is unavailable; retry recovery after profile storage is ready.",
        { cause: error },
      );
    }
  }
  const release = () => identity?.release();
  try {
    const requester = Object.freeze({
      snapshot,
      assertCurrent: prepareRequesterPolicy(snapshot, session, getCommittedRuntimeConfig, identity),
      release,
    });
    requester.assertCurrent();
    return requester;
  } catch (error) {
    release();
    throw error;
  }
}
