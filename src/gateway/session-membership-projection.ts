import type {
  SessionMembershipFact,
  SessionParticipantProjection,
} from "../config/sessions/session-membership-facts.types.js";
import { withPreparedSessionParticipants } from "../config/sessions/session-participant-prepared-read.js";
import { withSessionHistoryWorkerDatabases } from "../config/sessions/session-transcript-worker-runtime.js";
import type { SessionRowChange } from "../sessions/session-row-changes.js";

type SessionMembershipProjectionTarget = {
  agentId: string;
  discoveryAgentId?: string | null;
  discoveryOrder?: number;
  storePath: string;
  identity: string | symbol;
  filename?: string;
};

type Store = {
  target: SessionMembershipProjectionTarget;
  revision: number;
  initial: boolean;
  all: boolean;
  dirty: Set<string>;
  facts: Map<string, SessionMembershipFact>;
};
const noMembership: readonly string[] = Object.freeze([]);
const noParticipants: SessionParticipantProjection = Object.freeze({});
type GroupTarget = Readonly<{ sessionKey: string; agentId: string }>;

function freezeFact(fact: SessionMembershipFact): SessionMembershipFact {
  for (const participant of fact[3].participants ?? []) {
    Object.freeze(participant.identity);
    Object.freeze(participant);
  }
  if (fact[3].participants) {
    Object.freeze(fact[3].participants);
  }
  Object.freeze(fact[3]);
  Object.freeze(fact[2]);
  return Object.freeze(fact);
}

// SQLite BINARY compares UTF-8; UTF-16 string sorting reverses supplementary/BMP keys.
function compareSessionKeys(left: string, right: string): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index++) {
    if (left.charCodeAt(index) !== right.charCodeAt(index)) {
      return left.codePointAt(index)! - right.codePointAt(index)!;
    }
  }
  return left.length - right.length;
}

