/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import { sessionsResult } from "../../lib/sessions/session-capability.test-support.ts";
import type { GatewayRequestHandler } from "../../test-helpers/gateway-client.ts";
import { createMountedPanes, refreshPane } from "./chat-pane-mounted.test-support.ts";
import {
  switchChatContextWindow,
  switchChatFastMode,
  switchChatThinkingLevel,
} from "./chat-session.ts";
import { selectedChatSessionRow } from "./chat-state-route.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";

beforeEach(installTranscriptDomMocks);
afterEach(resetTranscriptTestDom);

type Setting = "thinking" | "speed" | "context";
type Choice = "first" | "second";
const settings: Setting[] = ["thinking", "speed", "context"];
const initialRow = (): GatewaySessionRow => ({
  key: "agent:main:settings-ownership",
  agentId: "main",
  sessionId: "settings-ownership-session",
  kind: "direct",
  updatedAt: 1,
  label: "Original label",
  thinkingLevel: "high",
  fastMode: false,
  effectiveFastMode: false,
  contextWindow: "64k",
});

function choiceFields(setting: Setting, choice: Choice): Partial<GatewaySessionRow> {
  if (setting === "thinking") {
    return { thinkingLevel: choice === "first" ? "off" : "low" };
  }
  if (setting === "speed") {
    const fastMode = choice === "first" ? true : "auto";
    return { fastMode, effectiveFastMode: fastMode };
  }
  return { contextWindow: choice === "first" ? "128k" : "256k" };
}

function choose(
  state: Parameters<typeof switchChatThinkingLevel>[0],
  setting: Setting,
  choice: Choice,
) {
  if (setting === "thinking") {
    return switchChatThinkingLevel(state, choice === "first" ? "off" : "low");
  }
  if (setting === "speed") {
    return switchChatFastMode(state, choice === "first" ? "on" : "auto");
  }
  return switchChatContextWindow(state, choice === "first" ? "128k" : "256k");
}

it.each(settings.flatMap((setting) => [false, true].map((removed) => ({ setting, removed }))))(
  "preserves queued settings row presence for $setting (removed=$removed)",
  async ({ setting, removed }) => {
    const initial = initialRow();
    delete initial.sessionId;
    const rows = [initial];
    const firstReply = createDeferred<unknown>();
    const patch = vi.fn<GatewayRequestHandler>(() => {
      if (patch.mock.calls.length === 1) {
        return firstReply.promise;
      }
      rows[0] = { ...initial, ...choiceFields(setting, "second"), updatedAt: 4 };
      return { ok: true, key: initial.key, path: "", entry: rows[0] };
    });
    const { sessions, mount } = createMountedPanes(rows, "main", undefined, {
      "sessions.patch": patch,
    });
    let first: Promise<boolean> | undefined;
    let queued: Promise<boolean> | undefined;
    try {
      await sessions.refresh({ agentId: "main", force: true });
      const pane = mount(initial.key);
      await refreshPane(pane);
      expect(selectedChatSessionRow(pane.state)).toMatchObject(initial);
      expect(selectedChatSessionRow(pane.state)?.sessionId).toBeUndefined();
      first = choose(pane.state, setting, "first");
      queued = choose(pane.state, setting, "second");
      expect(patch).toHaveBeenCalledOnce();

      if (removed) {
        rows.length = 0;
      }
      await sessions.refresh({ agentId: "main", force: true });
      expect(sessions.state.result?.sessions).toEqual(
        removed ? [] : [expect.objectContaining(initial)],
      );
      expect(selectedChatSessionRow(pane.state)?.key).toBe(removed ? undefined : initial.key);
      const confirmed = { ...initial, ...choiceFields(setting, "first"), updatedAt: 2 };
      if (!removed) {
        rows[0] = confirmed;
      }
      firstReply.resolve({ ok: true, key: initial.key, path: "", entry: confirmed });
      await expect(first).resolves.toBe(true);
      const completed = await queued;
      expect.soft(completed).toBe(!removed);
      expect(patch).toHaveBeenCalledTimes(removed ? 1 : 2);
      expect(sessions.state.result?.sessions).toEqual(
        removed
          ? []
          : [
              expect.objectContaining({
                ...initial,
                ...choiceFields(setting, "second"),
                updatedAt: 4,
              }),
            ],
      );
    } finally {
      firstReply.resolve({ ok: true, key: initial.key, path: "", entry: initial });
      await Promise.allSettled([first, queued]);
      await vi.dynamicImportSettled();
    }
  },
);

