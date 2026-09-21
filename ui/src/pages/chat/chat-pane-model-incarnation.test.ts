/* @vitest-environment jsdom */

import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewaySessionRow, SessionsPatchResult } from "../../api/types.ts";
import type { GatewayRequestHandler } from "../../test-helpers/gateway-client.ts";
import { createMountedPanes, refreshPane } from "./chat-pane-mounted.test-support.ts";
import { switchChatModel, switchChatThinkingLevel } from "./chat-session.ts";
import { getPendingChatPickerPatch } from "./chat-settings-patches.ts";
import { selectedChatSessionRow } from "./chat-state-route.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";

beforeEach(installTranscriptDomMocks);
afterEach(resetTranscriptTestDom);

it.each([false, true])(
  "keeps a queued model switch bound to its observed incarnation (replaced=%s)",
  async (replaced) => {
    const initial = {
      key: "agent:main:model-incarnation",
      agentId: "main",
      sessionId: "model-original-incarnation",
      kind: "direct",
      updatedAt: 1,
      model: "original",
      modelProvider: "fixture",
      thinkingLevel: "low",
    } satisfies GatewaySessionRow;
    const successor = {
      ...initial,
      sessionId: "model-successor-incarnation",
      updatedAt: 3,
      model: "successor",
      thinkingLevel: "off",
    } satisfies GatewaySessionRow;
    const rows: Array<GatewaySessionRow & { sessionId: string }> = [initial];
    const thinkingReply = createDeferred<SessionsPatchResult>();
    const thinkingReceipt = {
      ok: true,
      key: initial.key,
      path: "",
      entry: {
        sessionId: initial.sessionId,
        updatedAt: 2,
        thinkingLevel: "high",
      },
    } satisfies SessionsPatchResult;
    const patch = vi.fn<GatewayRequestHandler>((_method, raw) => {
      const params = asOptionalRecord(raw);
      if (params?.thinkingLevel === "high") {
        return thinkingReply.promise;
      }
      if (params?.model !== "fixture/selected") {
        throw new Error("Unexpected model-incarnation fixture patch");
      }
      const current = rows[0];
      if (!current) {
        throw new Error("Expected a durable model-incarnation fixture row");
      }
      if (
        params.expectedSessionId !== undefined &&
        params.expectedSessionId !== current.sessionId
      ) {
        throw new Error("Session changed before the model patch");
      }
      const committed = {
        ...current,
        updatedAt: 4,
        model: "selected",
        modelProvider: "fixture",
        modelOverrideSource: "user" as const,
      };
      rows[0] = committed;
      return {
        ok: true,
        key: initial.key,
        path: "",
        entry: {
          sessionId: committed.sessionId,
          updatedAt: committed.updatedAt,
          modelOverrideSource: "user",
        },
        resolved: { model: "selected", modelProvider: "fixture" },
      } satisfies SessionsPatchResult;
    });
    const { sessions, mount } = createMountedPanes(rows, "main", undefined, {
      "sessions.patch": patch,
    });
    let thinking: Promise<boolean> | undefined;
    let model: Promise<boolean> | undefined;
    try {
      await sessions.refresh({ agentId: "main", force: true });
      const pane = mount(initial.key);
      await refreshPane(pane);
      expect(selectedChatSessionRow(pane.state)).toMatchObject(initial);
      expect(pane.state.currentSessionId).toBe(initial.sessionId);
      const connection = sessions.captureConnectionScope();
      expect(connection).not.toBeNull();
      const client = pane.state.client;
      const epoch = pane.state.connectionEpoch;

      thinking = switchChatThinkingLevel(pane.state, "high");
      const previousTail = getPendingChatPickerPatch(pane.state, initial.key, "main");
      expect(previousTail).toBeDefined();
      model = switchChatModel(pane.state, "fixture/selected");
      expect(getPendingChatPickerPatch(pane.state, initial.key, "main")).not.toBe(previousTail);
      expect(patch).toHaveBeenCalledOnce();
      expect(patch.mock.calls[0]?.[1]).toMatchObject({
        key: initial.key,
        thinkingLevel: "high",
        expectedSessionId: initial.sessionId,
      });

      // Publish the durable replacement through the real list and pane owners while
      // the first RPC holds the canonical picker tail on the same connection.
      rows[0] = replaced ? successor : { ...initial, thinkingLevel: "high", updatedAt: 2 };
      await sessions.refresh({ agentId: "main", force: true });
      await refreshPane(pane);
      const expectedSessionId = replaced ? successor.sessionId : initial.sessionId;
      expect(selectedChatSessionRow(pane.state)?.sessionId).toBe(expectedSessionId);
      expect(pane.state.currentSessionId).toBe(expectedSessionId);
      expect(pane.state.client).toBe(client);
      expect(pane.state.connectionEpoch).toBe(epoch);
      expect(connection && sessions.isConnectionScopeCurrent(connection)).toBe(true);
      expect(patch).toHaveBeenCalledOnce();

      thinkingReply.resolve(thinkingReceipt);
      await expect(thinking).resolves.toBe(true);
      const switched = await model;
      expect.soft(switched).toBe(!replaced);
      expect.soft(patch).toHaveBeenCalledTimes(replaced ? 1 : 2);
      expect(sessions.state.modelOverrides).toEqual({});
      if (replaced) {
        expect(rows[0]).toEqual(successor);
        expect(selectedChatSessionRow(pane.state)).toMatchObject(successor);
        expect(sessions.state.result?.sessions).toEqual([expect.objectContaining(successor)]);
      } else {
        expect(patch.mock.calls[1]?.[1]).toMatchObject({
          key: initial.key,
          model: "fixture/selected",
          expectedSessionId: initial.sessionId,
        });
        expect(selectedChatSessionRow(pane.state)).toMatchObject({
          sessionId: initial.sessionId,
          model: "selected",
          modelProvider: "fixture",
        });
      }
    } finally {
      thinkingReply.resolve(thinkingReceipt);
      await Promise.allSettled([thinking, model]);
      await vi.dynamicImportSettled();
    }
  },
);
