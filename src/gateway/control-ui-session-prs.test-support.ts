// Shared fixtures for the control-ui session PR tests; test-only module.
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  replaceSessionEntrySync,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { resolveControlUiSessionPrTarget } from "./control-ui-session-pr-read.js";
import { loadControlUiSessionPullRequests } from "./control-ui-session-prs.js";
import { resolveRequestedSessionAgentId } from "./session-request-agent.js";
import { resolveSessionStoreKey } from "./session-store-key.js";
import { loadGatewaySessionEntryReadOnly } from "./session-utils-store.js";

type GitContext = { owner: string; repo: string; branch: string };

export function githubJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function requestUrl(input: RequestInfo | URL | undefined): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input?.url ?? "";
}

export function routedFetch(
  routes: Array<{ match: string; response: () => Response | Promise<Response> }>,
) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = requestUrl(input);
    const route = routes.find((candidate) => url.includes(candidate.match));
    if (!route) {
      throw new Error(`unexpected GitHub request: ${url}`);
    }
    return route.response();
  }) as unknown as typeof fetch & { mock: { calls: unknown[][] } };
}

export function pullListItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 103469,
    title: "fix(macos): tighten the link-browser tab header",
    html_url: "https://github.com/openclaw/openclaw/pull/103469",
    state: "open",
    draft: false,
    merged_at: null,
    head: { sha: "a".repeat(40) },
    base: { ref: "main", repo: { name: "openclaw", owner: { login: "openclaw" } } },
    ...overrides,
  };
}

export const testGitContext: GitContext = {
  owner: "openclaw",
  repo: "openclaw",
  branch: "claude/browser-tabs-tighter-header",
};

/** Git/network fixtures still select real sessions; each test owns its cache namespace. */
export function createSessionPullRequestsFixture() {
  let state: OpenClawTestState | undefined;
  let cfg: OpenClawConfig;
  const seeded = new Set<string>();
  beforeEach(async () => {
    state = await createOpenClawTestState({ scenario: "minimal" });
    cfg = { agents: { entries: { main: { workspace: state.workspaceDir } } } };
    await state.writeConfig(cfg);
    setRuntimeConfigSnapshot(cfg);
    seeded.clear();
    // Prepare the canonical store before tests install fake clocks or concurrent reads.
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: "agent:main:main" },
      { sessionId: randomUUID(), updatedAt: 1 },
    );
    seeded.add("agent:main:main");
  });
  afterEach(async () => {
    vi.useRealTimers();
    await state?.cleanup();
    state = undefined;
  });
  const seed = (params: Parameters<typeof loadControlUiSessionPullRequests>[0]) => {
    if (!state) {
      throw new Error("Session PR fixture is not active");
    }
    const requested = resolveRequestedSessionAgentId(cfg, params.sessionKey, params.agentId);
    if (!requested.ok) {
      throw new Error(requested.error.message);
    }
    const sessionKey = resolveSessionStoreKey({
      cfg,
      sessionKey: params.sessionKey,
      storeAgentId: requested.agentId,
    });
    if (!seeded.has(sessionKey)) {
      replaceSessionEntrySync(
        { agentId: requested.agentId, sessionKey },
        { sessionId: randomUUID(), updatedAt: 1 },
      );
      seeded.add(sessionKey);
    }
    return { sessionKey, agentId: requested.agentId };
  };
  const load: typeof loadControlUiSessionPullRequests = (params, deps) => {
    seed(params);
    return loadControlUiSessionPullRequests(params, deps);
  };
  return {
    load,
    prepareRead: (_connId: string, watchKey: string) => {
      const params = seed({ sessionKey: watchKey });
      return () =>
        resolveControlUiSessionPrTarget(
          loadGatewaySessionEntryReadOnly(params.sessionKey, { agentId: params.agentId }),
        );
    },
  };
}
