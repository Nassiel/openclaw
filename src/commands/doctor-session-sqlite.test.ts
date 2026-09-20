// Doctor session SQLite tests exercise real temp stores and per-agent SQLite files.
import { AsyncResource } from "node:async_hooks";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { SessionManager } from "../agents/sessions/session-manager.js";
import {
  loadExactSessionEntry,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.sqlite-entry.js";
import { importSqliteSessionRows } from "../config/sessions/session-accessor.sqlite-import.test-support.js";
import {
  loadTranscriptEventsSync,
  readTranscriptStatsSync,
} from "../config/sessions/session-accessor.sqlite-read.js";
import * as nodeSqlite from "../infra/node-sqlite.js";
import * as replaceFile from "../infra/replace-file.js";
import {
  AGENT_DATABASE_MAINTENANCE_LEASE,
  claimOpenClawAgentDatabaseLease,
  releaseOpenClawAgentDatabaseLease,
} from "../state/openclaw-agent-db-lease.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  OPENCLAW_AGENT_SCHEMA_VERSION,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import {
  readOpenClawDatabaseQuarantine,
  recordOpenClawDatabaseQuarantine,
} from "../state/openclaw-quarantine-store.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { sessionDeliveryRoute } from "../utils/delivery-context.shared.js";
import {
  createSessionSqliteMigrationRun,
  writeSessionSqliteMigrationManifest,
} from "./doctor-session-sqlite-migration-run.js";
import * as sqliteReaders from "./doctor-session-sqlite-readers.js";
import {
  createTranscriptEventReader,
  readOnlySqliteValidationSnapshot,
  resolveTargetSqlitePath,
} from "./doctor-session-sqlite-readers.js";
import { recoverDoctorSessionSqliteTargets } from "./doctor-session-sqlite-recover-report.js";
import { inspectSessionSqliteRecovery } from "./doctor-session-sqlite-recovery-inventory.js";
import { retireSessionSqliteRecovery } from "./doctor-session-sqlite-retirement.js";
import { createDoctorSessionSqliteTargetReport } from "./doctor-session-sqlite-types.js";
import { runDoctorSessionSqlite } from "./doctor-session-sqlite.js";
import {
  setupDoctorSessionSqliteTest,
  type TestStore,
  importLegacyStore,
  readMigrationManifest,
  requireMigrationManifestPath,
  trustedMigrationTarget,
  canonicalTestPath,
} from "./doctor-session-sqlite.test-support.js";

const { autoCleanupTempDirs, createLegacyStore } = setupDoctorSessionSqliteTest();

