import { DatabaseSync, StatementSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import { getRuntimeConfig } from "../config/io.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { deleteSessionEntryLifecycle } from "../config/sessions.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../state/openclaw-agent-db.js";
import { getSessionRepositoryWorkspaceStore } from "../state/session-repository-workspaces.js";
import { ensureProfileForEmail, linkEmail, setUserProfileRole } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type {
  ControlUiSessionPullRequestCheckDetails,
  ControlUiSessionPullRequests,
} from "./control-ui-contract.js";
import { prepareControlUiSessionPrRead } from "./control-ui-session-pr-read.js";
import { createControlUiSessionPullRequestSubscriptions } from "./control-ui-session-pr-subscriptions.js";
import { githubJson, pullListItem } from "./control-ui-session-prs.test-support.js";
import type { OperatorScope } from "./operator-scopes.js";
import { createGatewayConnectionState } from "./server-connection-state.js";
import { handleGatewayRequest } from "./server-methods.js";
import { createControlUiHandlers } from "./server-methods/control-ui.js";
import {
  disposeSessionReadContexts,
  initializeSessionReadContext,
} from "./server-methods/sessions-read-cache.test-support.js";
import { createGatewayRequestContext } from "./server-request-context.js";
import { makeContextParams } from "./server-request-context.test-support.js";
import { createGatewayWsTestSocket } from "./server/ws-connection.test-helpers.js";
import { createOperatorWsClient } from "./server/ws-connection/authenticated-request-dispatch.test-support.js";
import { getSessionRowProjection } from "./session-row-projection-access.js";
import { loadGatewaySessionEntryReadOnly } from "./session-utils-store.js";

const METHOD = "controlUi.sessionPullRequests.subscribe";
const EVENT = "controlUi.sessionPullRequests.changed";
const sessionKey = "agent:main:guest-publication";
const readerEmail = "guest-publication-reader@example.test";
const branch = { owner: "synthetic", repo: "publication", branch: "guest-change" };
const snapshot: ControlUiSessionPullRequests = { pullRequests: [], branch, rateLimited: false };
const readerChanges = [
  "unchanged",
  "role",
  "connection",
  "profile",
  "visibility",
  "grant",
  "replacement grant",
] as const;
type Load = NonNullable<
  Parameters<typeof createControlUiSessionPullRequestSubscriptions>[0]["load"]
>;

async function createFixture(scope: OperatorScope, useDefaultLoader = false) {
  const profile = ensureProfileForEmail(readerEmail);
  const other = ensureProfileForEmail("publication-owner@example.test");
  const cfg: OpenClawConfig = {
    gateway: {
      roles: {
        default: "reader",
        definitions: {
          reader: {
            agents: ["main"],
            sessions: { others: "view" },
            scopes: [scope],
          },
        },
      },
    },
  };
  setUserProfileRole(profile.id, "reader");
  setRuntimeConfigSnapshot(cfg);
  const seed = async (key: string, creator = profile.id, patch: Partial<SessionEntry> = {}) => {
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: key },
      {
        sessionId: key,
        updatedAt: 1,
        createdActor: { type: "human", source: "profile", id: creator },
        spawnedCwd: "/synthetic/guest-publication",
        ...patch,
      },
    );
  };
  await seed(sessionKey);
  const connections = createGatewayConnectionState({
    bootId: "publication-read",
    cfg,
    getRuntimeConfig,
  });
  const addReader = (connId: string) => {
    const socket = createGatewayWsTestSocket();
    const client = createOperatorWsClient({ connId, socket, scopes: [scope] });
    const access = new AbortController();
    client.internal = {
      ...client.internal,
      operatorAccessAuthority: {
        signal: access.signal,
        assertCurrent: () => access.signal.throwIfAborted(),
      },
    };
    client.authenticatedUserProfile = {
      profileId: profile.id,
      avatarRevision: "fixture",
      displayName: null,
      hasAvatar: false,
      updatedAt: 1,
    };
    connections.clients.add(client);
    return { client, socket, access };
  };
  const reader = addReader("guest-publication-reader");
  const load = vi.fn<Load>(async () => snapshot);
  const subscriptions = createControlUiSessionPullRequestSubscriptions({
    broadcastToConnIds: connections.broadcastToConnIds,
    isConnectionActive: connections.isConnectionActive,
    prepareRead: (connId, session) => {
      const client = connections.clients.getByConnectionId(connId);
      return client
        ? prepareControlUiSessionPrRead({
            client,
            ...session,
            getRuntimeConfig,
            getSessionRowProjection: () => getSessionRowProjection(context),
            isCurrentClient: () => connections.clients.getByConnectionId(connId) === client,
          })
        : undefined;
    },
    ...(useDefaultLoader ? {} : { load }),
  });
  const context = createGatewayRequestContext(makeContextParams(connections));
  context.getRuntimeConfig = getRuntimeConfig;
  context.controlUiSessionPullRequests = subscriptions;
  await initializeSessionReadContext(context);
  return {
    ...reader,
    addReader,
    profile,
    other,
    cfg,
    seed,
    load,
    subscriptions,
    context,
    async changeReader(change: (typeof readerChanges)[number], key = sessionKey) {
      if (change === "role") {
        const roles = cfg.gateway!.roles!;
        setRuntimeConfigSnapshot({
          ...cfg,
          gateway: {
            ...cfg.gateway,
            roles: {
              ...roles,
              definitions: {
                ...roles.definitions,
                reader: { ...roles.definitions.reader!, scopes: [] },
              },
            },
          },
        });
      } else if (change === "connection") {
        reader.client.invalidated = true;
      } else if (change === "profile") {
        linkEmail(readerEmail, other.id);
      } else if (change === "visibility") {
        await seed(key, other.id, { visibility: "draft", updatedAt: 2 });
      } else if (change === "grant") {
        reader.access.abort(new Error("Original access retired"));
      } else if (change === "replacement grant") {
        const replacement = new AbortController();
        reader.client.internal = {
          ...reader.client.internal,
          operatorAccessAuthority: {
            signal: replacement.signal,
            assertCurrent: () => replacement.signal.throwIfAborted(),
          },
        };
      }
    },
    async subscribe(keys = [sessionKey], client = reader.client) {
      const respond = vi.fn();
      await handleGatewayRequest({
        req: {
          type: "req",
          id: "guest-publication-watch",
          method: METHOD,
          params: { sessionKeys: keys },
        },
        client,
        context,
        isWebchatConnect: () => false,
        respond,
      });
      expect(respond).toHaveBeenCalledWith(true, { subscribed: keys.length > 0 }, undefined);
    },
    async close() {
      await subscriptions.stop();
      connections.clients.clear();
      disposeSessionReadContexts();
    },
  };
}