it.each(["rejected", "confirmed"] as const)(
  "preserves an initially empty thinking capture through %s readback",
  async (outcome) => {
    const key = "agent:main:initially-empty-thinking";
    const rows: GatewaySessionRow[] = [];
    const reply = createDeferred<unknown>();
    const patch = vi.fn<GatewayRequestHandler>(() => reply.promise);
    const { sessions, mount } = createMountedPanes(rows, "main", undefined, {
      "sessions.patch": patch,
    });
    let operation: Promise<boolean> | undefined;
    try {
      await sessions.refresh({ agentId: "main", force: true });
      const pane = mount(key);
      await refreshPane(pane);
      expect(selectedChatSessionRow(pane.state)).toBeUndefined();
      pane.state.chatThinkingLevel = "high";
      operation = switchChatThinkingLevel(pane.state, "low");
      expect(patch).toHaveBeenCalledOnce();

      const canonical: GatewaySessionRow = {
        key,
        agentId: "main",
        kind: "direct",
        updatedAt: 3,
        thinkingLevel: "off",
      };
      rows.push(canonical);
      await sessions.refresh({ agentId: "main", force: true });
      expect(selectedChatSessionRow(pane.state)).toMatchObject(canonical);
      expect(selectedChatSessionRow(pane.state)?.sessionId).toBeUndefined();
      pane.state.chatThinkingLevel = "medium";
      if (outcome === "rejected") {
        reply.reject(new Error("Synthetic failure of the initially empty target"));
      } else {
        reply.resolve({
          ok: true,
          key,
          path: "",
          entry: { ...canonical, updatedAt: 2, thinkingLevel: "medium" },
        });
      }
      await expect(operation).resolves.toBe(outcome === "confirmed");
      expect(pane.state.chatThinkingLevel).toBe(outcome === "confirmed" ? "off" : "medium");
      expect(selectedChatSessionRow(pane.state)).toMatchObject(canonical);
    } finally {
      reply.resolve({ ok: true, key, path: "", entry: rows[0] });
      await operation;
      await vi.dynamicImportSettled();
    }
  },
);

it.each(settings)(
  "does not dispatch an initially ID-less queued %s patch against an identified successor",
  async (setting) => {
    const initial: GatewaySessionRow = { ...initialRow(), sessionId: undefined };
    const successor = { ...initial, sessionId: "identified-successor", updatedAt: 3 };
    const rows = [initial];
    const firstReply = createDeferred<unknown>();
    const patch = vi.fn<GatewayRequestHandler>(() => {
      if (patch.mock.calls.length === 1) {
        return firstReply.promise;
      }
      rows[0] = { ...successor, ...choiceFields(setting, "second"), updatedAt: 4 };
      return { ok: true, key: initial.key, path: "", entry: rows[0] };
    });
    const { sessions, mount } = createMountedPanes(rows, "main", undefined, {
      "sessions.patch": patch,
    });
    let first: Promise<boolean> | undefined;
    let queued: Promise<boolean> | undefined;
    try {
      await sessions.refresh({ agentId: "main", force: true });
      const pane = mount(initial.key);
      await refreshPane(pane);
      expect(selectedChatSessionRow(pane.state)?.sessionId).toBeUndefined();
      first = choose(pane.state, setting, "first");
      queued = choose(pane.state, setting, "second");
      expect(patch).toHaveBeenCalledOnce();
      expect(patch.mock.calls[0]?.[1]).not.toEqual(
        expect.objectContaining({ expectedSessionId: expect.any(String) }),
      );

      rows[0] = successor;
      await sessions.refresh({ agentId: "main", force: true });
      await refreshPane(pane);
      expect(pane.state.currentSessionId).toBe(successor.sessionId);
      firstReply.resolve({
        ok: true,
        key: initial.key,
        path: "",
        entry: { ...initial, ...choiceFields(setting, "first"), updatedAt: 2 },
      });
      await expect(first).resolves.toBe(true);
      await expect(queued).resolves.toBe(false);
      expect(patch).toHaveBeenCalledOnce();
      expect(selectedChatSessionRow(pane.state)).toMatchObject(successor);
      expect(sessions.state.result?.sessions).toEqual([expect.objectContaining(successor)]);
    } finally {
      firstReply.resolve({ ok: true, key: initial.key, path: "", entry: initial });
      await Promise.allSettled([first, queued]);
      await vi.dynamicImportSettled();
    }
  },
);