describe("runDoctorSessionSqlite", () => {
  it("imports every legacy Codex assistant message, not only the last one", async () => {
    const codexReply = (id: string, parentId: string, content: string) =>
      JSON.stringify({
        type: "message",
        id,
        parentId,
        message: { role: "assistant", provider: "codex", api: "openai-chatgpt-responses", content },
      });
    const userMessage = (id: string, parentId: string | null, content: string) =>
      JSON.stringify({ type: "message", id, parentId, message: { role: "user", content } });
    const store = createLegacyStore({
      transcriptLines: [
        JSON.stringify({ type: "session", id: "session-1", version: 3 }),
        userMessage("user-1", null, "hi"),
        codexReply("reply-1", "user-1", "a"),
        userMessage("user-2", "reply-1", "b"),
        codexReply("reply-2", "user-2", "c"),
        userMessage("user-3", "reply-2", "d"),
      ],
    });

    const imported = await runDoctorSessionSqlite({
      env: store.env,
      mode: "import",
      store: store.storePath,
    });

    expect(imported.targets[0]?.issues).toEqual([]);
    expect(imported.totals).toMatchObject({ importedTranscriptEvents: 6 });
    expect(
      loadTranscriptEventsSync({
        agentId: "main",
        storePath: store.storePath,
        sessionId: "session-1",
      }),
    ).toEqual(
      ["session-1", "user-1", "reply-1", "user-2", "reply-2", "user-3"].map((id) =>
        expect.objectContaining({ id }),
      ),
    );
  });

  it("retains archived source mappings after more than 50 successful migration runs", async () => {
    const store = createLegacyStore();
    const original = fs.readFileSync(store.transcriptPath);
    const imported = await importLegacyStore(store);
    const manifestPath = requireMigrationManifestPath(imported.migrationRun?.manifestPath);
    const manifest = readMigrationManifest(manifestPath);
    const archive = manifest.targets[0]!.completedMoves.find((move) => move.kind === "transcript")!;
    // Real run creation owns retention. Later payload-free successes must not erase rollback maps.
    for (let index = 0; index < 52; index += 1) {
      const run = createSessionSqliteMigrationRun(store.env, [trustedMigrationTarget(store)]);
      run.manifest.completedAt = new Date(Date.now() + index + 1).toISOString();
      writeSessionSqliteMigrationManifest(run);
    }
    expect(fs.readFileSync(archive.archivePath)).toEqual(original);
    const restored = await runDoctorSessionSqlite({
      allAgents: true,
      cfg: {},
      env: store.env,
      mode: "restore",
    });
    expect(restored.targets[0]?.restore?.manifestPaths).toContain(manifestPath);
    expect(fs.readFileSync(store.transcriptPath)).toEqual(original);
  });

  it("uses the requested agent as the owner for explicit-store maintenance", async () => {
    const stateDir = autoCleanupTempDirs.make("openclaw-doctor-explicit-ops-");
    const storePath = path.join(stateDir, "shared", "sessions.json");
    const report = await runDoctorSessionSqlite({
      agent: "ops",
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      mode: "inspect",
      store: storePath,
    });

    expect(report.targets).toHaveLength(1);
    expect(report.targets[0]).toMatchObject({ agentId: "ops", storePath });
  });

  it("reads populated v13 session_entries before migration", () => {
    const stateDir = autoCleanupTempDirs.make("openclaw-doctor-v13-reader-");
    const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
    const target = { agentId: "main", storePath };
    const sqlitePath = resolveTargetSqlitePath(target);
    fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
    const sqlite = nodeSqlite.requireNodeSqlite();
    const database = new sqlite.DatabaseSync(sqlitePath);
    try {
      database.exec(`
        CREATE TABLE session_entries (
          session_key TEXT NOT NULL PRIMARY KEY,
          session_id TEXT NOT NULL,
          entry_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
        INSERT INTO session_entries (session_key, session_id, entry_json, updated_at)
        VALUES (
          'agent:main:v13-reader',
          'v13-reader-session',
          '{"sessionId":"v13-reader-session","updatedAt":13}',
          13
        );
        PRAGMA user_version = 13;
      `);
    } finally {
      database.close();
    }

    expect(readOnlySqliteValidationSnapshot(target)).toEqual({
      ok: true,
      snapshot: {
        sessionIdsBySessionKey: new Map([["agent:main:v13-reader", "v13-reader-session"]]),
        sessionKeysBySessionId: new Map(),
        transcriptEventCountsBySessionId: new Map(),
      },
    });
  });

  it("excludes v14 transcript-only nodes from doctor entry reads", () => {
    const stateDir = autoCleanupTempDirs.make("openclaw-doctor-v14-reader-");
    const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
    const target = { agentId: "main", storePath };
    const sqlitePath = resolveTargetSqlitePath(target);
    fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
    const sqlite = nodeSqlite.requireNodeSqlite();
    const database = new sqlite.DatabaseSync(sqlitePath);
    try {
      database.exec(`
        CREATE TABLE session_nodes (
          session_key TEXT NOT NULL PRIMARY KEY,
          current_session_id TEXT NOT NULL,
          entry_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
        INSERT INTO session_nodes VALUES
          ('agent:main:transcript-only', 'transcript-only-session', '{}', 14),
          ('agent:main:v14-reader', 'v14-reader-session',
           '{"sessionId":"v14-reader-session","updatedAt":14}', 14);
        PRAGMA user_version = 14;
      `);
    } finally {
      database.close();
    }

    expect(readOnlySqliteValidationSnapshot(target)).toEqual({
      ok: true,
      snapshot: {
        sessionIdsBySessionKey: new Map([["agent:main:v14-reader", "v14-reader-session"]]),
        sessionKeysBySessionId: new Map(),
        transcriptEventCountsBySessionId: new Map(),
      },
    });
  });

  it("reads compact promoted validation identities without parsing large entry JSON", () => {
    const stateDir = autoCleanupTempDirs.make("openclaw-doctor-compact-validation-");
    const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
    const target = { agentId: "main", storePath };
    const sqlitePath = resolveTargetSqlitePath(target);
    fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
    const sqlite = nodeSqlite.requireNodeSqlite();
    const database = new sqlite.DatabaseSync(sqlitePath);
    const payload = "x".repeat(2 * 1024 * 1024);
    const entryJson = JSON.stringify({
      payload,
      sessionId: "embedded-stale-id",
      updatedAt: 17,
    });
    try {
      database.exec(`
        CREATE TABLE session_nodes (
          session_key TEXT NOT NULL PRIMARY KEY,
          current_session_id TEXT NOT NULL,
          entry_json TEXT NOT NULL,
          entry_valid INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE transcript_events (
          session_id TEXT NOT NULL,
          event_json TEXT NOT NULL
        );
      `);
      database
        .prepare("INSERT INTO session_nodes VALUES (?, ?, ?, 1, 17)")
        .run("agent:main:compact", "promoted-session-id", entryJson);
      database
        .prepare("INSERT INTO transcript_events VALUES (?, '{}'), (?, '{}')")
        .run("promoted-session-id", "promoted-session-id");
    } finally {
      database.close();
    }
    const parseSpy = vi.spyOn(JSON, "parse");
    try {
      expect(readOnlySqliteValidationSnapshot(target)).toEqual({
        ok: true,
        snapshot: {
          sessionIdsBySessionKey: new Map([["agent:main:compact", "promoted-session-id"]]),
          sessionKeysBySessionId: new Map(),
          transcriptEventCountsBySessionId: new Map([["promoted-session-id", 2]]),
        },
      });
      expect(parseSpy.mock.calls.some(([value]) => value === entryJson)).toBe(false);
    } finally {
      parseSpy.mockRestore();
    }
  });

  it("imports zero legacy records without parsing canonical entry JSON", async () => {
    const stateDir = autoCleanupTempDirs.make("openclaw-doctor-empty-import-");
    const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(storePath, "{}\n", { mode: 0o600 });
    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    const entryJson = JSON.stringify({
      payload: "empty-import-sentinel".repeat(64 * 1024),
      sessionId: "canonical-only-session",
      updatedAt: 19,
    });
    database.db
      .prepare(
        "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at) VALUES (?, ?, ?, ?)",
      )
      .run("agent:main:main", "canonical-only-session", entryJson, 19);
    database.db.prepare("UPDATE session_nodes SET entry_valid = 1").run();
    const sqlitePath = database.path;
    closeOpenClawAgentDatabasesForTest();
    const parseSpy = vi.spyOn(JSON, "parse");
    try {
      const report = await runDoctorSessionSqlite({ env, mode: "import", store: storePath });
      expect(report.totals).toMatchObject({
        importedEntries: 0,
        issues: 0,
        legacyEntries: 0,
        sqliteEntries: 1,
      });
      expect(parseSpy.mock.calls.some(([value]) => value === entryJson)).toBe(false);
    } finally {
      parseSpy.mockRestore();
    }
    const verifier = new (nodeSqlite.requireNodeSqlite().DatabaseSync)(sqlitePath, {
      readOnly: true,
    });
    try {
      expect(verifier.prepare("SELECT entry_json FROM session_nodes").get()).toEqual({
        entry_json: entryJson,
      });
    } finally {
      verifier.close();
    }
  });

  it("dry-runs a legacy store without writing SQLite rows", async () => {
    const store = createLegacyStore();

    const report = await runDoctorSessionSqlite({
      env: store.env,
      mode: "dry-run",
      store: store.storePath,
    });

    expect(report.totals).toMatchObject({
      importedEntries: 0,
      importedTranscriptEvents: 0,
      issues: 0,
      legacyEntries: 1,
      sqliteEntries: 0,
      targets: 1,
      unreferencedJsonlFiles: 2,
      validatedEntries: 1,
      validatedTranscriptEvents: 2,
    });
    expect(report.targets[0]?.sqlitePath).toBeTruthy();
    expect(fs.existsSync(report.targets[0]?.sqlitePath ?? "")).toBe(false);
  });

  it("inspects a legacy store without creating a SQLite database", async () => {
    const store = createLegacyStore();

    const report = await runDoctorSessionSqlite({
      env: store.env,
      mode: "inspect",
      store: store.storePath,
    });

    expect(report.totals).toMatchObject({
      issues: 0,
      legacyEntries: 1,
      sqliteEntries: 0,
      targets: 1,
    });
    expect(report.targets[0]?.sqlitePath).toBeTruthy();
    expect(fs.existsSync(report.targets[0]?.sqlitePath ?? "")).toBe(false);
  });

  it("reports store_unreadable instead of crashing when the store stat fails", async () => {
    const store = createLegacyStore();
    // Replace the sessions directory with a regular file so statSync on the
    // store path throws ENOTDIR (non-ENOENT errors bypass throwIfNoEntry).
    fs.rmSync(store.sessionDir, { force: true, recursive: true });
    fs.writeFileSync(store.sessionDir, "not a directory\n", { mode: 0o600 });

    const report = await runDoctorSessionSqlite({
      env: store.env,
      mode: "inspect",
      store: store.storePath,
    });

    expect(report.targets[0]?.issues).toEqual([
      expect.objectContaining({ code: "store_unreadable" }),
    ]);
  });

  it("reports store_unreadable for a non-regular store path", async () => {
    const store = createLegacyStore();

    const report = await runDoctorSessionSqlite({
      env: store.env,
      mode: "inspect",
      store: store.sessionDir,
    });

    expect(report.targets[0]?.issues).toEqual([
      expect.objectContaining({
        code: "store_unreadable",
        message: expect.stringContaining("not a regular file"),
      }),
    ]);
  });

  it("inspects SQLite-only all-agent targets without requiring a legacy store", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-session-sqlite-"));
    try {
      const stateDir = path.join(tempDir, "state");
      const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      await upsertSessionEntryCore(
        { agentId: "main", env, sessionKey: "agent:main:main", storePath },
        { sessionId: "sqlite-session", updatedAt: Date.now() },
      );

      const report = await runDoctorSessionSqlite({
        allAgents: true,
        cfg: {},
        env,
        mode: "inspect",
      });

      expect(fs.existsSync(storePath)).toBe(false);
      expect(report.totals).toMatchObject({
        issues: 0,
        legacyEntries: 0,
        sqliteEntries: 1,
        targets: 1,
      });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("migrates a dormant historical agent database before all-agent import compaction", async () => {
    const tempDir = autoCleanupTempDirs.make("openclaw-doctor-session-sqlite-");
    const stateDir = path.join(tempDir, "state");
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const agentIds = ["dormant", "current"] as const;
    for (const agentId of agentIds) {
      const sessionsDir = path.join(stateDir, "agents", agentId, "sessions");
      fs.mkdirSync(sessionsDir, { recursive: true });
      fs.writeFileSync(path.join(sessionsDir, "sessions.json"), "{}\n", { mode: 0o600 });
    }
    const dormantPath = createHistoricalV1AgentDatabase({ agentId: "dormant", env });
    const currentPath = openOpenClawAgentDatabase({ agentId: "current", env }).path;
    closeOpenClawAgentDatabasesForTest();

    const sqlite = nodeSqlite.requireNodeSqlite();
    const currentBefore = new sqlite.DatabaseSync(currentPath);
    const currentUpdatedAt = expectDefined(
      currentBefore
        .prepare("SELECT updated_at FROM schema_meta WHERE meta_key = 'primary'")
        .get() as { updated_at?: number } | undefined,
      "current schema metadata",
    ).updated_at;
    currentBefore.close();

    const report = await runDoctorSessionSqlite({
      allAgents: true,
      cfg: { agents: { list: agentIds.map((id) => ({ id })) } },
      env,
      mode: "import",
    });

    expect(report.totals).toMatchObject({
      importedEntries: 0,
      issues: 0,
      targets: 2,
    });
    expect(report.targets.find((target) => target.agentId === "dormant")?.compact).toMatchObject({
      skipped: false,
    });
    const dormantAfter = new sqlite.DatabaseSync(dormantPath);
    const currentAfter = new sqlite.DatabaseSync(currentPath);
    try {
      expect(dormantAfter.prepare("PRAGMA user_version").get()).toEqual({
        user_version: OPENCLAW_AGENT_SCHEMA_VERSION,
      });
      expect(
        dormantAfter
          .prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'")
          .get(),
      ).toEqual({ schema_version: OPENCLAW_AGENT_SCHEMA_VERSION });
      expect(
        dormantAfter
          .prepare("PRAGMA table_info(session_windows)")
          .all()
          .map((column) => (column as { name?: unknown }).name),
      ).toContain("session_scope");
      expect(
        dormantAfter
          .prepare("PRAGMA table_info(memory_index_sources)")
          .all()
          .map((column) => (column as { name?: unknown }).name),
      ).toEqual(["id", "path", "source", "hash", "mtime", "size"]);
      expect(dormantAfter.prepare("PRAGMA integrity_check").get()).toEqual({
        integrity_check: "ok",
      });
      expect(dormantAfter.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(
        currentAfter
          .prepare("SELECT schema_version, updated_at FROM schema_meta WHERE meta_key = 'primary'")
          .get(),
      ).toEqual({
        schema_version: OPENCLAW_AGENT_SCHEMA_VERSION,
        updated_at: currentUpdatedAt,
      });
    } finally {
      dormantAfter.close();
      currentAfter.close();
    }
  });

  it("keeps mismatched older agent schema versions blocking during all-agent import", async () => {
    const tempDir = autoCleanupTempDirs.make("openclaw-doctor-session-sqlite-");
    const stateDir = path.join(tempDir, "token=supersecret", "state");
    const sessionsDir = path.join(stateDir, "agents", "drifted", "sessions");
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(path.join(sessionsDir, "sessions.json"), "{}\n", { mode: 0o600 });
    const sqlitePath = openOpenClawAgentDatabase({ agentId: "drifted", env }).path;
    closeOpenClawAgentDatabasesForTest();

    const sqlite = nodeSqlite.requireNodeSqlite();
    const database = new sqlite.DatabaseSync(sqlitePath);
    try {
      database.exec("PRAGMA user_version = 1;");
      database
        .prepare("UPDATE schema_meta SET schema_version = 2 WHERE meta_key = 'primary'")
        .run();
    } finally {
      database.close();
    }

    const report = await runDoctorSessionSqlite({
      allAgents: true,
      cfg: { agents: { list: [{ id: "drifted" }] } },
      env,
      mode: "import",
    });

    expect(report.targets[0]?.issues).toEqual([
      expect.objectContaining({
        code: "sqlite_compact_failed",
        message: expect.stringMatching(/uses schema version 1/iu),
      }),
    ]);
    const manifest = readMigrationManifest(report.migrationRun?.manifestPath);
    expect(manifest.failedAt).toBeTruthy();
    expect(manifest.failureReports).toBeDefined();
    const failureReportPath = expectDefined(
      report.migrationRun?.failureReportMarkdownPath,
      "blocking migration failure report path",
    );
    const failureReport = fs.readFileSync(failureReportPath, "utf-8");
    expect(failureReport).toContain("sqlite_compact_failed");
    expect(failureReport).toContain("openclaw doctor --session-sqlite recover --github-issue");
    expect(failureReport).not.toContain("supersecret");
    const after = new sqlite.DatabaseSync(sqlitePath);
    try {
      expect(after.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
      expect(
        after.prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'").get(),
      ).toEqual({ schema_version: 2 });
    } finally {
      after.close();
    }
  });

  it("repairs legacy transcript and route shapes at the import boundary", async () => {
    const store = createLegacyStore({
      entryOverrides: {
        route: "stale-custom-slot",
        deliveryContext: { channel: "telegram", to: "123" },
      },
      transcriptLines: [
        '{"type":"session","sessionId":"session-1"}',
        '{"type":"plugin_state","id":"opaque-1","payload":{"keep":"exact"}}',
        '{"type":"message","id":"m1","parentId":null,"message":{"role":"assistant","content":"legacy string"}}',
        '{"type":"compaction","summary":"legacy summary","firstKeptEntryIndex":2,"tokensBefore":42}',
      ],
    });

    const report = await importLegacyStore(store);

    expect(report.totals).toMatchObject({ importedEntries: 1, issues: 0 });
    const imported = loadExactSessionEntry({
      agentId: "main",
      sessionKey: "agent:main:main",
      storePath: store.storePath,
    });
    // The SQLite runtime does no read repair, so import must store canonical shapes.
    expect(typeof sessionDeliveryRoute(imported?.entry)).not.toBe("string");
    const events = loadTranscriptEventsSync({
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      storePath: store.storePath,
    });
    const message = events.find((event) => (event as { type?: string }).type === "message") as {
      id?: string;
      message?: { content?: unknown };
    };
    const compaction = events.find(
      (event) => (event as { type?: string }).type === "compaction",
    ) as { firstKeptEntryId?: string; parentId?: string };
    expect(events[0]).toMatchObject({
      id: "session-1",
      type: "session",
      version: 3,
    });
    expect(events[0]).not.toHaveProperty("sessionId");
    expect(events[1]).toEqual({
      id: "opaque-1",
      payload: { keep: "exact" },
      type: "plugin_state",
    });
    expect(message?.message?.content).toEqual([{ type: "text", text: "legacy string" }]);
    expect(compaction).toMatchObject({
      firstKeptEntryId: message.id,
      parentId: message.id,
    });
    const manager = SessionManager.open(
      {
        agentId: "main",
        sessionId: "session-1",
        sessionKey: "agent:main:main",
        storePath: store.storePath,
      },
      store.tempDir,
    );
    expect(
      manager.appendMessage({
        content: "post-import message",
        role: "user",
        timestamp: Date.now(),
      }),
    ).toEqual(expect.any(String));
    closeOpenClawAgentDatabasesForTest();
    const sqlite = nodeSqlite.requireNodeSqlite();
    const migrated = new sqlite.DatabaseSync(
      resolveOpenClawAgentSqlitePath({ agentId: "main", env: store.env }),
      { readOnly: true },
    );
    try {
      expect(migrated.prepare("PRAGMA user_version").get()).toEqual({
        user_version: OPENCLAW_AGENT_SCHEMA_VERSION,
      });
      expect(
        migrated
          .prepare(
            "SELECT session_id, length(generation) AS generation_length FROM transcript_rewrite_watermarks",
          )
          .all(),
      ).toEqual([{ generation_length: 32, session_id: "session-1" }]);
    } finally {
      migrated.close();
    }
  });

  it("aborts import when the legacy transcript changes between passes", () => {
    const store = createLegacyStore();
    const realStatSync = fs.statSync.bind(fs);
    let fingerprintReads = 0;
    const statSpy = vi.spyOn(fs, "statSync").mockImplementation(((candidate, options) => {
      const stat = realStatSync(candidate, options as never);
      if (
        path.resolve(String(candidate)) === path.resolve(store.transcriptPath) &&
        (options as { bigint?: boolean } | undefined)?.bigint === true
      ) {
        fingerprintReads += 1;
        if (fingerprintReads === 2) {
          fs.appendFileSync(store.transcriptPath, '{"type":"custom","customType":"late"}\n');
        }
      }
      return stat;
    }) as typeof fs.statSync);

    try {
      const events: unknown[] = [];
      expect(() =>
        createTranscriptEventReader(
          store.transcriptPath,
          "session-1",
        )((event) => {
          events.push(event);
        }),
      ).toThrow(/stop active session writers and rerun `openclaw doctor --fix`/);
      expect(events).toEqual([]);
    } finally {
      statSpy.mockRestore();
    }
  });

  it("aborts a batch when a prepared transcript changes before import", async () => {
    const store = createLegacyStore();
    const realStatSync = fs.statSync.bind(fs);
    let changed = false;
    const statSpy = vi.spyOn(fs, "statSync").mockImplementation(((candidate, options) => {
      const stat = realStatSync(candidate, options as never);
      if (
        !changed &&
        path.resolve(String(candidate)) === path.resolve(store.transcriptPath) &&
        !(options as { bigint?: boolean } | undefined)?.bigint
      ) {
        changed = true;
        fs.appendFileSync(store.transcriptPath, '{"type":"custom","customType":"late"}\n');
      }
      return stat;
    }) as typeof fs.statSync);

    try {
      await expect(importLegacyStore(store)).rejects.toThrow(
        /stop active session writers and rerun `openclaw doctor --fix`/,
      );
      expect(fs.existsSync(store.transcriptPath)).toBe(true);
    } finally {
      statSpy.mockRestore();
    }
  });

  it("preserves the legacy transcript mtime as the SQLite mutation watermark", async () => {
    const store = createLegacyStore();
    const transcriptMtimeMs = 1_700_000_000_000;
    const transcriptMtime = new Date(transcriptMtimeMs);
    fs.utimesSync(store.transcriptPath, transcriptMtime, transcriptMtime);

    const report = await importLegacyStore(store);

    expect(report.totals).toMatchObject({ importedEntries: 1, issues: 0 });
    expect(
      readTranscriptStatsSync({
        agentId: "main",
        sessionId: "session-1",
        sessionKey: "agent:main:main",
        storePath: store.storePath,
      }).lastMutationAtMs,
    ).toBe(transcriptMtimeMs);
  });

  it("preserves a same-generation canonical harness owner during legacy import", async () => {
    const store = createLegacyStore({
      entryOverrides: { lifecycleRevision: "rev-1" },
    });
    await upsertSessionEntryCore(
      {
        agentId: "main",
        env: store.env,
        sessionKey: "agent:main:main",
        storePath: store.storePath,
      },
      {
        agentHarnessId: "codex",
        lifecycleRevision: "rev-1",
        sessionId: "session-1",
        updatedAt: 3000,
      },
    );
    const report = await importLegacyStore(store);

    expect(report.totals).toMatchObject({ importedEntries: 1, issues: 0 });
    expect(
      loadExactSessionEntry({
        agentId: "main",
        sessionKey: "agent:main:main",
        storePath: store.storePath,
      })?.entry,
    ).toMatchObject({
      agentHarnessId: "codex",
      lifecycleRevision: "rev-1",
      sessionId: "session-1",
    });
  });

  it.each([true, false])(
    "preserves required=%s creation provenance when importing an older legacy row",
    async (required) => {
      const legacyStamp = {
        createdActor: { id: "profile-legacy", type: "human" as const },
        createdAt: 1000,
        createdVia: "channel" as const,
      };
      const authoritativeStamp = {
        createdActor: {
          id: "profile-protected",
          type: "human" as const,
          source: "profile" as const,
        },
        createdAt: 1500,
        createdVia: "operator" as const,
        ...(required ? { sandbox: "required" as const } : {}),
      };
      const store = createLegacyStore({ entryOverrides: legacyStamp });
      const scope = {
        agentId: "main",
        env: store.env,
        sessionKey: "agent:main:main",
        storePath: store.storePath,
      };
      await upsertSessionEntryCore(scope, {
        ...authoritativeStamp,
        sessionId: "session-1",
        updatedAt: 3000,
      });

      const report = await importLegacyStore(store);

      expect(report.totals).toMatchObject({ importedEntries: 1, issues: 0 });
      const imported = loadExactSessionEntry(scope)?.entry;
      expect(imported).toMatchObject({
        ...(required
          ? authoritativeStamp
          : {
              ...legacyStamp,
              createdActor: { ...legacyStamp.createdActor, source: "channel" },
            }),
        sessionId: "session-1",
      });
      if (!required) {
        expect(imported).not.toHaveProperty("sandbox");
      }
    },
  );

  it("imports and validates legacy sessions idempotently", async () => {
    const store = createLegacyStore();

    const firstImport = await importLegacyStore(store);
    const secondImport = await importLegacyStore(store);
    const validation = await runDoctorSessionSqlite({
      env: store.env,
      mode: "validate",
      store: store.storePath,
    });
    const inspect = await runDoctorSessionSqlite({
      env: store.env,
      mode: "inspect",
      store: store.storePath,
    });

    expect(firstImport.totals).toMatchObject({
      archivedLegacyStoreFiles: 1,
      archivedTranscriptFiles: 2,
      archivedUnreferencedJsonlFiles: 1,
      importedEntries: 1,
      importedTranscriptEvents: 2,
      issues: 0,
      sqliteEntries: 1,
      unreferencedJsonlFiles: 0,
    });
    expect(secondImport.totals).toMatchObject({
      archivedLegacyStoreFiles: 0,
      archivedTranscriptFiles: 0,
      archivedUnreferencedJsonlFiles: 0,
      importedEntries: 0,
      importedTranscriptEvents: 0,
      issues: 0,
      sqliteEntries: 0,
      unreferencedJsonlFiles: 0,
      validatedEntries: 0,
      validatedTranscriptEvents: 0,
    });
    expect(validation.totals).toMatchObject({
      issues: 0,
      validatedEntries: 0,
      validatedTranscriptEvents: 0,
    });
    expect(fs.existsSync(store.storePath)).toBe(false);
    expect(fs.existsSync(store.transcriptPath)).toBe(false);
    expect(fs.existsSync(store.trajectoryPath)).toBe(false);
    expect(fs.existsSync(store.unreferencedJsonlPath)).toBe(false);
    expect(firstImport.targets[0]?.archivedTranscriptFiles).toHaveLength(2);
    for (const archivedTranscriptPath of firstImport.targets[0]?.archivedTranscriptFiles ?? []) {
      expect(archivedTranscriptPath).toBeTruthy();
      expect(archivedTranscriptPath).not.toContain(`${path.sep}sessions${path.sep}`);
      expect(fs.existsSync(archivedTranscriptPath)).toBe(true);
    }
    expect(firstImport.targets[0]?.archivedUnreferencedJsonlFiles).toHaveLength(1);
    const archivedUnreferencedPath = expectDefined(
      firstImport.targets[0]?.archivedUnreferencedJsonlFiles[0],
      "firstImport.targets[0]?.archivedUnreferencedJsonlFiles[0] test invariant",
    );
    expect(archivedUnreferencedPath).toBeTruthy();
    expect(archivedUnreferencedPath).not.toContain(`${path.sep}sessions${path.sep}`);
    expect(archivedUnreferencedPath).toContain("archive-tier.orphan.jsonl.imported-");
    expect(fs.existsSync(archivedUnreferencedPath)).toBe(true);
    expect(fs.readFileSync(archivedUnreferencedPath, "utf-8")).toBe('{"type":"event"}\n');
    expect(inspect.totals.sqliteEntries).toBe(1);
    expect(inspect.totals.unreferencedJsonlFiles).toBe(0);
    expect(
      loadExactSessionEntry({
        agentId: "main",
        sessionKey: "agent:main:main",
        storePath: store.storePath,
      })?.entry,
    ).not.toHaveProperty("sessionFile");
    expect(
      loadTranscriptEventsSync({
        agentId: "main",
        sessionId: "session-1",
        sessionKey: "agent:main:main",
        storePath: store.storePath,
      }),
    ).toHaveLength(2);
  });

  it("archives legacy stores with valid sessions and invalid cron stubs without failing", async () => {
    const store = createLegacyStore();
    const legacyStore = JSON.parse(fs.readFileSync(store.storePath, "utf-8")) as Record<
      string,
      unknown
    >;
    const cronStubKey = "agent:main:cron:legacy-stub";
    legacyStore[cronStubKey] = { updatedAt: 1500 };
    fs.writeFileSync(store.storePath, `${JSON.stringify(legacyStore, null, 2)}\n`, { mode: 0o600 });

    const report = await importLegacyStore(store);

    expect(report.totals).toMatchObject({
      archivedLegacyStoreFiles: 1,
      importedEntries: 1,
      importedTranscriptEvents: 2,
      issues: 1,
      sqliteEntries: 1,
    });
    expect(report.targets[0]?.issues).toEqual([
      {
        code: "entry_invalid",
        message: expect.stringContaining(
          `${store.storePath}: session entry is missing a valid sessionId`,
        ),
        sessionKey: cronStubKey,
      },
    ]);
    const archivedStorePath = expectDefined(
      report.targets[0]?.archivedLegacyStoreFiles?.[0],
      "archived legacy store path",
    );
    expect(fs.existsSync(store.storePath)).toBe(false);
    expect(fs.existsSync(archivedStorePath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(archivedStorePath, "utf-8"))).toMatchObject({
      [cronStubKey]: { updatedAt: 1500 },
    });

    const manifest = readMigrationManifest(report.migrationRun?.manifestPath);
    expect(manifest.failedAt).toBeUndefined();
    expect(manifest.failureReports).toBeUndefined();
    expect(manifest.targets[0]).toMatchObject({
      issues: [expect.objectContaining({ code: "entry_invalid", sessionKey: cronStubKey })],
      validationBeforeArchive: "passed",
    });
    expect(report.migrationRun?.failureReportJsonPath).toBeUndefined();
    expect(report.migrationRun?.failureReportMarkdownPath).toBeUndefined();
    expect(fs.existsSync(store.unreferencedJsonlPath)).toBe(true);
    expect(
      manifest.targets[0]!.completedMoves.every(
        (move) => move.artifact?.classification === "protected",
      ),
    ).toBe(true);
    closeOpenClawAgentDatabasesForTest();
    const cleanup = await retireSessionSqliteRecovery({
      env: store.env,
      preview: inspectSessionSqliteRecovery({ cfg: {}, env: store.env }),
      readConfig: async () => ({}),
      confirm: async () => true,
    });
    expect(cleanup.totals.removedFiles).toBe(0);
    expect(fs.existsSync(archivedStorePath)).toBe(true);
  });

  it.each(["NONE", "FULL", "INCREMENTAL"] as const)(
    "finalizes imports from auto_vacuum=%s without unnecessary repacking",
    async (autoVacuum) => {
      const { sqlitePath, store } = await createImportedStoreForCompaction();
      fs.writeFileSync(store.storePath, "{}\n");
      const database = nodeSqlite.openNodeSqliteDatabase(sqlitePath);
      let freelistBefore: number;
      try {
        database.exec(`PRAGMA auto_vacuum = ${autoVacuum}; VACUUM;
          CREATE TABLE cleanup_payload (id INTEGER PRIMARY KEY, body TEXT NOT NULL);
          CREATE TABLE cleanup_discard (body BLOB);
          BEGIN;`);
        const insert = database.prepare("INSERT INTO cleanup_payload VALUES (?, ?)");
        for (let index = 0; index < 1000; index++) {
          insert.run(index, "x".repeat(1000));
        }
        // Keep partially filled pages as well as completely freed pages: only full
        // compaction should repack the former when pointer maps already exist.
        database.exec(`COMMIT; UPDATE cleanup_payload SET body = 'keep';
          INSERT INTO cleanup_discard VALUES (zeroblob(1048576));
          DELETE FROM cleanup_discard; PRAGMA wal_checkpoint(TRUNCATE);`);
        freelistBefore = Number(database.prepare("PRAGMA freelist_count").get()?.freelist_count);
      } finally {
        database.close();
      }
      const imported = await importLegacyStore(store);
      expect(imported.totals.issues).toBe(0);
      const cleanup = expectDefined(imported.targets[0]?.compact, "import cleanup");
      expect(cleanup.freelistAfterPages).toBe(0);
      if (autoVacuum !== "FULL") {
        expect(freelistBefore).toBeGreaterThan(0);
        expect(cleanup.reclaimedBytes).toBeGreaterThan(0);
      }
      const compacted = await runDoctorSessionSqlite({
        env: store.env,
        mode: "compact",
        store: store.storePath,
      });
      expect(compacted.totals.issues).toBe(0);
      const packed = expectDefined(compacted.targets[0]?.compact, "explicit compaction");
      if (autoVacuum === "NONE") {
        expect(packed.dbSizeAfterBytes).toBe(cleanup.dbSizeAfterBytes);
      } else {
        expect(packed.dbSizeAfterBytes).toBeLessThan(cleanup.dbSizeAfterBytes);
      }
      const after = nodeSqlite.openNodeSqliteDatabase(sqlitePath, { readOnly: true });
      try {
        expect(after.prepare("PRAGMA auto_vacuum").get()).toEqual({ auto_vacuum: 2 });
        expect(after.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
        expect(after.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
        expect(after.prepare("SELECT id, body FROM cleanup_payload ORDER BY id").all()).toEqual(
          Array.from({ length: 1000 }, (_, id) => ({ id, body: "keep" })),
        );
      } finally {
        after.close();
      }
    },
  );

  it("compacts migrated agent SQLite databases and reports reclaimed pages", async () => {
    const store = createLegacyStore({
      transcriptLines: [
        '{"type":"session","sessionId":"session-1"}',
        ...Array.from({ length: 240 }, (_, index) =>
          JSON.stringify({
            id: `evt-${index}`,
            message: { content: "x".repeat(2_000), role: "user" },
            type: "message",
          }),
        ),
      ],
    });
    const importReport = await importLegacyStore(store);
    const sqlitePath = importReport.targets[0]?.sqlitePath;
    expect(sqlitePath).toBeTruthy();
    const sqlite = nodeSqlite.requireNodeSqlite();
    const db = new sqlite.DatabaseSync(sqlitePath ?? "");
    try {
      db.exec("DELETE FROM transcript_events;");
    } finally {
      db.close();
    }

    const compact = await runDoctorSessionSqlite({
      env: store.env,
      mode: "compact",
      store: store.storePath,
    });

    expect(compact.totals.issues).toBe(0);
    expect(compact.totals.reclaimedBytes).toBeGreaterThan(0);
    expect(compact.targets[0]?.compact).toMatchObject({
      freelistAfterPages: 0,
      skipped: false,
    });
    expect(compact.targets[0]?.compact?.freelistBeforePages).toBeGreaterThan(0);
    expect(compact.targets[0]?.compact?.dbSizeAfterBytes).toBeLessThan(
      compact.targets[0]?.compact?.dbSizeBeforeBytes ?? 0,
    );
  });

  it.skipIf(process.platform === "win32")(
    "allows hard-linked legacy stores during SQLite compaction",
    async () => {
      const { store } = await createImportedStoreForCompaction();
      const externalStorePath = path.join(store.tempDir, "external-sessions.json");
      fs.writeFileSync(store.storePath, "{}\n", { mode: 0o600 });
      fs.linkSync(store.storePath, externalStorePath);

      const report = await runDoctorSessionSqlite({
        env: store.env,
        mode: "compact",
        store: store.storePath,
      });

      expect(report.totals.issues).toBe(0);
      expect(fs.statSync(externalStorePath).nlink).toBe(2);
      expect(fs.readFileSync(externalStorePath, "utf8")).toBe("{}\n");
    },
  );

  it("preserves the typed maintenance cause when import finalization fails", async () => {
    const store = createLegacyStore();
    fs.writeFileSync(store.storePath, "{}\n");
    openOpenClawAgentDatabase({ agentId: "main", env: store.env });
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    const openDatabase = nodeSqlite.openNodeSqliteDatabase;
    const sharedPath = resolveOpenClawStateSqlitePath(store.env);
    const spy = vi
      .spyOn(nodeSqlite, "openNodeSqliteDatabase")
      .mockImplementation((file, options) => {
        if (file === sharedPath && !options?.readOnly) {
          throw Object.assign(new Error("fixture lease storage failure"), { code: "SQLITE_IOERR" });
        }
        return openDatabase(file, options);
      });
    try {
      const report = await importLegacyStore(store);
      expect(report.targets[0]?.issues).toContainEqual(
        expect.objectContaining({
          code: "sqlite_compact_failed",
          message: expect.stringContaining("fixture lease storage failure | SQLITE_IOERR"),
        }),
      );
      expect(fs.readFileSync(store.storePath, "utf8")).toBe("{}\n");
      const failureReportPath = expectDefined(
        report.migrationRun?.failureReportMarkdownPath,
        "failure report",
      );
      expect(fs.readFileSync(failureReportPath, "utf8")).toContain(
        "fixture lease storage failure | SQLITE_IOERR",
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("refuses compaction while this process owns an open agent database handle", async () => {
    const { sqlitePath, store } = await createImportedStoreForCompaction();
    openOpenClawAgentDatabase({
      agentId: "main",
      env: store.env,
      path: sqlitePath,
    });

    const report = await runDoctorSessionSqlite({
      env: store.env,
      mode: "compact",
      store: store.storePath,
    });

    expect(report.targets[0]?.issues).toEqual([
      expect.objectContaining({
        code: "sqlite_compact_failed",
        message: expect.stringMatching(/already open in this process/iu),
      }),
    ]);
  });

  it.each([
    {
      label: "wrong schema role",
      mutate: (database: DatabaseSync) => {
        database.prepare("UPDATE schema_meta SET role = 'global' WHERE meta_key = 'primary'").run();
      },
      message: /schema role global.*expected agent/iu,
    },
    {
      label: "wrong agent owner",
      mutate: (database: DatabaseSync) => {
        database
          .prepare("UPDATE schema_meta SET agent_id = 'work' WHERE meta_key = 'primary'")
          .run();
      },
      message: /belongs to agent work.*requested agent main/iu,
    },
    {
      label: "stale metadata version",
      mutate: (database: DatabaseSync) => {
        database
          .prepare("UPDATE schema_meta SET schema_version = ? WHERE meta_key = 'primary'")
          .run(OPENCLAW_AGENT_SCHEMA_VERSION - 1);
      },
      message: /metadata schema version .* does not match/iu,
    },
    {
      label: "stale user version",
      mutate: (database: DatabaseSync) => {
        database.exec(`PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION - 1};`);
      },
      message: /run openclaw doctor --fix before compacting/iu,
    },
  ])("rejects $label before compaction", async ({ mutate, message }) => {
    const { sqlitePath, store } = await createImportedStoreForCompaction();
    const sqlite = nodeSqlite.requireNodeSqlite();
    const database = new sqlite.DatabaseSync(sqlitePath);
    try {
      mutate(database);
    } finally {
      database.close();
    }

    const report = await runDoctorSessionSqlite({
      env: store.env,
      mode: "compact",
      store: store.storePath,
    });

    expect(report.targets[0]?.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "sqlite_compact_failed",
          message: expect.stringMatching(message),
        }),
      ]),
    );
  });

  it.skipIf(process.platform === "win32")(
    "refuses a symlink at the agent database path",
    async () => {
      const { sqlitePath, store } = await createImportedStoreForCompaction();
      const realPath = `${sqlitePath}.real`;
      fs.renameSync(sqlitePath, realPath);
      fs.symlinkSync(realPath, sqlitePath);

      await expect(
        runDoctorSessionSqlite({
          env: store.env,
          mode: "compact",
          store: store.storePath,
        }),
      ).rejects.toThrow(/Cannot run session SQLite compact.*symbolic-link path/iu);
    },
  );

  it("clears agent quarantine after compaction", async () => {
    const { sqlitePath, store } = await createImportedStoreForCompaction();
    expect(
      recordOpenClawDatabaseQuarantine({
        env: store.env,
        kind: "agent",
        path: sqlitePath,
        reason: "corrupt index",
      }),
    ).toBe(true);

    const report = await runDoctorSessionSqlite({
      env: store.env,
      mode: "compact",
      store: store.storePath,
    });

    expect(report.totals.issues).toBe(0);
    expect(readOpenClawDatabaseQuarantine(sqlitePath, { env: store.env })).toBeUndefined();
    expect(openOpenClawAgentDatabase({ agentId: "main", env: store.env }).db.isOpen).toBe(true);
  });

  it.each([false, true])(
    "compacts and repairs canonical indexes in place (shared store: %s)",
    async (shared) => {
      const { sqlitePath, store } = await createImportedStoreForCompaction(shared);
      const selection = {
        env: store.env,
        store: store.storePath,
        ...(shared ? { agent: "beta" } : {}),
      };
      const compact = await runDoctorSessionSqlite({ ...selection, mode: "compact" });
      expect(compact.totals.issues).toBe(0);
      expect(compact.targets[0]?.compact?.skipped).toBe(false);
      createCanonicalCacheIndexDrift(sqlitePath);
      expect(
        recordOpenClawDatabaseQuarantine({
          env: store.env,
          kind: "agent",
          path: sqlitePath,
          reason: "canonical cache index drift",
        }),
      ).toBe(true);

      const report = await runDoctorSessionSqlite({
        ...selection,
        mode: "recover",
      });

      expect(report.totals.issues).toBe(0);
      expect(report.targets[0]?.corruptRecovery).toBeUndefined();
      expect(fs.existsSync(sqlitePath)).toBe(true);
      expect(readOpenClawDatabaseQuarantine(sqlitePath, { env: store.env })).toBeUndefined();

      const sqlite = nodeSqlite.requireNodeSqlite();
      const database = new sqlite.DatabaseSync(sqlitePath, { readOnly: true });
      try {
        expect(database.prepare("PRAGMA integrity_check").get()).toEqual({
          integrity_check: "ok",
        });
        expect(
          database
            .prepare("SELECT value_json FROM cache_entries WHERE scope = ? AND key = ?")
            .get("doctor", "canonical-index"),
        ).toEqual({ value_json: '{"ok":true}' });
      } finally {
        database.close();
      }
      expect(
        openOpenClawAgentDatabase({
          agentId: shared ? "alpha" : "main",
          env: store.env,
          path: sqlitePath,
        }).db.isOpen,
      ).toBe(true);
    },
  );

  it("fences quarantine clearing and later recovery targets after an awaited repair loses maintenance", async () => {
    const { sqlitePath, store } = await createImportedStoreForCompaction();
    createCanonicalCacheIndexDrift(sqlitePath);
    const laterPath = resolveOpenClawAgentSqlitePath({ agentId: "later", env: store.env });
    fs.mkdirSync(path.dirname(laterPath), { recursive: true });
    const laterBytes = Buffer.from("synthetic corrupt database\n");
    fs.writeFileSync(laterPath, laterBytes, { mode: 0o600 });
    for (const databasePath of [sqlitePath, laterPath]) {
      expect(
        recordOpenClawDatabaseQuarantine({
          env: store.env,
          kind: "agent",
          path: databasePath,
          reason: "synthetic recovery quarantine",
        }),
      ).toBe(true);
    }
    const quarantineBefore = [sqlitePath, laterPath].map((databasePath) =>
      readOpenClawDatabaseQuarantine(databasePath, { env: store.env }),
    );
    const agentDatabase = await import("../state/openclaw-agent-db.js");
    const migrate = agentDatabase.migrateOpenClawAgentDatabaseForMaintenance;
    // The competitor must not inherit the maintenance authority being revoked.
    const claimCompetingLease = AsyncResource.bind(claimOpenClawAgentDatabaseLease);
    let competingLeaseId: string | undefined;
    const repair = vi
      .spyOn(agentDatabase, "migrateOpenClawAgentDatabaseForMaintenance")
      .mockImplementationOnce(async (options, maintenance) => {
        await migrate(options, maintenance);
        // Lose the real owner at the caller's new await boundary, after native repair succeeds.
        const removed = openOpenClawStateDatabase({ env: store.env })
          .db.prepare("DELETE FROM state_leases WHERE scope = ? AND lease_key = ?")
          .run(AGENT_DATABASE_MAINTENANCE_LEASE.scope, AGENT_DATABASE_MAINTENANCE_LEASE.key);
        expect(removed.changes).toBe(1);
        competingLeaseId = claimCompetingLease({
          agentId: "later",
          path: laterPath,
          env: store.env,
        });
      });
    try {
      await expect(
        recoverDoctorSessionSqliteTargets({
          env: store.env,
          options: { mode: "recover" },
          targets: [
            { agentId: "main", storePath: sqlitePath },
            { agentId: "later", storePath: laterPath },
          ],
          validateTarget: async () => {
            throw new Error("Expected direct recovery without a failed migration manifest");
          },
        }),
      ).rejects.toThrow(/maintenance lease.*was lost/iu);
      expect(competingLeaseId).toBeDefined();
      expect(
        [sqlitePath, laterPath].map((databasePath) =>
          readOpenClawDatabaseQuarantine(databasePath, { env: store.env }),
        ),
      ).toEqual(quarantineBefore);
      expect(fs.readFileSync(laterPath)).toEqual(laterBytes);
      expect(
        fs.readdirSync(path.dirname(laterPath)).some((name) => name.includes(".corrupt-")),
      ).toBe(false);
    } finally {
      repair.mockRestore();
      if (competingLeaseId) {
        releaseOpenClawAgentDatabaseLease(competingLeaseId, { env: store.env });
      }
    }
  });

  it.each(["newer schema", "mismatched older schema", "I/O error"] as const)(
    "keeps canonical-index repair failures in place after %s",
    async (failure) => {
      const { sqlitePath, store } = await createImportedStoreForCompaction();
      createCanonicalCacheIndexDrift(sqlitePath);
      if (failure !== "I/O error") {
        const version = failure === "newer schema" ? OPENCLAW_AGENT_SCHEMA_VERSION + 1 : 1;
        const database = new (nodeSqlite.requireNodeSqlite().DatabaseSync)(sqlitePath);
        try {
          database.exec(`PRAGMA user_version = ${version};`);
          database
            .prepare("UPDATE schema_meta SET schema_version = ? WHERE meta_key = 'primary'")
            .run(failure === "newer schema" ? version : 2);
        } finally {
          database.close();
        }
      }
      const before = fs.readFileSync(sqlitePath);
      const openDatabase = nodeSqlite.openNodeSqliteDatabase;
      const openSpy =
        failure === "I/O error"
          ? vi
              .spyOn(nodeSqlite, "openNodeSqliteDatabase")
              .mockImplementation((pathname, options) => {
                if (pathname === sqlitePath && options?.readOnly !== true) {
                  throw Object.assign(new Error("injected maintenance I/O failure"), {
                    code: "EIO",
                  });
                }
                return openDatabase(pathname, options);
              })
          : undefined;
      let report: Awaited<ReturnType<typeof runDoctorSessionSqlite>>;
      try {
        report = await runDoctorSessionSqlite({
          env: store.env,
          mode: "recover",
          store: store.storePath,
        });
      } finally {
        openSpy?.mockRestore();
      }
      expect(report.targets[0]?.issues).toMatchObject([{ code: "sqlite_recovery_inspect_failed" }]);
      expect(report.targets[0]?.corruptRecovery).toBeUndefined();
      expect(fs.readFileSync(sqlitePath)).toEqual(before);
      expect(
        fs.readdirSync(path.dirname(sqlitePath)).some((entry) => entry.includes(".corrupt-")),
      ).toBe(false);
    },
  );

  it("validates the trusted SQLite override when recovering a migration manifest", async () => {
    const store = createLegacyStore();
    const target = {
      agentId: "main",
      sqlitePath: path.join(store.stateDir, "migration-target.sqlite"),
      storePath: store.storePath,
    };
    await upsertSessionEntryCore(
      {
        agentId: target.agentId,
        env: store.env,
        sessionKey: "agent:main:main",
        storePath: target.sqlitePath,
      },
      { sessionId: "session-1", updatedAt: 1 },
    );
    const run = createSessionSqliteMigrationRun(store.env, [target]);
    const report = await recoverDoctorSessionSqliteTargets({
      env: store.env,
      options: { mode: "recover" },
      targets: [target],
      validateTarget: async (selected) => {
        const validation = readOnlySqliteValidationSnapshot(selected);
        if (!validation.ok) {
          throw validation.error;
        }
        return createDoctorSessionSqliteTargetReport({
          ...selected,
          sqlitePath: resolveTargetSqlitePath(selected),
          validatedEntries: validation.snapshot.sessionIdsBySessionKey.size,
        });
      },
    });
    expect(report.migrationRun?.manifestPath).toBe(run.manifestPath);
    expect(report.targets[0]?.sqlitePath).toBe(target.sqlitePath);
    expect(report.totals.validatedEntries).toBe(1);
  });

  it.skipIf(process.platform === "win32")(
    "reapplies owner-only permissions after compaction",
    async () => {
      const { sqlitePath, store } = await createImportedStoreForCompaction();
      fs.chmodSync(sqlitePath, 0o666);

      const report = await runDoctorSessionSqlite({
        env: store.env,
        mode: "compact",
        store: store.storePath,
      });

      expect(report.totals.issues).toBe(0);
      expect(fs.statSync(sqlitePath).mode & 0o777).toBe(0o600);
    },
  );

  it("rejects stale secondary indexes before compacting and quarantines them in recovery", async () => {
    const { sqlitePath, store } = await createImportedStoreForCompaction();
    createUnsafeIndexDrift(sqlitePath);
    expect(
      recordOpenClawDatabaseQuarantine({
        env: store.env,
        kind: "agent",
        path: sqlitePath,
        reason: "stale secondary index",
      }),
    ).toBe(true);

    const report = await runDoctorSessionSqlite({
      env: store.env,
      mode: "compact",
      store: store.storePath,
    });

    expect(report.targets[0]?.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "sqlite_compact_failed",
          message: expect.stringMatching(
            /integrity_check failed.*missing from index unsafe_session_index/iu,
          ),
        }),
      ]),
    );
    expect(readOpenClawDatabaseQuarantine(sqlitePath, { env: store.env })?.reason).toBe(
      "stale secondary index",
    );

    const recovery = await runDoctorSessionSqlite({
      env: store.env,
      mode: "recover",
      store: store.storePath,
    });
    expect(recovery.totals.issues).toBe(0);
    expect(recovery.targets[0]?.corruptRecovery?.movedFiles).toEqual(
      expect.arrayContaining([expect.stringMatching(/openclaw-agent\.sqlite\.corrupt-/u)]),
    );
    expect(fs.existsSync(sqlitePath)).toBe(false);
  });

  it("does not report SQLite markers as missing transcript files", async () => {
    const store = createLegacyStore();
    fs.rmSync(store.transcriptPath);
    fs.rmSync(store.trajectoryPath);
    fs.writeFileSync(
      store.storePath,
      JSON.stringify(
        {
          "agent:main:main": {
            channel: "cli",
            chatType: "direct",
            sessionFile: `sqlite:main:session-1:${store.storePath}`,
            sessionId: "session-1",
            sessionStartedAt: 1000,
            updatedAt: 2000,
          },
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );

    const report = await importLegacyStore(store);
    const validation = await runDoctorSessionSqlite({
      env: store.env,
      mode: "validate",
      store: store.storePath,
    });

    expect(report.totals).toMatchObject({
      importedEntries: 1,
      importedTranscriptEvents: 0,
      issues: 0,
      sqliteEntries: 1,
    });
    expect(validation.totals).toMatchObject({
      issues: 0,
      validatedEntries: 0,
      validatedTranscriptEvents: 0,
    });
    expect(
      loadExactSessionEntry({
        agentId: "main",
        sessionKey: "agent:main:main",
        storePath: store.storePath,
      })?.entry,
    ).not.toHaveProperty("sessionFile");
  });

  it.each([
    ["missing row", undefined, 0, false, "sqlite_entry_missing", 0, 0],
    ["different session", "other", 2, false, "sqlite_entry_mismatch", 0, 0],
    ["short transcript", "session-1", 1, false, "sqlite_transcript_count_mismatch", 1, 0],
    ["matching transcript", "session-1", 2, false, undefined, 1, 2],
    ["longer transcript", "session-1", 3, false, "sqlite_transcript_count_mismatch", 1, 0],
    ["missing source", "session-1", 2, true, undefined, 1, 2],
  ] as const)(
    "validates a %s against SQLite",
    async (
      _name,
      sessionId,
      eventCount,
      missingSource,
      issueCode,
      validatedEntries,
      validatedTranscriptEvents,
    ) => {
      const events = [
        { type: "session", id: "session-1", version: 3 },
        {
          type: "message",
          id: "one",
          parentId: null,
          message: { role: "user", content: "source" },
        },
        {
          type: "message",
          id: "two",
          parentId: "one",
          message: { role: "assistant", content: "later" },
        },
      ];
      const store = createLegacyStore({
        transcriptLines: events.slice(0, 2).map((event) => JSON.stringify(event)),
      });
      if (sessionId) {
        await importSqliteSessionRows({
          agentId: "main",
          env: store.env,
          sessionKey: "agent:main:main",
          storePath: store.storePath,
          entry: { sessionId, updatedAt: 2000 },
          readTranscriptEvents: (append) => events.slice(0, eventCount).forEach(append),
        });
      }
      if (missingSource) {
        fs.rmSync(store.transcriptPath);
      }

      const report = await runDoctorSessionSqlite({
        env: store.env,
        mode: "validate",
        store: store.storePath,
      });

      const expectedIssueCodes = [
        ...(issueCode ? [issueCode] : []),
        ...(sessionId === "session-1" && !missingSource ? ["active_sqlite_transcript_jsonl"] : []),
      ];
      expect(report.totals).toMatchObject({
        issues: expectedIssueCodes.length,
        sqliteEntries: sessionId ? 1 : 0,
        validatedEntries,
        validatedTranscriptEvents,
      });
      expect(report.targets[0]?.issues.map((issue) => issue.code)).toEqual(expectedIssueCodes);
      if (issueCode) {
        expect(report.targets[0]?.issues[0]?.sessionKey).toBe("agent:main:main");
      }
      expect(fs.existsSync(report.targets[0]?.sqlitePath ?? "")).toBe(Boolean(sessionId));
      if (eventCount === 3) {
        const imported = await importLegacyStore(store);
        expect(imported.targets[0]?.issues).toEqual([]);
        expect(fs.existsSync(store.transcriptPath)).toBe(false);
      }
    },
  );

  it("writes a migration manifest with planned and completed archive moves", async () => {
    const store = createLegacyStore();
    const expectedStorePath = fs.realpathSync.native(store.storePath);

    const report = await importLegacyStore(store);
    const manifest = readMigrationManifest(report.migrationRun?.manifestPath);
    const target = expectDefined(manifest.targets[0], "manifest.targets[0] test invariant");

    expect(report.migrationRun?.runId).toBe(manifest.runId);
    expect(manifest.manifestVersion).toBe(3);
    expect(target).toMatchObject({
      agentId: "main",
      storePath: expectedStorePath,
      validationBeforeArchive: "passed",
    });
    expect(target.completedMoves).toHaveLength(4);
    expect(target.plannedMoves.map((move) => path.basename(move.sourcePath)).toSorted()).toEqual([
      "orphan.jsonl",
      "session-1.jsonl",
      "session-1.trajectory.jsonl",
      "sessions.json",
    ]);
  });

  it("checkpoints bulk archive moves without per-file manifest rewrites", async () => {
    const store = createLegacyStore();
    const sessions = JSON.parse(fs.readFileSync(store.storePath, "utf-8")) as Record<
      string,
      Record<string, unknown>
    >;
    for (let index = 0; index < 64; index += 1) {
      const sessionId = `bulk-session-${index}`;
      const sessionFile = `${sessionId}.jsonl`;
      sessions[`agent:main:bulk:${index}`] = {
        channel: "cli",
        chatType: "direct",
        sessionFile,
        sessionId,
        updatedAt: 2000 + index,
      };
      fs.writeFileSync(
        path.join(store.sessionDir, sessionFile),
        `${JSON.stringify({ type: "session", sessionId })}\n`,
        { mode: 0o600 },
      );
      fs.writeFileSync(path.join(store.sessionDir, `orphan-${index}.jsonl`), "{}\n", {
        mode: 0o600,
      });
    }
    fs.writeFileSync(store.storePath, JSON.stringify(sessions, null, 2), { mode: 0o600 });
    fs.writeFileSync(path.join(store.sessionDir, "orphan collision.jsonl"), "{}\n", {
      mode: 0o600,
    });
    fs.writeFileSync(path.join(store.sessionDir, "orphan_collision.jsonl"), "{}\n", {
      mode: 0o600,
    });
    const replaceFileAtomicSync = vi.spyOn(replaceFile, "replaceFileAtomicSync");

    try {
      const report = await importLegacyStore(store);
      const manifest = readMigrationManifest(report.migrationRun?.manifestPath);
      const manifestWrites = replaceFileAtomicSync.mock.calls.filter(([options]) =>
        options.filePath.includes("session-sqlite-migration-runs"),
      ).length;
      const plannedUnreferencedMoves =
        manifest.targets[0]?.plannedMoves.filter((move) => move.kind === "unreferenced-jsonl") ??
        [];
      const plannedTranscriptMoves =
        manifest.targets[0]?.plannedMoves.filter((move) => move.kind === "transcript") ?? [];

      expect(plannedUnreferencedMoves).toHaveLength(67);
      expect(new Set(plannedUnreferencedMoves.map((move) => move.archivePath)).size).toBe(67);
      expect(plannedTranscriptMoves).toHaveLength(65);
      expect(
        manifest.targets[0]?.completedMoves.filter((move) => move.kind === "unreferenced-jsonl"),
      ).toHaveLength(67);
      expect(
        manifest.targets[0]?.completedMoves.filter((move) => move.kind === "transcript"),
      ).toHaveLength(65);
      expect(manifestWrites).toBeLessThan(20);
      expect(replaceFileAtomicSync).toHaveBeenCalledWith(
        expect.objectContaining({
          filePath: report.migrationRun?.manifestPath,
          mode: 0o600,
          tempPrefix: path.basename(report.migrationRun?.manifestPath ?? ""),
        }),
      );
    } finally {
      replaceFileAtomicSync.mockRestore();
    }
  });

  it("archives legacy trajectory pointer files with imported transcripts", async () => {
    const store = createLegacyStore();
    const pointerPath = path.join(store.sessionDir, "session-1.trajectory-path.json");
    fs.writeFileSync(
      pointerPath,
      `${JSON.stringify({
        traceSchema: "openclaw-trajectory-pointer",
        schemaVersion: 1,
        sessionId: "session-1",
        runtimeFile: store.trajectoryPath,
      })}\n`,
      { mode: 0o600 },
    );
    const expectedPointerPath = canonicalTestPath(pointerPath);

    const report = await importLegacyStore(store);
    const archivedNames =
      report.targets[0]?.archivedTranscriptFiles.map((filePath) => path.basename(filePath)) ?? [];

    expect(fs.existsSync(pointerPath)).toBe(false);
    expect(archivedNames).toEqual(
      expect.arrayContaining([expect.stringContaining("session-1.trajectory-path.json.imported-")]),
    );
    expect(
      readMigrationManifest(report.migrationRun?.manifestPath).targets[0]?.plannedMoves,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "trajectory",
          sourcePath: expectedPointerPath,
        }),
      ]),
    );
  });

  it("explains hard-linked legacy index refusal and supports an independent copy before retry", async () => {
    const store = createLegacyStore();
    const snapshotPath = path.join(store.tempDir, "snapshot-sessions.json");
    const originalBytes = fs.readFileSync(store.storePath);
    fs.linkSync(store.storePath, snapshotPath);

    const refused = importLegacyStore(store);
    await expect(refused).rejects.toThrow(store.storePath);
    await expect(refused).rejects.toThrow("nlink=2");
    await expect(refused).rejects.toThrow("another hard link references this inode");
    await expect(refused).rejects.toThrow("backup");
    await expect(refused).rejects.toThrow("#hard-linked-legacy-artifacts");
    expect(fs.lstatSync(store.storePath).nlink).toBe(2);
    expect(fs.readFileSync(store.storePath)).toEqual(originalBytes);
    expect(fs.readFileSync(snapshotPath)).toEqual(originalBytes);
    expect(fs.existsSync(store.transcriptPath)).toBe(true);

    const copyPath = path.join(store.sessionDir, "sessions-copy.tmp");
    fs.copyFileSync(store.storePath, copyPath, fs.constants.COPYFILE_EXCL);
    expect(fs.readFileSync(copyPath)).toEqual(originalBytes);
    fs.renameSync(copyPath, store.storePath);
    expect(fs.lstatSync(store.storePath).nlink).toBe(1);
    expect((await importLegacyStore(store)).totals.issues).toBe(0);
    expect(fs.readFileSync(snapshotPath)).toEqual(originalBytes);
  });

  it("explains hard-linked transcript archive refusal without changing either link", async () => {
    const store = createLegacyStore();
    const snapshotPath = path.join(store.tempDir, "snapshot-transcript.jsonl");
    const originalBytes = fs.readFileSync(store.transcriptPath);
    fs.linkSync(store.transcriptPath, snapshotPath);

    const report = await importLegacyStore(store);
    const issue = expectDefined(
      report.targets[0]?.issues.find((entry) => entry.code === "transcript_archive_failed"),
      "hard-linked transcript archive refusal",
    );
    expect(issue.message).toContain(store.transcriptPath);
    expect(issue.message).toContain("nlink=2");
    expect(issue.message).toContain("another hard link references this inode");
    expect(issue.message).toContain("backup");
    expect(issue.message).toContain("#hard-linked-legacy-artifacts");
    expect(fs.lstatSync(store.transcriptPath).nlink).toBe(2);
    expect(fs.readFileSync(store.transcriptPath)).toEqual(originalBytes);
    expect(fs.readFileSync(snapshotPath)).toEqual(originalBytes);
    expect(fs.existsSync(store.storePath)).toBe(true);
  });

  it.skipIf(process.platform === "win32")(
    "rejects symlink-backed legacy stores before migration",
    async () => {
      const store = createLegacyStore();
      const realStorePath = path.join(store.tempDir, "real-sessions.json");
      fs.renameSync(store.storePath, realStorePath);
      fs.symlinkSync(realStorePath, store.storePath);

      await expect(importLegacyStore(store)).rejects.toThrow(
        "Refusing session SQLite migration through symbolic link",
      );

      expect(fs.lstatSync(store.storePath).isSymbolicLink()).toBe(true);
      expect(fs.existsSync(realStorePath)).toBe(true);
      expect(fs.existsSync(store.transcriptPath)).toBe(true);
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects symlink-backed archive directories before migration",
    async () => {
      const store = createLegacyStore();
      const archiveDir = path.join(path.dirname(store.sessionDir), "session-sqlite-import-archive");
      const outsideArchiveDir = path.join(store.tempDir, "outside-archive");
      fs.mkdirSync(outsideArchiveDir, { recursive: true });
      fs.symlinkSync(outsideArchiveDir, archiveDir);

      await expect(importLegacyStore(store)).rejects.toThrow(
        "Refusing session SQLite migration through symbolic link",
      );

      expect(fs.existsSync(store.storePath)).toBe(true);
      expect(fs.existsSync(store.transcriptPath)).toBe(true);
      expect(fs.readdirSync(outsideArchiveDir)).toEqual([]);
    },
  );

  it.each([false, true])(
    "imports aliases before archival and retains a failed alias (failed=%s)",
    async (failed) => {
      const store = createLegacyStore({
        transcriptLines: [
          '{"type":"session","sessionId":"session-1"}',
          '{"type":"message","message":{"role":"user","content":"shared legacy message"}}',
        ],
      });
      const legacyStore = JSON.parse(fs.readFileSync(store.storePath, "utf-8")) as Record<
        string,
        unknown
      >;
      legacyStore["agent:main:alias"] = legacyStore["agent:main:main"];
      fs.writeFileSync(store.storePath, `${JSON.stringify(legacyStore, null, 2)}\n`, {
        mode: 0o600,
      });

      const original = fs.readFileSync(store.transcriptPath);
      const snapshot = sqliteReaders.readOnlySqliteValidationSnapshot;
      const spy = vi
        .spyOn(sqliteReaders, "readOnlySqliteValidationSnapshot")
        .mockImplementation((target) => {
          const result = snapshot(target);
          if (
            failed &&
            result.ok &&
            result.snapshot.sessionIdsBySessionKey.has("agent:main:alias")
          ) {
            const keys = new Map(result.snapshot.sessionIdsBySessionKey);
            keys.delete("agent:main:alias");
            return { ok: true, snapshot: { ...result.snapshot, sessionIdsBySessionKey: keys } };
          }
          return result;
        });
      let report;
      try {
        report = await importLegacyStore(store);
      } finally {
        spy.mockRestore();
      }
      if (failed) {
        expect(report.targets[0]?.issues).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              code: "sqlite_entry_missing",
              sessionKey: "agent:main:alias",
            }),
          ]),
        );
        expect(fs.readFileSync(store.transcriptPath)).toEqual(original);
      } else {
        expect(report.targets[0]?.issues).toEqual([]);
      }

      expect(report.totals).toMatchObject({
        archivedTranscriptFiles: failed ? 0 : 2,
        importedEntries: 2,
        importedTranscriptEvents: 2,
        sqliteEntries: 2,
      });
      expect(fs.existsSync(store.transcriptPath)).toBe(failed);
      expect(
        loadExactSessionEntry({
          agentId: "main",
          sessionKey: "agent:main:main",
          storePath: store.storePath,
        })?.entry.sessionId,
      ).toBe("session-1");
      expect(
        loadExactSessionEntry({
          agentId: "main",
          sessionKey: "agent:main:alias",
          storePath: store.storePath,
        })?.entry.sessionId,
      ).toBe("session-1");
      closeOpenClawAgentDatabasesForTest();
      const cleanup = await retireSessionSqliteRecovery({
        env: store.env,
        preview: inspectSessionSqliteRecovery({ cfg: {}, env: store.env }),
        readConfig: async () => ({}),
        confirm: async () => true,
      });
      expect(cleanup.totals.removedFiles).toBe(failed ? 0 : 2);
      if (failed) {
        expect(fs.readFileSync(store.transcriptPath)).toEqual(original);
      }
    },
  );

  it("leaves legacy transcript symlinks in place instead of archiving them", async () => {
    const store = createLegacyStore();
    const outsideTranscriptPath = path.join(store.tempDir, "outside-session-1.jsonl");
    fs.renameSync(store.transcriptPath, outsideTranscriptPath);
    fs.symlinkSync(outsideTranscriptPath, store.transcriptPath);

    const report = await importLegacyStore(store);

    expect(report.targets[0]?.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: expect.stringMatching(/archive_failed$/),
        }),
      ]),
    );
    expect(report.targets[0]?.archivedTranscriptFiles).toEqual([]);
    expect(fs.existsSync(outsideTranscriptPath)).toBe(true);
    expect(fs.lstatSync(store.transcriptPath).isSymbolicLink()).toBe(true);
  });

  it("imports explicit stores into the agent database owned by the path", async () => {
    const store = createLegacyStore({ agentDirName: "codex-proof" });

    const report = await importLegacyStore(store);

    expect(report.targets[0]?.agentId).toBe("codex-proof");
    expect(report.totals).toMatchObject({
      importedEntries: 1,
      importedTranscriptEvents: 2,
      issues: 0,
      sqliteEntries: 1,
    });
    expect(
      loadTranscriptEventsSync({
        agentId: "codex-proof",
        sessionId: "session-1",
        sessionKey: "agent:main:main",
        storePath: store.storePath,
      }),
    ).toHaveLength(2);
  });

  it("imports legacy entries even when their transcript sidecar is missing", async () => {
    const store = createLegacyStore();
    fs.rmSync(store.transcriptPath);

    const report = await importLegacyStore(store);

    expect(report.totals).toMatchObject({
      importedEntries: 1,
      importedTranscriptEvents: 0,
      issues: 1,
      sqliteEntries: 1,
    });
    expect(report.targets[0]?.issues[0]).toMatchObject({
      code: "transcript_missing",
      sessionKey: "agent:main:main",
    });
    expect(
      loadExactSessionEntry({
        agentId: "main",
        sessionKey: "agent:main:main",
        storePath: store.storePath,
      })?.entry.sessionId,
    ).toBe("session-1");
    expect(
      loadTranscriptEventsSync({
        agentId: "main",
        sessionId: "session-1",
        sessionKey: "agent:main:main",
        storePath: store.storePath,
      }),
    ).toEqual([]);
  });

  it("keeps a shared legacy store intact when importing only one agent", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-session-sqlite-"));
    try {
      const stateDir = path.join(tempDir, "state");
      const sessionDir = path.join(tempDir, "shared-session-store");
      const storePath = path.join(sessionDir, "sessions.json");
      const mainTranscriptPath = path.join(sessionDir, "main-session.jsonl");
      const workTranscriptPath = path.join(sessionDir, "work-session.jsonl");
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      fs.mkdirSync(sessionDir, { recursive: true });
      fs.writeFileSync(
        storePath,
        JSON.stringify({
          "agent:main:main": {
            sessionFile: "main-session.jsonl",
            sessionId: "main-session",
            updatedAt: 20,
          },
          "agent:work:main": {
            sessionFile: "work-session.jsonl",
            sessionId: "work-session",
            updatedAt: 30,
          },
        }),
        { mode: 0o600 },
      );
      fs.writeFileSync(mainTranscriptPath, '{"type":"session","sessionId":"main-session"}\n');
      fs.writeFileSync(workTranscriptPath, '{"type":"session","sessionId":"work-session"}\n');

      const report = await runDoctorSessionSqlite({
        agent: "main",
        cfg: {
          agents: { list: [{ default: true, id: "main" }, { id: "work" }] },
          session: { store: storePath },
        },
        env,
        mode: "import",
      });

      expect(report.totals).toMatchObject({
        archivedLegacyStoreFiles: 0,
        archivedTranscriptFiles: 0,
        importedEntries: 1,
        issues: 2,
      });
      expect(report.targets[0]?.issues).toMatchObject([
        { code: "transcript_archive_deferred", sessionKey: "agent:main:main" },
        { code: "active_sqlite_transcript_jsonl", sessionKey: "agent:main:main" },
      ]);
      expect(fs.existsSync(storePath)).toBe(true);
      expect(fs.existsSync(mainTranscriptPath)).toBe(true);
      expect(fs.existsSync(workTranscriptPath)).toBe(true);
      expect(
        loadExactSessionEntry({
          agentId: "main",
          sessionKey: "agent:main:main",
          storePath,
        })?.entry.sessionId,
      ).toBe("main-session");
      expect(
        loadExactSessionEntry({
          agentId: "work",
          sessionKey: "agent:work:main",
          storePath,
        }),
      ).toBeUndefined();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("partitions the retired top-level store without guessing unscoped ownership", async () => {
    const stateDir = autoCleanupTempDirs.make("openclaw-doctor-retired-sessions-");
    const sessionDir = path.join(stateDir, "sessions");
    const storePath = path.join(sessionDir, "sessions.json");
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      storePath,
      JSON.stringify({
        "agent:main:main": {
          sessionFile: "/retired/home/.openclaw/sessions/main-session.jsonl",
          sessionId: "main-会議",
          updatedAt: 20,
        },
        "agent:ops:main": {
          sessionFile: "ops-session.jsonl",
          sessionId: "ops-session",
          updatedAt: 30,
        },
        "voice:ambiguous": { sessionId: "ambiguous-session", updatedAt: 40 },
      }),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(sessionDir, "main-session.jsonl"),
      '{"type":"session","sessionId":"main-会議"}\n',
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(sessionDir, "ops-session.jsonl"),
      '{"type":"session","sessionId":"ops-session"}\n',
      { mode: 0o600 },
    );

    const cfg = {
      agents: { ownership: "explicit" as const, entries: { main: {}, ops: {} } },
    };
    const report = await runDoctorSessionSqlite({
      allAgents: true,
      cfg,
      env,
      mode: "import",
    });

    expect(report.targets.map((target) => target.agentId)).toEqual(["main", "ops"]);
    expect(report.totals).toMatchObject({
      archivedLegacyStoreFiles: 0,
      importedEntries: 2,
      importedTranscriptEvents: 2,
      legacyEntries: 2,
      sqliteEntries: 2,
    });
    for (const [agentId, sessionId] of [
      ["main", "main-会議"],
      ["ops", "ops-session"],
    ] as const) {
      const agentStorePath = path.join(stateDir, "agents", agentId, "sessions", "sessions.json");
      expect(
        loadExactSessionEntry({
          agentId,
          sessionKey: `agent:${agentId}:main`,
          storePath: agentStorePath,
        })?.entry.sessionId,
      ).toBe(sessionId);
      expect(
        loadExactSessionEntry({
          agentId,
          sessionKey: "voice:ambiguous",
          storePath: agentStorePath,
        }),
      ).toBeUndefined();
    }
    expect(fs.existsSync(storePath)).toBe(true);
    expect(fs.existsSync(path.join(sessionDir, "main-session.jsonl"))).toBe(true);
    expect(fs.existsSync(path.join(sessionDir, "ops-session.jsonl"))).toBe(true);

    const owned = await runDoctorSessionSqlite({
      allAgents: true,
      cfg: {
        ...cfg,
        agents: { ...cfg.agents, defaults: { sessionStore: { agentId: "main" } } },
      },
      env,
      mode: "import",
    });
    expect(owned.totals.archivedLegacyStoreFiles).toBe(1);
    expect(owned.totals.importedEntries).toBe(3);
    expect(fs.existsSync(storePath)).toBe(false);
  });

  it.each([true, false])(
    "imports shared custom stores and respects cleanup ownership (internal=%s)",
    async (internal) => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-session-sqlite-"));
      try {
        const stateDir = path.join(tempDir, "state");
        const sessionDir = path.join(internal ? stateDir : tempDir, "shared-session-store");
        const storePath = path.join(sessionDir, "sessions.json");
        const mainTranscriptPath = path.join(sessionDir, "main-session.jsonl");
        const workTranscriptPath = path.join(sessionDir, "work-session.jsonl");
        const orphanTranscriptPath = path.join(sessionDir, "orphan.jsonl");
        const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
        fs.mkdirSync(sessionDir, { recursive: true });
        fs.writeFileSync(
          storePath,
          JSON.stringify(
            {
              "agent:main:main": {
                sessionFile: "main-session.jsonl",
                sessionId: "main-session",
                updatedAt: 20,
              },
              "agent:work:main": {
                sessionFile: "work-session.jsonl",
                sessionId: "work-session",
                updatedAt: 30,
              },
            },
            null,
            2,
          ),
          { mode: 0o600 },
        );
        fs.writeFileSync(mainTranscriptPath, '{"type":"session","sessionId":"main-session"}\n', {
          mode: 0o600,
        });
        fs.writeFileSync(workTranscriptPath, '{"type":"session","sessionId":"work-session"}\n', {
          mode: 0o600,
        });
        fs.writeFileSync(orphanTranscriptPath, '{"type":"event","id":"orphan"}\n', { mode: 0o600 });

        const report = await runDoctorSessionSqlite({
          allAgents: true,
          cfg: {
            agents: { list: [{ default: true, id: "main" }, { id: "work" }] },
            session: { store: storePath },
          },
          env,
          mode: "import",
        });

        expect(report.targets.map((target) => target.agentId)).toEqual(["main", "work"]);
        expect(report.totals).toMatchObject({
          archivedLegacyStoreFiles: 1,
          archivedTranscriptFiles: 2,
          archivedUnreferencedJsonlFiles: 1,
          importedEntries: 2,
          importedTranscriptEvents: 2,
          issues: 0,
          sqliteEntries: 2,
        });
        expect(report.totals).toHaveProperty("reclaimedBytes");
        const manifest = readMigrationManifest(report.migrationRun?.manifestPath);
        for (const target of manifest.targets) {
          expect(target.completedMoves.some((move) => move.kind === "legacy-store")).toBe(true);
        }
        expect(
          loadExactSessionEntry({
            agentId: "main",
            sessionKey: "agent:main:main",
            storePath,
          })?.entry.sessionId,
        ).toBe("main-session");
        expect(
          loadExactSessionEntry({
            agentId: "work",
            sessionKey: "agent:work:main",
            storePath,
          })?.entry.sessionId,
        ).toBe("work-session");
        expect(fs.existsSync(mainTranscriptPath)).toBe(false);
        expect(fs.existsSync(workTranscriptPath)).toBe(false);
        expect(fs.existsSync(orphanTranscriptPath)).toBe(false);
        closeOpenClawAgentDatabasesForTest();
        const cfg = { agents: { entries: { main: {}, work: {} } }, session: { store: storePath } };
        const preview = inspectSessionSqliteRecovery({ cfg, env });
        const cleanup = await retireSessionSqliteRecovery({
          env,
          preview,
          readConfig: async () => cfg,
          confirm: async () => true,
        });
        expect(cleanup.totals.removedFiles).toBe(internal ? 3 : 0);
        expect(cleanup.artifacts.filter((item) => item.outcome === "protected")).toHaveLength(
          internal ? 1 : 4,
        );
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    },
  );

  it("reports active JSONL files left beside SQLite-backed sessions", async () => {
    const store = createLegacyStore();

    await importLegacyStore(store);
    fs.writeFileSync(store.transcriptPath, '{"type":"event","id":"heartbeat"}\n', {
      mode: 0o600,
    });
    await upsertSessionEntryCore(
      {
        agentId: "main",
        env: store.env,
        sessionKey: "agent:main:main",
        storePath: store.storePath,
      },
      {
        sessionFile: "session-1.jsonl",
        sessionId: "session-1",
        updatedAt: 3000,
      },
    );
    for (const suffix of ["zeta", "alpha"]) {
      fs.writeFileSync(path.join(store.sessionDir, `${suffix}.jsonl`), '{"type":"event"}\n', {
        mode: 0o600,
      });
      await upsertSessionEntryCore(
        {
          agentId: "main",
          env: store.env,
          sessionKey: `agent:main:${suffix}`,
          storePath: store.storePath,
        },
        {
          sessionId: `${suffix}-session`,
          skillsSnapshot: {
            prompt: "active-transcript-scan".repeat(16 * 1024),
            skills: [],
          },
          updatedAt: 3000,
        },
      );
    }
    const database = openOpenClawAgentDatabase({
      agentId: "main",
      env: store.env,
      path: resolveTargetSqlitePath({ agentId: "main", storePath: store.storePath }),
    });
    for (const suffix of ["zeta", "alpha"]) {
      database.db
        .prepare(
          "UPDATE session_nodes SET entry_json = json_set(entry_json, '$.sessionFile', ?) WHERE session_key = ?",
        )
        .run(`${suffix}.jsonl`, `agent:main:${suffix}`);
    }
    database.db.prepare("UPDATE session_nodes SET entry_valid = 1").run();

    const report = await runDoctorSessionSqlite({
      env: store.env,
      mode: "inspect",
      store: store.storePath,
    });

    expect(report.targets[0]?.issues).toMatchObject([
      { code: "active_sqlite_transcript_jsonl", sessionKey: "agent:main:alpha" },
      { code: "active_sqlite_transcript_jsonl", sessionKey: "agent:main:main" },
      { code: "active_sqlite_transcript_jsonl", sessionKey: "agent:main:zeta" },
    ]);
    expect(report.targets[0]?.issues[1]?.message).toContain("session-1.jsonl");
  });

  it("reports active JSONL scan failures without aborting inspect", async () => {
    const store = createLegacyStore();
    const sqlitePath = path.join(
      store.stateDir,
      "agents",
      "main",
      "agent",
      "openclaw-agent.sqlite",
    );
    fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
    fs.writeFileSync(sqlitePath, "not a sqlite database\n", { mode: 0o600 });

    const report = await runDoctorSessionSqlite({
      env: store.env,
      mode: "inspect",
      store: store.storePath,
    });

    expect(report.totals.issues).toBe(2);
    expect(report.targets[0]?.issues.map((issue) => issue.code)).toEqual([
      "sqlite_corrupt",
      "sqlite_active_transcript_scan_failed",
    ]);
  });

  it("does not truncate existing SQLite transcript rows when re-importing a duplicate fragment", async () => {
    const store = createLegacyStore({
      transcriptLines: [
        '{"type":"session","sessionId":"session-1"}',
        '{"type":"message","id":"msg-1","message":{"role":"user","content":"first"}}',
        '{"type":"message","id":"msg-2","message":{"role":"assistant","content":"second"}}',
      ],
    });

    await importLegacyStore(store);
    fs.writeFileSync(
      store.transcriptPath,
      '{"type":"message","id":"msg-2","message":{"role":"assistant","content":"second"}}\n',
      { mode: 0o600 },
    );
    fs.writeFileSync(store.trajectoryPath, `${JSON.stringify({ type: "trajectory" })}\n`, {
      mode: 0o600,
    });

    const report = await importLegacyStore(store);

    expect(report.totals).toMatchObject({
      archivedTranscriptFiles: 0,
      importedEntries: 0,
      importedTranscriptEvents: 0,
      issues: 0,
    });
    expect(
      loadTranscriptEventsSync({
        agentId: "main",
        sessionId: "session-1",
        sessionKey: "agent:main:main",
        storePath: store.storePath,
      }),
    ).toHaveLength(3);
  });

  it("reports custom explicit store sqlite paths beside the store", async () => {
    const store = createLegacyStore({ customStore: true });

    const report = await importLegacyStore(store);

    expect(report.targets[0]?.sqlitePath).toBe(
      path.join(store.sessionDir, "openclaw-agent.sqlite"),
    );
    expect(
      fs.existsSync(
        expectDefined(
          report.targets[0]?.sqlitePath,
          "report.targets[0]?.sqlitePath test invariant",
        ),
      ),
    ).toBe(true);
    expect(
      loadTranscriptEventsSync({
        agentId: "main",
        sessionId: "session-1",
        sessionKey: "agent:main:main",
        storePath: store.storePath,
      }),
    ).toHaveLength(2);
  });

  it("reports a malformed non-newline-terminated final JSONL record", async () => {
    const store = createLegacyStore();
    fs.writeFileSync(
      store.transcriptPath,
      '{"type":"session","sessionId":"session-1"}\n{"type":"message"',
      { mode: 0o600 },
    );

    const report = await importLegacyStore(store);

    expect(report.totals).toMatchObject({
      importedEntries: 1,
      importedTranscriptEvents: 1,
      issues: 1,
      sqliteEntries: 1,
    });
    expect(report.targets[0]?.issues[0]?.code).toBe("transcript_malformed");
    expect(
      loadTranscriptEventsSync({
        agentId: "main",
        sessionId: "session-1",
        sessionKey: "agent:main:main",
        storePath: store.storePath,
      }),
    ).toHaveLength(1);
    expect(fs.existsSync(store.transcriptPath)).toBe(false);
  });

  it("reports malformed transcripts while importing the session entry", async () => {
    const store = createLegacyStore({
      agentDirName: "token=supersecret",
      transcriptLines: ['{"type":"session","sessionId":"session-1"}', "{bad"],
    });

    const report = await importLegacyStore(store);
    const inspect = await runDoctorSessionSqlite({
      env: store.env,
      mode: "inspect",
      store: store.storePath,
    });

    expect(report.totals.issues).toBe(1);
    expect(report.totals).toMatchObject({
      archivedTranscriptFiles: 2,
      archivedUnreferencedJsonlFiles: 1,
      importedEntries: 1,
      importedTranscriptEvents: 1,
      sqliteEntries: 1,
      unreferencedJsonlFiles: 0,
    });
    expect(report.targets[0]?.issues[0]?.code).toBe("transcript_malformed");
    expect(fs.existsSync(store.transcriptPath)).toBe(false);
    expect(fs.existsSync(store.unreferencedJsonlPath)).toBe(false);
    expect(inspect.totals.sqliteEntries).toBe(1);
    expect(
      loadTranscriptEventsSync({
        agentId: "token-supersecret",
        sessionId: "session-1",
        sessionKey: "agent:main:main",
        storePath: store.storePath,
      }),
    ).toHaveLength(1);
    const manifest = readMigrationManifest(report.migrationRun?.manifestPath);
    expect(manifest.targets[0]?.completedMoves.some((move) => move.kind === "transcript")).toBe(
      true,
    );
    expect(
      manifest.targets[0]?.completedMoves.some((move) => move.kind === "unreferenced-jsonl"),
    ).toBe(true);
    expect(manifest.failedAt).toBeUndefined();
    expect(manifest.failureReports).toBeUndefined();
    expect(report.migrationRun?.failureReportMarkdownPath).toBeUndefined();
  });

  it("reports malformed selected legacy transcripts during validation", async () => {
    const store = createLegacyStore({ transcriptLines: ['{"type":"session"}', "{bad"] });
    await upsertSessionEntryCore(
      {
        agentId: "main",
        env: store.env,
        sessionKey: "agent:main:main",
        storePath: store.storePath,
      },
      { sessionId: "session-1", updatedAt: 2000 },
    );

    const report = await runDoctorSessionSqlite({
      env: store.env,
      mode: "validate",
      store: store.storePath,
    });

    expect(report.totals).toMatchObject({
      issues: 2,
      sqliteEntries: 1,
      validatedEntries: 1,
      validatedTranscriptEvents: 0,
    });
    expect(report.targets[0]?.issues[0]).toMatchObject({
      code: "transcript_malformed",
      sessionKey: "agent:main:main",
    });
  });
});

