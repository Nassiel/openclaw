import { vi } from "vitest";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions.js";
import type { callGateway } from "../../gateway/call.js";
import type { GatewayRecoveryRuntime } from "../../gateway/server-instance-runtime.types.js";
import {
  createSessionEntry,
  type SessionEntryFixture,
} from "../subagent-test-fixtures.test-helpers.js";

export function mainSessionEntry(overrides: SessionEntryFixture = {}): SessionEntry {
  return createSessionEntry({
    sessionId: "main-session",
    permissionMode: "guarded",
    updatedAt: Date.now() - 10_000,
    status: "running",
    abortedLastRun: true,
    ...overrides,
  });
}

export function runningSessionEntry(
  sessionId: string,
  overrides: SessionEntryFixture = {},
): SessionEntry {
  return createSessionEntry({
    sessionId,
    updatedAt: Date.now() - 10_000,
    status: "running",
    ...overrides,
  });
}

export function createRecoveryRuntimeFixture(params: {
  callGateway: typeof callGateway;
  getDispatchSettlement: () => Promise<void>;
  sendRecoveryNotice: GatewayRecoveryRuntime["sendRecoveryNotice"];
}) {
  return {
    dispatchSessionMethod: vi.fn(),
    dispatchAgent: async <T>(
      request: Record<string, unknown>,
      timeoutMs?: number,
      options?: Parameters<GatewayRecoveryRuntime["dispatchAgent"]>[2],
    ) => {
      const result = (await params.callGateway({
        method: "agent",
        params: request,
        timeoutMs,
      })) as T;
      const status = (result as { status?: unknown } | undefined)?.status;
      if (status === undefined) {
        options?.onStartOwner?.({
          observe: () => ({ executionStarted: true, expiresAtMs: Date.now() + 60_000 }),
          abort: () => false,
        });
        options?.onAccepted?.(result);
        options?.onExecutionStarted?.();
        await params.getDispatchSettlement();
      }
      return result;
    },
    waitForAgent: async <T>(request: Record<string, unknown>, timeoutMs?: number) => {
      if (request.timeoutMs === 30_000) {
        // Capacity observation follows this fixture's actual dispatch lifetime;
        // zero-time recovery probes below retain their independent RPC plan.
        await params.getDispatchSettlement();
        return { status: "ok", endedAt: Date.now() } as T;
      }
      return (await params.callGateway({ method: "agent.wait", params: request, timeoutMs })) as T;
    },
    sendRecoveryNotice: params.sendRecoveryNotice,
  };
}
