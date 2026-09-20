import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, aroundEach, beforeEach, expect, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as directoryDurability from "../infra/directory-durability.js";
import { withSqliteReadOnlyWorkerScope } from "../infra/sqlite-readonly-worker.js";
import { ExitError } from "../runtime.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import type { ActiveSessionSqliteMigrationRun } from "./doctor-session-sqlite-migration-run.js";
import { resolveTargetSqlitePath } from "./doctor-session-sqlite-readers.js";
import { runDoctorSessionSqlite, type DoctorSessionSqliteReport } from "./doctor-session-sqlite.js";
import { doctorCommand } from "./doctor.js";

export function setupDoctorSessionSqliteTest() {
  const previousEnv = {
    OPENCLAW_CONFIG_PATH: process.env.OPENCLAW_CONFIG_PATH,
    OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR,
  };
  const autoCleanupTempDirs = useAutoCleanupTempDirTracker(afterEach);

  // Reuse child imports within each case; every snapshot admits and reads fresh state.
  aroundEach((runTest) => withSqliteReadOnlyWorkerScope(runTest));
  beforeEach(() => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
  });
  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    restoreEnvValue("OPENCLAW_CONFIG_PATH", previousEnv.OPENCLAW_CONFIG_PATH);
    restoreEnvValue("OPENCLAW_STATE_DIR", previousEnv.OPENCLAW_STATE_DIR);
  });

  function createLegacyStore(
    params: {
      agentDirName?: string;
      customStore?: boolean;
      entryOverrides?: Record<string, unknown>;
      tempRoot?: string;
      transcriptLines?: string[];
    } = {},
  ): TestStore {
    const tempDir = autoCleanupTempDirs.make("openclaw-doctor-session-sqlite-", params.tempRoot);
    const stateDir = path.join(tempDir, "state");
    const configPath = path.join(tempDir, "openclaw.json");
    const sessionDir = params.customStore
      ? path.join(tempDir, "legacy-session-store")
      : path.join(stateDir, "agents", params.agentDirName ?? "main", "sessions");
    const storePath = path.join(sessionDir, "sessions.json");
    const transcriptPath = path.join(sessionDir, "session-1.jsonl");
    const trajectoryPath = path.join(sessionDir, "session-1.trajectory.jsonl");
    const unreferencedJsonlPath = path.join(sessionDir, "orphan.jsonl");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(configPath, "{}\n", { mode: 0o600 });
    fs.writeFileSync(
      storePath,
      JSON.stringify(
        {
          "agent:main:main": {
            channel: "cli",
            chatType: "direct",
            sessionFile: "session-1.jsonl",
            sessionId: "session-1",
            sessionStartedAt: 1000,
            updatedAt: 2000,
            ...params.entryOverrides,
          },
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      transcriptPath,
      `${(params.transcriptLines ?? ['{"type":"session","sessionId":"session-1"}', '{"type":"event","id":"evt-1"}']).join("\n")}\n`,
      { mode: 0o600 },
    );
    fs.writeFileSync(trajectoryPath, `${JSON.stringify({ type: "trajectory" })}\n`, {
      mode: 0o600,
    });
    fs.writeFileSync(unreferencedJsonlPath, '{"type":"event"}\n', {
      mode: 0o600,
    });
    const env = {
      ...process.env,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_STATE_DIR: stateDir,
    };
    process.env.OPENCLAW_CONFIG_PATH = configPath;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    return {
      configPath,
      env,
      sessionDir,
      stateDir,
      storePath,
      tempDir,
      unreferencedJsonlPath,
      trajectoryPath,
      transcriptPath,
    };
  }

  function createHistoricalRestoreStore(version: 1 | 2) {
    const store = createLegacyStore({ transcriptLines: RECOVERY_TRANSCRIPT_LINES });
    const archiveDir = path.join(path.dirname(store.sessionDir), "session-sqlite-import-archive");
    const runsDir = path.join(store.stateDir, "session-sqlite-migration-runs");
    fs.mkdirSync(archiveDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(runsDir, { recursive: true, mode: 0o700 });
    // Model the historical on-disk contract directly; the current importer is not fixture setup.
    const moves = (
      [
        ["transcript", store.transcriptPath],
        ["trajectory", store.trajectoryPath],
        ["unreferenced-jsonl", store.unreferencedJsonlPath],
        ["legacy-store", store.storePath],
      ] as const
    ).map(([kind, sourcePath]) => {
      const archivePath = path.join(archiveDir, `${kind}.${path.basename(sourcePath)}.imported-1`);
      fs.renameSync(sourcePath, archivePath);
      return { kind, sourcePath, archivePath };
    });
    const manifest: SessionSqliteMigrationManifest = {
      manifestVersion: version,
      openClawVersion: "test",
      runId: `historical-v${version}`,
      startedAt: "2026-08-30T00:00:00.000Z",
      completedAt: "2026-08-30T00:00:01.000Z",
      targets: [
        {
          ...trustedMigrationTarget(store),
          plannedMoves: moves,
          completedMoves: structuredClone(moves),
          issues: [],
          validationBeforeArchive: "passed",
        },
      ],
    };
    const manifestPath = path.join(runsDir, `${manifest.runId}.json`);
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
    const archivePath = expectDefined(
      moves.find((move) => move.kind === "transcript"),
      "historical transcript archive",
    ).archivePath;
    return { store, manifestPath, manifest, archivePath };
  }

  function createSharedRecoveryFixture(params: {
    separateIndexes: boolean;
    reverse: boolean;
    sharedTranscript?: boolean;
  }) {
    const independent = createLegacyStore({
      agentDirName: "spare",
      transcriptLines: [
        '{"type":"session","id":"session-1","version":3}',
        '{"type":"message","id":"one","parentId":null,"message":{"role":"user","content":"independent"}}',
      ],
    });
    const { env, stateDir } = independent;
    const sessionDir = path.join(stateDir, "shared-session-store");
    fs.mkdirSync(sessionDir, { recursive: true });
    const owners = params.reverse ? ["work", "main"] : ["main", "work"];
    const storePath = path.join(
      sessionDir,
      params.separateIndexes ? "{agentId}.json" : "sessions.json",
    );
    const records = Object.fromEntries(
      owners.map((owner) => {
        const sessionId = params.sharedTranscript === false ? `${owner}-session` : "main-session";
        fs.writeFileSync(
          path.join(sessionDir, `${sessionId}.jsonl`),
          `${JSON.stringify({ type: "session", version: 3, id: sessionId })}\n${JSON.stringify({ type: "message", id: "one", parentId: null, message: { role: "user", content: "shared original" } })}\n`,
        );
        return [
          `agent:${owner}:main`,
          { sessionId, sessionFile: `${sessionId}.jsonl`, updatedAt: 20 },
        ];
      }),
    );
    const indexes = params.separateIndexes
      ? owners.map((owner) => {
          const index = storePath.replace("{agentId}", owner);
          fs.writeFileSync(
            index,
            JSON.stringify({ [`agent:${owner}:main`]: records[`agent:${owner}:main`] }),
          );
          return index;
        })
      : [storePath];
    if (!params.separateIndexes) {
      fs.writeFileSync(storePath, JSON.stringify(records));
    }
    const cfg = {
      agents: {
        entries: Object.fromEntries(owners.map((owner) => [owner, { default: owner === "main" }])),
      },
      session: { store: storePath },
    };
    return {
      cfg,
      env,
      indexes,
      independent,
      transcriptPath: path.join(sessionDir, "main-session.jsonl"),
    };
  }

  async function createVerifiedRecoveryStore(transcriptLines = RECOVERY_TRANSCRIPT_LINES) {
    const store = createLegacyStore({ transcriptLines });
    const imported = await importLegacyStore(store);
    expect(imported.targets[0]?.issues).toEqual([]);
    const manifest = readMigrationManifest(imported.migrationRun?.manifestPath);
    const archivePath = manifest.targets[0]!.completedMoves.find(
      (move) => move.kind === "transcript",
    )!.archivePath;
    closeOpenClawAgentDatabasesForTest();
    return { store, imported, archivePath };
  }

  return {
    autoCleanupTempDirs,
    createLegacyStore,
    createHistoricalRestoreStore,
    createSharedRecoveryFixture,
    createVerifiedRecoveryStore,
  };
}

function restoreEnvValue(key: keyof NodeJS.ProcessEnv, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}

export type SessionSqliteMigrationManifest = ActiveSessionSqliteMigrationRun["manifest"];

export type TestStore = {
  configPath: string;
  env: NodeJS.ProcessEnv;
  sessionDir: string;
  stateDir: string;
  storePath: string;
  tempDir: string;
  unreferencedJsonlPath: string;
  trajectoryPath: string;
  transcriptPath: string;
};

export const RECOVERY_TRANSCRIPT_LINES = [
  JSON.stringify({
    type: "session",
    id: "session-1",
    version: 3,
    timestamp: "2026-08-30T00:00:00Z",
    cwd: "/fixture",
  }),
  JSON.stringify({
    type: "message",
    id: "one",
    parentId: null,
    message: { role: "user", content: "preserved history" },
  }),
];

export async function runPublicSessionSqlite(
  store: TestStore,
  mode: "import" | "restore" | "recover",
) {
  let exitCode: number | undefined;
  const runtime = {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn((code: number): never => {
      exitCode = code;
      throw new ExitError(code);
    }),
  };
  try {
    await doctorCommand(runtime, {
      sessionSqlite: mode,
      sessionSqliteStore: store.storePath,
      json: true,
    });
  } catch (error) {
    if (!(error instanceof ExitError)) {
      throw error;
    }
  }
  const output = expectDefined(runtime.log.mock.calls.at(-1)?.[0], "Doctor JSON report");
  return {
    exitCode: expectDefined(exitCode, "Doctor exit code"),
    report: JSON.parse(String(output)) as DoctorSessionSqliteReport,
  };
}

export function observeRecoveryDirectorySync(
  manifestDir: string,
  onSynced: (directory: string) => void,
): () => void {
  const sync = directoryDurability.syncDirectory;
  const asyncSpy = vi
    .spyOn(directoryDurability, "syncDirectory")
    .mockImplementation(async (directory, options) => {
      const result = await sync(directory, options);
      onSynced(typeof directory === "string" ? directory : directory.path);
      return result;
    });
  const fsync = fs.fsyncSync;
  const syncSpy = vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
    fsync(fd);
    if (isDirectoryDescriptor(fd, manifestDir)) {
      onSynced(manifestDir);
    }
  });
  return () => {
    asyncSpy.mockRestore();
    syncSpy.mockRestore();
  };
}

