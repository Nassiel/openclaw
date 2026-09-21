import {
  assertAdmittedRunOperatorAuthority,
  bindOperatorModelExecution,
  type AdmittedRunOperatorAuthority,
} from "../../agents/admitted-run-context.js";
import type { ModelRef } from "../../agents/model-ref-shared.js";
import { captureGatewayToolCallerAssertion } from "../../agents/tools/gateway-caller-context.js";
import { resolveGatewayOperatorRoleActor } from "../../gateway/operator-role-policy.js";
import { captureGatewayOperatorRunAuthority } from "../../gateway/operator-run-authority.js";
import { captureOperatorToolGatewayAuthority } from "../../gateway/server-plugin-in-process-dispatch.js";
import { runWithAsyncWorkResources } from "../../shared/async-work-resources.js";
import { getPluginRuntimeGatewayRequestScope } from "./gateway-request-scope.js";
import { createLlmCompleteError } from "./runtime-llm-error.js";
import type { LlmCompleteCaller, LlmCompleteParams, LlmCompleteResult } from "./types-core.js";

type CompletionOperatorSource = {
  operatorAuthority?: AdmittedRunOperatorAuthority;
  signal?: AbortSignal;
  assertCurrent: () => void;
  bindModelExecution: (
    model: ModelRef | undefined,
  ) => ReturnType<typeof bindOperatorModelExecution>;
};

/** Keep the original requester through preparation, provider work, and asynchronous cleanup. */
export function bindLlmOperatorAuthority(
  hostCaller: LlmCompleteCaller | undefined,
  complete: (
    params: LlmCompleteParams,
    source: CompletionOperatorSource,
  ) => Promise<LlmCompleteResult>,
): (params: LlmCompleteParams) => Promise<LlmCompleteResult> {
  return (params) =>
    runWithAsyncWorkResources(async (onAcquired) => {
      // Only the host-issued context-engine capability identifies bounded system maintenance.
      // A request's caller/purpose fields cannot change its execution authority.
      if (hostCaller?.kind === "context-engine") {
        return await complete(params, {
          signal: params.signal,
          assertCurrent: () => params.signal?.throwIfAborted(),
          bindModelExecution: () => undefined,
        });
      }
      const scope = getPluginRuntimeGatewayRequestScope();
      const invocation = captureOperatorToolGatewayAuthority();
      const inheritedOperator = invocation?.authority;
      const context = scope?.context ?? scope?.resolveGatewayContext?.();
      const assertInvocationCurrent =
        inheritedOperator || !scope?.client || !context
          ? invocation?.assertCurrent
          : captureGatewayToolCallerAssertion();
      if (inheritedOperator) {
        assertAdmittedRunOperatorAuthority(inheritedOperator);
        inheritedOperator.assertCurrent();
      } else if (
        scope?.client &&
        !context &&
        resolveGatewayOperatorRoleActor(scope.client)?.kind === "operator"
      ) {
        throw createLlmCompleteError(
          "LLM_COMPLETION_NOT_AUTHORIZED",
          "Plugin model completion requires its current Gateway binding.",
        );
      }
      const capturedOperator = inheritedOperator
        ? { authority: inheritedOperator, release: inheritedOperator.retain?.() }
        : scope?.client && context
          ? captureGatewayOperatorRunAuthority({
              client: scope.client,
              context,
              hasCurrentClientAuthority: scope.hasCurrentClientAuthority,
              ...(scope.signal
                ? {
                    sourceAuthority: {
                      assertCurrent: () => scope.signal?.throwIfAborted(),
                      signal: scope.signal,
                    },
                  }
                : {}),
            })
          : undefined;
      const resources = new AsyncDisposableStack();
      if (capturedOperator?.release) {
        resources.defer(capturedOperator.release);
      }
      onAcquired({ release: () => resources.disposeAsync() });
      const operatorAuthority = capturedOperator?.authority;
      const signal = operatorAuthority?.signal
        ? params.signal
          ? AbortSignal.any([params.signal, operatorAuthority.signal])
          : operatorAuthority.signal
        : params.signal;
      const assertCurrent = () => {
        assertInvocationCurrent?.();
        operatorAuthority?.assertCurrent();
        signal?.throwIfAborted();
      };
      assertCurrent();
      return await complete(params, {
        operatorAuthority,
        signal,
        assertCurrent,
        bindModelExecution: (model) => {
          const execution = bindOperatorModelExecution(operatorAuthority, model);
          if (execution) {
            resources.defer(execution.release);
          }
          return execution;
        },
      });
    });
}
