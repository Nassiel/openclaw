import { isAgentEventLifecycleGenerationCurrent } from "../infra/agent-events.js";
import { waitForChatAbortTerminalPersistence } from "./chat-abort-lifecycle-internal.js";
import { createChatAbortOps } from "./chat-abort-ops.js";
import {
  abortChatRunById,
  isChatAbortControllerEntryAbortable,
  type ChatAbortControllerEntry,
} from "./chat-abort.js";
import { abortQueuedChatTurnById } from "./chat-queued-turns.js";
import { retainGatewayDeviceRevocation } from "./device-revocation.js";
import { captureGatewayOperatorRunAuthority } from "./operator-run-authority.js";
import { captureAbortedPartial } from "./server-methods/chat-aborted-partial.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { formatForLog } from "./ws-log.js";

type OperatorRunCancellationContext = Pick<
  GatewayRequestContext,
  | "agentRunSeq"
  | "broadcast"
  | "cancelRunBoundApprovals"
  | "chatAbortControllers"
  | "chatQueuedTurns"
  | "chatRunState"
  | "getRuntimeConfig"
  | "logGateway"
  | "nodeSendToSession"
  | "removeChatRun"
  | "trackExecution"
>;

/** Admission releases its retained source and exact-run cancellation listener together. */
export function retainGatewayOperatorRun(
  params: Parameters<typeof captureGatewayOperatorRunAuthority>[0] & {
    context: OperatorRunCancellationContext;
    runId: string;
    entry?: ChatAbortControllerEntry;
  },
) {
  const captured = captureGatewayOperatorRunAuthority(params);
  const releaseSource =
    captured?.release ?? retainGatewayDeviceRevocation(params.hasCurrentClientAuthority);
  const signal = captured?.authority.signal;
  if (!signal || !params.entry) {
    return { authority: captured?.authority, release: releaseSource };
  }
  try {
    const releaseCancellation = bindGatewayOperatorRunCancellation({
      signal,
      runId: params.runId,
      entry: params.entry,
      context: params.context,
    });
    return {
      authority: captured.authority,
      release: () => {
        releaseCancellation();
        releaseSource?.();
      },
    };
  } catch (error) {
    releaseSource?.();
    throw error;
  }
}

/** Retained work owns this listener across active-to-queue transfer, until its final release. */
export function bindGatewayOperatorRunCancellation(params: {
  signal: AbortSignal;
  runId: string;
  entry: ChatAbortControllerEntry;
  context: OperatorRunCancellationContext;
}): () => void {
  const { signal, runId, entry, context } = params;
  const controller = entry.controller;
  const sessionKey = entry.sessionKey;
  const lifecycleGeneration = entry.lifecycleGeneration;
  let released = false;
  let cancellationStarted = false;
  const ownsLifetime = () =>
    !released &&
    (!lifecycleGeneration || isAgentEventLifecycleGenerationCurrent(lifecycleGeneration));
  // chat-send admission hides progress-card refreshes while execution is live.
  // Pending lifecycle errors can still retry; persistence and the execution
  // owner's abortability, not sidebar projection, distinguish terminal work.
  const ownsActiveRun = () =>
    ownsLifetime() &&
    context.chatAbortControllers.get(runId) === entry &&
    entry.controller === controller &&
    entry.sessionKey === sessionKey &&
    !entry.registrationCleanupRequested &&
    entry.projectSessionTerminalPersistence === undefined &&
    entry.projectSessionTerminalPersisted !== true &&
    isChatAbortControllerEntryAbortable(entry);
  const cancelQueuedTurn = () => {
    const queued = context.chatQueuedTurns.get(runId);
    if (!ownsLifetime() || queued?.controller !== controller || queued.abortable === false) {
      return;
    }
    abortQueuedChatTurnById(context.chatQueuedTurns, {
      runId,
      sessionKey: queued.sessionKey,
      stopReason: "rpc",
    });
  };
  const cancel = async () => {
    if (!ownsActiveRun()) {
      cancelQueuedTurn();
      return;
    }
    // A provider can settle and release its run during source abortion. Capture
    // and stop this exact owner before yielding; children retain their own source.
    const text = context.chatRunState.resolveBuffer(runId, { final: true }).text;
    // Internal runs use a separate transcript target; coordination and progress
    // refresh output stay hidden. This snapshot would create a visible reply.
    const snapshot =
      entry.controlUiVisible !== false && text.trim()
        ? captureAbortedPartial({
            runId,
            sessionKey,
            sessionId: entry.sessionId,
            agentId: entry.agentId,
            text,
            abortOrigin: "rpc",
          })
        : undefined;
    const { aborted } = abortChatRunById(createChatAbortOps(context), {
      runId,
      sessionKey,
      stopReason: "rpc",
    });
    if (!aborted) {
      return;
    }
    // Listener release cannot revoke already accepted terminal persistence.
    // The asynchronous writer stays outside admission's eager module graph.
    const settled = await Promise.allSettled([
      waitForChatAbortTerminalPersistence(entry),
      ...(snapshot
        ? [
            import("./server-methods/chat-transcript-persistence.runtime.js").then((transcript) =>
              transcript.persistAbortedPartials({ context, snapshots: [snapshot] }),
            ),
          ]
        : []),
    ]);
    const failures = settled.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length === 1) {
      throw failures[0];
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, "Operator access cancellation did not fully settle");
    }
  };
  const onAbort = () => {
    if (released || cancellationStarted) {
      return;
    }
    cancellationStarted = true;
    void context.trackExecution(cancel).catch((error: unknown) => {
      context.logGateway.warn(`Operator access cancellation failed: ${formatForLog(error)}`);
    });
  };
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) {
    onAbort();
  }
  return () => {
    released = true;
    signal.removeEventListener("abort", onAbort);
  };
}