export function isDirectoryDescriptor(fd: number, directory: string): boolean {
  const opened = fs.fstatSync(fd);
  if (!opened.isDirectory()) {
    return false;
  }
  const expected = fs.statSync(directory);
  return opened.dev === expected.dev && opened.ino === expected.ino;
}

export function importLegacyStore(store: TestStore): Promise<DoctorSessionSqliteReport> {
  return runDoctorSessionSqlite({
    env: store.env,
    mode: "import",
    store: store.storePath,
  });
}

export function readMigrationManifest(
  manifestPath: string | undefined,
): SessionSqliteMigrationManifest {
  if (!manifestPath) {
    throw new Error("expected migration manifest path");
  }
  return JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as SessionSqliteMigrationManifest;
}

export function simulateHistoricalFailureReportRewrite(manifestPath: string): boolean {
  const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
    failureReports?: { jsonPath?: unknown; markdownPath?: unknown };
    manifestVersion?: unknown;
    [key: string]: unknown;
  };
  // Released Doctors accept only v1-v3. Their schema strips the unknown receipt
  // before the failure-report writer atomically serializes the parsed manifest.
  if (![1, 2, 3].includes(parsed.manifestVersion as number) || !parsed.failureReports) {
    return false;
  }
  parsed.failureReports = {
    jsonPath: parsed.failureReports.jsonPath,
    markdownPath: parsed.failureReports.markdownPath,
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
  return true;
}

