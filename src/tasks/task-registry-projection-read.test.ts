import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import * as taskRuntime from "./runtime-internal.js";
import { createRunningTaskRunCoreWithReceiptAsync } from "./task-executor-create.async.js";
import { taskAgentEventMutations } from "./task-registry-agent-events.js";
import { updateTask } from "./task-registry-mutation.js";
import { prepareTaskRegistryRead } from "./task-registry-read.js";
import {
  createReadTask,
  requestTasks,
  resetReadState,
  withReadState,
} from "./task-registry-read.test-support.js";
import { runTaskRegistryWorkerMutation, taskDeliveryStates, tasks } from "./task-registry-state.js";
import { configureTaskRegistryRuntime, getTaskRegistryStore } from "./task-registry.store.js";
import { loadTaskRegistryStateFromSqliteReadOnly } from "./task-registry.store.sqlite.js";
import type {
  TaskRegistryMutationScope,
  TaskRegistryStoreSnapshot,
} from "./task-registry.store.types.js";
import { createTaskFixture, prepareTaskFixtureRead } from "./task-registry.test-support.js";

afterEach(resetReadState);

it.each(["current", "read failure", "retired store"] as const)(
  "prepares registered task reads from one overlapping scope snapshot: %s",
  async (outcome) => {
    await withReadState(async () => {
      const first = createReadTask("union-first");
      const second = createReadTask("union-second");
      const overlap = createReadTask("union-overlap");
      const removed = createReadTask("union-removed");
      const unrelated = createReadTask("union-unrelated");
      const store = await prepareTaskFixtureRead(first);
      const context = captureOpenClawStateWorkerContext();
      const load = store.loadMutationSnapshotAsync.bind(store);
      const releaseMutations = createDeferred();
      const releaseRead = createDeferred();
      const enteredRead = createDeferred();
      const failure = new Error("Synthetic union snapshot failure");
      const snapshots: TaskRegistryStoreSnapshot[] = [];
      const scopes: TaskRegistryMutationScope[] = [
        { taskId: first.taskId, runId: second.runId },
        { taskId: second.taskId, runId: first.runId },
        { taskId: overlap.taskId },
        { taskId: removed.taskId },
      ];
      const nextFirst = { ...first, task: "Fresh first" };
      const nextSecond = { ...second, task: "Fresh second" };
      const nextOverlap = {
        ...overlap,
        task: "Fresh overlapping task",
      };
      const firstDelivery = { taskId: first.taskId, lastNotifiedEventAt: 17 };
      const overlapDelivery = { taskId: overlap.taskId, lastNotifiedEventAt: 23 };
      const mutations = scopes.map((scope, index) =>
        runTaskRegistryWorkerMutation(
          {
            scope,
            admission: context.admission,
            readIdentity: "preserved",
            publicationRecords: () => new Map(),
          },
          async () => {
            if (index === 0) {
              store.upsertTaskWithDeliveryState({ task: nextFirst, deliveryState: firstDelivery });
            } else if (index === 1) {
              store.upsertTaskWithDeliveryState({ task: nextSecond });
            } else if (index === 2) {
              store.upsertTaskWithDeliveryState({
                task: nextOverlap,
                deliveryState: overlapDelivery,
              });
            } else {
              store.deleteTaskWithDeliveryState(removed.taskId);
            }
            await releaseMutations.promise;
          },
          () => load(context, scope),
        ),
      );
      const previousTasks = new Map(tasks);
      const previousDelivery = new Map(taskDeliveryStates);
      vi.spyOn(store, "loadMutationSnapshotAsync").mockImplementation(async (...args) => {
        const snapshot = await load(...args);
        snapshots.push(snapshot);
        enteredRead.resolve();
        await releaseRead.promise;
        if (outcome === "read failure") {
          throw failure;
        }
        return snapshot;
      });
      const respond = vi.fn();
      const reading = requestTasks(first.ownerKey, respond);
      const settled = Promise.allSettled([reading]);
      try {
        await withTestTimeout(enteredRead.promise, 5_000, "Task read reached its worker snapshot");
        expect(respond).not.toHaveBeenCalled();
        expect(tasks).toEqual(previousTasks);
        expect(taskDeliveryStates).toEqual(previousDelivery);
        if (outcome === "retired store") {
          configureTaskRegistryRuntime({ store: { ...store } });
        }
        releaseRead.resolve();
        const [result] = await withTestTimeout(settled, 5_000, "Task read settled its snapshot");
        if (outcome === "current") {
          expect(result.status).toBe("fulfilled");
          expect(respond).toHaveBeenCalledOnce();
          expect(respond.mock.calls[0]?.[1]).toHaveProperty("tasks.length", 4);
          expect(respond.mock.calls[0]).toMatchObject([
            true,
            {
              tasks: expect.arrayContaining(
                [
                  { id: first.taskId, title: nextFirst.task },
                  { id: second.taskId, title: nextSecond.task },
                  { id: overlap.taskId, title: nextOverlap.task },
                  { id: unrelated.taskId, title: unrelated.task },
                ].map((task) => expect.objectContaining(task)),
              ),
            },
          ]);
          expect(tasks).toEqual(
            new Map([
              [first.taskId, nextFirst],
              [second.taskId, nextSecond],
              [overlap.taskId, nextOverlap],
              [unrelated.taskId, unrelated],
            ]),
          );
          expect(taskDeliveryStates).toEqual(
            new Map([
              [first.taskId, firstDelivery],
              [overlap.taskId, overlapDelivery],
            ]),
          );
          expect(snapshots).toEqual([
            {
              tasks: new Map([
                [first.taskId, nextFirst],
                [second.taskId, nextSecond],
                [overlap.taskId, nextOverlap],
              ]),
              deliveryStates: new Map([
                [first.taskId, firstDelivery],
                [overlap.taskId, overlapDelivery],
              ]),
            },
          ]);
        } else {
          expect(result.status).toBe("rejected");
          if (result.status === "rejected") {
            if (outcome === "read failure") {
              expect(result.reason).toBe(failure);
            } else {
              expect(result.reason.message).toContain("owner");
            }
          }
          expect(respond).not.toHaveBeenCalled();
          expect(tasks).toEqual(previousTasks);
          expect(taskDeliveryStates).toEqual(previousDelivery);
        }
      } finally {
        releaseRead.resolve();
        await settled;
        releaseMutations.resolve();
        await Promise.allSettled(mutations);
      }
    });
  },
);