it.each(settings)(
  "keeps an initially ID-less in-flight %s rejection out of its successor's errors",
  async (setting) => {
    const initial: GatewaySessionRow = { ...initialRow(), sessionId: undefined };
    const successor = { ...initial, sessionId: "identified-successor", updatedAt: 3 };
    const rows = [initial];
    const reply = createDeferred<unknown>();
    const patch = vi.fn<GatewayRequestHandler>(() => reply.promise);
    const { sessions, mount } = createMountedPanes(rows, "main", undefined, {
      "sessions.patch": patch,
    });
    let operation: Promise<boolean> | undefined;
    try {
      await sessions.refresh({ agentId: "main", force: true });
      const pane = mount(initial.key);
      await refreshPane(pane);
      expect(selectedChatSessionRow(pane.state)?.sessionId).toBeUndefined();
      operation = choose(pane.state, setting, "first");
      expect(patch).toHaveBeenCalledOnce();

      rows[0] = successor;
      await sessions.refresh({ agentId: "main", force: true });
      await refreshPane(pane);
      expect(pane.state.currentSessionId).toBe(successor.sessionId);
      pane.state.chatError = "A successor warning";
      pane.state.lastError = "A successor warning";
      const sharedError = sessions.state.error;
      reply.reject(new Error("Synthetic rejection for the previous unbound target"));
      await expect(operation).resolves.toBe(false);
      expect.soft(pane.state.chatError).toBe("A successor warning");
      expect.soft(pane.state.lastError).toBe("A successor warning");
      expect(sessions.state.error).toBe(sharedError);
      expect(selectedChatSessionRow(pane.state)).toMatchObject(successor);
      expect(patch).toHaveBeenCalledOnce();
    } finally {
      reply.resolve({ ok: true, key: initial.key, path: "", entry: initial });
      await operation;
      await vi.dynamicImportSettled();
    }
  },
);

