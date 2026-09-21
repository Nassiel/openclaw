import { describe, expect, it, vi } from "vitest";
import {
  appendTranscriptMessageSync,
  loadTranscriptEventsSync,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { onAgentEvent } from "../infra/agent-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { registerChatAbortController, type ChatAbortControllerEntry } from "./chat-abort.js";
import {
  completeQueuedChatTurn,
  registerQueuedChatTurn,
  retireQueuedChatTurnCancellation,
  type QueuedChatTurnEntry,
} from "./chat-queued-turns.js";
import { bindGatewayOperatorRunCancellation } from "./operator-run-cancellation.js";
import { createChatRunState } from "./server-chat-state.js";
import { createChatSendWorkAdmission } from "./server-methods/chat-send-work-admission.js";

async function withCancellationFixture(
  run: (fixture: Awaited<ReturnType<typeof createCancellationFixture>>) => Promise<void>,
): Promise<void> {
  await withOpenClawTestState({ label: "operator-run-cancellation" }, async (state) => {
    const cfg: OpenClawConfig = {
      agents: { defaults: { workspace: state.workspaceDir }, entries: { main: {} } },
    };
    await state.writeConfig(cfg);
    const fixture = await createCancellationFixture(cfg);
    try {
      await run(fixture);
    } finally {
      fixture.release();
      await fixture.execution.drain();
      fixture.cleanup();
    }
  });
}

async function createCancellationFixture(cfg: OpenClawConfig) {
  const scope = {
    agentId: "main",
    sessionId: "guest-and-staff-session",
    sessionKey: "agent:main:guest-and-staff",
  };
  await replaceSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: 1 });
  const savedInput = { role: "user", content: [{ type: "text", text: "Saved work stays here." }] };
  expect(
    appendTranscriptMessageSync(scope, { eventId: "saved-input", message: savedInput }),
  ).toMatchObject({ ok: true });
  const chatRunState = createChatRunState();
  const execution = new AsyncWorkScope();
  const logGateway = createSubsystemLogger("test/operator-run-cancellation");
  const warn = vi.spyOn(logGateway, "warn").mockImplementation(() => {});
  const context: Parameters<typeof bindGatewayOperatorRunCancellation>[0]["context"] = {
    chatAbortControllers: new Map<string, ChatAbortControllerEntry>(),
    chatQueuedTurns: new Map<string, QueuedChatTurnEntry>(),
    chatRunState,
    agentRunSeq: new Map(),
    broadcast: vi.fn(),
    nodeSendToSession: vi.fn(),
    removeChatRun: (sessionId, runId, sessionKey) =>
      chatRunState.registry.remove(sessionId, runId, sessionKey),
    cancelRunBoundApprovals: vi.fn(() => 0),
    getRuntimeConfig: () => cfg,
    trackExecution: (work) => execution.track(work),
    logGateway,
  };
  const registrations: Array<ReturnType<typeof registerChatAbortController>> = [];
  const releases: Array<() => void> = [];
  const register = (
    runId: string,
    projection: Pick<
      Parameters<typeof registerChatAbortController>[0],
      "controlUiVisible" | "projectSessionActive"
    > = {},
  ) => {
    const registration = registerChatAbortController({
      chatAbortControllers: context.chatAbortControllers,
      ...scope,
      runId,
      timeoutMs: 60_000,
      ownerConnId: "same-person-connection",
      ...projection,
    });
    if (!registration.registered) {
      throw new Error("fixture run was not registered");
    }
    registrations.push(registration);
    return registration;
  };
  const bind = (signal: AbortSignal, runId: string, entry: ChatAbortControllerEntry) => {
    const release = bindGatewayOperatorRunCancellation({ signal, runId, entry, context });
    releases.push(release);
    return release;
  };
  return {
    scope,
    context,
    execution,
    settle: () =>
      AsyncWorkScope.runWhenAllIdle(
        () => [execution],
        () => {},
      ),
    warn,
    register,
    bind,
    release: () => {
      for (const release of releases) {
        release();
      }
    },
    cleanup: () => {
      for (const registration of registrations) {
        registration.cleanup();
      }
      for (const [runId, entry] of context.chatQueuedTurns) {
        completeQueuedChatTurn(context.chatQueuedTurns, runId, entry.controller);
      }
      chatRunState.clear();
      warn.mockRestore();
    },
  };
}