/** Committed session publications are the only refresh clock for these derived facts. */
export function createSessionMembershipProjection(options: { env?: NodeJS.ProcessEnv } = {}) {
  const env = { ...(options.env ?? process.env) };
  let stores = new Map<string | symbol, Store>();
  let aliases = new Map<string, Store>();
  let disposed = false;
  let pending: Promise<void> | undefined;
  let groups: ReadonlyMap<string, readonly GroupTarget[]> | undefined;
  const needsPreparation = () =>
    !disposed && [...stores.values()].some((store) => store.all || store.dirty.size > 0);
  function updateTargets(targets: readonly SessionMembershipProjectionTarget[]) {
    if (disposed) {
      return;
    }
    const next = new Map<string | symbol, Store>();
    const nextAliases = new Map<string, Store>();
    for (const target of targets) {
      if (typeof target.identity !== "string") {
        continue;
      }
      let store = next.get(target.identity);
      if (!store) {
        store = stores.get(target.identity) ?? {
          target: { ...target },
          revision: 0,
          initial: true,
          all: true,
          dirty: new Set<string>(),
          facts: new Map<string, SessionMembershipFact>(),
        };
        // Preserve first-admitted physical-store order while every locator shares its facts.
        store.target = { ...target };
        next.set(target.identity, store);
      } else if (
        target.discoveryAgentId != null &&
        (store.target.discoveryAgentId == null ||
          (target.discoveryOrder ?? Number.MAX_SAFE_INTEGER) <
            (store.target.discoveryOrder ?? Number.MAX_SAFE_INTEGER))
      ) {
        store.target = {
          ...store.target,
          discoveryAgentId: target.discoveryAgentId,
          discoveryOrder: target.discoveryOrder,
        };
      }
      nextAliases.set(target.storePath, store);
      if (target.filename) {
        nextAliases.set(target.filename, store);
      }
    }
    stores = next;
    aliases = nextAliases;
    groups = undefined;
  }
  function matching(change: { agentId?: string; storePath?: string }) {
    if (change.storePath) {
      const store = aliases.get(change.storePath);
      return store ? [store] : [];
    }
    // Shared physical stores can contain keys from any logical agent.
    return stores.values();
  }
  function invalidate(change: SessionRowChange) {
    if (disposed || (!("all" in change) && change.scope === "automation")) {
      return;
    }
    if ("all" in change) {
      if (typeof change.scope === "string") {
        // Catalog/profile/model publications do not change membership or participant facts.
        if (!change.factsInvalidated && change.scope !== "stores" && change.scope !== "config") {
          return;
        }
      }
      for (const store of matching(typeof change.scope === "string" ? {} : change.scope)) {
        store.revision++;
        store.all = true;
        if (change.factsInvalidated) {
          store.facts.clear();
        }
      }
    } else {
      for (const store of matching(change)) {
        store.revision++;
        if (change.factsInvalidated) {
          store.facts.delete(change.sessionKey);
          store.dirty.add(change.sessionKey);
          continue;
        }
        if (change.membership === undefined && change.participants === undefined) {
          store.dirty.add(change.sessionKey);
        }
        if (change.membership !== undefined || change.participants !== undefined) {
          const previous = store.facts.get(change.sessionKey);
          store.facts.set(
            change.sessionKey,
            freezeFact([
              change.sessionKey,
              previous?.[1] ?? null,
              change.membership === undefined
                ? (previous?.[2] ?? noMembership)
                : [...change.membership],
              change.participants === undefined
                ? (previous?.[3] ?? noParticipants)
                : {
                    ...change.participants,
                    ...(change.participants.participants
                      ? {
                          participants: change.participants.participants.map(({ identity }) => ({
                            identity: { ...identity },
                          })),
                        }
                      : {}),
                  },
            ]),
          );
        }
      }
    }
    groups = undefined;
  }
  async function refresh() {
    while (needsPreparation()) {
      const selected = [...stores.values()].filter((store) => store.all || store.dirty.size > 0);
      const requests = selected.map((store) => ({
        store,
        revision: store.revision,
        keys: store.all ? undefined : [...store.dirty],
      }));
      await withSessionHistoryWorkerDatabases(
        selected.map(({ target }) => ({
          agentId: target.agentId,
          path: target.filename ?? target.storePath,
          env,
        })),
        async (owners) => {
          for (const [index, request] of requests.entries()) {
            const { store, revision, keys } = request;
            const result = await owners[index]!.readMembershipFacts({ sessionKeys: keys, env });
            if (
              disposed ||
              stores.get(store.target.identity) !== store ||
              store.revision !== revision
            ) {
              continue;
            }
            if (result.identity !== undefined && result.identity !== store.target.identity) {
              throw new Error("Session membership store changed before publication");
            }
            if (keys === undefined) {
              store.facts.clear();
            } else {
              for (const key of keys) {
                store.facts.delete(key);
              }
            }
            for (const fact of result.facts) {
              store.facts.set(fact[0], freezeFact(fact));
            }
            store.initial = false;
            store.all = false;
            store.dirty.clear();
            groups = undefined;
          }
        },
      );
    }
  }
  function prepare(): Promise<void> {
    if (!needsPreparation()) {
      return pending ?? Promise.resolve();
    }
    return (pending ??= refresh().then(
      () => {
        pending = undefined;
        return needsPreparation() ? prepare() : undefined;
      },
      (error: unknown) => {
        pending = undefined;
        throw error;
      },
    ));
  }
  function membership(storePath: string, sessionKey: string) {
    const store = aliases.get(storePath);
    return !disposed && store ? (store.facts.get(sessionKey)?.[2] ?? noMembership) : undefined;
  }
  return {
    updateTargets,
    invalidate,
    prepare,
    membership,
    ready(storePath: string, sessionKey: string) {
      const store = aliases.get(storePath);
      return Boolean(
        !disposed && store && !store.initial && !store.all && !store.dirty.has(sessionKey),
      );
    },
    get needsPreparation() {
      return needsPreparation();
    },
    withPreparedParticipantRead<T>(consume: () => T): T {
      if (disposed) {
        throw new Error("Session membership projection is disposed");
      }
      return withPreparedSessionParticipants((identity, sessionKey) => {
        const store = stores.get(identity);
        return store ? (store.facts.get(sessionKey)?.[3] ?? noParticipants) : undefined;
      }, consume);
    },
    groupTargets(): ReadonlyMap<string, readonly GroupTarget[]> {
      if (!groups) {
        const next = new Map<string, GroupTarget[]>();
        const discovered = [...stores.values()]
          .filter(({ target }) => target.discoveryAgentId !== null)
          .toSorted(
            (left, right) =>
              (left.target.discoveryOrder ?? Number.MAX_SAFE_INTEGER) -
              (right.target.discoveryOrder ?? Number.MAX_SAFE_INTEGER),
          );
        for (const store of discovered) {
          for (const key of [...store.facts.keys()].toSorted(compareSessionKeys)) {
            const category = store.facts.get(key)![1];
            if (!category) {
              continue;
            }
            const targets = next.get(category) ?? [];
            targets.push(
              Object.freeze({
                sessionKey: key,
                agentId: store.target.discoveryAgentId ?? store.target.agentId,
              }),
            );
            next.set(category, targets);
          }
        }
        for (const targets of next.values()) {
          Object.freeze(targets);
        }
        groups = next;
      }
      return groups;
    },
    dispose() {
      disposed = true;
      stores.clear();
      aliases.clear();
      groups = undefined;
    },
  };
}
