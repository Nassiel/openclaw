import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createAdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import { loadProviderScopedThinkingCatalog } from "../agents/model-catalog.runtime.js";
import { prepareOperatorModelPolicy } from "../agents/operator-model-policy.js";
import { withGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withOperatorToolGatewayAuthority } from "../gateway/server-plugin-in-process-dispatch.js";
import { createSyntheticPluginRuntimeClient } from "../gateway/server-plugin-runtime-client.js";
import { applySessionModelSelection } from "../plugin-sdk/model-session-runtime.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { createModelSelectionInputs } from "./apply-session-model-selection.test-support.js";

vi.mock("../agents/model-runtime-choice.js", () => ({
  preparePublishedModelRuntimeChoice: vi.fn(async () => ({
    kind: "ready",
    runtimeId: "openclaw",
    validate: () => undefined,
  })),
}));
vi.mock("../agents/model-catalog.runtime.js", () => ({
  loadProviderScopedThinkingCatalog: vi.fn(async () => []),
}));

const { effects, factories, resetMocks } = await vi.hoisted(async () => {
  const { createModelSelectionMocks } =
    await import("./apply-session-model-selection.test-support.js");
  return createModelSelectionMocks();
});
vi.mock("../infra/system-events.js", factories.systemEvents);
vi.mock("../auto-reply/reply/queue.js", factories.queue);
vi.mock("../gateway/session-patch-hooks.js", factories.patchHooks);
vi.mock("../config/config.js", factories.config);
vi.mock("../logging/subsystem.js", factories.logging);
vi.mock("../gateway/session-worker-placement-context.js", factories.placementContext);
vi.mock("../gateway/worker-environments/placement-session-runtime.js", factories.placementRuntime);

beforeEach(() => resetMocks());
afterEach(() => vi.clearAllMocks());

it.each(["agent-tool", "request", "direct-tool", "unbound-operator"] as const)(
  "the public SDK cannot omit operator model policy in %s context",
  async (source) => {
    const cfg: OpenClawConfig = {
      plugins: { enabled: false },
      agents: { defaults: { model: "fixture/allowed" } },
      models: {
        providers: {
          fixture: {
            api: "openai-completions",
            baseUrl: "https://fixture.invalid/v1",
            agentRuntime: { id: "openclaw" },
            models: [],
          },
        },
      },
    };
    const authority = createAdmittedRunOperatorAuthority({
      profileId: "operator-fixture",
      scopes: ["operator.write"],
      assertCurrent: () => {},
      modelPolicy: prepareOperatorModelPolicy({ cfg, policy: { allow: ["fixture/allowed"] } }),
    });
    const profile = {
      profileId: authority.profileId,
      displayName: "Operator Fixture",
      hasAvatar: false,
      updatedAt: 1,
    };
    const catalog = ["allowed", "blocked"].map((id) => ({ provider: "fixture", id, name: id }));
    const { createParams, createEntry } = createModelSelectionInputs();
    const params = createParams({
      cfg,
      defaultProvider: "fixture",
      defaultModel: "allowed",
      currentProvider: "fixture",
      currentModel: "allowed",
      sessionEntry: createEntry({ providerOverride: "fixture", modelOverride: "allowed" }),
      modelCatalog: catalog,
      thinkingCatalog: catalog,
      request: {
        provider: "fixture",
        model: "blocked",
        isDefault: false,
        runtime: { kind: "unchanged" },
      },
    });
    const before = structuredClone(params.sessionEntry);
    const run = () => applySessionModelSelection(params);
    const result =
      source === "agent-tool"
        ? await withGatewayToolCallerIdentity(
            { agentId: "main", sessionKey: params.sessionKey, operatorAuthority: authority },
            run,
          )
        : source === "request"
          ? await withPluginRuntimeGatewayRequestScope(
              {
                client: createSyntheticPluginRuntimeClient({
                  authenticatedUserProfile: profile,
                  operatorRunAuthority: authority,
                  scopes: ["operator.write"],
                }),
                isWebchatConnect: () => false,
              },
              run,
            )
          : await withOperatorToolGatewayAuthority(
              {
                authenticatedUserProfile: profile,
                scopes: ["operator.write"],
                ...(source === "direct-tool" ? { operatorRunAuthority: authority } : {}),
              },
              run,
            );

    expect(result).toMatchObject({
      status: "rejected",
      reason: "not-allowed",
      message: expect.stringContaining(
        source === "unbound-operator"
          ? "requires original Gateway authority"
          : "operator role cannot use this model",
      ),
    });
    expect(params.sessionEntry).toEqual(before);
    expect(loadProviderScopedThinkingCatalog).not.toHaveBeenCalled();
    expect(effects.triggerSessionPatchHook).not.toHaveBeenCalled();
    expect(effects.refreshQueuedFollowupSession).not.toHaveBeenCalled();
    expect(effects.mutateConfigFileWithRetry).not.toHaveBeenCalled();
  },
);
