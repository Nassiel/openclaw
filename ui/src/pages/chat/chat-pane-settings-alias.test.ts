/* @vitest-environment jsdom */

import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { render } from "lit";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import type { GatewaySessionRow, ModelCatalogEntry } from "../../api/types.ts";
import { createApplicationConfigCapability } from "../../app/config.ts";
import { createApplicationPlacementStartup } from "../../app/session-placement-startup.ts";
import { createRuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import { sessionsResult } from "../../lib/sessions/session-capability.test-support.ts";
import { resolveUiConversationIdentity } from "../../lib/sessions/session-key.ts";
import { ControlUiPluginRuntime } from "../../plugins/control-ui-runtime.ts";
import {
  createTestGatewayClient,
  type GatewayRequestHandler,
} from "../../test-helpers/gateway-client.ts";
import { sessionMutationGatewayHello } from "../../test-helpers/gateway-methods.ts";
import { refreshPane } from "./chat-pane-mounted.test-support.ts";
import {
  readChatPaneMutationAccess,
  renderChatPaneComposerControls,
} from "./chat-pane-session-controls.ts";
import { createTestChatPane } from "./chat-pane.test-support.ts";
import { selectedChatSessionRow } from "./chat-state-route.ts";
import * as modelControls from "./components/chat-model-controls.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";

beforeEach(installTranscriptDomMocks);
afterEach(resetTranscriptTestDom);

type Setting = "thinking" | "speed" | "context";
type ComposerSettings = Parameters<typeof modelControls.renderChatModelControls>[0];

const models: ModelCatalogEntry[] = [
  {
    id: "fixture-model",
    name: "Fixture model",
    provider: "fixture",
    reasoning: true,
    // An existing unsupported speed override remains clearable through the real toggle.
    supportsFastMode: false,
  },
];

async function mountAlias(mainKey: string, setting: Setting, choice: "" | "low") {
  const routeKey = `agent:work:${mainKey}`;
  const initial: GatewaySessionRow = {
    key: "global",
    agentId: "work",
    sessionId: "work-global-session",
    kind: "global",
    updatedAt: 1,
    model: "fixture-model",
    modelProvider: "fixture",
    thinkingLevel: "high",
    thinkingDefault: "low",
    thinkingLevels: [
      { id: "low", label: "Low" },
      { id: "high", label: "High" },
    ],
    fastMode: true,
    effectiveFastMode: true,
    contextWindow: "128k",
    contextWindowDefault: "64k",
    contextWindows: [
      { id: "64k", label: "64K", contextWindow: 64_000 },
      { id: "128k", label: "128K", contextWindow: 128_000 },
    ],
  };
  const mainRow: GatewaySessionRow = {
    ...initial,
    agentId: "main",
    sessionId: "main-global-session",
    thinkingLevel: "high",
  };
  const canonical: GatewaySessionRow = {
    ...initial,
    updatedAt: 2,
    ...(setting === "thinking"
      ? { thinkingLevel: choice || undefined }
      : setting === "speed"
        ? { fastMode: undefined, effectiveFastMode: false }
        : { contextWindow: undefined }),
  };
  const field =
    setting === "thinking" ? "thinkingLevel" : setting === "speed" ? "fastMode" : "contextWindow";
  let current = initial;
  const patch = vi.fn<GatewayRequestHandler>((_method, raw) => {
    expect(raw).toMatchObject({
      key: routeKey,
      agentId: "work",
      expectedSessionId: initial.sessionId,
      [field]: choice || null,
    });
    current = canonical;
    return {
      ok: true,
      key: "global",
      path: "",
      entry: {
        sessionId: canonical.sessionId,
        updatedAt: canonical.updatedAt,
        thinkingLevel: canonical.thinkingLevel,
        fastMode: canonical.fastMode,
        contextWindow: canonical.contextWindow,
      },
    };
  });
  const client = createTestGatewayClient(async (method, raw, options) => {
    const params = asOptionalRecord(raw);
    if (method === "agents.list") {
      return {
        defaultId: "main",
        mainKey,
        scope: "global",
        agents: [{ id: "main" }, { id: "work" }],
      };
    }
    if (method === "models.list" || method === "chat.metadata") {
      return { models, commands: [], swarmEnabled: false };
    }
    if (method === "agent.identity.get") {
      return { agentId: params?.agentId, name: "Assistant" };
    }
    if (method === "sessions.patch") {
      return patch(method, raw, options);
    }
    if (method === "sessions.list") {
      return sessionsResult(params?.agentId === "work" ? [current] : [mainRow], current.updatedAt!);
    }
    if (method === "sessions.describe" || method === "chat.history" || method === "chat.startup") {
      const key = params?.key ?? params?.sessionKey;
      const row =
        params?.agentId === "work" && (key === routeKey || key === "global")
          ? current
          : params?.agentId === "main" && key === "global"
            ? mainRow
            : undefined;
      return method === "sessions.describe"
        ? { session: row ?? null }
        : { messages: [], sessionInfo: row, sessionId: row?.sessionId };
    }
    return {};
  });
  const fixture = createTestChatPane({ client });
  const { pane, sessions } = fixture;
  const context = pane.context;
  const runtimeConfig = createRuntimeConfigCapability(context.gateway);
  const placementStartup = createApplicationPlacementStartup(context);
  Object.assign(context, {
    config: createApplicationConfigCapability({ resourceBasePath: "" }),
    runtimeConfig,
    placementStartup,
    plugins: new ControlUiPluginRuntime(() => context),
  });
  onTestFinished(() => {
    runtimeConfig.dispose();
    placementStartup.dispose();
    client.stop();
  });
  pane.sessionKey = routeKey;
  Object.assign(pane, { agentId: "work" });
  context.agentSelection.set("work");
  pane.applyGatewaySnapshot({
    ...context.gateway.snapshot,
    hello: {
      ...sessionMutationGatewayHello(),
      snapshot: {
        sessionDefaults: { defaultAgentId: "main", mainKey, mainSessionKey: "global" },
      },
    },
  });
  await context.agents.ensureList();
  await sessions.refresh({ agentId: "work", force: true });
  pane.connectedCallback();
  await refreshPane(pane);
  pane.state.chatModelCatalog = models;
  expect(pane.state.sessionKey).toBe(routeKey);
  expect(pane.state.assistantAgentId).toBe("work");
  expect(resolveUiConversationIdentity(pane.state, routeKey)).toEqual({
    sessionKey: "global",
    agentId: "work",
  });
  expect(selectedChatSessionRow(pane.state)).toMatchObject(initial);
  expect(pane.state.currentSessionId).toBe(initial.sessionId);
  expect(sessions.state.result?.sessions).toEqual([expect.objectContaining(initial)]);
  return { pane, sessions, context, routeKey, initial, canonical, mainRow, patch, field };
}

function invokeSetting(props: ComposerSettings, setting: Setting, choice: "" | "low") {
  if (setting === "thinking" && props.onThinkingSelect) {
    return props.onThinkingSelect(choice, props.sessionKey);
  }
  if (setting === "speed" && props.onFastModeSelect) {
    return props.onFastModeSelect("", props.sessionKey);
  }
  if (setting === "context" && props.onContextWindowSelect) {
    return props.onContextWindowSelect("", props.sessionKey);
  }
  throw new Error(`Missing actual composer ${setting} callback`);
}

for (const mainKey of ["main", "workspace"]) {
  it.each([
    { setting: "thinking" as const, choice: "" as const },
    { setting: "speed" as const, choice: "" as const },
    { setting: "context" as const, choice: "" as const },
    { setting: "thinking" as const, choice: "low" as const },
  ])(
    `patches the canonical global owner through agent:work:${mainKey} ($setting=$choice)`,
    async ({ setting, choice }) => {
      const fixture = await mountAlias(mainKey, setting, choice);
      const { pane, sessions, context, routeKey, initial, canonical, patch, field } = fixture;
      const container = document.createElement("div");
      const rendered = vi.spyOn(modelControls, "renderChatModelControls");
      let operation: Promise<unknown> | undefined;
      const renderControls = () => {
        const access = readChatPaneMutationAccess(context.gateway.snapshot, routeKey);
        expect(access.effort.allowed).toBe(true);
        expect(access.contextWindow.allowed).toBe(true);
        const controls = renderChatPaneComposerControls({
          state: pane.state,
          selectedSession: selectedChatSessionRow(pane.state),
          agentDefaultModel: undefined,
          modelAccess: access.model,
          effortAccess: access.effort,
          contextWindowAccess: access.contextWindow,
          permissionAccess: access.permission,
          canSelectFull: false,
          onModelSetup: vi.fn(),
        });
        render(controls.composerControls, container);
        const props = rendered.mock.calls.at(-1)?.[0];
        if (!props) {
          throw new Error("Composer did not render its model controls");
        }
        return props;
      };
      try {
        const props = renderControls();
        expect(props.sessionKey).toBe(routeKey);
        expect(props.selectedSession).toMatchObject(initial);
        operation = Promise.resolve(invokeSetting(props, setting, choice));
        await expect(operation).resolves.toBe(true);
        expect(patch).toHaveBeenCalledOnce();
        expect(patch.mock.calls[0]?.[1]).toMatchObject({
          key: routeKey,
          agentId: "work",
          expectedSessionId: initial.sessionId,
          [field]: choice || null,
        });
        expect(selectedChatSessionRow(pane.state)).toMatchObject(canonical);
        expect(sessions.state.result?.sessions).toEqual([expect.objectContaining(canonical)]);
        expect(pane.state.currentSessionId).toBe(initial.sessionId);
        renderControls();
        if (setting === "thinking") {
          expect(
            container.querySelector<HTMLElement>("[data-chat-thinking-select]")?.dataset
              .chatThinkingValue,
          ).toBe(choice);
          expect(
            container.querySelector("[data-chat-thinking-preview-committed]")?.textContent,
          ).toBe("Low");
        } else if (setting === "speed") {
          expect(
            container
              .querySelector("[data-chat-thinking-select]")
              ?.getAttribute("data-chat-fast-mode"),
          ).toBe("false");
        } else {
          expect(
            container
              .querySelector("[data-chat-context-window-toggle]")
              ?.getAttribute("aria-checked"),
          ).toBe("false");
        }
      } finally {
        await Promise.allSettled([operation]);
        await vi.dynamicImportSettled();
        rendered.mockRestore();
        render(null, container);
      }
    },
  );
}