describe("registered task list read fence", () => {
  it("retries a changed page without joining events accepted after its first read", async () => {
    await withReadState(async () => {
      const task = createReadTask("read-before-page-retry");
      const later = createTaskFixture("cli", {
        runId: "accepted-after-page-selection",
        ownerKey: "agent:main:later-event",
        requesterSessionKey: "agent:main:later-event",
        task: "Unrelated later work",
        status: "running",
        notifyPolicy: "silent",
        deliveryStatus: "not_applicable",
      });
      const entered = createDeferred();
      const release = createDeferred();
      const store = getTaskRegistryStore();
      const mutate = store.runAgentEventMutationAsync.bind(store);
      vi.spyOn(store, "runAgentEventMutationAsync").mockImplementation(async (...args) => {
        if (args[1].taskId === later.taskId) {
          entered.resolve();
          await release.promise;
        }
        return mutate(...args);
      });
      const select = taskRuntime.listTaskRecordPage;
      let changed = false;
      vi.spyOn(taskRuntime, "listTaskRecordPage").mockImplementation(async (params) => {
        const page = await select(params);
        if (!changed && page.ok) {
          changed = true;
          expect(page.value.tasks).toMatchObject([{ taskId: task.taskId, toolUseCount: 1 }]);
          expect(updateTask(task.taskId, { task: "Changed before response" })).not.toBeNull();
          emitAgentEvent({
            runId: later.runId!,
            stream: "tool",
            data: { phase: "start", name: "later-tool" },
          });
          await withTestTimeout(entered.promise, 5_000, "Later event did not reach its barrier");
        }
        return page;
      });
      emitAgentEvent({
        runId: task.runId!,
        stream: "tool",
        data: { phase: "start", name: "accepted-before-read" },
      });
      const read = requestTasks(task.ownerKey);
      try {
        await withTestTimeout(
          Promise.race([
            entered.promise,
            read.then(() => {
              throw new Error("Task request settled before the later-event barrier");
            }),
          ]),
          5_000,
          "Later event did not reach its barrier",
        );
        const response = await withTestTimeout(read, 5_000, "Page retry joined a later event");
        expect(changed).toBe(true);
        expect(response.mock.calls[0]).toMatchObject([
          true,
          { tasks: [{ id: task.taskId, title: "Changed before response", toolUseCount: 1 }] },
        ]);
      } finally {
        release.resolve();
        await read;
        await prepareTaskRegistryRead();
      }
      expect(loadTaskRegistryStateFromSqliteReadOnly().tasks.get(later.taskId)).toMatchObject({
        toolUseCount: 1,
        lastToolName: "later-tool",
      });
    });
  });
});