async function withFixture(
  scope: OperatorScope,
  run: (fixture: Awaited<ReturnType<typeof createFixture>>) => Promise<void>,
) {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const fixture = await createFixture(scope);
    try {
      await run(fixture);
    } finally {
      await fixture.close();
    }
  });
}

function frames(socket: ReturnType<typeof createGatewayWsTestSocket>) {
  return socket.send.mock.calls.flatMap(([data]) => {
    const frame: unknown = JSON.parse(data);
    return isRecord(frame) && frame.event === EVENT ? [frame] : [];
  });
}

function expectedFrame(key: string, value: ControlUiSessionPullRequests = snapshot) {
  return expect.objectContaining({
    type: "event",
    event: EVENT,
    payload: { sessions: { [key]: { ...value, status: "ready" } } },
  });
}

describe("registered session PR subscriptions", () => {
  it.each(["operator.read", "operator.write", "operator.admin"] as const)(
    "delivers the owned branch through the real broadcaster with %s",
    async (scope) => {
      await withFixture(scope, async (f) => {
        await f.subscribe();
        await f.subscriptions.pollNow();
        expect(f.load).toHaveBeenCalledWith(
          { sessionKey, agentId: "main" },
          expect.any(AbortSignal),
          expect.objectContaining({ assertCurrent: expect.any(Function) }),
        );
        expect(frames(f.socket)).toContainEqual(expectedFrame(sessionKey));
      });
    },
  );

  it("resolves a scoped global watch to its persisted global row", async () => {
    await withFixture("operator.read", async (f) => {
      const watchKey = "agent:main:global";
      await f.seed("global");
      await f.seed(watchKey, f.profile.id, { sessionId: "separate-literal-global-row" });
      await f.subscribe([watchKey]);
      await f.subscriptions.pollNow();
      expect(f.load).toHaveBeenCalledWith(
        { sessionKey: "global", agentId: "main" },
        expect.any(AbortSignal),
        expect.objectContaining({ assertCurrent: expect.any(Function) }),
      );
      expect(frames(f.socket)).toEqual([expectedFrame(watchKey)]);
    });
  });

  it.each(["draft", "incognito", "missing"] as const)(
    "does not load or deliver an inaccessible %s target",
    async (kind) => {
      await withFixture("operator.read", async (f) => {
        const key = `agent:main:foreign-${kind}`;
        if (kind !== "missing") {
          await f.seed(
            key,
            f.other.id,
            kind === "draft" ? { visibility: "draft" } : { incognito: true },
          );
        }
        await f.subscribe([key]);
        await f.subscriptions.pollNow();
        expect(f.load).not.toHaveBeenCalled();
        expect(frames(f.socket)).toEqual([]);
      });
    },
  );

  it.each(readerChanges)(
    "rechecks the original reader after a pending snapshot (%s)",
    async (change) => {
      await withFixture("operator.read", async (f) => {
        const key = "agent:main:shared-read";
        await f.seed(key, f.other.id);
        const entered = createDeferredCore();
        const held = createDeferredCore<ControlUiSessionPullRequests>();
        f.load.mockImplementationOnce(async () => {
          entered.resolve();
          return await held.promise;
        });
        try {
          await f.subscribe([key]);
          await entered.promise;
          await f.changeReader(change, key);
          held.resolve(snapshot);
          await f.subscriptions.pollNow();
          expect(frames(f.socket)).toEqual(change === "unchanged" ? [expectedFrame(key)] : []);
        } finally {
          held.resolve(snapshot);
        }
      });
    },
  );

  it.each(["connection", "grant"] as const)(
    "keeps a shared load for an unchanged viewer when the other %s retires",
    async (retired) => {
      await withFixture("operator.read", async (f) => {
        const entered = createDeferredCore();
        const held = createDeferredCore<ControlUiSessionPullRequests>();
        f.load.mockImplementationOnce(async () => {
          entered.resolve();
          return await held.promise;
        });
        const peer = f.addReader("unchanged-reader");
        try {
          await f.subscribe();
          await entered.promise;
          await f.subscribe([sessionKey], peer.client);
          if (retired === "connection") {
            f.client.invalidated = true;
          } else {
            f.access.abort(new Error("Original access retired"));
          }
          held.resolve(snapshot);
          await f.subscriptions.pollNow();
          expect(f.load).toHaveBeenCalledTimes(1);
          expect(frames(f.socket)).toEqual([]);
          expect(frames(peer.socket)).toEqual([expectedFrame(sessionKey)]);
          expect(f.load.mock.calls[0]?.[1]?.aborted).toBe(false);
        } finally {
          held.resolve(snapshot);
        }
      });
    },
  );

  it("retires cached branch data after canonical replacement and hydrates the new target", async () => {
    await withFixture("operator.read", async (f) => {
      await f.subscribe();
      await f.subscriptions.pollNow();
      f.socket.send.mockClear();
      const original = loadGatewaySessionEntryReadOnly(sessionKey, { agentId: "main" });
      await expect(
        deleteSessionEntryLifecycle({
          agentId: "main",
          storePath: original.storePath,
          target: { canonicalKey: original.canonicalKey, storeKeys: original.storeKeys },
          expectedSessionId: sessionKey,
          archiveTranscript: false,
        }),
      ).resolves.toMatchObject({ deleted: true });
      await f.seed(sessionKey, f.profile.id, {
        sessionId: "replacement-publication",
        updatedAt: 2,
      });
      const replacement = { ...snapshot, branch: { ...branch, branch: "replacement-change" } };
      f.load.mockResolvedValue(replacement);
      await f.subscriptions.pollNow();
      expect(f.load).toHaveBeenCalledTimes(2);
      expect(frames(f.socket)).toEqual([expectedFrame(sessionKey, replacement)]);
      const peer = f.addReader("replacement-reader");
      await f.subscribe([sessionKey], peer.client);
      await f.subscriptions.pollNow();
      expect(frames(peer.socket)).toEqual([expectedFrame(sessionKey, replacement)]);
    });
  });
});

