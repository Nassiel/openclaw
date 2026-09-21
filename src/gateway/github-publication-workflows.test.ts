import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { setUserProfileRole } from "../state/user-profiles.js";
import { GitHubPublicationRecoveryPendingError } from "./github-publication-git-index.js";
import {
  createRequesterPublicationFixture,
  guestScopes,
} from "./github-publication-requester.test-support.js";
import {
  SESSION_ID,
  SESSION_KEY,
  BRANCH,
  commandResult,
  githubPublicationTestMocks,
  installGitHubPublicationTestHarness,
  root,
} from "./github-publication.test-support.js";
import { invalidateOperatorRolePolicy } from "./operator-role-policy.js";
import { handleGatewayRequest } from "./server-methods.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";

const mocks = githubPublicationTestMocks();
// Inert fixture only. No workflow is sent to GitHub or executed.
const workflow = "name: synthetic\non: workflow_dispatch\njobs: {}\n";
const cases = ["add", "modify", "delete", "rename-in", "rename-out", "committed"] as const;
const createRequesters = async () => {
  const f = await createRequesterPublicationFixture(vi.fn(), "local", {
    sessionId: SESSION_ID,
    sessionKey: SESSION_KEY,
  });
  if (!f.local) {
    throw new Error("Expected a local publication fixture.");
  }
  return { ...f, local: f.local };
};