async function createImportedStoreForCompaction(shared = false): Promise<{
  sqlitePath: string;
  store: TestStore;
}> {
  const store = createLegacyStore({ agentDirName: shared ? "alpha" : undefined });
  const report = await importLegacyStore(store);
  let sqlitePath = report.targets[0]?.sqlitePath;
  if (!sqlitePath) {
    throw new Error("expected imported agent SQLite path");
  }
  closeOpenClawAgentDatabasesForTest();
  if (shared) {
    const sharedPath = path.join(store.stateDir, "shared.sqlite");
    fs.renameSync(sqlitePath, sharedPath);
    sqlitePath = sharedPath;
    store.storePath = sharedPath;
  }
  return { sqlitePath, store };
}

// Build the physical v1 layout directly so the doctor path, not the runtime
// opener, owns the upgrade. Empty session tables preserve the dormant-agent
// reproduction: import has no rows to open before its compact step.
function createHistoricalV1AgentDatabase(params: {
  agentId: string;
  env: NodeJS.ProcessEnv;
}): string {
  const sqlitePath = resolveOpenClawAgentSqlitePath(params);
  fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
  const sqlite = nodeSqlite.requireNodeSqlite();
  const database = new sqlite.DatabaseSync(sqlitePath);
  try {
    database.exec(`
      CREATE TABLE schema_meta (
        meta_key TEXT NOT NULL PRIMARY KEY,
        role TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        agent_id TEXT,
        app_version TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE sessions (
        session_id TEXT NOT NULL PRIMARY KEY,
        session_key TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE session_entries (
        session_key TEXT NOT NULL PRIMARY KEY,
        session_id TEXT NOT NULL,
        entry_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
      );
      CREATE TABLE memory_index_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        revision INTEGER NOT NULL
      );
      INSERT INTO memory_index_state (id, revision) VALUES (1, 1);
      CREATE TABLE memory_index_sources (
        source_kind TEXT NOT NULL DEFAULT 'memory',
        source_key TEXT NOT NULL,
        path TEXT,
        session_id TEXT,
        hash TEXT NOT NULL,
        mtime INTEGER NOT NULL,
        size INTEGER NOT NULL,
        PRIMARY KEY (source_kind, source_key),
        FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
      );
      CREATE TABLE memory_index_chunks (
        id TEXT PRIMARY KEY,
        source_kind TEXT NOT NULL DEFAULT 'memory',
        source_key TEXT NOT NULL,
        path TEXT NOT NULL,
        session_id TEXT,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        hash TEXT NOT NULL,
        model TEXT NOT NULL,
        text TEXT NOT NULL,
        embedding BLOB NOT NULL,
        embedding_dims INTEGER,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (source_kind, source_key)
          REFERENCES memory_index_sources(source_kind, source_key) ON DELETE CASCADE,
        FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
      );
      PRAGMA user_version = 1;
    `);
    database
      .prepare(
        `
          INSERT INTO schema_meta
            (meta_key, role, schema_version, agent_id, app_version, created_at, updated_at)
          VALUES ('primary', 'agent', 1, ?, NULL, 1, 1)
        `,
      )
      .run(params.agentId);
  } finally {
    database.close();
  }
  return sqlitePath;
}