describe("registered session PR check details", () => {
  it.each([
    ...readerChanges,
    "literal-global",
    "literal-global-visibility",
    "store closure",
  ] as const)("keeps pending details bound to the original reader (%s)", async (change) => {
    await withFixture("operator.read", async (f) => {
      const key = change.startsWith("literal-global")
        ? "agent:main:global"
        : "agent:main:shared-checks";
      if (change === "literal-global-visibility") {
        await f.seed("global", f.profile.id, { sessionId: "separate-global-row" });
      }
      const mutation =
        change === "literal-global"
          ? "unchanged"
          : change === "literal-global-visibility"
            ? "visibility"
            : change;
      await f.seed(key, f.other.id);
      const params = {
        sessionKey: key,
        owner: "synthetic",
        repo: "publication",
        number: 1,
        headSha: "a".repeat(40),
      };
      const result: ControlUiSessionPullRequestCheckDetails = {
        owner: params.owner,
        repo: params.repo,
        number: params.number,
        headSha: params.headSha,
        status: "ready",
        rateLimited: false,
        checks: [],
      };
      const entered = createDeferredCore();
      const held = createDeferredCore<ControlUiSessionPullRequestCheckDetails>();
      const load = vi.fn(async () => {
        entered.resolve();
        return await held.promise;
      });
      const respond = vi.fn();
      const request = handleGatewayRequest({
        req: {
          type: "req",
          id: "pending-checks",
          method: "controlUi.sessionPullRequests.checks",
          params,
        },
        client: f.client,
        context: f.context,
        extraHandlers: createControlUiHandlers(undefined, undefined, load),
        isWebchatConnect: () => false,
        respond,
      });
      try {
        await Promise.race([
          entered.promise,
          request.then(() => {
            throw new Error("The registered check-details loader was not entered");
          }),
        ]);
        if (mutation === "store closure") {
          const source = loadGatewaySessionEntryReadOnly(key, { agentId: "main" }).readSource;
          expect(source).toBeDefined();
          await closeOpenClawAgentDatabaseByPathAsync(source!.path);
        } else {
          await f.changeReader(mutation, key);
        }
        held.resolve(result);
        await request;
        expect(respond).toHaveBeenCalledExactlyOnceWith(
          mutation === "unchanged",
          mutation === "unchanged" ? result : undefined,
          mutation === "unchanged" ? undefined : expect.objectContaining({ code: "UNAVAILABLE" }),
        );
      } finally {
        held.resolve(result);
        await request;
      }
    });
  });
});

