import { resolveSessionStoreEntryCore } from "../config/sessions/store-entry.js";
import { mergeSessionEntry, type SessionEntry } from "../config/sessions/types.js";

export function createSessionStatusStoreMock(params: {
  loadSessionStore: (storePath: string) => Record<string, SessionEntry>;
  updateSessionStore: (storePath: string, store: Record<string, SessionEntry>) => void;
}) {
  const resolveMockStorePath = (_store: string | undefined, opts?: { agentId?: string }) =>
    opts?.agentId === "support" ? "/tmp/support/sessions.json" : "/tmp/main/sessions.json";
  const cloneEntry = (entry: SessionEntry): SessionEntry => structuredClone(entry);
  return {
    patchSessionEntryWithKey: async (
      scope: { agentId?: string; sessionKey: string; storePath?: string },
      update: (
        entry: SessionEntry,
        context: { existingEntry?: SessionEntry },
      ) => Promise<Partial<SessionEntry> | null> | Partial<SessionEntry> | null,
      options?: { fallbackEntry?: SessionEntry; replaceEntry?: boolean },
    ) => {
      const storePath =
        scope.storePath ?? resolveMockStorePath(undefined, { agentId: scope.agentId });
      const store = params.loadSessionStore(storePath);
      const resolved = resolveSessionStoreEntryCore({ store, sessionKey: scope.sessionKey });
      const existing = resolved.existing ?? options?.fallbackEntry;
      if (!existing) {
        return null;
      }
      const patch = await update(cloneEntry(existing), {
        existingEntry: resolved.existing ? cloneEntry(resolved.existing) : undefined,
      });
      if (!patch) {
        return { sessionKey: resolved.normalizedKey, entry: cloneEntry(existing) };
      }
      const next = options?.replaceEntry
        ? cloneEntry(patch as SessionEntry)
        : mergeSessionEntry(existing, patch);
      store[resolved.normalizedKey] = next;
      params.updateSessionStore(storePath, store);
      return { sessionKey: resolved.normalizedKey, entry: cloneEntry(next) };
    },
    resolveSessionEntryCandidateTarget: (scope: {
      agentId: string;
      candidateKeys: readonly string[];
      cfg: { session?: { store?: string } };
      fallback?: { sessionKey: string; entry: SessionEntry };
    }) => {
      const storePath = resolveMockStorePath(scope.cfg.session?.store, { agentId: scope.agentId });
      const store = params.loadSessionStore(storePath);
      const candidates = [...new Set(scope.candidateKeys.map((key) => key.trim()))];
      for (const candidateKey of candidates) {
        if (!candidateKey) {
          continue;
        }
        const resolved = resolveSessionStoreEntryCore({ store, sessionKey: candidateKey });
        if (!resolved.existing) {
          continue;
        }
        return {
          agentId: scope.agentId,
          candidateKey,
          entry: cloneEntry(resolved.existing),
          persisted: true,
          sessionKey: resolved.normalizedKey,
        };
      }
      const fallbackKey = scope.fallback?.sessionKey.trim();
      return fallbackKey && scope.fallback
        ? {
            agentId: scope.agentId,
            candidateKey: fallbackKey,
            entry: cloneEntry(scope.fallback.entry),
            persisted: false,
            sessionKey: fallbackKey,
          }
        : null;
    },
    resolveSessionStorePathCore: resolveMockStorePath,
  };
}
