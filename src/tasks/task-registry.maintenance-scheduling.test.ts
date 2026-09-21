import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import { getTaskById } from "./task-registry.js";
import { registerTaskRegistryScheduledMaintenanceTests } from "./task-registry.maintenance-scheduling.test-utils.js";
import {
  resetTaskRegistryMaintenanceRuntimeForTests,
  setTaskRegistryMaintenanceRuntimeForTests,
  startTaskRegistryMaintenance,
  stopTaskRegistryMaintenance,
} from "./task-registry.maintenance.js";
import { createPreparedMaintenanceRead } from "./task-registry.maintenance.test-support.js";
import {
  createTaskFixture,
  flushAsyncWork,
  withTaskRegistryTempDir,
} from "./task-registry.test-support.js";

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

  registerTaskRegistryScheduledMaintenanceTests();
});