it.each(["local", "repository"] as const)(
  "reuses prepared %s rows for warm readers without SQLite freshness polling",
  async (source) => {
    await withFixture("operator.read", async (f) => {
      const repositories = getSessionRepositoryWorkspaceStore();
      const repository =
        source === "repository"
          ? repositories.create({
              agentId: "main",
              sessionKey,
              url: "https://github.com/synthetic/publication",
              branch: "guest-change",
              assertCurrent: () => {},
            })
          : undefined;
      if (repository) {
        await f.seed(sessionKey, f.profile.id, { repositoryWorkspaceId: repository.workspaceId });
      }
      await f.subscribe();
      for (let index = 1; index < 20; index++) {
        await f.subscribe([sessionKey], f.addReader(`warm-reader-${index}`).client);
      }
      await f.subscriptions.pollNow();
      const statements = (["get", "all", "iterate"] as const).map((method) =>
        vi.spyOn(StatementSync.prototype, method),
      );
      f.load.mockClear();
      try {
        for (let index = 0; index < 3; index++) {
          await f.subscriptions.pollNow();
        }
        const queries = statements.flatMap((statement) =>
          statement.mock.contexts.map((context) =>
            context instanceof StatementSync ? context.sourceSQL.toLowerCase() : "",
          ),
        );
        expect({
          sessionReads: queries.filter((sql) => sql.includes("session_nodes")).length,
          repositoryReads: queries.filter((sql) => sql.includes("session_repository_workspaces"))
            .length,
          freshnessReads: queries.filter(
            (sql) => sql.includes("pragma") || sql.includes("cache_generation"),
          ).length,
        }).toEqual({ sessionReads: 0, repositoryReads: 0, freshnessReads: 0 });
        expect(f.load).toHaveBeenCalledTimes(3);
        expect(frames(f.socket)).toEqual([expectedFrame(sessionKey)]);
      } finally {
        for (const statement of statements) {
          statement.mockRestore();
        }
      }
      if (repository) {
        const previousCache = f.load.mock.calls[0]?.[1];
        await repositories.delete({ workspaceId: repository.workspaceId, assertCurrent: () => {} });
        const unavailable = { pullRequests: [], rateLimited: false };
        f.load.mockResolvedValue(unavailable);
        await f.subscriptions.pollNow();
        expect(previousCache?.aborted).toBe(true);
        expect(frames(f.socket)).toEqual([
          expectedFrame(sessionKey),
          expectedFrame(sessionKey, unavailable),
        ]);
      }
    });
  },
);

