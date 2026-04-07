import path from "node:path";

import dotenv from "dotenv";

import { getDefaultResultsId } from "./api-config.js";
import { buildResultsPath, readJson, writeJson } from "./fs.js";
import { buildResultsArtifact, buildResultsAttempt } from "./results-artifact.js";
import { parseModelVariantString, withDefaultReasoningEffort, type ModelVariant } from "./model-config.js";
import { scoreRun } from "./proofreading.js";
import type { ResultsArtifact, ResultsAttempt, RunArtifact } from "./types.js";

dotenv.config();

type CliOptions = {
  artifactPath: string | null;
  groupId: string;
  datasetPath: string | null;
  model: string | null;
  judgeModel: string | null;
  concurrency: number;
  requestTimeoutMs: number | null;
};

function parseArgs(argv: string[]): CliOptions {
  let artifactPath: string | null = null;
  let groupId = getDefaultResultsId();
  let datasetPath: string | null = null;
  let model: string | null = null;
  let judgeModel: string | null = null;
  let concurrency = 4;
  let requestTimeoutMs: number | null = 120000;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--artifact") {
      artifactPath = argv[index + 1] ?? artifactPath;
      index += 1;
      continue;
    }

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

    if (arg === "--model") {
      model = argv[index + 1] ?? model;
      index += 1;
      continue;
    }

    if (arg === "--judge-model") {
      judgeModel = argv[index + 1] ?? judgeModel;
      index += 1;
      continue;
    }

    if (arg === "--concurrency") {
      const parsed = Number.parseInt(argv[index + 1] ?? `${concurrency}`, 10);
      concurrency = Number.isFinite(parsed) && parsed > 0 ? parsed : concurrency;
      index += 1;
      continue;
    }

    if (arg === "--request-timeout-ms") {
      const parsed = Number.parseInt(argv[index + 1] ?? "", 10);
      requestTimeoutMs = Number.isFinite(parsed) && parsed > 0 ? parsed : requestTimeoutMs;
      index += 1;
    }
  }

  return { artifactPath, groupId, datasetPath, model, judgeModel, concurrency, requestTimeoutMs };
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

function shouldRescore(attempt: ResultsAttempt, options: CliOptions): boolean {
  if (!attempt.succeeded || !attempt.runArtifact || !attempt.reportArtifact) {
    return false;
  }

  if (options.datasetPath && !matchesDatasetPath(attempt.datasetPath, options.datasetPath)) {
    return false;
  }

  if (options.model && !matchesModel(attempt.baseModel, attempt.model, options.model)) {
    return false;
  }

  return true;
}

function resolveJudgeModel(attempt: ResultsAttempt, judgeModelOverride: string | null): ModelVariant | null {
  if (judgeModelOverride) {
    return withDefaultReasoningEffort(parseModelVariantString(judgeModelOverride));
  }

  if (!attempt.judgeModel) {
    return null;
  }

  return withDefaultReasoningEffort(parseModelVariantString(attempt.judgeModel));
}

async function runWithConcurrency<T>(
  tasks: T[],
  concurrency: number,
  worker: (task: T, index: number) => Promise<void>
): Promise<void> {
  let nextIndex = 0;

  async function runWorker(): Promise<void> {
    while (true) {
      const taskIndex = nextIndex;
      nextIndex += 1;

      if (taskIndex >= tasks.length) {
        return;
      }

      await worker(tasks[taskIndex], taskIndex);
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, tasks.length));
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const artifactPath =
    options.artifactPath != null ? path.resolve(options.artifactPath) : buildResultsPath(options.groupId);
  const rawArtifact = await readJson<ResultsArtifact>(artifactPath);
  const artifact = buildResultsArtifact(rawArtifact.groupId, rawArtifact.attempts, rawArtifact.createdAt);
  const attempts = [...artifact.attempts];
  const matchingIndexes = attempts
    .map((attempt, index) => ({ attempt, index }))
    .filter(({ attempt }) => shouldRescore(attempt, options));

  console.log(`group_id=${artifact.groupId}`);
  console.log(`artifact=${artifactPath}`);
  console.log(`matched_attempts=${matchingIndexes.length}`);
  console.log(`dataset_filter=${options.datasetPath ?? "none"}`);
  console.log(`model_filter=${options.model ?? "none"}`);
  console.log(`judge_model_override=${options.judgeModel ?? "none"}`);
  console.log(`concurrency=${options.concurrency}`);
  console.log(`request_timeout_ms=${options.requestTimeoutMs ?? "none"}`);

  let checkpointWrites = Promise.resolve();
  let completed = 0;
  let failed = 0;

  await runWithConcurrency(matchingIndexes, options.concurrency, async ({ attempt, index: attemptIndex }, taskIndex) => {
    try {
      const run = await readJson<RunArtifact>(attempt.runArtifact as string);
      const judgeModel = resolveJudgeModel(attempt, options.judgeModel);
      const report = await scoreRun(run, {
        judgeModel,
        judgeTimeoutMs: options.requestTimeoutMs
      });
      const reportArtifact = attempt.reportArtifact as string;

      await writeJson(reportArtifact, report);

      attempts[attemptIndex] = buildResultsAttempt(run, report, attempt.runArtifact as string, reportArtifact, attempt.runNumber, {
        sessionId: attempt.sessionId,
        datasetPath: attempt.datasetPath,
        datasetName: attempt.datasetName,
        datasetHash: attempt.datasetHash,
        judgeModel: judgeModel?.label ?? null,
        apiProvider: attempt.apiProvider ?? run.apiProvider ?? null,
        apiEndpointLabel: attempt.apiEndpointLabel ?? run.apiEndpointLabel ?? null,
        maxWordsPerChunk: attempt.maxWordsPerChunk ?? null,
        maxTurnsPerChunk: attempt.maxTurnsPerChunk ?? 3
      });

      checkpointWrites = checkpointWrites.then(async () => {
        const updatedArtifact = buildResultsArtifact(artifact.groupId, attempts, artifact.createdAt);
        await writeJson(artifactPath, updatedArtifact);
      });
      await checkpointWrites;

      completed += 1;
      console.log(
        `rescored=${completed}/${matchingIndexes.length} model=${attempt.model} dataset=${attempt.datasetName} run=${attempt.runNumber} corrected_issues=${report.summary.correctedIssues}/${report.summary.totalIssues}`
      );
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      console.log(
        `rescore_failed=${failed} task=${taskIndex + 1}/${matchingIndexes.length} model=${attempt.model} dataset=${attempt.datasetName} run=${attempt.runNumber} error=${JSON.stringify(message)}`
      );
    }
  });

  await checkpointWrites;

  console.log(`rescored_ok=${completed}`);
  console.log(`rescored_failed=${failed}`);
  console.log(`group_artifact=${artifactPath}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