export function requireMigrationManifestPath(manifestPath: string | undefined): string {
  if (!manifestPath) {
    throw new Error("expected migration manifest path");
  }
  return manifestPath;
}

export function trustedMigrationTarget(store: TestStore) {
  const target = { agentId: "main", storePath: store.storePath };
  return {
    ...target,
    sqlitePath: resolveTargetSqlitePath(target),
  };
}

export function writeFailedManifest(
  store: TestStore,
  fileName: string,
  failedAt: string,
  target: { agentId?: string; storePath?: string } = {},
): void {
  const runsDir = path.join(store.stateDir, "session-sqlite-migration-runs");
  fs.mkdirSync(runsDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(runsDir, fileName),
    `${JSON.stringify(
      {
        failedAt,
        manifestVersion: 1,
        openClawVersion: "test",
        runId: path.basename(fileName, ".json"),
        startedAt: failedAt,
        targets: [
          {
            agentId: target.agentId ?? "older",
            completedMoves: [],
            issues: [{ code: "older_failure", message: "older failure" }],
            plannedMoves: [],
            sqlitePath: path.join(store.tempDir, "older.sqlite"),
            storePath: target.storePath ?? path.join(store.tempDir, "older-sessions.json"),
            validationBeforeArchive: "failed",
          },
        ],
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
}

export function canonicalTestPaths(paths: string[]): string[] {
  return paths.map((filePath) => canonicalTestPath(filePath)).toSorted();
}

export function canonicalTestPath(filePath: string): string {
  try {
    return fs.realpathSync.native(filePath);
  } catch {
    return path.resolve(filePath);
  }
}
