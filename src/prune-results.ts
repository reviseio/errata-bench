import path from "node:path";

import { getDefaultResultsId } from "./api-config.js";
import { buildResultsPath, readJson, writeJson } from "./fs.js";
import { buildResultsArtifact } from "./results-artifact.js";
import { parseModelVariantString } from "./model-config.js";
import type { ResultsArtifact } from "./types.js";

type CliOptions = {
  groupId: string;
  datasetPath: string | null;
  datasetHash: string | null;
  model: string | null;
  failedOnly: boolean;
};

function parseArgs(argv: string[]): CliOptions {
  let groupId = getDefaultResultsId();
  let datasetPath: string | null = null;
  let datasetHash: string | null = null;
  let model: string | null = null;
  let failedOnly = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--group-id") {
      groupId = argv[index + 1] ?? groupId;
      index += 1;
      continue;
    }

    if (arg === "--dataset") {
      datasetPath = argv[index + 1] ?? datasetPath;
      index += 1;
      continue;
    }

    if (arg === "--dataset-hash") {
      datasetHash = argv[index + 1] ?? datasetHash;
      index += 1;
      continue;
    }

    if (arg === "--model") {
      model = argv[index + 1] ?? model;
      index += 1;
      continue;
    }

    if (arg === "--failed" || arg === "--failed-only") {
      failedOnly = true;
      continue;
    }
  }

  return { groupId, datasetPath, datasetHash, model, failedOnly };
}

function matchesDatasetPath(candidatePath: string, datasetArg: string): boolean {
  const resolvedArg = path.resolve(datasetArg);
  const argName = path.basename(datasetArg, path.extname(datasetArg));
  const candidateName = path.basename(candidatePath, path.extname(candidatePath));

  return candidatePath === resolvedArg || candidateName === argName;
}

function matchesModel(candidateBaseModel: string, candidateLabel: string, modelArg: string): boolean {
  const variant = parseModelVariantString(modelArg);

  if (variant.reasoningEffort == null) {
    return candidateBaseModel === variant.model || candidateLabel === variant.label;
  }

  return candidateLabel === variant.label;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (!options.datasetPath && !options.datasetHash && !options.model && !options.failedOnly) {
    throw new Error("Pass --dataset and/or --dataset-hash and/or --model and/or --failed");
  }

  const groupPath = buildResultsPath(options.groupId);
  const existing = await readJson<ResultsArtifact>(groupPath);
  const beforeCount = existing.attempts.length;
  const filteredAttempts = existing.attempts.filter((attempt) => {
    const datasetMatches = options.datasetPath ? matchesDatasetPath(attempt.datasetPath, options.datasetPath) : true;
    const hashMatches = options.datasetHash ? attempt.datasetHash === options.datasetHash : true;
    const modelMatches = options.model ? matchesModel(attempt.baseModel, attempt.model, options.model) : true;
    const statusMatches = options.failedOnly ? !attempt.succeeded : true;
    return !(datasetMatches && hashMatches && modelMatches && statusMatches);
  });

  const removedCount = beforeCount - filteredAttempts.length;

  if (removedCount === 0) {
    console.log(`group_id=${options.groupId}`);
    console.log(`removed_attempts=0`);
    console.log(`dataset_filter=${options.datasetPath ?? "none"}`);
    console.log(`dataset_hash_filter=${options.datasetHash ?? "none"}`);
    console.log(`model_filter=${options.model ?? "none"}`);
    console.log(`failed_filter=${options.failedOnly}`);
    console.log(`group_artifact=${groupPath}`);
    return;
  }

  const nextArtifact = buildResultsArtifact(options.groupId, filteredAttempts, existing.createdAt);
  await writeJson(groupPath, nextArtifact);

  console.log(`group_id=${options.groupId}`);
  console.log(`removed_attempts=${removedCount}`);
  console.log(`remaining_attempts=${nextArtifact.attempts.length}`);
  console.log(`dataset_filter=${options.datasetPath ?? "none"}`);
  console.log(`dataset_hash_filter=${options.datasetHash ?? "none"}`);
  console.log(`model_filter=${options.model ?? "none"}`);
  console.log(`failed_filter=${options.failedOnly}`);
  console.log(`group_artifact=${groupPath}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
