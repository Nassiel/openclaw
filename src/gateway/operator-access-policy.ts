import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginGatewayAccessAuthority } from "../plugins/gateway-access-policy.types.js";
import { getPluginRegistryState } from "../plugins/runtime-state.js";
import { readUserProfileVersion } from "../state/user-profile-events.js";
import { getUserProfileListItem } from "../state/user-profiles.js";
import { resolveOperatorRolePolicyForAssignment } from "./operator-role-policy.js";

export const GATEWAY_OPERATOR_ACCESS_DENIED_MESSAGE =
  "Gateway access is no longer active; ask a Gateway administrator to restore it.";

export class GatewayOperatorAccessDeniedError extends Error {
  constructor() {
    super(GATEWAY_OPERATOR_ACCESS_DENIED_MESSAGE);
    this.name = "GatewayOperatorAccessDeniedError";
  }
}

function currentAccessPolicies() {
  const registry = getPluginRegistryState()?.activeRegistry;
  return (
    registry?.gatewayAccessPolicies?.filter((registration) =>
      registry.plugins.some(
        (plugin) =>
          plugin.id === registration.pluginId && plugin.enabled && plugin.status === "loaded",
      ),
    ) ?? []
  );
}

export function hasGatewayOperatorAccessPolicies(config: OpenClawConfig): boolean {
  return (
    currentAccessPolicies().length > 0 ||
    Object.values(config.gateway?.roles?.definitions ?? {}).some((role) => role.accessPolicyPlugin)
  );
}

/** Bind additional access to this exact authenticated person and the original policy lifetimes. */
export function resolveGatewayOperatorAccessAuthority(
  profileId: string,
  config: OpenClawConfig,
): PluginGatewayAccessAuthority | undefined {
  if (profileId === GATEWAY_OWNER_PROFILE_ID) {
    return undefined;
  }
  const policies = currentAccessPolicies();
  if (policies.length === 0 && !hasGatewayOperatorAccessPolicies(config)) {
    return undefined;
  }
  const profile = getUserProfileListItem(profileId);
  const requiredPlugin = resolveOperatorRolePolicyForAssignment(
    profile.id,
    profile.role ?? null,
    config,
  )?.accessPolicyPlugin;
  if (requiredPlugin && !policies.some((entry) => entry.pluginId === requiredPlugin)) {
    throw new GatewayOperatorAccessDeniedError();
  }
  const emails = [...profile.emails];
  let authorities: PluginGatewayAccessAuthority[];
  try {
    let requiredPolicyConfirmed = !requiredPlugin;
    authorities = policies.flatMap(({ policy, pluginId }) => {
      const authority = policy.authorize({
        config,
        profile: { profileId: profile.id, emails: [...emails], assignedRole: profile.role ?? null },
      });
      if (authority && pluginId === requiredPlugin) {
        requiredPolicyConfirmed = true;
      }
      return authority ? [authority] : [];
    });
    if (!requiredPolicyConfirmed) {
      throw new GatewayOperatorAccessDeniedError();
    }
  } catch {
    // Policy errors can contain private configuration; only the generic denial crosses ingress.
    throw new GatewayOperatorAccessDeniedError();
  }
  if (authorities.length === 0) {
    return undefined;
  }
  const invalidated = new AbortController();
  const signal = AbortSignal.any([invalidated.signal, ...authorities.map((entry) => entry.signal)]);
  let profileVersion = readUserProfileVersion();
  let denial: GatewayOperatorAccessDeniedError | undefined;
  const assertCurrent = () => {
    try {
      signal.throwIfAborted();
      if (profile.id !== profileId) {
        throw new GatewayOperatorAccessDeniedError();
      }
      const currentVersion = readUserProfileVersion();
      if (currentVersion !== profileVersion) {
        const current = getUserProfileListItem(profileId);
        const currentEmails = new Set(current.emails);
        // A merge or alias replacement cannot transfer a captured grant to its successor.
        // Display/avatar changes leave these facts unchanged and preserve admitted work.
        if (current.id !== profileId || emails.some((email) => !currentEmails.has(email))) {
          throw new GatewayOperatorAccessDeniedError();
        }
        profileVersion = currentVersion;
      }
      for (const authority of authorities) {
        authority.assertCurrent();
      }
    } catch {
      // Once closed, a later invitation, profile repair or renewal cannot revive this capture.
      denial ??= new GatewayOperatorAccessDeniedError();
      invalidated.abort(denial);
      throw denial;
    }
  };
  assertCurrent();
  return { assertCurrent, signal };
}

export function hasCurrentGatewayOperatorAccess(
  authority: PluginGatewayAccessAuthority | undefined,
): boolean {
  try {
    authority?.signal.throwIfAborted();
    authority?.assertCurrent();
    return true;
  } catch {
    return false;
  }
}