it("keeps warm default-loader SQL constant as readers join without a native row transaction", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    vi.stubEnv("GH_TOKEN", "");
    vi.stubEnv("GITHUB_TOKEN", "");
    const provider = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      );
      if (url.pathname.endsWith("/pulls")) {
        return githubJson([
          pullListItem({
            state: "closed",
            head: {},
            base: { ref: "main", repo: { name: "publication", owner: { login: "synthetic" } } },
          }),
        ]);
      }
      throw new Error(`Unexpected warm PR request: ${url.pathname}`);
    });
    vi.stubGlobal("fetch", provider);
    const f = await createFixture("operator.read", true);
    try {
      const repository = getSessionRepositoryWorkspaceStore().create({
        agentId: "main",
        sessionKey,
        url: "https://github.com/synthetic/publication",
        branch: "guest-change",
        assertCurrent: () => {},
      });
      await f.seed(sessionKey, f.profile.id, { repositoryWorkspaceId: repository.workspaceId });
      await f.subscribe();
      await f.subscriptions.pollNow();
      const measure = async () => {
        const statements = (["get", "all", "iterate"] as const).map((method) =>
          vi.spyOn(StatementSync.prototype, method),
        );
        const executions = vi.spyOn(DatabaseSync.prototype, "exec");
        try {
          for (let index = 0; index < 3; index++) {
            await f.subscriptions.pollNow();
          }
          const queries = statements.flatMap((statement) =>
            statement.mock.contexts.map((context) =>
              context instanceof StatementSync ? context.sourceSQL.toLowerCase() : "",
            ),
          );
          return {
            sessionReads: queries.filter((sql) => sql.includes("session_nodes")).length,
            repositoryReads: queries.filter((sql) => sql.includes("session_repository_workspaces"))
              .length,
            transactions: executions.mock.calls.filter(([sql]) => /^\s*begin\b/iu.test(sql)).length,
          };
        } finally {
          executions.mockRestore();
          for (const statement of statements) {
            statement.mockRestore();
          }
        }
      };
      const oneReader = await measure();
      for (let index = 1; index < 20; index++) {
        await f.subscribe([sessionKey], f.addReader(`default-reader-${index}`).client);
      }
      const twentyReaders = await measure();
      console.info("PR_DEFAULT_LOADER_SQL", JSON.stringify({ oneReader, twentyReaders }));
      expect(twentyReaders).toEqual(oneReader);
      expect(oneReader.transactions).toBe(0);
      expect(frames(f.socket)).toHaveLength(1);
      expect(JSON.stringify(frames(f.socket))).toContain('"number":103469');
      expect(provider).toHaveBeenCalledTimes(1);
    } finally {
      await f.close();
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });
});

