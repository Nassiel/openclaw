import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync, executeSqliteQueryTakeFirstSync } from "../infra/kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../infra/sqlite-transaction.js";
import { tableExists, tableHasColumn } from "./openclaw-state-db-schema-helpers.js";
import {
  openOpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db.js";
import { selectUserProfileGitHubIdentities } from "./user-profile-github-identity.js";
import {
  selectResolvedUserProfileMetadataById,
  userProfilesDb,
  userProfileDisplaySelection,
  normalizeUserProfileAvatarMime,
} from "./user-profiles-internal.js";
import {
  ensureUserProfilesSchema,
  hasEnsuredUserProfileRoleSchema,
} from "./user-profiles-schema.js";
import type { UserProfileEmailBinding } from "./user-profiles.types.js";

/** Worker hydration retains unknown legacy bindings without inventing their lifetime. */
export function readUserProfileEmailBindings(
  db: DatabaseSync,
  profileId?: string,
): UserProfileEmailBinding[] {
  if (!tableExists(db, "user_profile_emails")) {
    return [];
  }
  const query = userProfilesDb(db)
    .selectFrom("user_profile_emails")
    .select(["email", "profile_id"])
    .select((eb) => [
      tableHasColumn(db, "user_profile_emails", "binding_id")
        ? "binding_id"
        : eb.val<string | null>(null).as("binding_id"),
    ])
    .orderBy("email", "asc");
  return executeSqliteQuerySync(
    db,
    profileId === undefined ? query : query.where("profile_id", "=", profileId),
  ).rows.map(({ email, profile_id, binding_id }) => ({
    email,
    profileId: profile_id,
    bindingId: binding_id,
  }));
}

/** Alias lookup is observational and never initializes profile storage. */
export function readUserProfileIdForEmail(db: DatabaseSync, email: string): string | undefined {
  if (!tableExists(db, "user_profile_emails") || !tableExists(db, "user_profiles")) {
    return undefined;
  }
  const alias = executeSqliteQueryTakeFirstSync(
    db,
    userProfilesDb(db)
      .selectFrom("user_profile_emails")
      .select("profile_id")
      .where("email", "=", email),
  );
  return alias ? selectResolvedUserProfileMetadataById(db, alias.profile_id)?.id : undefined;
}

export function listUserProfilesSync(options: OpenClawStateDatabaseOptions = {}) {
  ensureUserProfilesSchema(options);
  const database = openOpenClawStateDatabase(options);
  return runSqliteDeferredTransactionSync(
    database.db,
    () => {
      const kysely = userProfilesDb(database.db);
      const profiles = executeSqliteQuerySync(
        database.db,
        kysely
          .selectFrom("user_profiles")
          .select([
            ...userProfileDisplaySelection,
            "created_at",
            // The native role writer can add this column after a worker has opened.
            ...(hasEnsuredUserProfileRoleSchema(database.db) ||
            tableHasColumn(database.db, "user_profiles", "role")
              ? (["role"] as const)
              : []),
          ])
          .orderBy("created_at", "asc")
          .orderBy("id", "asc"),
      ).rows;
      const emails = executeSqliteQuerySync(
        database.db,
        kysely
          .selectFrom("user_profile_emails")
          .select(["profile_id", "email"])
          .orderBy("email", "asc"),
      ).rows;
      const githubIdentities = selectUserProfileGitHubIdentities(database.db);
      const emailsByProfile = new Map<string, string[]>(profiles.map(({ id }) => [id, []]));
      for (const { profile_id, email } of emails) {
        emailsByProfile.get(profile_id)?.push(email);
      }
      return profiles.map((profile) =>
        Object.assign(
          {
            id: profile.id,
            displayName: profile.display_name,
            avatarMime: normalizeUserProfileAvatarMime(profile.avatar_mime),
            mergedInto: profile.merged_into,
            createdAt: profile.created_at,
            updatedAt: profile.updated_at,
            emails: emailsByProfile.get(profile.id) ?? [],
            githubIdentity: githubIdentities.get(profile.id) ?? null,
            hasAvatar: profile.has_avatar === 1,
          },
          profile.role ? { role: profile.role } : {},
        ),
      );
    },
    { databaseLabel: database.path, operationLabel: "user-profiles.list" },
  );
}
