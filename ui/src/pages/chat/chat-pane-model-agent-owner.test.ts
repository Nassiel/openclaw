/* @vitest-environment jsdom */

import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { render } from "lit";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { sessionsResult } from "../../lib/sessions/session-capability.test-support.ts";
import type { GatewayRequestHandler } from "../../test-helpers/gateway-client.ts";
import { createMountedPanes, refreshPane } from "./chat-pane-mounted.test-support.ts";
import {
  readChatPaneMutationAccess,
  renderChatPaneComposerControls,
} from "./chat-pane-session-controls.ts";
import { selectedChatSessionRow } from "./chat-state-route.ts";
import * as modelControls from "./components/chat-model-controls.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";

beforeEach(installTranscriptDomMocks);
afterEach(resetTranscriptTestDom);

it.each([false, true])(
  "does not borrow the prior global agent's model target (foreign lock=%s)",
  async (modelSelectionLocked) => {
    const foreign: GatewaySessionRow = {
      key: "global",
      agentId: "main",
      sessionId: "foreign-main-session",
      kind: "global",
      updatedAt: 1,
      model: "original",
      modelProvider: "fixture",
      modelSelectionLocked,
    };
    const created: GatewaySessionRow = {
      key: "global",
      agentId: "research",
      sessionId: "selected-research-session",
      kind: "global",
      updatedAt: 2,
      model: "selected",
      modelProvider: "fixture",
      modelOverrideSource: "user",
    };
    const rows = [foreign];
    const researchList = createDeferred<SessionsListResult>();
    const researchListStarted = createDeferred();
    const patch = vi.fn<GatewayRequestHandler>((_method, raw) => {
      expect(raw).toMatchObject({ key: "global", agentId: "research", model: "fixture/selected" });
      expect.soft(raw).not.toHaveProperty("expectedSessionId");
      rows.push(created);
      return {
        ok: true,
        key: "global",
        path: "",
        entry: { sessionId: created.sessionId, updatedAt: 2 },
        resolved: { model: "selected", modelProvider: "fixture" },
      };
    });
    const { sessions, mount, context } = createMountedPanes(rows, "main", undefined, {
      "sessions.list": (_method, raw) => {
        if (asOptionalRecord(raw)?.agentId === "research") {
          researchListStarted.resolve();
          return researchList.promise;
        }
        return sessionsResult([foreign], 1);
      },
      "sessions.patch": patch,
    });
    let operation: Promise<unknown> | undefined;
    const rendered = vi.spyOn(modelControls, "renderChatModelControls");
    try {
      await sessions.refresh({ agentId: "main", force: true });
      const pane = mount("global");
      await refreshPane(pane);
      expect(selectedChatSessionRow(pane.state)).toMatchObject(foreign);
      // Real application agent selection retires main's pane bindings while the
      // newly selected agent's authoritative list request remains held.
      Object.assign(pane, { agentId: undefined });
      context.agentSelection.set("research");
      await researchListStarted.promise;
      await refreshPane(pane);
      expect(pane.state.assistantAgentId).toBe("research");
      expect(pane.state.sessionsResult?.sessions).toContainEqual(expect.objectContaining(foreign));
      expect(selectedChatSessionRow(pane.state)).toBeUndefined();
      pane.state.chatModelCatalog = [
        { id: "original", name: "Original", provider: "fixture" },
        { id: "selected", name: "Selected", provider: "fixture" },
      ];
      const access = readChatPaneMutationAccess(context.gateway.snapshot, "global");
      expect(access.model.allowed).toBe(true);
      const controls = renderChatPaneComposerControls({
        state: pane.state,
        selectedSession: selectedChatSessionRow(pane.state),
        agentDefaultModel: "fixture/original",
        modelAccess: access.model,
        effortAccess: access.effort,
        contextWindowAccess: access.contextWindow,
        permissionAccess: access.permission,
        canSelectFull: false,
        onModelSetup: vi.fn(),
      });
      const container = document.createElement("div");
      render(controls.composerControls, container);
      expect(
        container.querySelector("[data-chat-model-select]")?.getAttribute("aria-disabled"),
      ).toBe("false");
      const props = rendered.mock.calls.at(-1)?.[0];
      if (!props?.onModelSelect) {
        throw new Error("Expected live model callback");
      }
      operation = Promise.resolve(props.onModelSelect("fixture/selected", "global"));
      expect.soft(patch).toHaveBeenCalledOnce();
      researchList.resolve(sessionsResult([created], 2));
      await expect(operation).resolves.toBe(true);
      expect(foreign.sessionId).toBe("foreign-main-session");
      expect(selectedChatSessionRow(pane.state)).toMatchObject(created);
    } finally {
      researchList.resolve(
        sessionsResult(
          rows.filter((row) => row.agentId === "research"),
          2,
        ),
      );
      await operation;
      await vi.dynamicImportSettled();
    }
  },
);
