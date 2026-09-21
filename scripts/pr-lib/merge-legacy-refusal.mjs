import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Explicit operator recovery qualifies this historical evidence; matching text
// alone never authorizes retry. gh v2.98 canMerge returns before mergePullRequest
// for this complete DIRTY refusal (cli/cli:pkg/cmd/pr/merge/merge.go).
const names = ["gates.env", "merge-output.log", "prep.env", "prep.md"];
const oid = /^[0-9a-f]{40}$/u;
const git = (args, input) =>
  execFileSync(process.env.OPENCLAW_PR_GIT || process.env.GIT_EXEC || "git", args, {
    encoding: "utf8",
    env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
    input,
  });
const hash = (path) => {
  if (!lstatSync(path).isFile()) {
    throw new Error("legacy evidence must be regular files");
  }
  return execFileSync(
    process.env.OPENCLAW_PR_GIT || process.env.GIT_EXEC || "git",
    ["hash-object", "--no-filters", "--", path],
    {
      encoding: "utf8",
    },
  ).trim();
};

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).toSorted()) === JSON.stringify(keys.toSorted())
  );
}

function localAutoRefusal(mode, location, outcome) {
  if (!oid.test(outcome) || git(["cat-file", "-t", outcome]).trim() !== "commit") {
    throw new Error("invalid original outcome identity");
  }
  const record = JSON.parse(git(["show", `${outcome}:outcome.json`]));
  if (
    record.phase !== "intent" ||
    record.route !== "auto" ||
    record.accepted !== false ||
    record.method !== "squash" ||
    !oid.test(record.head) ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(record.attempt)
  ) {
    throw new Error("require the original unaccepted squash auto intent");
  }
  const retained = mode === "--local-auto-tree";
  if (
    retained
      ? !oid.test(location) || git(["cat-file", "-t", location]).trim() !== "tree"
      : !lstatSync(location).isDirectory()
  ) {
    throw new Error("invalid refusal evidence location");
  }
  const entries = retained ? git(["ls-tree", location]).trim().split("\n") : [];
  const read = (name) => {
    if (!retained) {
      const file = join(location, name);
      if (!lstatSync(file).isFile()) {
        throw new Error("refusal evidence must be regular files");
      }
      const contents = readFileSync(file);
      return {
        oid: git(["hash-object", "--no-filters", "--stdin"], contents).trim(),
        contents: contents.toString("utf8"),
      };
    }
    const entry = entries.find((line) => line.endsWith(`\t${name}`)) ?? "";
    const fileOid = /^100644 blob ([0-9a-f]{40})\t/u.exec(entry)?.[1];
    if (!fileOid) {
      throw new Error("refusal evidence must retain regular blobs");
    }
    return { oid: fileOid, contents: git(["cat-file", "blob", fileOid]) };
  };
  const proof = read("refusal.json");
  const manifest = JSON.parse(proof.contents);
  const captureName = `merge-output.${record.attempt}.log`;
  if (
    retained &&
    JSON.stringify(entries.map((entry) => entry.split("\t")[1]).toSorted()) !==
      JSON.stringify([captureName, "refusal.json"].toSorted())
  ) {
    throw new Error("retained refusal evidence has unexpected entries");
  }
  // This manifest is the operator's historical source/argv attestation. Neither
  // today's binary nor the generic error line can establish it automatically.
  if (
    !exactKeys(manifest, ["kind", "client", "outcome", "argv", "capture"]) ||
    manifest.kind !== "octopool-auto-pre-dispatch-refusal" ||
    manifest.outcome !== outcome ||
    !exactKeys(manifest.client, ["version", "revision"]) ||
    manifest.client.version !== "0.6.10" ||
    manifest.client.revision !== "00c442d8084ad26eb5a5003f7372170e75a20c8a" ||
    !exactKeys(manifest.capture, ["name", "oid"]) ||
    manifest.capture.name !== captureName ||
    !oid.test(manifest.capture.oid)
  ) {
    throw new Error("missing or mismatched source-qualified refusal attestation");
  }
  const expected = [
    "pr",
    "merge",
    String(record.pr),
    "--repo",
    record.repo.url,
    "--squash",
    "--auto",
    "--match-head-commit",
    record.head,
    "--body-file",
  ];
  if (
    !Array.isArray(manifest.argv) ||
    manifest.argv.length !== expected.length + 1 ||
    expected.some((value, index) => manifest.argv[index] !== value) ||
    !/^\.local\/merge-body\.[A-Za-z0-9]{6}$/u.test(manifest.argv.at(-1))
  ) {
    throw new Error("historical command differs from the qualified native auto request");
  }
  const capture = read(captureName);
  if (
    capture.oid !== manifest.capture.oid ||
    capture.contents !== "error: string rewrite protection blocked unsafe input\n"
  ) {
    throw new Error("capture is not the complete qualified local refusal");
  }
  if (!retained) {
    const captures = readdirSync(".local").filter((name) =>
      /^merge-output(?:\..+)?\.log$/u.test(name),
    );
    if (
      captures.length !== 1 ||
      captures[0] !== captureName ||
      hash(join(".local", captureName)) !== capture.oid
    ) {
      throw new Error("require the unchanged sole original attempt capture");
    }
  }
  return {
    kind: manifest.kind,
    client: manifest.client,
    files: { "refusal.json": proof.oid, [captureName]: capture.oid },
  };
}

