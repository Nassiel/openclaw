// Doctor session SQLite tests exercise real temp stores and per-agent SQLite files.
import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { prepareGithubIssue } from "../infra/github-issue.js";
import * as nodeSqlite from "../infra/node-sqlite.js";
import { resolveSqliteDatabaseFilePaths } from "../infra/sqlite-files.js";
import { ExitError } from "../runtime.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import {
  claimSessionSqliteMigrationGithubIssue,
  clearSessionSqliteMigrationGithubIssueClaim,
  createSessionSqliteMigrationFailureIssue,
  writeSessionSqliteMigrationFailureReports,
} from "./doctor-session-sqlite-failure.js";
import * as migrationRun from "./doctor-session-sqlite-migration-run.js";
import { inspectSessionSqliteRecovery } from "./doctor-session-sqlite-recovery-inventory.js";
import { retireSessionSqliteRecovery } from "./doctor-session-sqlite-retirement.js";
import { runDoctorSessionSqlite } from "./doctor-session-sqlite.js";
import {
  setupDoctorSessionSqliteTest,
  type SessionSqliteMigrationManifest,
  importLegacyStore,
  readMigrationManifest,
  simulateHistoricalFailureReportRewrite,
  requireMigrationManifestPath,
  trustedMigrationTarget,
  writeFailedManifest,
  canonicalTestPaths,
} from "./doctor-session-sqlite.test-support.js";
import { doctorCommand } from "./doctor.js";

const { createLegacyStore, createVerifiedRecoveryStore } = setupDoctorSessionSqliteTest();