describe("operator access cancellation", () => {
  it.each([false, true])(
    "stops only its run and settles persistence (hidden progress refresh: %s)",
    async (hiddenRefresh) => {
      await withCancellationFixture(async (f) => {
        const source = new AbortController();
        const guest = f.register(
          "guest-run",
          hiddenRefresh ? { controlUiVisible: false, projectSessionActive: false } : {},
        );
        const staff = f.register("staff-run");
        const savedTranscript = loadTranscriptEventsSync(f.scope);
        f.context.chatRunState.getOrCreate("guest-run").buffer = "The guest's saved progress.";
        f.context.chatRunState.getOrCreate("staff-run").buffer = "Staff work continues.";
        f.bind(source.signal, "guest-run", guest.entry);
        const terminalWrite = createDeferredCore();
        const cancellationObserved = createDeferredCore();
        let sourceClosedAtAbort = false;
        const unsubscribe = onAgentEvent((event) => {
          if (event.runId !== "guest-run" || event.stream !== "lifecycle") {
            return;
          }
          sourceClosedAtAbort = source.signal.aborted;
          guest.entry.projectSessionTerminalObservedAt = Date.now();
          guest.entry.projectSessionTerminalPersistence = terminalWrite.promise.then(() => {
            guest.entry.projectSessionTerminalPending = false;
          });
          cancellationObserved.resolve();
        });
        let drain: Promise<void> | undefined;
        try {
          source.abort();
          await Promise.race([
            cancellationObserved.promise,
            f.settle().then(() => {
              throw new Error("cancellation finished without aborting its registered run");
            }),
          ]);
          let drained = false;
          drain = f.settle().then(() => {
            drained = true;
          });
          await Promise.resolve();
          expect(drained).toBe(false);
          expect(sourceClosedAtAbort).toBe(true);
          expect(guest.controller.signal.aborted).toBe(true);
          expect(staff.controller.signal.aborted).toBe(false);
          terminalWrite.resolve();
          await drain;
          expect(f.context.chatRunState.resolveBuffer("staff-run").text).toBe(
            "Staff work continues.",
          );
          if (hiddenRefresh) {
            expect(loadTranscriptEventsSync(f.scope)).toEqual(savedTranscript);
            expect(f.context.broadcast).not.toHaveBeenCalled();
            expect(f.context.nodeSendToSession).not.toHaveBeenCalled();
          } else {
            expect(loadTranscriptEventsSync(f.scope)).toEqual(
              expect.arrayContaining([
                ...savedTranscript,
                expect.objectContaining({
                  message: expect.objectContaining({
                    role: "assistant",
                    content: [{ type: "text", text: "The guest's saved progress." }],
                  }),
                }),
              ]),
            );
          }
          expect(f.warn).not.toHaveBeenCalled();
        } finally {
          terminalWrite.resolve();
          unsubscribe();
          await drain;
        }
      });
    },
  );

  it.each(["persisting", "persisted"] as const)(
    "preserves an accepted terminal result while %s",
    async (phase) => {
      await withCancellationFixture(async (f) => {
        const source = new AbortController();
        const guest = f.register("terminal-run");
        const savedTranscript = loadTranscriptEventsSync(f.scope);
        const acceptedMessage = {
          role: "assistant",
          content: [{ type: "text", text: "The already accepted result." }],
        };
        f.context.chatRunState.getOrCreate("terminal-run").buffer = "The already accepted result.";
        const terminalWrite = createDeferredCore();
        guest.entry.projectSessionActive = false;
        guest.entry.projectSessionTerminalPending = true;
        guest.entry.projectSessionTerminalObservedAt = Date.now();
        const persistence = terminalWrite.promise.then(() => {
          expect(
            appendTranscriptMessageSync(f.scope, {
              eventId: "accepted-result",
              message: acceptedMessage,
            }),
          ).toMatchObject({ ok: true });
          guest.entry.projectSessionTerminalPending = false;
          guest.entry.projectSessionTerminalPersistence = undefined;
          guest.entry.projectSessionTerminalPersisted = true;
        });
        guest.entry.projectSessionTerminalPersistence = persistence;
        f.bind(source.signal, "terminal-run", guest.entry);
        try {
          if (phase === "persisted") {
            terminalWrite.resolve();
            await persistence;
          }
          source.abort();
          await f.settle();
          expect(guest.controller.signal.aborted).toBe(false);
          expect(f.context.chatAbortControllers.get("terminal-run")).toBe(guest.entry);
          expect(f.context.chatRunState.resolveBuffer("terminal-run").text).toBe(
            "The already accepted result.",
          );
          expect(f.context.broadcast).not.toHaveBeenCalled();
          terminalWrite.resolve();
          await persistence;
          expect(loadTranscriptEventsSync(f.scope)).toEqual([
            ...savedTranscript,
            expect.objectContaining({
              id: "accepted-result",
              message: expect.objectContaining(acceptedMessage),
            }),
          ]);
          expect(f.warn).not.toHaveBeenCalled();
        } finally {
          terminalWrite.resolve();
          await persistence;
        }
      });
    },
  );

  it.each([false, true])(
    "retains queued custody and respects collect transfer=%s",
    async (collect) => {
      await withCancellationFixture(async (f) => {
        const source = new AbortController();
        const guest = f.register("queued-guest");
        const staff = f.register("queued-staff");
        const work = createChatSendWorkAdmission({
          admission: { release: () => {} },
          releaseCallerAuthority: f.bind(source.signal, "queued-guest", guest.entry),
          logGateway: f.context.logGateway,
        });
        const releaseQueue = work.retain();
        for (const [runId, registration] of [
          ["queued-guest", guest],
          ["queued-staff", staff],
        ] as const) {
          expect(
            registerQueuedChatTurn({
              chatQueuedTurns: f.context.chatQueuedTurns,
              ...f.scope,
              runId,
              controller: registration.controller,
            }),
          ).toBe(true);
          registration.cleanup();
        }
        work.release();
        if (collect) {
          retireQueuedChatTurnCancellation(
            f.context.chatQueuedTurns,
            "queued-guest",
            guest.controller,
          );
        }
        try {
          source.abort();
          await f.settle();
          expect(guest.controller.signal.aborted).toBe(!collect);
          expect(f.context.chatQueuedTurns.has("queued-guest")).toBe(collect);
          expect(staff.controller.signal.aborted).toBe(false);
          expect(f.context.chatQueuedTurns.has("queued-staff")).toBe(true);
        } finally {
          releaseQueue();
        }
      });
    },
  );

  it("does not retire a replacement that reuses a completed run ID", async () => {
    await withCancellationFixture(async (f) => {
      const source = new AbortController();
      const original = f.register("reused-run");
      f.bind(source.signal, "reused-run", original.entry);
      original.cleanup();
      const replacement = f.register("reused-run");
      source.abort();
      await f.settle();
      expect(replacement.controller.signal.aborted).toBe(false);
      expect(f.context.chatAbortControllers.get("reused-run")).toBe(replacement.entry);
      expect(f.context.broadcast).not.toHaveBeenCalled();
    });
  });

  it.each(["released", "already-aborted"] as const)(
    "handles a %s source at binding",
    async (state) => {
      await withCancellationFixture(async (f) => {
        const source = new AbortController();
        const guest = f.register("bound-run");
        if (state === "already-aborted") {
          source.abort();
        }
        const release = f.bind(source.signal, "bound-run", guest.entry);
        if (state === "released") {
          release();
          source.abort();
        }
        await f.settle();
        expect(guest.controller.signal.aborted).toBe(state === "already-aborted");
      });
    },
  );

  it("retains cancellation and partial persistence after immediate run cleanup releases its listener", async () => {
    await withCancellationFixture(async (f) => {
      const source = new AbortController();
      const guest = f.register("settled-run");
      f.context.chatRunState.getOrCreate("settled-run").buffer =
        "Keep the canceled run's progress.";
      const release = f.bind(source.signal, "settled-run", guest.entry);
      source.abort();
      guest.cleanup();
      release();
      const replacement = f.register("settled-run");
      await f.settle();
      expect(guest.controller.signal.aborted).toBe(true);
      expect(replacement.controller.signal.aborted).toBe(false);
      expect(loadTranscriptEventsSync(f.scope)).toContainEqual(
        expect.objectContaining({
          message: expect.objectContaining({
            content: [{ type: "text", text: "Keep the canceled run's progress." }],
          }),
        }),
      );
    });
  });

  it("still stops its exact run if partial transcript capture fails", async () => {
    await withCancellationFixture(async (f) => {
      const source = new AbortController();
      const guest = f.register("failed-partial-capture");
      guest.entry.sessionId = "retired-session";
      f.context.chatRunState.getOrCreate("failed-partial-capture").buffer =
        "Preserve this progress.";
      f.bind(source.signal, "failed-partial-capture", guest.entry);
      source.abort();
      await f.settle();
      expect(guest.controller.signal.aborted).toBe(true);
      expect(f.warn).toHaveBeenCalledWith(
        expect.stringContaining("Aborted partial transcript session changed before persistence"),
      );
    });
  });
});