const mode = process.argv[2];
if (mode === "--local-auto" || mode === "--local-auto-tree") {
  try {
    process.stdout.write(JSON.stringify(localAutoRefusal(mode, process.argv[3], process.argv[4])));
  } catch (error) {
    console.error(
      `Local refusal recovery: ${error.message}; preserve the evidence for investigation.`,
    );
    process.exitCode = 1;
  }
} else {
  const [directory, captureOid, repo, pr, repoUrl] = process.argv.slice(2);
  try {
    const captures = readdirSync(".local").filter((name) =>
      /^merge-output(?:\..+)?\.log$/u.test(name),
    );
    if (captures.length !== 1 || captures[0] !== "merge-output.log") {
      throw new Error("require the sole original legacy capture; other attempts remain unresolved");
    }
    const files = Object.fromEntries(names.map((name) => [name, hash(join(directory, name))]));
    if (
      !oid.test(captureOid) ||
      files["merge-output.log"] !== captureOid ||
      hash(".local/merge-output.log") !== captureOid
    ) {
      throw new Error("legacy capture differs from the operator-pinned original");
    }
    const expected = `X Pull request ${repo}#${pr} is not mergeable: the merge commit cannot be cleanly created.
To have the pull request merged after all the requirements have been met, add the \`--auto\` flag.
Run the following to resolve the merge conflicts locally:
  gh pr checkout ${pr} && git fetch origin main && git merge origin/main
`;
    if (readFileSync(join(directory, "merge-output.log"), "utf8") !== expected) {
      throw new Error("capture is not the qualified complete gh pre-dispatch refusal");
    }
    // Historical shell artifacts are data: never source them during recovery.
    const prep = readFileSync(join(directory, "prep.env"), "utf8");
    const field = (name) => {
      const rows = prep.split("\n").filter((line) => line.startsWith(`${name}=`));
      if (rows.length !== 1) {
        throw new Error("missing or duplicate legacy preparation identity");
      }
      return rows[0].slice(name.length + 1);
    };
    const head = field("PREP_HEAD_SHA");
    const preparedBase = field("PREP_MAINLINE_BASE_SHA");
    if (field("PR_NUMBER") !== pr || !oid.test(head) || !oid.test(preparedBase)) {
      throw new Error("invalid legacy PR/head/prepared-base identity");
    }
    const urls = prep.split("\n").filter((line) => line.startsWith("PR_URL="));
    if (urls.length && (urls.length !== 1 || urls[0] !== `PR_URL=${repoUrl}/pull/${pr}`)) {
      throw new Error("legacy preparation belongs to a different PR");
    }
    process.stdout.write(
      JSON.stringify({ kind: "gh-2.98-pre-dispatch-refusal", head, preparedBase, files }),
    );
  } catch (error) {
    console.error(
      `Legacy refusal recovery: ${error.message}; preserve the evidence for investigation.`,
    );
    process.exitCode = 1;
  }
}