it.each(
  settings.flatMap((setting) =>
    (["rejected", "confirmed"] as const).map((outcome) => ({ setting, outcome })),
  ),
)(
  "preserves the second pane's pending $setting intent when the first pane is $outcome",
  async ({ setting, outcome }) => {
    const initial = initialRow();
    const rows = [initial];
    const firstReply = createDeferred<unknown>();
    const secondReply = createDeferred<unknown>();
    const secondDispatched = createDeferred();
    let calls = 0;
    const patch = vi.fn<GatewayRequestHandler>(() => {
      calls += 1;
      if (calls === 1) {
        return firstReply.promise;
      }
      expect(calls).toBe(2);
      secondDispatched.resolve();
      return secondReply.promise;
    });
    const { sessions, mount } = createMountedPanes(rows, "main", undefined, {
      "sessions.patch": patch,
    });
    let first: Promise<boolean> | undefined;
    let second: Promise<boolean> | undefined;
    let secondSettled = false;
    try {
      await sessions.refresh({ agentId: "main", force: true });
      const panes = [mount(initial.key), mount(initial.key)];
      await Promise.all(panes.map(refreshPane));
      const assertFields = (fields: Partial<GatewaySessionRow>) => {
        const expected = { key: initial.key, sessionId: initial.sessionId, ...fields };
        expect(sessions.state.result?.sessions).toEqual([expect.objectContaining(expected)]);
        for (const pane of panes) {
          expect(pane.state.currentSessionId).toBe(initial.sessionId);
          expect(selectedChatSessionRow(pane.state)).toMatchObject(expected);
        }
      };
      assertFields(initial);
      first = choose(panes[0]!.state, setting, "first");
      expect(patch).toHaveBeenCalledOnce();
      assertFields(choiceFields(setting, "first"));
      second = choose(panes[1]!.state, setting, "second");
      void second.then(
        () => {
          secondSettled = true;
        },
        () => {
          secondSettled = true;
        },
      );
      expect(patch).toHaveBeenCalledOnce();
      assertFields(choiceFields(setting, "second"));

      if (outcome === "confirmed") {
        rows[0] = { ...initial, ...choiceFields(setting, "first"), updatedAt: 2 };
        firstReply.resolve({ ok: true, key: initial.key, path: "", entry: rows[0] });
      } else {
        firstReply.reject(new Error("Synthetic first-pane settings rejection"));
      }
      await expect(first).resolves.toBe(outcome === "confirmed");
      await Promise.race([secondDispatched.promise, second]);
      expect(patch).toHaveBeenCalledTimes(2);
      expect(secondSettled).toBe(false);
      assertFields(choiceFields(setting, "second"));

      rows[0] = { ...initial, ...choiceFields(setting, "second"), updatedAt: 4 };
      secondReply.resolve({ ok: true, key: initial.key, path: "", entry: rows[0] });
      await expect(second).resolves.toBe(true);
      assertFields(choiceFields(setting, "second"));
    } finally {
      firstReply.resolve({ ok: true, key: initial.key, path: "", entry: rows[0] });
      secondReply.resolve({ ok: true, key: initial.key, path: "", entry: rows[0] });
      await Promise.allSettled([first, second]);
      await vi.dynamicImportSettled();
    }
  },
);

it.each(settings)(
  "rolls rejected %s back while preserving an authoritative update to another field",
  async (setting) => {
    const initial = initialRow();
    const rows = [initial];
    const acknowledgement = createDeferred<unknown>();
    const patch = vi.fn<GatewayRequestHandler>(() => acknowledgement.promise);
    const { sessions, mount, emitGatewayEvent } = createMountedPanes(rows, "main", undefined, {
      "sessions.patch": patch,
    });
    let operation: Promise<boolean> | undefined;
    try {
      await sessions.refresh({ agentId: "main", force: true });
      const panes = [mount(initial.key), mount(initial.key)];
      await Promise.all(panes.map(refreshPane));
      const assertRows = (fields: Partial<GatewaySessionRow>) => {
        const expected = { key: initial.key, sessionId: initial.sessionId, ...fields };
        expect(sessions.state.result?.sessions).toEqual([expect.objectContaining(expected)]);
        for (const pane of panes) {
          expect(pane.state.currentSessionId).toBe(initial.sessionId);
          expect(selectedChatSessionRow(pane.state)).toMatchObject(expected);
        }
      };
      assertRows(initial);
      operation = choose(panes[0]!.state, setting, "first");
      expect(patch).toHaveBeenCalledOnce();
      assertRows(choiceFields(setting, "first"));
      const label = "Authoritative label while settings are pending";
      rows[0] = { ...initial, updatedAt: 3, label };
      emitGatewayEvent("sessions.changed", {
        sessionKey: initial.key,
        agentId: "main",
        sessionId: initial.sessionId,
        reason: "label",
        updatedAt: 3,
        label,
      });
      assertRows({ ...choiceFields(setting, "first"), label });
      acknowledgement.reject(new Error("Synthetic rejected settings after label update"));
      await expect(operation).resolves.toBe(false);
      assertRows({ ...initial, updatedAt: 3, label });
    } finally {
      acknowledgement.resolve({ ok: true, key: initial.key, path: "", entry: rows[0] });
      await operation;
      await vi.dynamicImportSettled();
    }
  },
);

