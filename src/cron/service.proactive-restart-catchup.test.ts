// Integration proof (task 10.2) for restart catch-up suppression of resolved /
// abandoned proactive check-ins. A persisted proactive job whose live
// resolutionState is terminal must never resume outreach after a restart: the
// restart catch-up collector (collectStartupCatchupJobs -> isRunnableJob ->
// isProactiveOccurrenceSuppressed) short-circuits it with no turn and no send,
// while a pending sibling is still collected and evaluated. This exercises the
// real runMissedJobs catch-up path, not the pure suppression predicate in
// isolation. Suppression / no-run is proven by the absence of any run-history
// write on the terminal jobs, versus a run record on the pending sibling.
//
// Requirements: 4.7
import { describe, expect, it, vi } from "vitest";
import { setupCronServiceSuite } from "./service.test-harness.js";
import { createCronServiceState } from "./service/state.js";
import { runMissedJobs } from "./service/timer.js";
import { loadCronStore, saveCronStore } from "./store.js";
import type { CronJob, CronProactiveResolutionState } from "./types.js";

const { logger: noopLogger, makeStorePath } = setupCronServiceSuite({
  prefix: "openclaw-cron-proactive-",
  baseTimeIso: "2025-12-13T17:00:00.000Z",
});

describe("CronService restart catch-up: proactive suppression", () => {
  const startNow = Date.parse("2025-12-13T17:00:00.000Z");

  async function writeStoreJobs(storePath: string, jobs: CronJob[]) {
    await saveCronStore(storePath, { version: 1, jobs });
  }

  function createOverdueProactiveJob(
    id: string,
    resolutionState: CronProactiveResolutionState,
  ): CronJob {
    const nextRunAtMs = startNow - 60_000;
    return {
      id,
      name: `proactive-${id}`,
      enabled: true,
      createdAtMs: nextRunAtMs - 60_000,
      updatedAtMs: nextRunAtMs - 60_000,
      // Recurring so the occurrence keeps coming due; a pending topic must still
      // be evaluated each occurrence after restart.
      schedule: { kind: "every", everyMs: 60_000, anchorMs: nextRunAtMs - 60_000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: {
        kind: "proactiveCheckIn",
        pendingTopicRef: `topic-${id}`,
        targetUser: "user-42",
        deliveryChannel: "slack",
        // Live state (below) is authoritative; keep the payload initial value
        // consistent so the test does not accidentally rely on the fallback.
        resolutionState,
        guardrails: { minIntervalSeconds: 3600, maxUnanswered: 3 },
      },
      state: {
        nextRunAtMs,
        proactive: { resolutionState, unansweredCount: 0 },
      },
    };
  }

  it("does not resume a resolved proactive job after restart catch-up while a pending one is collected", async () => {
    const store = await makeStorePath();
    const resolved = createOverdueProactiveJob("restart-resolved", "resolved");
    const pending = createOverdueProactiveJob("restart-pending", "pending");
    await writeStoreJobs(store.storePath, [resolved, pending]);

    const enqueueSystemEvent = vi.fn();
    const requestHeartbeat = vi.fn();

    const state = createCronServiceState({
      cronEnabled: true,
      defaultAgentId: "main",
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => startNow,
      enqueueSystemEvent,
      requestHeartbeat,
    });

    try {
      await runMissedJobs(state);

      const persisted = await loadCronStore(store.storePath);

      // The resolved job is short-circuited by the restart catch-up occurrence
      // gate (isProactiveOccurrenceSuppressed): it is never collected as a
      // missed job, so no run history is written and it never resumes outreach.
      const persistedResolved = persisted.jobs.find((job) => job.id === resolved.id);
      expect(persistedResolved?.state.proactive?.resolutionState).toBe("resolved");
      expect(persistedResolved?.state.lastRunStatus).toBeUndefined();
      expect(persistedResolved?.state.lastRunAtMs).toBeUndefined();

      // The pending job stays eligible: it is collected for the catch-up run and
      // evaluated (a run record is written), so it keeps being nudged. Its live
      // resolution state remains pending.
      const persistedPending = persisted.jobs.find((job) => job.id === pending.id);
      expect(persistedPending?.state.proactive?.resolutionState).toBe("pending");
      expect(persistedPending?.state.lastRunAtMs).toBe(startNow);
    } finally {
      await store.cleanup();
    }
  });

  it("does not resume an abandoned proactive job after restart catch-up", async () => {
    const store = await makeStorePath();
    const abandoned = createOverdueProactiveJob("restart-abandoned", "abandoned");
    await writeStoreJobs(store.storePath, [abandoned]);

    const state = createCronServiceState({
      cronEnabled: true,
      defaultAgentId: "main",
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => startNow,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
    });

    try {
      await runMissedJobs(state);

      const persisted = await loadCronStore(store.storePath);
      const persistedAbandoned = persisted.jobs.find((job) => job.id === abandoned.id);
      expect(persistedAbandoned?.state.proactive?.resolutionState).toBe("abandoned");
      expect(persistedAbandoned?.state.lastRunStatus).toBeUndefined();
      expect(persistedAbandoned?.state.lastRunAtMs).toBeUndefined();
    } finally {
      await store.cleanup();
    }
  });

  it("suppresses a legacy resolved proactive row lacking the live proactive block", async () => {
    const store = await makeStorePath();
    // Pre-migration row: no state.proactive block, so resolveProactiveResolutionState
    // falls back to the payload's resolutionState (still suppressed, Req 4.7).
    const legacy = createOverdueProactiveJob("restart-legacy-resolved", "resolved");
    delete legacy.state.proactive;
    await writeStoreJobs(store.storePath, [legacy]);

    const state = createCronServiceState({
      cronEnabled: true,
      defaultAgentId: "main",
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => startNow,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
    });

    try {
      await runMissedJobs(state);

      const persisted = await loadCronStore(store.storePath);
      const persistedLegacy = persisted.jobs.find((job) => job.id === legacy.id);
      // Never collected for catch-up, so no run history and no outreach.
      expect(persistedLegacy?.state.lastRunStatus).toBeUndefined();
      expect(persistedLegacy?.state.lastRunAtMs).toBeUndefined();
    } finally {
      await store.cleanup();
    }
  });
});
