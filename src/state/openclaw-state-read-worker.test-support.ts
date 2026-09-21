import { vi, type Mock } from "vitest";
import type {
  OwnedWorkerTask,
  WorkerTaskInput,
  WorkerTaskOptions,
} from "../infra/worker-task-pool.types.js";
import { createDeferredCore } from "../shared/deferred.js";
import type {
  OpenClawStateReadReply,
  OpenClawStateReadRequest,
} from "./openclaw-state-read.types.js";

type ReadTask = OwnedWorkerTask<OpenClawStateReadReply>;
export type StateReadTaskRunner = (
  input: WorkerTaskInput<OpenClawStateReadRequest>,
  options: WorkerTaskOptions<OpenClawStateReadRequest>,
) => ReadTask;

export function createStateReadTaskQueue(
  runTask: Mock<StateReadTaskRunner>,
  taskCleanups: Array<() => void>,
) {
  return function queueTask(dispatchReady: Promise<void> = Promise.resolve()) {
    const result = createDeferredCore<OpenClawStateReadReply>();
    const submitted = createDeferredCore<WorkerTaskOptions<OpenClawStateReadRequest>>();
    const captured = createDeferredCore<OpenClawStateReadRequest>();
    const close = vi.fn<ReadTask["close"]>().mockResolvedValue();
    const handle: ReadTask = { result: result.promise, close };
    let detach = () => {};
    runTask.mockImplementationOnce((input, options) => {
      const signal = options.signal;
      const abort = () => result.reject(signal?.reason);
      signal?.addEventListener("abort", abort, { once: true });
      detach = () => signal?.removeEventListener("abort", abort);
      if (signal?.aborted) {
        abort();
      }
      submitted.resolve(options);
      void dispatchReady
        .then(async () => {
          const request = typeof input === "function" ? await input() : input;
          captured.resolve(request);
        })
        .catch((error: unknown) => {
          captured.reject(error);
          result.reject(error);
        });
      return handle;
    });
    void captured.promise.catch(() => undefined);
    taskCleanups.push(() => {
      detach();
      close.mockReset().mockResolvedValue();
      result.reject(new Error("test task cleanup"));
    });
    return { result, submitted: submitted.promise, captured: captured.promise, close };
  };
}