it.each(
  settings.flatMap((setting) =>
    (["rejected", "older-clock ACK", "equal-clock ACK"] as const).map((outcome) => ({
      setting,
      outcome,
    })),
  ),
)(
  "retains settled $setting facts after an older direct capability patch returns $outcome",
  async ({ setting, outcome }) => {
    const initial = initialRow();
    const firstFields =
      setting === "thinking"
        ? { thinkingLevel: "off" }
        : setting === "speed"
          ? { fastMode: true }
          : { contextWindow: "128k" };
    const secondFields =
      setting === "thinking"
        ? { thinkingLevel: "low" }
        : setting === "speed"
          ? { fastMode: "auto" as const }
          : { contextWindow: "256k" };
    const firstReply = createDeferred<unknown>();
    const secondReply = createDeferred<unknown>();
    const firstAcknowledgement = {
      ok: true,
      key: initial.key,
      path: "",
      entry: {
        sessionId: initial.sessionId,
        updatedAt: outcome === "equal-clock ACK" ? 3 : 2,
        ...firstFields,
      },
    };
    const secondAcknowledgement = {
      ok: true,
      key: initial.key,
      path: "",
      entry: { sessionId: initial.sessionId, updatedAt: 3, ...secondFields },
    };
    let calls = 0;
    const patch = vi.fn<GatewayRequestHandler>(() => {
      calls += 1;
      if (calls === 1) {
        return firstReply.promise;
      }
      expect(calls).toBe(2);
      return secondReply.promise;
    });
    const { sessions, mount } = createMountedPanes([initial], "main", undefined, {
      "sessions.patch": patch,
    });
    let first: ReturnType<typeof sessions.patch> | undefined;
    let second: ReturnType<typeof sessions.patch> | undefined;
    let firstSettled = false;
    try {
      await sessions.refresh({ agentId: "main", force: true });
      const panes = [mount(initial.key), mount(initial.key)];
      await Promise.all(panes.map(refreshPane));
      const assertFields = (fields: Partial<GatewaySessionRow>) => {
        const expected = { key: initial.key, sessionId: initial.sessionId, ...fields };
        expect(sessions.state.result?.sessions).toEqual([expect.objectContaining(expected)]);
        for (const pane of panes) {
          expect(pane.state.currentSessionId).toBe(initial.sessionId);
          expect(selectedChatSessionRow(pane.state)).toMatchObject(expected);
        }
      };
      assertFields(initial);
      const options = {
        agentId: "main",
        expectedSessionId: initial.sessionId,
        deferListRefresh: true,
      };
      // Direct capability callers can overlap; chat pickers serialize their RPCs separately.
      first = sessions.patch(initial.key, firstFields, options);
      const firstOutcome = Promise.allSettled([first]).then((results) => {
        firstSettled = true;
        return results;
      });
      assertFields(firstFields);
      second = sessions.patch(initial.key, secondFields, options);
      expect(patch).toHaveBeenCalledTimes(2);
      assertFields(secondFields);

      secondReply.resolve(secondAcknowledgement);
      await expect(second).resolves.toMatchObject(secondAcknowledgement);
      expect(firstSettled).toBe(false);
      assertFields(secondFields);

      const rejection = new Error("Synthetic late rejection after successor settled");
      if (outcome === "rejected") {
        firstReply.reject(rejection);
      } else {
        firstReply.resolve(firstAcknowledgement);
      }
      const [settled] = await firstOutcome;
      if (outcome === "rejected") {
        expect(settled).toEqual({ status: "rejected", reason: rejection });
      } else {
        expect(settled).toMatchObject({ status: "fulfilled", value: firstAcknowledgement });
      }
      assertFields(secondFields);
      expect(patch).toHaveBeenCalledTimes(2);
    } finally {
      firstReply.resolve(firstAcknowledgement);
      secondReply.resolve(secondAcknowledgement);
      await Promise.allSettled([first, second]);
      await vi.dynamicImportSettled();
    }
  },
);

