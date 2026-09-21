import { parseAgentSessionKey } from "../routing/session-key.js";
import { createControlUiSessionPullRequestSubscriptions } from "./control-ui-session-pr-subscriptions.js";

type SubscriptionDeps = Parameters<typeof createControlUiSessionPullRequestSubscriptions>[0];

/** Resource-owner fixtures supply a stable visible target; access fixtures use the real reader. */
export function createTestControlUiSessionPrSubscriptions(
  deps: Omit<SubscriptionDeps, "prepareRead"> & Partial<Pick<SubscriptionDeps, "prepareRead">>,
) {
  return createControlUiSessionPullRequestSubscriptions({
    prepareRead: (_connId, watchKey) => {
      const parsed = parseAgentSessionKey(watchKey);
      const target = {
        params: {
          sessionKey: parsed?.rest === "global" ? "global" : watchKey,
          agentId: parsed?.agentId ?? "main",
        },
        identity: watchKey,
        source: null,
      };
      return () => target;
    },
    ...deps,
  });
}
