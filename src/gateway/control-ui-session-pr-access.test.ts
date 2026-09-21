import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import { getRuntimeConfig } from "../config/io.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { deleteSessionEntryLifecycle } from "../config/sessions.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createDeferredCore } from "../shared/deferred.js";
import { ensureProfileForEmail, linkEmail, setUserProfileRole } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { ControlUiSessionPullRequests } from "./control-ui-contract.js";
import { prepareControlUiSessionPrRead } from "./control-ui-session-pr-read.js";
import { createControlUiSessionPullRequestSubscriptions } from "./control-ui-session-pr-subscriptions.js";
import { createGatewayConnectionState } from "./server-connection-state.js";
import { handleGatewayRequest } from "./server-methods.js";
import {
  disposeSessionReadContexts,
  initializeSessionReadContext,
} from "./server-methods/sessions-read-cache.test-support.js";
import { createGatewayRequestContext } from "./server-request-context.js";
import { makeContextParams } from "./server-request-context.test-support.js";
import { createGatewayWsTestSocket } from "./server/ws-connection.test-helpers.js";
import { createOperatorWsClient } from "./server/ws-connection/authenticated-request-dispatch.test-support.js";
import { loadGatewaySessionEntryReadOnly } from "./session-utils-store.js";

const METHOD = "controlUi.sessionPullRequests.subscribe";
const EVENT = "controlUi.sessionPullRequests.changed";
const sessionKey = "agent:main:guest-publication";
const readerEmail = "guest-publication-reader@example.test";
const branch = { owner: "synthetic", repo: "publication", branch: "guest-change" };
const snapshot: ControlUiSessionPullRequests = { pullRequests: [], branch, rateLimited: false };
type Load = NonNullable<
  Parameters<typeof createControlUiSessionPullRequestSubscriptions>[0]["load"]
>;

async function createFixture(scope: string) {
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
    prepareRead: (connId, watchKey) => {
      const client = connections.clients.getByConnectionId(connId);
      return client
        ? prepareControlUiSessionPrRead({
            client,
            watchKey,
            getRuntimeConfig,
            isCurrentClient: () => connections.clients.getByConnectionId(connId) === client,
          })
        : undefined;
    },
    load,
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
  scope: string,
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
  it.each(["operator.read", "operator.write", "operator.admin"])(
    "delivers the owned branch through the real broadcaster with %s",
    async (scope) => {
      await withFixture(scope, async (f) => {
        await f.subscribe();
        await f.subscriptions.pollNow();
        expect(f.load).toHaveBeenCalledWith(
          { sessionKey, agentId: "main" },
          expect.any(AbortSignal),
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

  it.each([
    "unchanged",
    "role",
    "connection",
    "profile",
    "visibility",
    "grant",
    "replacement grant",
  ] as const)("rechecks the original reader after a pending snapshot (%s)", async (change) => {
    await withFixture("operator.read", async (f) => {
      const key = "agent:main:shared-read";
      await f.seed(key, f.other.id);
      const entered = createDeferredCore<void>();
      const held = createDeferredCore<ControlUiSessionPullRequests>();
      f.load.mockImplementationOnce(async () => {
        entered.resolve();
        return await held.promise;
      });
      try {
        await f.subscribe([key]);
        await entered.promise;
        if (change === "role") {
          const roles = f.cfg.gateway!.roles!;
          setRuntimeConfigSnapshot({
            ...f.cfg,
            gateway: {
              ...f.cfg.gateway,
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
          f.client.invalidated = true;
        } else if (change === "profile") {
          linkEmail(readerEmail, f.other.id);
        } else if (change === "visibility") {
          await f.seed(key, f.other.id, { visibility: "draft", updatedAt: 2 });
        } else if (change === "grant") {
          f.access.abort(new Error("Original access retired"));
        } else if (change === "replacement grant") {
          const replacement = new AbortController();
          f.client.internal = {
            ...f.client.internal,
            operatorAccessAuthority: {
              signal: replacement.signal,
              assertCurrent: () => replacement.signal.throwIfAborted(),
            },
          };
        }
        held.resolve(snapshot);
        await f.subscriptions.pollNow();
        expect(frames(f.socket)).toEqual(change === "unchanged" ? [expectedFrame(key)] : []);
      } finally {
        held.resolve(snapshot);
      }
    });
  });

  it.each(["connection", "grant"] as const)(
    "keeps a shared load for an unchanged viewer when the other %s retires",
    async (retired) => {
      await withFixture("operator.read", async (f) => {
        const entered = createDeferredCore<void>();
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