it.each(["concurrency limit", "earlier refresh", "publication"] as const)(
  "retires default PR loads queued behind %s",
  async (waitingOn) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      vi.stubEnv("GH_TOKEN", "");
      vi.stubEnv("GITHUB_TOKEN", "");
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const lookedUp: string[] = [];
      const activeLoads = waitingOn === "concurrency limit" ? 4 : 1;
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(async (input) => {
          const url = new URL(
            typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
          );
          if (url.pathname.endsWith("/pulls")) {
            lookedUp.push(url.pathname);
            if (lookedUp.length === activeLoads) {
              entered.resolve();
            }
            await release.promise;
            return githubJson([pullListItem({ state: "closed", head: {} })]);
          }
          return githubJson({ additions: 1, deletions: 0 });
        }),
      );
      const f = await createFixture("operator.read", true);
      try {
        const keys = [];
        for (let index = 0; index < (waitingOn === "concurrency limit" ? 5 : 1); index++) {
          const key = `agent:main:queued-pr-${index}`;
          keys.push(key);
          const repository = getSessionRepositoryWorkspaceStore().create({
            agentId: "main",
            sessionKey: key,
            url: `https://github.com/synthetic/queued-${index}`,
            branch: "guest-change",
            assertCurrent: () => {},
          });
          await f.seed(key, f.profile.id, { repositoryWorkspaceId: repository.workspaceId });
        }
        await f.subscribe(keys);
        await entered.promise;
        const queuedRefresh =
          waitingOn === "earlier refresh"
            ? f.subscriptions.replace(f.client.connId!, keys, new Set(keys))
            : Promise.resolve();
        const source = loadGatewaySessionEntryReadOnly(keys[0]!, { agentId: "main" }).readSource;
        expect(source).toBeDefined();
        let retirement: ReturnType<typeof closeOpenClawAgentDatabaseByPathAsync> | undefined;
        const peer = waitingOn === "publication" ? f.addReader("publication-peer") : undefined;
        if (peer) {
          await f.subscribe(keys, peer.client);
          f.socket.send.mockImplementationOnce(() => {
            retirement = closeOpenClawAgentDatabaseByPathAsync(source!.path);
          });
        } else {
          await closeOpenClawAgentDatabaseByPathAsync(source!.path);
        }
        release.resolve();
        await Promise.all([f.subscriptions.pollNow(), queuedRefresh]);
        await retirement;
        expect(lookedUp).toHaveLength(activeLoads);
        expect(lookedUp.some((url) => url.includes("queued-4"))).toBe(false);
        if (peer) {
          expect(JSON.stringify(frames(f.socket))).toContain('"number":103469');
          expect(JSON.stringify(frames(peer.socket))).not.toContain('"number":103469');
        } else {
          expect(JSON.stringify(frames(f.socket))).not.toContain('"number":103469');
        }
      } finally {
        release.resolve();
        await f.close();
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
      }
    });
  },
);