describe("accepted GitHub workflow publication", () => {
  installGitHubPublicationTestHarness({
    creatorEmail: "publication-guest@example.test",
    sandbox: "required",
    realWorktree: true,
  });

  it.each([
    ...cases.map((operation) => ({ operation, allowed: false, actor: "operator" })),
    { operation: "modify", allowed: true, actor: "operator" },
    { operation: "ordinary", allowed: false, actor: "operator" },
    { operation: "modify", allowed: false, actor: "system" },
    { operation: "modify", allowed: true, actor: "system" },
  ] as const)(
    "checks $operation for $actor with full workflow authority=$allowed",
    async ({ operation, allowed, actor }) => {
      const f = await createRequesters();
      const workspace = f.local;
      const workflowPath = path.join(workspace.cwd, ".github/workflows/example.yml");
      const ordinaryPath = path.join(workspace.cwd, "workflow-example.txt");
      await fs.mkdir(path.dirname(workflowPath), { recursive: true });
      if (["modify", "delete", "rename-out", "ordinary"].includes(operation)) {
        await fs.writeFile(workflowPath, workflow);
      }
      if (operation === "rename-in") {
        await fs.writeFile(ordinaryPath, workflow);
      }
      await workspace.git("add", "-A");
      await workspace.git("commit", "-m", "synthetic publication baseline");
      const baseHead = await workspace.git("rev-parse", "HEAD");
      const transport = mocks.runCommand.getMockImplementation()!;
      mocks.runCommand.mockImplementation(async (argv, options) => {
        if (
          argv[0] === "gh" &&
          argv.some((arg: string) => arg.startsWith("repos/openclaw/openclaw/git/ref/heads/"))
        ) {
          return commandResult(JSON.stringify({ ref: "refs/heads/main", sha: baseHead }));
        }
        return await transport(argv, options);
      });
      if (operation === "delete") {
        await fs.unlink(workflowPath);
      } else if (operation === "rename-in") {
        await fs.rename(ordinaryPath, workflowPath);
      } else if (operation === "rename-out") {
        await fs.rename(workflowPath, ordinaryPath);
      } else if (operation !== "ordinary") {
        await fs.writeFile(workflowPath, `${workflow}# accepted change\n`);
      }
      if (operation === "committed") {
        await workspace.git("add", "-A");
        await workspace.git("commit", "-m", "synthetic source commit");
      }
      await fs.writeFile(path.join(workspace.cwd, "artifact.txt"), "ordinary accepted work\n");
      const head = await workspace.git("rev-parse", "HEAD");
      const index = await fs.readFile(path.join(workspace.cwd, ".git/index"));
      const before = await workspace.git("diff", "HEAD");

      const source = allowed ? f.maintainerSource : f.guestSource;
      const client =
        actor === "system"
          ? createSyntheticPluginRuntimeClient({
              operatorRoleActor: { kind: "system" },
              scopes: allowed ? ["operator.write"] : guestScopes,
            })
          : source.client;
      const respond = vi.fn();
      const params = { sessionKey: SESSION_KEY, idempotencyKey: operation };
      await handleGatewayRequest({
        req: { type: "req", id: operation, method: "sessions.github.publish", params },
        context: {
          ...source.context,
          githubPublicationService: f.coordinator,
        } as GatewayRequestContext,
        client,
        isWebchatConnect: () => false,
        respond,
      });
      if (allowed || operation === "ordinary") {
        expect(respond).toHaveBeenCalledWith(
          true,
          expect.objectContaining({ status: "published" }),
        );
        expect(workspace.effects).toEqual(["push", "pull_request"]);
      } else {
        expect(respond).toHaveBeenCalledWith(
          true,
          expect.objectContaining({
            status: "failed",
            code: "github_rejected",
            nextAction: expect.stringContaining("Ask a maintainer"),
          }),
        );
        expect(workspace.effects).toEqual([]);
        expect(await workspace.git("rev-parse", "HEAD")).toBe(head);
        expect(await fs.readFile(path.join(workspace.cwd, ".git/index"))).toEqual(index);
        expect(await workspace.git("diff", "HEAD")).toBe(before);
        expect(await fs.readFile(path.join(workspace.cwd, "artifact.txt"), "utf8")).toBe(
          "ordinary accepted work\n",
        );
      }
    },
  );

  it("checks the accepted tree while leaving later workflow edits unpublished", async () => {
    const f = await createRequesters();
    const workspace = f.local;
    const file = path.join(workspace.cwd, ".github/workflows/later.yml");
    const resolveRepository = mocks.resolveRepository.getMockImplementation()!;
    mocks.resolveRepository.mockImplementationOnce(async () => {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, workflow);
      return await resolveRepository();
    });
    expect(
      await f.coordinator.requestForSession(f.request("immutable-workflows", f.guest)),
    ).toMatchObject({ status: "published" });
    expect(await workspace.git("ls-tree", "HEAD", ".github/workflows")).toBe("");
    expect(await fs.readFile(file, "utf8")).toBe(workflow);
    expect(workspace.effects).toEqual(["push", "pull_request"]);
  });

  it("rechecks workflow permission before push while settling an accepted local commit", async () => {
    const f = await createRequesters();
    const workspace = f.local;
    const file = path.join(workspace.cwd, ".github/workflows/example.yml");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, workflow);
    const transport = mocks.runCommand.getMockImplementation()!;
    mocks.runCommand.mockImplementation(async (args, options) => {
      const result = await transport(args, options);
      if (args.includes("update-ref")) {
        setUserProfileRole(f.maintainerProfile, "revoked");
        invalidateOperatorRolePolicy(f.maintainerProfile);
      }
      return result;
    });
    expect(
      await f.coordinator.requestForSession(f.request("permission-before-push", f.maintainer)),
    ).toMatchObject({ status: "failed", code: "identity_changed" });
    expect(workspace.effects).toEqual([]);
    expect(await workspace.git("show", "HEAD:.github/workflows/example.yml")).toBe(workflow.trim());
    expect(await workspace.git("diff", "--cached", "HEAD")).toBe("");
    expect(await fs.readFile(file, "utf8")).toBe(workflow);
  });

  it("cleans an index reservation when workflow permission closes before local CAS", async () => {
    const f = await createRequesters();
    const workspace = f.local;
    const file = path.join(workspace.cwd, ".github/workflows/example.yml");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, workflow);
    const head = await workspace.git("rev-parse", "HEAD");
    const transport = mocks.runCommand.getMockImplementation()!;
    mocks.runCommand.mockImplementation(async (args, options) => {
      const result = await transport(args, options);
      if (args.includes("write-tree") && options?.env?.GIT_INDEX_FILE?.endsWith("observed-index")) {
        setUserProfileRole(f.maintainerProfile, "revoked");
        invalidateOperatorRolePolicy(f.maintainerProfile);
      }
      return result;
    });
    await expect(
      f.coordinator.requestForSession(f.request("permission-before-cas", f.maintainer)),
    ).resolves.toMatchObject({ status: "failed", code: "identity_changed" });
    expect(workspace.effects).toEqual([]);
    expect(await workspace.git("rev-parse", "HEAD")).toBe(head);
    await expect(fs.stat(path.join(workspace.cwd, ".git/index.lock"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(
      (await fs.readdir(path.join(workspace.cwd, ".git"))).some((entry) =>
        entry.startsWith("index.openclaw-"),
      ),
    ).toBe(false);
    expect(await fs.readFile(file, "utf8")).toBe(workflow);
  });

  it("cannot reintroduce a workflow after a remote reset following the last observation", async () => {
    const f = await createRequesters();
    const workspace = f.local;
    const original = await workspace.git("rev-parse", "HEAD");
    const file = path.join(workspace.cwd, ".github/workflows/example.yml");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, workflow);
    await workspace.git("add", "-A");
    await workspace.git("commit", "-m", "maintainer workflow");
    const published = await workspace.git("rev-parse", "HEAD");
    const remote = path.join(root, "race-remote.git");
    await workspace.git("init", "--bare", remote);
    await workspace.git("push", remote, `${published}:refs/heads/${BRANCH}`);
    await fs.writeFile(path.join(workspace.cwd, "artifact.txt"), "guest change\n");
    const transport = mocks.runCommand.getMockImplementation()!;
    let pushes = 0;
    mocks.runCommand.mockImplementation(async (args, options) => {
      if (args.includes("ls-remote")) {
        return commandResult(
          await workspace.git("ls-remote", "--refs", remote, `refs/heads/${BRANCH}`),
        );
      }
      if (args.includes("push")) {
        pushes += 1;
        await workspace.git("--git-dir", remote, "update-ref", `refs/heads/${BRANCH}`, original);
        const remoteIndex = args.indexOf("--") + 1;
        try {
          return commandResult(
            await workspace.git(
              ...args
                .slice(1)
                .map((arg: string, index: number) => (index + 1 === remoteIndex ? remote : arg)),
            ),
          );
        } catch {
          return commandResult("", 1);
        }
      }
      return await transport(args, options);
    });
    const request = f.request("reset-after-observation", f.guest);
    await expect(f.coordinator.requestForSession(request)).rejects.toThrow(
      GitHubPublicationRecoveryPendingError,
    );
    expect(await f.coordinator.requestForSession(request)).toMatchObject({
      status: "failed",
      code: "github_rejected",
    });
    expect(pushes).toBe(1);
    expect(await workspace.git("--git-dir", remote, "rev-parse", `refs/heads/${BRANCH}`)).toBe(
      original,
    );
    expect(workspace.effects).toEqual([]);
    expect(await fs.readFile(path.join(workspace.cwd, "artifact.txt"), "utf8")).toBe(
      "guest change\n",
    );
  });
});