it("settles admitted run creations before preparing a registered task page", async () => {
  await withReadState(async () => {
    const originals = Array.from({ length: 4 }, (_, index) =>
      createReadTask(`admitted-creation-${index}`),
    );
    const first = originals[0]!;
    const store = await prepareTaskFixtureRead(first);
    await requestTasks(first.ownerKey);
    const context = captureOpenClawStateWorkerContext();
    const mutate = store.runInitialMutationAsync.bind(store);
    const load = store.loadMutationSnapshotAsync.bind(store);
    const committed = createDeferred();
    const release = createDeferred();
    let committedCount = 0;
    vi.spyOn(store, "runInitialMutationAsync").mockImplementation(async (...args) => {
      const result = await mutate(...args);
      if (args[1].type === "tasks.createRecord") {
        committedCount += 1;
        if (committedCount === originals.length) {
          committed.resolve();
        }
        await release.promise;
      }
      return result;
    });
    const creations = originals.map((task) =>
      createRunningTaskRunCoreWithReceiptAsync({
        runtime: task.runtime,
        runId: task.runId!,
        task: task.task,
        ownerKey: task.ownerKey,
        scopeKind: task.scopeKind,
        requesterSessionKey: task.requesterSessionKey,
        notifyPolicy: "silent",
        deliveryStatus: "not_applicable",
        detail: { historyGeneration: "replacement" },
      }),
    );
    const settled = Promise.allSettled(creations);
    let reading: ReturnType<typeof requestTasks> | undefined;
    try {
      await withTestTimeout(committed.promise, 5_000, "Run creations committed before publication");
      const snapshot = await load(
        context,
        originals.map((task) => ({ taskId: task.taskId, runId: task.runId })),
      );
      // Read-only snapshots may finish before the creation owners publish their committed rows.
      // Keep those canonical rows fixed while producer readbacks retain their real worker path.
      vi.spyOn(store, "loadMutationSnapshotAsync").mockImplementation(async (...args) =>
        Array.isArray(args[1]) ? snapshot : load(...args),
      );
      const entered = createDeferred();
      const fence = taskAgentEventMutations.captureReadFence.bind(taskAgentEventMutations);
      vi.spyOn(taskAgentEventMutations, "captureReadFence").mockImplementationOnce((admission) => {
        const result = fence(admission);
        entered.resolve();
        return result;
      });
      const respond = vi.fn();
      reading = requestTasks(first.ownerKey, respond);
      await withTestTimeout(entered.promise, 5_000, "Registered read captured its admitted work");
      release.resolve();
      await withTestTimeout(reading, 5_000, "Registered read joined run creation publication");
      await Promise.all(creations);
      expect(respond).toHaveBeenCalledOnce();
      expect(respond.mock.calls[0]).toMatchObject([
        true,
        {
          tasks: expect.arrayContaining(
            originals.map((task) => expect.objectContaining({ id: task.taskId })),
          ),
        },
      ]);
    } finally {
      release.resolve();
      await settled;
      await reading?.catch(() => {});
    }
  });
});