describe("runDoctorSessionSqlite", () => {
  it.each([
    { kind: "transcript", mode: "import", entry: "inner" },
    { kind: "legacy-store", mode: "import", entry: "inner" },
    { kind: "transcript", mode: "restore", entry: "inner" },
    { kind: "legacy-store", mode: "restore", entry: "inner" },
    { kind: "transcript", mode: "import", entry: "public" },
    { kind: "legacy-store", mode: "import", entry: "public" },
    { kind: "transcript", mode: "restore", entry: "public" },
    { kind: "legacy-store", mode: "restore", entry: "public" },
  ] as const)(
    "recovers interrupted $kind publication through $entry $mode",
    async ({ kind, mode, entry }) => {
      const { store } = await createVerifiedRecoveryStore();
      await runDoctorSessionSqlite({ env: store.env, mode: "restore", store: store.storePath });
      const source = kind === "transcript" ? store.transcriptPath : store.storePath;
      const original = fs.readFileSync(source);
      const token = "sk-abcdefghijklmnopqrstuv";
      const unlink = fs.unlinkSync;
      let injected = false;
      const spy = vi.spyOn(fs, "unlinkSync").mockImplementation((file) => {
        if (!injected && file === source) {
          injected = true;
          throw new Error(
            `injected interruption before source unlink: Authorization: Bearer ${token}`,
          );
        }
        return unlink(file);
      });
      let interrupted;
      try {
        interrupted = await importLegacyStore(store);
      } finally {
        spy.mockRestore();
      }
      expect(injected).toBe(true);
      const manifestPath = requireMigrationManifestPath(interrupted.migrationRun?.manifestPath);
      const move = readMigrationManifest(manifestPath).targets[0]!.plannedMoves.find(
        (item) => item.sourcePath === source,
      )!;
      const issueCode =
        kind === "transcript" ? "transcript_archive_failed" : "legacy_store_archive_failed";
      const issue = interrupted.targets[0]?.issues.find((item) => item.code === issueCode);
      expect(issue?.message).toContain("injected interruption before source unlink");
      expect(issue?.message).not.toContain(token);
      expect(fs.readFileSync(source)).toEqual(original);
      expect(fs.statSync(source).nlink).toBe(2);
      expect(fs.statSync(source).ino).toBe(fs.statSync(move.archivePath).ino);
      if (entry === "public") {
        const runtime = {
          log: vi.fn(),
          error: vi.fn(),
          exit: vi.fn((code: number): never => {
            throw new ExitError(code);
          }),
        };
        await expect(
          doctorCommand(runtime, {
            sessionSqlite: mode,
            sessionSqliteStore: store.storePath,
            json: true,
          }),
        ).rejects.toMatchObject({ code: 0 });
      } else {
        const recovered = await runDoctorSessionSqlite({
          env: store.env,
          mode,
          store: store.storePath,
        });
        expect(recovered.targets[0]?.issues).toEqual([]);
      }
      expect(readMigrationManifest(manifestPath).restore?.consumedArchives).toContain(
        move.archivePath,
      );
      expect(fs.existsSync(move.archivePath)).toBe(false);
      if (mode === "restore") {
        expect(fs.statSync(source).nlink).toBe(1);
        expect(fs.readFileSync(source)).toEqual(original);
        const reimport = await importLegacyStore(store);
        expect(reimport.targets[0]?.issues).toEqual([]);
      }
      closeOpenClawAgentDatabasesForTest();
      const cleanup = await retireSessionSqliteRecovery({
        env: store.env,
        preview: inspectSessionSqliteRecovery({ cfg: {}, env: store.env }),
        readConfig: async () => ({}),
        confirm: async () => true,
      });
      expect(cleanup.status).toBe("complete");
      expect(cleanup.totals.removedFiles).toBe(2);
    },
  );

  it.each(["mismatch", "third-link"] as const)(
    "refuses public recovery of a recorded publication with %s",
    async (fault) => {
      const { store, imported } = await createVerifiedRecoveryStore();
      const manifest = readMigrationManifest(imported.migrationRun?.manifestPath);
      const move = manifest.targets[0]!.plannedMoves.find((item) => item.kind === "legacy-store")!;
      fs.linkSync(move.archivePath, move.sourcePath);
      const third = path.join(store.sessionDir, "unexpected-alias");
      if (fault === "third-link") {
        fs.linkSync(move.sourcePath, third);
      } else {
        fs.writeFileSync(move.sourcePath, "different bytes on the same inode");
      }
      const before = fs.readFileSync(move.sourcePath);
      for (const mode of ["import", "restore"] as const) {
        const runtime = {
          log: vi.fn(),
          error: vi.fn(),
          exit: vi.fn((code: number): never => {
            throw new ExitError(code);
          }),
        };
        await expect(
          doctorCommand(runtime, {
            sessionSqlite: mode,
            sessionSqliteStore: store.storePath,
            json: true,
          }),
        ).rejects.toThrow(/hard-linked|publication paths changed/);
        expect(fs.readFileSync(move.sourcePath)).toEqual(before);
        expect(fs.readFileSync(move.archivePath)).toEqual(before);
        expect(fs.statSync(move.sourcePath).nlink).toBe(fault === "third-link" ? 3 : 2);
      }
    },
  );

  it("recovers the latest failed migration run and prepares a sanitized GitHub issue", async () => {
    const store = createLegacyStore({ agentDirName: "token=supersecret" });
    const importReport = await importLegacyStore(store);
    const manifestPath = requireMigrationManifestPath(importReport.migrationRun?.manifestPath);
    const manifest = readMigrationManifest(manifestPath);
    manifest.failedAt = "2030-01-01T00:00:00.000Z";
    expectDefined(manifest.targets[0], "manifest.targets[0] test invariant").issues = [
      {
        code: "startup_failure",
        message: `token=supersecret startup migration failed for agent:main:main at ${store.storePath} and ${process.env.HOME ?? "/Users/example"}/private/openclaw.json`,
        sessionKey: "agent:main:main",
      },
    ];
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    writeFailedManifest(store, "older-failed.json", "2000-01-01T00:00:00.000Z");

    const recover = await runDoctorSessionSqlite({
      cfg: {},
      env: store.env,
      mode: "recover",
    });

    expect(recover.mode).toBe("recover");
    expect(recover.totals).not.toHaveProperty("archivedLegacyStoreFiles");
    expect(recover.totals).not.toHaveProperty("reclaimedBytes");
    expect(recover.targets[0]?.issues).toMatchObject([
      { code: "active_sqlite_transcript_jsonl", sessionKey: "agent:main:main" },
    ]);
    expect(recover.migrationRun?.manifestPath).toBe(manifestPath);
    expect(recover.targets[0]?.restore?.manifestPaths).toEqual([manifestPath]);
    expect(recover.targets[0]?.restore?.restoredFiles).toEqual(
      expect.arrayContaining(canonicalTestPaths([store.transcriptPath, store.trajectoryPath])),
    );
    expect(fs.existsSync(store.transcriptPath)).toBe(true);
    expect(recover.supportIssue?.title).toContain(manifest.runId);
    expect(recover.supportIssue?.body).toContain("startup_failure");
    expect(recover.supportIssue?.body).not.toContain("agent:main:main");
    expect(recover.supportIssue?.body).not.toContain("supersecret");
    expect(recover.supportIssue?.body).not.toContain(store.storePath);
    if (process.env.HOME) {
      expect(recover.supportIssue?.body).not.toContain(process.env.HOME);
    }
    expect(recover.supportIssue).not.toHaveProperty("url");
  });

  it.each(["replaced", "missing"] as const)(
    "refuses a support claim when the saved report is %s during consent",
    (change) => {
      const store = createLegacyStore();
      writeFailedManifest(store, "consent-race.json", "2030-01-01T00:00:00.000Z");
      const manifestPath = path.join(
        store.stateDir,
        "session-sqlite-migration-runs",
        "consent-race.json",
      );
      const { markdownPath } = writeSessionSqliteMigrationFailureReports(manifestPath, {
        reason: "recovery before consent",
      });
      const approved = prepareGithubIssue(
        expectDefined(createSessionSqliteMigrationFailureIssue(manifestPath), "approved report"),
      );
      if (change === "replaced") {
        writeSessionSqliteMigrationFailureReports(manifestPath, {
          reason: "another recovery during consent",
        });
      } else {
        fs.unlinkSync(markdownPath);
      }
      const manifestBefore = fs.readFileSync(manifestPath);

      expect(
        claimSessionSqliteMigrationGithubIssue(manifestPath, approved, { assertCurrent: vi.fn() }),
      ).toBeUndefined();
      expect(fs.readFileSync(manifestPath)).toEqual(manifestBefore);
      if (change === "missing") {
        expect(createSessionSqliteMigrationFailureIssue(manifestPath)).toBeUndefined();
        expect(fs.existsSync(markdownPath)).toBe(false);
        return;
      }

      const current = prepareGithubIssue(
        expectDefined(createSessionSqliteMigrationFailureIssue(manifestPath), "current report"),
      );
      expect(current.marker).not.toBe(approved.marker);
      expect(
        claimSessionSqliteMigrationGithubIssue(manifestPath, current, { assertCurrent: vi.fn() }),
      ).toMatchObject({ issue: { marker: current.marker }, status: "claimed" });
      expect(readMigrationManifest(manifestPath).failureReports?.githubIssue?.marker).toBe(
        current.marker,
      );
    },
  );

  it.each([1, 2, 3] as const)(
    "persists one support issue receipt on a historical v%s manifest",
    (manifestVersion) => {
      const store = createLegacyStore();
      const manifestPath = path.join(store.tempDir, `historical-v${manifestVersion}.json`);
      const failureJsonPath = path.join(
        store.tempDir,
        `historical-v${manifestVersion}.failure.json`,
      );
      const failureMarkdownPath = path.join(
        store.tempDir,
        `historical-v${manifestVersion}.failure.md`,
      );
      const manifest: SessionSqliteMigrationManifest = {
        failedAt: "2030-01-01T00:00:00.000Z",
        failureReports: { jsonPath: failureJsonPath, markdownPath: failureMarkdownPath },
        manifestVersion,
        openClawVersion: "historical",
        runId: `historical-v${manifestVersion}`,
        startedAt: "2030-01-01T00:00:00.000Z",
        targets: [
          {
            ...trustedMigrationTarget(store),
            completedMoves: [],
            issues: [{ code: "startup_failure", message: "sanitized failure" }],
            plannedMoves: [],
            validationBeforeArchive: "failed",
          },
        ],
      };
      fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
      const authority = { assertCurrent: vi.fn() };
      fs.writeFileSync(failureMarkdownPath, `stable sanitized report v${manifestVersion}\n`, {
        mode: 0o600,
      });
      const { marker, title } = prepareGithubIssue(
        expectDefined(createSessionSqliteMigrationFailureIssue(manifestPath), "historical report"),
      );
      const issue = { marker, title };

      expect(claimSessionSqliteMigrationGithubIssue(manifestPath, issue, authority)).toMatchObject({
        issue: { ...issue, status: "attempted" },
        status: "claimed",
      });
      expect(
        claimSessionSqliteMigrationGithubIssue(
          manifestPath,
          { ...issue, title: "regenerated title must not replace the claim" },
          authority,
        ),
      ).toMatchObject({ issue: { ...issue, status: "attempted" }, status: "existing" });

      writeSessionSqliteMigrationFailureReports(manifestPath, { reason: "retry" });
      expect(createSessionSqliteMigrationFailureIssue(manifestPath)).toMatchObject({
        body: expect.stringContaining(`stable sanitized report v${manifestVersion}`),
        title: issue.title,
      });
      const receiptManifest = readMigrationManifest(manifestPath);
      expect(receiptManifest).toMatchObject({
        failureReports: { githubIssue: { ...issue, status: "attempted" } },
        manifestVersion: 4,
      });
      fs.writeFileSync(
        manifestPath,
        `${JSON.stringify({ ...receiptManifest, manifestVersion }, null, 2)}\n`,
        { mode: 0o600 },
      );
      expect(migrationRun.readSessionSqliteMigrationManifest(manifestPath)).toBeUndefined();
      fs.writeFileSync(manifestPath, `${JSON.stringify(receiptManifest, null, 2)}\n`, {
        mode: 0o600,
      });
      const beforeHistoricalRewrite = fs.readFileSync(manifestPath, "utf8");
      expect(simulateHistoricalFailureReportRewrite(manifestPath)).toBe(false);
      expect(fs.readFileSync(manifestPath, "utf8")).toBe(beforeHistoricalRewrite);
      expect(
        claimSessionSqliteMigrationGithubIssue(
          manifestPath,
          {
            marker: `openclaw-report:${"c".repeat(64)}`,
            title: "regenerated process must not replace the claim",
          },
          authority,
        ),
      ).toMatchObject({ issue: { ...issue, status: "attempted" }, status: "existing" });
      const receiptJson = fs.readFileSync(manifestPath, "utf8");
      expect(receiptJson).not.toContain(`stable sanitized report v${manifestVersion}`);
      expect(receiptJson).not.toContain("github.com/openclaw/openclaw/issues/");
      expect(receiptJson).not.toContain("openclaw doctor");
      expect(receiptJson).not.toContain('"body"');
      expect(receiptJson).not.toContain("?body=");
      expect(fs.readFileSync(failureMarkdownPath, "utf8")).toBe(
        `stable sanitized report v${manifestVersion}\n`,
      );
      expect(
        clearSessionSqliteMigrationGithubIssueClaim(manifestPath, issue.marker, authority),
      ).toBe(true);
      const clearedManifest = readMigrationManifest(manifestPath);
      expect(clearedManifest.manifestVersion).toBe(4);
      expect(clearedManifest.failureReports).not.toHaveProperty("githubIssue");
      expect(simulateHistoricalFailureReportRewrite(manifestPath)).toBe(false);
      expect(authority.assertCurrent).toHaveBeenCalledTimes(4);
    },
  );

  it("derives private report paths instead of trusting persisted destinations", () => {
    const store = createLegacyStore();
    const manifestPath = path.join(store.tempDir, "path-ownership.json");
    const expectedJsonPath = path.join(store.tempDir, "path-ownership.failure.json");
    const expectedMarkdownPath = path.join(store.tempDir, "path-ownership.failure.md");
    const untrustedJsonPath = path.join(store.tempDir, "untrusted-destination.json");
    const untrustedMarkdownPath = path.join(store.tempDir, "untrusted-destination.md");
    const manifest: SessionSqliteMigrationManifest = {
      failedAt: "2030-01-01T00:00:00.000Z",
      failureReports: { jsonPath: untrustedJsonPath, markdownPath: untrustedMarkdownPath },
      manifestVersion: 3,
      openClawVersion: "test",
      runId: "path-ownership",
      startedAt: "2030-01-01T00:00:00.000Z",
      targets: [
        {
          ...trustedMigrationTarget(store),
          completedMoves: [],
          issues: [{ code: "startup_failure", message: "sanitized failure" }],
          plannedMoves: [],
          validationBeforeArchive: "failed",
        },
      ],
    };
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    fs.writeFileSync(untrustedJsonPath, "private json sentinel\n", { mode: 0o600 });
    fs.writeFileSync(untrustedMarkdownPath, "private markdown sentinel\n", { mode: 0o600 });

    expect(writeSessionSqliteMigrationFailureReports(manifestPath, { reason: "failed" })).toEqual({
      jsonPath: expectedJsonPath,
      markdownPath: expectedMarkdownPath,
    });
    expect(createSessionSqliteMigrationFailureIssue(manifestPath)).toMatchObject({
      body: expect.not.stringContaining("private markdown sentinel"),
      bodyPath: expectedMarkdownPath,
    });
    expect(fs.readFileSync(untrustedJsonPath, "utf8")).toBe("private json sentinel\n");
    expect(fs.readFileSync(untrustedMarkdownPath, "utf8")).toBe("private markdown sentinel\n");
    expect(readMigrationManifest(manifestPath).failureReports).toEqual({
      jsonPath: expectedJsonPath,
      markdownPath: expectedMarkdownPath,
    });
  });

  it("keeps bounded GitHub issue bodies on a valid UTF-16 boundary", () => {
    const store = createLegacyStore();
    const manifestPath = path.join(store.tempDir, "failed-migration.json");
    const unpairedSurrogate =
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
    const writeManifest = (messages: string[]) => {
      const manifest: SessionSqliteMigrationManifest = {
        failedAt: "2030-01-01T00:00:00.000Z",
        manifestVersion: 2,
        openClawVersion: "test",
        runId: "utf16-boundary",
        startedAt: "2030-01-01T00:00:00.000Z",
        targets: Array.from({ length: Math.ceil(messages.length / 10) }, (_, index) => {
          return {
            agentId: `agent-${index}`,
            completedMoves: [],
            issues: messages.slice(index * 10, (index + 1) * 10).map((message) => ({
              code: "startup_failure",
              message,
            })),
            plannedMoves: [],
            sqlitePath: path.join(store.tempDir, "openclaw-agent.sqlite"),
            storePath: store.storePath,
            validationBeforeArchive: "failed",
          };
        }),
      };
      fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    };

    writeManifest([`${"x".repeat(499)}🎉tail`]);
    const fieldIssue = createSessionSqliteMigrationFailureIssue(manifestPath);
    expect(fieldIssue?.body).toContain(`${"x".repeat(499)}\n`);
    expect(fieldIssue?.body).not.toContain("🎉tail");
    expect(fieldIssue?.body).not.toMatch(unpairedSurrogate);
    expect(fieldIssue).not.toHaveProperty("url");

    for (const [limit, messageCount] of [
      [6_000, 20],
      [20_000, 50],
    ] as const) {
      const marker = "BOUNDARY";
      const messages = Array.from({ length: messageCount - 1 }, () => "");
      writeManifest([...messages, `${marker}!!tail`]);
      const probe = createSessionSqliteMigrationFailureIssue(manifestPath);
      const markerOffset = probe?.body.indexOf(marker) ?? -1;
      expect(markerOffset).toBeGreaterThanOrEqual(0);
      let padding = limit - 1 - markerOffset - marker.length;
      expect(padding).toBeGreaterThanOrEqual(0);

      // Fill earlier fields, each within its 500-unit cap, so path length cannot
      // move the surrogate away from the URL/body boundary being exercised.
      for (let index = 0; index < messages.length; index += 1) {
        const length = Math.min(padding, 500);
        messages[index] = "x".repeat(length);
        padding -= length;
      }
      expect(padding).toBe(0);
      writeManifest([...messages, `${marker}!!tail`]);
      const aligned = createSessionSqliteMigrationFailureIssue(manifestPath);
      expect(aligned?.body.slice(limit - 1 - marker.length, limit)).toBe(`${marker}!`);

      writeManifest([...messages, `${marker}🎉tail`]);
      const issue = createSessionSqliteMigrationFailureIssue(manifestPath);
      expect(issue?.body).not.toMatch(unpairedSurrogate);
      expect(issue).not.toHaveProperty("url");
      if (limit === 6_000) {
        expect(issue?.body).toContain(`${marker}🎉tail`);
      } else {
        expect(issue?.body).toHaveLength(limit - 1);
        expect(issue?.body.endsWith(marker)).toBe(true);
      }
    }
  });

  it("recovers only manifests matching an explicit store selector", async () => {
    const store = createLegacyStore();
    const importReport = await importLegacyStore(store);
    const manifestPath = requireMigrationManifestPath(importReport.migrationRun?.manifestPath);
    const manifest = readMigrationManifest(manifestPath);
    manifest.failedAt = "2030-01-01T00:00:00.000Z";
    expectDefined(manifest.targets[0], "manifest.targets[0] test invariant").issues = [
      { code: "startup_failure", message: "selected store failed after archive" },
    ];
    manifest.targets.push({
      agentId: "other",
      completedMoves: [],
      issues: [{ code: "unselected_failure", message: "unselected target should stay private" }],
      plannedMoves: [],
      sqlitePath: path.join(store.tempDir, "other.sqlite"),
      storePath: path.join(store.tempDir, "other", "sessions.json"),
      validationBeforeArchive: "failed",
    });
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    writeFailedManifest(store, "newer-unselected.json", "2040-01-01T00:00:00.000Z", {
      agentId: "other",
      storePath: path.join(store.tempDir, "other", "sessions.json"),
    });

    const recover = await runDoctorSessionSqlite({
      cfg: {},
      env: store.env,
      mode: "recover",
      store: store.storePath,
    });

    expect(recover.migrationRun?.manifestPath).toBe(manifestPath);
    expect(recover.targets[0]?.restore?.manifestPaths).toEqual([manifestPath]);
    expect(recover.supportIssue?.body).not.toContain("unselected_failure");
    expect(fs.existsSync(store.transcriptPath)).toBe(true);
  });

  it("moves corrupt SQLite database files aside during recovery", async () => {
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
    fs.writeFileSync(`${sqlitePath}-wal`, "wal", { mode: 0o600 });
    fs.writeFileSync(`${sqlitePath}-shm`, "shm", { mode: 0o600 });
    fs.writeFileSync(`${sqlitePath}-journal`, "journal", { mode: 0o600 });

    const report = await runDoctorSessionSqlite({
      env: store.env,
      mode: "recover",
      store: store.storePath,
    });

    expect(report.totals.issues).toBe(0);
    expect(report.targets[0]?.corruptRecovery?.movedFiles).toHaveLength(4);
    expect(report.targets[0]?.corruptRecovery?.skippedFiles).toEqual([]);
    for (const candidate of resolveSqliteDatabaseFilePaths(sqlitePath)) {
      expect(fs.existsSync(candidate)).toBe(false);
      expect(
        report.targets[0]?.corruptRecovery?.movedFiles.some((filePath) =>
          filePath.startsWith(`${candidate}.corrupt-`),
        ),
      ).toBe(true);
    }
  });

  it.skipIf(process.platform === "win32")(
    "recovers owner-readable corrupt SQLite database files",
    async () => {
      const store = createLegacyStore();
      const sqlitePath = path.join(
        store.stateDir,
        "agents",
        "main",
        "agent",
        "openclaw-agent.sqlite",
      );
      fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
      fs.writeFileSync(sqlitePath, "not a sqlite database\n", { mode: 0o400 });

      const report = await runDoctorSessionSqlite({
        env: store.env,
        mode: "recover",
        store: store.storePath,
      });

      expect(report.totals.issues).toBe(0);
      expect(report.targets[0]?.corruptRecovery?.movedFiles).toEqual([
        expect.stringMatching(/openclaw-agent\.sqlite\.corrupt-/u),
      ]);
      expect(fs.existsSync(sqlitePath)).toBe(false);
    },
  );

  it("moves orphaned SQLite sidecars aside during recovery", async () => {
    const store = createLegacyStore();
    const sqlitePath = path.join(
      store.stateDir,
      "agents",
      "main",
      "agent",
      "openclaw-agent.sqlite",
    );
    fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
    fs.writeFileSync(`${sqlitePath}-wal`, "wal", { mode: 0o600 });
    fs.writeFileSync(`${sqlitePath}-journal`, "journal", { mode: 0o600 });

    const report = await runDoctorSessionSqlite({
      env: store.env,
      mode: "recover",
      store: store.storePath,
    });

    expect(report.totals.issues).toBe(0);
    expect(report.targets[0]?.corruptRecovery?.movedFiles).toHaveLength(2);
    expect(report.targets[0]?.corruptRecovery?.skippedFiles).toEqual([
      sqlitePath,
      `${sqlitePath}-shm`,
    ]);
    expect(fs.existsSync(`${sqlitePath}-wal`)).toBe(false);
    expect(fs.existsSync(`${sqlitePath}-journal`)).toBe(false);
  });

  it("rolls back every completed corrupt-file move when a later rename fails", async () => {
    const store = createLegacyStore();
    const sqlitePath = path.join(
      store.stateDir,
      "agents",
      "main",
      "agent",
      "openclaw-agent.sqlite",
    );
    fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
    const expectedContents = new Map<string, string>();
    for (const [candidate, contents] of [
      [sqlitePath, "not a sqlite database\n"],
      [`${sqlitePath}-wal`, "wal"],
      [`${sqlitePath}-shm`, "shm"],
      [`${sqlitePath}-journal`, "journal"],
    ] as const) {
      fs.writeFileSync(candidate, contents, { mode: 0o600 });
      expectedContents.set(candidate, contents);
    }
    const renameSync = fs.renameSync.bind(fs);
    let renameCalls = 0;
    const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      renameCalls += 1;
      if (renameCalls === 2) {
        throw new Error("forced corrupt recovery rename failure");
      }
      renameSync(source, destination);
    });

    let report: Awaited<ReturnType<typeof runDoctorSessionSqlite>> | undefined;
    try {
      report = await runDoctorSessionSqlite({
        env: store.env,
        mode: "recover",
        store: store.storePath,
      });
    } finally {
      renameSpy.mockRestore();
    }

    expect(report?.totals.issues).toBe(1);
    expect(report?.targets[0]?.corruptRecovery).toBeUndefined();
    expect(report?.targets[0]?.issues[0]).toMatchObject({
      code: "sqlite_corrupt_recovery_failed",
      message: expect.stringContaining("forced corrupt recovery rename failure"),
    });
    for (const [candidate, contents] of expectedContents) {
      expect(fs.readFileSync(candidate, "utf8")).toBe(contents);
    }
    expect(
      fs.readdirSync(path.dirname(sqlitePath)).filter((entry) => entry.includes(".corrupt-")),
    ).toEqual([]);
  });

  it("does not move SQLite paths aside for non-corruption recovery inspection failures", async () => {
    const store = createLegacyStore();
    const sqlitePath = path.join(
      store.stateDir,
      "agents",
      "main",
      "agent",
      "openclaw-agent.sqlite",
    );
    fs.mkdirSync(sqlitePath, { recursive: true });

    const report = await runDoctorSessionSqlite({
      env: store.env,
      mode: "recover",
      store: store.storePath,
    });

    expect(report.totals.issues).toBe(1);
    expect(report.targets[0]?.issues[0]?.code).toBe("sqlite_recovery_inspect_failed");
    expect(report.targets[0]?.corruptRecovery).toBeUndefined();
    expect(fs.statSync(sqlitePath).isDirectory()).toBe(true);
  });

  it.each(["maintenance", "inspection"])(
    "preserves recovery state when the %s SQLite loader fails",
    async (failure) => {
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
      const openDatabase = nodeSqlite.openNodeSqliteDatabase;
      const openSqlite = vi
        .spyOn(nodeSqlite, "openNodeSqliteDatabase")
        .mockImplementation((pathname, options) => {
          // An unavailable lease store must refuse; an unreadable agent copy is reportable.
          if (failure === "maintenance" || path.basename(pathname) === path.basename(sqlitePath)) {
            throw new Error("node:sqlite unavailable");
          }
          return openDatabase(pathname, options);
        });

      let report: Awaited<ReturnType<typeof runDoctorSessionSqlite>> | undefined;
      try {
        const recovery = runDoctorSessionSqlite({
          env: store.env,
          mode: "recover",
          store: store.storePath,
        });
        if (failure === "maintenance") {
          await expect(recovery).rejects.toThrow(
            "failed to acquire agent database maintenance lease",
          );
          expect(fs.readFileSync(sqlitePath, "utf8")).toBe("not a sqlite database\n");
          return;
        }
        report = await recovery;
      } finally {
        openSqlite.mockRestore();
      }

      expect(report?.totals.issues).toBe(1);
      expect(report?.targets[0]?.issues[0]).toMatchObject({
        code: "sqlite_recovery_inspect_failed",
        message: expect.stringContaining("node:sqlite unavailable"),
      });
      expect(report?.targets[0]?.corruptRecovery).toBeUndefined();
      expect(fs.existsSync(sqlitePath)).toBe(true);
    },
  );
});