function createUnsafeIndexDrift(sqlitePath: string): void {
  const sqlite = nodeSqlite.requireNodeSqlite();
  const database = new sqlite.DatabaseSync(sqlitePath);
  try {
    database.exec(`
      CREATE TABLE unsafe_session_index_records (
        id INTEGER PRIMARY KEY,
        indexed_value TEXT NOT NULL,
        alternate_value TEXT NOT NULL
      );
      CREATE INDEX unsafe_session_index
      ON unsafe_session_index_records(indexed_value);
      INSERT INTO unsafe_session_index_records (indexed_value, alternate_value)
      VALUES ('alpha', 'zeta'), ('beta', 'eta'), ('gamma', 'theta');
    `);
    database.enableDefensive?.(false);
    database.exec("PRAGMA writable_schema = ON;");
    database
      .prepare(
        "UPDATE sqlite_schema SET sql = 'CREATE INDEX unsafe_session_index ON unsafe_session_index_records(alternate_value)' WHERE name = 'unsafe_session_index'",
      )
      .run();
    database.exec("PRAGMA writable_schema = OFF;");
    const schemaVersionRow = database.prepare("PRAGMA schema_version;").get() as
      | Record<string, unknown>
      | undefined;
    const schemaVersion = Number(
      schemaVersionRow?.schema_version ??
        (schemaVersionRow ? Object.values(schemaVersionRow)[0] : undefined),
    );
    database.exec(`PRAGMA schema_version = ${schemaVersion + 1};`);
  } finally {
    database.close();
  }
}

