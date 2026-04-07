import path from "node:path";

import dotenv from "dotenv";

import { DEFAULT_DISQUALIFIED_ISSUES_PATH, readIssueDisqualificationManifestSync } from "./issue-disqualifications.js";
import { writeJson } from "./fs.js";

dotenv.config();

type CliOptions = {
  manifestPath: string;
  dataset: string | null;
  caseId: string | null;
  issueIds: string[];
  reason: string | null;
  dryRun: boolean;
};

function parseArgs(argv: string[]): CliOptions {
  let manifestPath = DEFAULT_DISQUALIFIED_ISSUES_PATH;
  let dataset: string | null = null;
  let caseId: string | null = null;
  let issueIds: string[] = [];
  let reason: string | null = null;
  let dryRun = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--manifest") {
      manifestPath = path.resolve(argv[index + 1] ?? manifestPath);
      index += 1;
      continue;
    }

    if (arg === "--dataset") {
      dataset = argv[index + 1] ?? dataset;
      index += 1;
      continue;
    }

    if (arg === "--case-id") {
      caseId = argv[index + 1] ?? caseId;
      index += 1;
      continue;
    }

    if (arg === "--issue-ids") {
      issueIds = (argv[index + 1] ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value.length > 0);
      index += 1;
      continue;
    }

    if (arg === "--reason") {
      reason = argv[index + 1] ?? reason;
      index += 1;
      continue;
    }

    if (arg === "--dry-run") {
      dryRun = true;
    }
  }

  return { manifestPath, dataset, caseId, issueIds, reason, dryRun };
}

function resolveCaseId(options: CliOptions): string {
  if (options.caseId) {
    return options.caseId;
  }

  if (options.dataset) {
    return path.basename(options.dataset, path.extname(options.dataset));
  }

  throw new Error("Provide --dataset or --case-id.");
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const caseId = resolveCaseId(options);

  if (options.issueIds.length === 0) {
    throw new Error("Provide at least one issue id with --issue-ids.");
  }

  const manifest = readIssueDisqualificationManifestSync(options.manifestPath);
  const existingKeys = new Set(manifest.issues.map((issue) => `${issue.caseId}::${issue.issueId}`));
  const additions = options.issueIds
    .map((issueId) => ({
      caseId,
      issueId,
      reason: options.reason ?? undefined
    }))
    .filter((issue) => !existingKeys.has(`${issue.caseId}::${issue.issueId}`));

  const updatedManifest = {
    version: "v1" as const,
    issues: [...manifest.issues, ...additions].sort((left, right) =>
      left.caseId === right.caseId ? left.issueId.localeCompare(right.issueId) : left.caseId.localeCompare(right.caseId)
    )
  };

  console.log(`manifest=${options.manifestPath}`);
  console.log(`case_id=${caseId}`);
  console.log(`requested_issue_ids=${options.issueIds.join(",")}`);
  console.log(`new_issue_ids=${additions.map((issue) => issue.issueId).join(",") || "none"}`);
  console.log(`existing_entries=${manifest.issues.length}`);
  console.log(`updated_entries=${updatedManifest.issues.length}`);
  console.log(`dry_run=${options.dryRun ? "yes" : "no"}`);

  if (options.dryRun) {
    return;
  }

  await writeJson(options.manifestPath, updatedManifest);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