it.each([
  { read: "deferred", overlap: false, observeEffective: false },
  { read: "failed", overlap: false, observeEffective: false },
  { read: "deferred", overlap: true, observeEffective: false },
  { read: "failed", overlap: true, observeEffective: false },
  { read: "deferred", overlap: true, observeEffective: true },
  { read: "fresh", overlap: true, observeEffective: false },
] as const)(
  "settles only admitted effective speed ($read read, overlap=$overlap, event=$observeEffective)",
  async ({ read, overlap, observeEffective }) => {
    const initial = initialRow();
    const firstReply = createDeferred<unknown>();
    const secondReply = createDeferred<unknown>();
    let calls = 0;
    let acknowledged = false;
    let postAckReads = 0;
    let committed = initial;
    const patch = vi.fn<GatewayRequestHandler>(() => {
      calls += 1;
      if (calls === 1) {
        return firstReply.promise;
      }
      expect(calls).toBe(2);
      return secondReply.promise;
    });
    const { sessions, mount, emitGatewayEvent } = createMountedPanes([initial], "main", undefined, {
      "sessions.patch": patch,
      "sessions.list": () => {
        if (!acknowledged) {
          return sessionsResult([initial], 1);
        }
        postAckReads += 1;
        if (read === "failed") {
          throw new Error("Synthetic unavailable effective-speed readback");
        }
        return sessionsResult(
          read === "fresh"
            ? [{ ...committed, updatedAt: (committed.updatedAt ?? 0) + 1, effectiveFastMode: true }]
            : [initial],
          (committed.updatedAt ?? 0) + 1,
        );
      },
    });
    let first: ReturnType<typeof sessions.patch> | undefined;
    let second: ReturnType<typeof sessions.patch> | undefined;
    try {
      await sessions.refresh({ agentId: "main", force: true });
      const panes = [mount(initial.key), mount(initial.key)];
      await Promise.all(panes.map(refreshPane));
      const assertModes = (
        fastMode: GatewaySessionRow["fastMode"],
        effectiveFastMode: GatewaySessionRow["effectiveFastMode"],
      ) => {
        const expected = { sessionId: initial.sessionId, fastMode, effectiveFastMode };
        expect(sessions.state.result?.sessions).toEqual([expect.objectContaining(expected)]);
        for (const pane of panes) {
          expect(pane.state.currentSessionId).toBe(initial.sessionId);
          expect(selectedChatSessionRow(pane.state)).toMatchObject(expected);
        }
      };
      const options = { agentId: "main", deferListRefresh: read === "deferred" };
      first = sessions.patch(initial.key, { fastMode: true }, options);
      expect(patch).toHaveBeenCalledOnce();
      assertModes(true, true);
      if (observeEffective) {
        emitGatewayEvent("sessions.changed", {
          sessionKey: initial.key,
          agentId: "main",
          sessionId: initial.sessionId,
          reason: "patch",
          session: { ...initial, updatedAt: 2, fastMode: true, effectiveFastMode: true },
        });
        expect(sessions.state.result?.sessions[0]?.updatedAt).toBe(2);
      }
      if (overlap) {
        second = sessions.patch(initial.key, { fastMode: "auto" }, options);
        expect(patch).toHaveBeenCalledTimes(2);
        assertModes("auto", "auto");
      }

      committed = { ...initial, updatedAt: 3, fastMode: true };
      acknowledged = true;
      firstReply.resolve({
        ok: true,
        key: initial.key,
        path: "",
        entry: { sessionId: initial.sessionId, updatedAt: 3, fastMode: true },
      });
      await expect(first).resolves.toMatchObject({ entry: { fastMode: true } });
      if (overlap) {
        assertModes("auto", "auto");
        committed = { ...initial, updatedAt: 5, fastMode: "auto" };
        secondReply.resolve({
          ok: true,
          key: initial.key,
          path: "",
          entry: { sessionId: initial.sessionId, updatedAt: 5, fastMode: "auto" },
        });
        await expect(second).resolves.toMatchObject({ entry: { fastMode: "auto" } });
      }
      if (read === "deferred") {
        expect(postAckReads).toBe(0);
      } else {
        expect(postAckReads).toBeGreaterThan(0);
      }
      assertModes(overlap ? "auto" : true, observeEffective || read === "fresh");
    } finally {
      firstReply.resolve({
        ok: true,
        key: initial.key,
        path: "",
        entry: { sessionId: initial.sessionId, updatedAt: 3, fastMode: true },
      });
      secondReply.resolve({
        ok: true,
        key: initial.key,
        path: "",
        entry: { sessionId: initial.sessionId, updatedAt: 5, fastMode: "auto" },
      });
      await Promise.allSettled([first, second]);
      await vi.dynamicImportSettled();
    }
  },
);