function createCanonicalCacheIndexDrift(sqlitePath: string): void {
  const sqlite = nodeSqlite.requireNodeSqlite();
  const database = new sqlite.DatabaseSync(sqlitePath);
  try {
    database.exec(`
      INSERT INTO cache_entries (scope, key, value_json, expires_at, updated_at)
      VALUES ('doctor', 'canonical-index', '{"ok":true}', 100, 1);
      DROP INDEX idx_agent_cache_expiry;
      CREATE INDEX idx_agent_cache_expiry ON cache_entries(key);
    `);
    database.enableDefensive?.(false);
    database.exec("PRAGMA writable_schema = ON;");
    database
      .prepare(
        `UPDATE sqlite_schema
            SET sql = 'CREATE INDEX idx_agent_cache_expiry ON cache_entries(scope, expires_at, key) WHERE expires_at IS NOT NULL'
          WHERE name = 'idx_agent_cache_expiry'`,
      )
      .run();
    database.exec("PRAGMA writable_schema = OFF;");
    const schemaVersionRow = database.prepare("PRAGMA schema_version;").get() as
      | Record<string, unknown>
      | undefined;
    const schemaVersion = Number(
      schemaVersionRow?.schema_version ??
        (schemaVersionRow ? Object.values(schemaVersionRow)[0] : undefined),
    );
    database.exec(`PRAGMA schema_version = ${schemaVersion + 1};`);
  } finally {
    database.close();
  }
}

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
