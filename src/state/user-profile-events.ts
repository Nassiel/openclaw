import type { DatabaseSync } from "node:sqlite";
import { stageSqliteTransactionState } from "../infra/sqlite-post-commit.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { notifyListeners, registerListener } from "../shared/listeners.js";
import type { UserProfileEmailBinding } from "./user-profiles.types.js";

type EmailBindingChange = {
  db: DatabaseSync;
  email: string;
  binding: UserProfileEmailBinding | null;
};

const changes = resolveGlobalSingleton(Symbol.for("openclaw.userProfileChanges"), () => ({
  version: 0,
  aliasRevision: 0,
  bindingRevision: 0,
  listeners: new Set<() => void>(),
  bindingListeners: new Set<(change: EmailBindingChange) => void>(),
}));

export function onUserProfileEmailBindingChanged(
  listener: (change: EmailBindingChange) => void,
): () => void {
  return registerListener(changes.bindingListeners, listener);
}

/** Native writer facts become visible with the commit, before profile observers. */
export function stageUserProfileEmailBindingChange(
  db: DatabaseSync,
  email: string,
  binding: UserProfileEmailBinding | null,
): void {
  stageSqliteTransactionState(db, {
    stage: () => {},
    rollback: () => {},
    commit: () => {
      changes.bindingRevision += 1;
      for (const listener of changes.bindingListeners) {
        listener({ db, email, binding });
      }
    },
  });
}

export function readUserProfileEmailBindingRevision(): number {
  return changes.bindingRevision;
}

export function readUserProfileVersion(): number {
  return changes.version;
}

export function readUserProfileAliasRevision(): number {
  return changes.aliasRevision;
}

/** Publish only after a committed merge/unmerge; cosmetic profile updates preserve access. */
export function publishUserProfileAliasChange(): void {
  changes.aliasRevision += 1;
}

export function onUserProfilesChanged(listener: () => void): () => void {
  return registerListener(changes.listeners, listener);
}

/** No profile data crosses this notification; readers reapply their own visibility policy. */
export function emitUserProfilesChanged(): void {
  changes.version += 1;
  notifyListeners(changes.listeners, undefined);
  sessionChanges.emit({ all: true, scope: "profiles" });
}
