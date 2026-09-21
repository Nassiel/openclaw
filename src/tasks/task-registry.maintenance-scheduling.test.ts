import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AcpSessionStoreEntry } from "../acp/runtime/session-meta.js";
import * as gatewayWorkAdmission from "../process/gateway-work-admission.js";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
} from "../process/gateway-work-admission.js";
import { createManagedTaskFlow, getTaskFlowById } from "./task-flow-registry.js";
import { resetTaskFlowRegistryForTests } from "./task-flow-registry.test-support.js";
import { getTaskById } from "./task-registry.js";
import {
  resetTaskRegistryMaintenanceRuntimeForTests,
  setTaskRegistryMaintenanceRuntimeForTests,
  startTaskRegistryMaintenance,
  stopTaskRegistryMaintenance,
} from "./task-registry.maintenance.js";
import {
  configureTaskRegistryMaintenanceRuntimeForTest,
  createPreparedMaintenanceRead,
} from "./task-registry.maintenance.test-support.js";
import {
  createTaskFixture,
  flushAsyncWork,
  withTaskRegistryTempDir,
  resetTaskRegistryForTests,
} from "./task-registry.test-support.js";

function captureScheduledMaintenance() {
  const admission = vi.spyOn(gatewayWorkAdmission, "runWithGatewayIndependentRootWorkAdmission");
  return {
    async settle() {
      const index = admission.mock.calls.findIndex(([, origin]) => origin === "tasks:maintenance");
      const result = admission.mock.results[index];
      if (!result || result.type !== "return") {
        throw new Error("Expected the scheduled maintenance admission");
      }
      await result.value;
    },
    [Symbol.dispose]() {
      admission.mockRestore();
    },
  };
}

beforeEach(() => {
  resetGatewayWorkAdmission();
});

afterEach(() => {
  stopTaskRegistryMaintenance();
  resetTaskRegistryMaintenanceRuntimeForTests();
  resetGatewayWorkAdmission();
  vi.useRealTimers();
});

describe("task-registry maintenance scheduling", () => {
  it("does not leak unhandled rejections when the scheduled maintenance sweep fails", async () => {
    await withTaskRegistryTempDir(async () => {
      vi.useFakeTimers();

      const unhandled: unknown[] = [];
      const onUnhandledRejection = (reason: unknown) => {
        unhandled.push(reason);
      };
      process.on("unhandledRejection", onUnhandledRejection);

      setTaskRegistryMaintenanceRuntimeForTests({
        listAcpSessionEntries: async () => [],
        readAcpSessionEntry: () => ({
          cfg: {},
          storePath: "",
          sessionKey: "",
          storeSessionKey: "",
          entry: undefined,
          storeReadFailed: false,
        }),
        listSessionEntries: () => [],
        resolveStorePath: () => "",
        parseAgentSessionKey: () => null,
        isCronJobActive: () => false,
        getAgentRunContext: () => undefined,
        hasActiveAcpTurn: () => false,
        hasActiveTaskForChildSessionKey: () => false,
        deleteTaskRecordById: () => false,
        ensureTaskRegistryReady: () => {},
        getTaskById: () => undefined,
        getTaskRegistryMaintenanceTask: () => undefined,
        prepareTaskRegistryRead: async () => createPreparedMaintenanceRead(),
        getTaskRegistryMaintenanceSnapshot: () => {
          throw new Error("maintenance boom");
        },
        listTaskRecords: () => [],
        markTaskLostById: () => null,
        markTaskTerminalById: () => null,
        maybeDeliverTaskTerminalUpdate: async () => null,
        resolveTaskForLookupToken: () => undefined,
        setTaskCleanupAfterById: () => null,
        isRuntimeAuthoritative: () => true,
        listTaskRegistryRecordsByRuntimeSourceIdFromSqlite: () => [],
      });

      try {
        startTaskRegistryMaintenance();
        await vi.advanceTimersByTimeAsync(5_000);
        await flushAsyncWork();
        expect(unhandled).toStrictEqual([]);
      } finally {
        process.off("unhandledRejection", onUnhandledRejection);
      }
    });
  });

  it("cancels the deferred maintenance sweep during test teardown", async () => {
    await withTaskRegistryTempDir(async () => {
      vi.useFakeTimers();
      const now = Date.now();

      const task = createTaskFixture("acp", {
        childSessionKey: "agent:main:acp:missing",
        runId: "run-deferred-maintenance-stop",
        task: "Missing child",
        deliveryStatus: "pending",
        lastEventAt: now - 10 * 60_000,
      });

      startTaskRegistryMaintenance();
      stopTaskRegistryMaintenance();

      await vi.advanceTimersByTimeAsync(5_000);
      await flushAsyncWork();

      expect(getTaskById(task.taskId)).toMatchObject({
        status: "running",
      });
    });
  });

  it("prunes expired ended TaskFlows during scheduled maintenance", async () => {
    await withTaskRegistryTempDir(
      async () => {
        vi.useFakeTimers();
        const endedAt = Date.now() - 8 * 24 * 60 * 60_000;
        const flow = expectDefined(
          createManagedTaskFlow({
            ownerKey: "agent:main:main",
            controllerId: "tests/scheduled-task-flow-maintenance",
            goal: "Completed without a usable result",
            status: "blocked",
            createdAt: endedAt,
            updatedAt: endedAt,
            endedAt,
          }),
          "expected managed TaskFlow creation to succeed",
        );
        resetTaskRegistryForTests({ persist: false });
        resetTaskFlowRegistryForTests({ persist: false });

        using sweep = captureScheduledMaintenance();
        try {
          startTaskRegistryMaintenance();
          await vi.advanceTimersByTimeAsync(5_000);
          await sweep.settle();
          expect(getTaskFlowById(flow.flowId)).toBeUndefined();
        } finally {
          stopTaskRegistryMaintenance();
        }
      },
      { durableStore: true },
    );
  });

  it("keeps scheduled maintenance root-admitted until session cleanup inspection settles", async () => {
    await withTaskRegistryTempDir(async () => {
      vi.useFakeTimers();
      let releaseInspection = (_entries: AcpSessionStoreEntry[]) => {};
      const inspection = new Promise<AcpSessionStoreEntry[]>((resolve) => {
        releaseInspection = resolve;
      });
      configureTaskRegistryMaintenanceRuntimeForTest({
        currentTasks: new Map(),
        snapshotTasks: [],
        listAcpSessionEntries: async () => await inspection,
      });

      using sweep = captureScheduledMaintenance();
      startTaskRegistryMaintenance();
      try {
        await vi.advanceTimersByTimeAsync(5_000);
        expect(getActiveGatewayRootWorkCount()).toBe(1);

        releaseInspection([]);
        await sweep.settle();
        expect(getActiveGatewayRootWorkCount()).toBe(0);
      } finally {
        releaseInspection([]);
        try {
          await sweep.settle();
        } finally {
          stopTaskRegistryMaintenance();
        }
      }
    });
  });
});
