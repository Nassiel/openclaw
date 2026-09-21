import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAdmittedRunOperatorAuthority,
  readRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
} from "../agents/admitted-run-context.js";
import { createAgentHarnessToolSurfaceRuntimeCore } from "../agents/harness/tool-surface-bridge.js";
import { prepareOperatorModelPolicy } from "../agents/operator-model-policy.js";
import { refreshPreparedModelRuntimeSnapshots } from "../agents/prepared-model-runtime.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "../agents/prepared-model-runtime.test-support.js";
import { createStubTool } from "../agents/test-helpers/agent-tool-stubs.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createSessionCompanion } from "./session-companion.js";

const runLoop = vi.hoisted(() =>
  vi.fn<
    (typeof import("../agents/embedded-agent-runner/run-loop.js"))["runPreparedEmbeddedLoop"]
  >(),
);
vi.mock("../agents/embedded-agent-runner/run-loop.js", () => ({
  runPreparedEmbeddedLoop: runLoop,
}));

afterEach(async () => {
  runLoop.mockReset();
  await resetPreparedModelRuntimeSnapshotsForTest();
});

describe("Side chat with a published Gateway runtime", () => {
  it("keeps its read-only tools and requester model policy after runtime admission", async () => {
    const state = await createOpenClawTestState({
      label: "companion-runtime",
      env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
    });
    const cfg: OpenClawConfig = {
      agents: {
        entries: { main: { workspace: state.workspaceDir } },
        defaults: {
          workspace: state.workspaceDir,
          model: "test-provider/test-model",
          utilityModel: "test-provider/utility-model",
        },
      },
      models: {
        providers: {
          "test-provider": {
            api: "openai-completions",
            apiKey: "synthetic-test-key",
            baseUrl: "http://127.0.0.1:9/v1",
            models: ["test-model", "utility-model"].map((id) => ({
              id,
              name: id,
              reasoning: false,
              input: ["text" as const],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 8192,
              maxTokens: 1024,
            })),
          },
        },
      },
      plugins: { allow: [], slots: { memory: "none" } },
      tools: {
        codeMode: true,
        toolSearch: { enabled: true, mode: "directory" },
        sessions: { visibility: "all" },
        fs: { workspaceOnly: false },
      },
    };
    const companion = createSessionCompanion({
      getConfig: () => cfg,
      contextReader: {
        currentSessionId: () => "selected-session",
        read: async () => ({
          kind: "ready",
          context: { empty: true, messages: [], sessionId: "selected-session" },
        }),
      },
      sessionObserver: { getCompanionSnapshot: () => ({ agentId: "main", notes: [] }) },
    });
    const observedTools: string[][] = [];
    const observedModels: Array<{
      model: string | undefined;
      authority: AdmittedRunOperatorAuthority | undefined;
    }> = [];
    runLoop.mockImplementation(async (_refresh, { runParams }) => {
      observedModels.push({
        model: runParams.model,
        authority: readRunOperatorAuthority(runParams),
      });
      const surface = createAgentHarnessToolSurfaceRuntimeCore({
        config: runParams.config,
        agentId: runParams.agentId,
        sessionId: runParams.sessionId,
        sessionKey: runParams.sessionKey,
        runId: runParams.runId,
        modelProvider: "test-provider",
        modelId: "test-model",
        codeModeOverride: runParams.codeModeOverride,
        disableToolSearch: runParams.disableToolSearch,
        toolsAllow: runParams.toolsAllow,
        modelToolsEnabled: true,
        executeTool: async () => ({ content: [], details: {} }),
      });
      try {
        expect.soft(surface.toolSearchControlsEnabled).toBe(false);
        observedTools.push(
          surface
            .compactTools(["read", "sessions_history", "sessions_search"].map(createStubTool))
            .tools.map((tool) => tool.name),
        );
        expect.soft(runParams.requireWorkspaceOnly).toBe(true);
        expect.soft(runParams.sessionReadScopeKey).toBe("agent:main:selected");
        expect.soft(runParams.sessionKey).not.toBe(runParams.sessionReadScopeKey);
        expect.soft(runParams.config?.messages?.responsePrefix).toBe("committed");
      } finally {
        surface.cleanup();
      }
      return {
        meta: { durationMs: 1, finalAssistantVisibleText: "The selected session is ready." },
      };
    });
    try {
      await state.writeConfig(cfg);
      // Admission must use committed Gateway policy, not the caller's stale config.
      await refreshPreparedModelRuntimeSnapshots(
        { ...cfg, messages: { responsePrefix: "committed" } },
        { gatewayLifecycle: true, catalogMode: "static" },
      );
      await expect(
        companion.ask({
          agentId: "main",
          sessionKey: "agent:main:selected",
          question: "What is it doing?",
          connId: "test-connection",
        }),
      ).resolves.toMatchObject({ answer: "The selected session is ready." });
      const authority = createAdmittedRunOperatorAuthority({
        profileId: "companion-reader",
        scopes: ["operator.read"],
        assertCurrent: () => {},
        modelPolicy: prepareOperatorModelPolicy({
          cfg,
          policy: { sourceAgent: "main", allow: ["test-provider/test-model"] },
          manifestPlugins: [],
        }),
      });
      await expect(
        companion.ask({
          agentId: "main",
          sessionKey: "agent:main:selected",
          question: "What is it doing now?",
          connId: "restricted-connection",
          operatorAuthority: authority,
        }),
      ).resolves.toMatchObject({ answer: "The selected session is ready." });
      const deniedAuthority = createAdmittedRunOperatorAuthority({
        profileId: "companion-reader",
        scopes: ["operator.read"],
        assertCurrent: () => {},
        modelPolicy: prepareOperatorModelPolicy({
          cfg,
          policy: { sourceAgent: "main", allow: [] },
          manifestPlugins: [],
        }),
      });
      await expect(
        companion.ask({
          agentId: "main",
          sessionKey: "agent:main:selected",
          question: "Use another model?",
          connId: "denied-connection",
          operatorAuthority: deniedAuthority,
        }),
      ).rejects.toThrow("Side chat");
      expect(observedModels).toEqual([
        { model: "utility-model", authority: undefined },
        { model: "test-model", authority },
      ]);
      expect(observedTools).toEqual([
        ["read", "sessions_history", "sessions_search"],
        ["read", "sessions_history", "sessions_search"],
      ]);
      expect(cfg.tools?.toolSearch).toEqual({ enabled: true, mode: "directory" });
      expect(cfg.tools?.sessions?.visibility).toBe("all");
      expect(cfg.tools?.fs?.workspaceOnly).toBe(false);
    } finally {
      companion.dispose();
      await resetPreparedModelRuntimeSnapshotsForTest();
      await state.cleanup();
    }
  });
});
