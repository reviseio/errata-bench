import path from "node:path";
import { readdir, stat } from "node:fs/promises";

import dotenv from "dotenv";

import {
  getApiEndpointLabel,
  getApiProviderLabel,
  getDefaultResultsId,
  getDefaultJudgeModel
} from "./api-config.js";
import { fingerprintProofreadingDataset, loadProofreadingDataset } from "./dataset.js";
import { buildArtifactBaseName, buildResultsPath, makeRunId, readJson, writeJson } from "./fs.js";
import { buildFailedResultsAttempt, buildResultsArtifact, buildResultsAttempt, renderResultsAscii } from "./results-artifact.js";
import { parseModelVariant, parseModelVariantString, withDefaultReasoningEffort, type ModelVariant } from "./model-config.js";
import { scoreRun } from "./proofreading.js";
import {
  DEFAULT_MAX_TURNS_PER_CHUNK,
  DEFAULT_MAX_WORDS_PER_CHUNK,
  runBenchmarkCase,
  type RunProgressUpdate
} from "./runner.js";
import type { ResultsArtifact, ResultsAttempt, RunArtifact } from "./types.js";

dotenv.config();

const DEFAULT_RESULT_GROUP_ID = getDefaultResultsId();
const DEFAULT_ALTERNATIVE_JUDGE_MODEL = "anthropic/claude-opus-4.6:low";

type CliOptions = {
  datasetPaths: string[];
  groupId: string;
  models: string[];
  modelsFile: string | null;
  judgeModel: string | null;
  runs: number;
  concurrency: number;
  verbose: boolean;
  requestTimeoutMs: number | null;
  maxCompletionTokensPerTurn: number | null;
  reasoningExclude: boolean;
  reasoningMaxTokens: number | null;
  maxTurnsPerChunk: number;
  maxWordsPerChunk: number | null;
};

type AttemptTask = {
  runNumber: number;
  model: ModelVariant;
};

type DatasetExecutionPlan = {
  datasetMeta: Awaited<ReturnType<typeof fingerprintProofreadingDataset>>;
  dataset: Awaited<ReturnType<typeof loadProofreadingDataset>>;
  caseCount: number;
  runPlan: DatasetRunPlan;
};

type ScheduledAttemptTask = AttemptTask & {
  datasetMeta: Awaited<ReturnType<typeof fingerprintProofreadingDataset>>;
  dataset: Awaited<ReturnType<typeof loadProofreadingDataset>>;
  runKey: string;
};

type DatasetRunPlan = {
  attemptTasks: AttemptTask[];
  matchingAttempts: ResultsAttempt[];
  existingMatchingAttempts: number;
  existingMatchingSuccessfulRuns: number;
};

type SpendTotals = {
  total: number | null;
  candidate: number | null;
  judge: number | null;
};

type ActiveRunIdentity = {
  runKey: string;
  runNumber: number;
  datasetName: string;
};

type LiveModelProgress = {
  activeRuns: Map<string, ActiveRunIdentity>;
  activeRunProgress: Map<string, RunProgressUpdate | null>;
  succeededRuns: number;
  failedRuns: number;
  qualityValues: number[];
  efficiencyValues: number[];
  speedValues: number[];
  costValues: number[];
  candidateCostValues: number[];
  judgeCostValues: number[];
  lastStatus: string;
};

function parseArgs(argv: string[]): CliOptions {
  let datasetPaths = ["datasets/v1/generated"];
  let groupId = DEFAULT_RESULT_GROUP_ID;
  let judgeModel: string | null = getDefaultJudgeModel() ?? DEFAULT_ALTERNATIVE_JUDGE_MODEL;
  let models: string[] = [];
  let modelsFile: string | null = "models/starter-models.json";
  let runs = 3;
  let concurrency = 3;
  let verbose = false;
  let requestTimeoutMs: number | null = 360_0000;
  let maxCompletionTokensPerTurn: number | null = null;
  let reasoningExclude = false;
  let reasoningMaxTokens: number | null = null;
  let maxTurnsPerChunk = DEFAULT_MAX_TURNS_PER_CHUNK;
  let maxWordsPerChunk: number | null = DEFAULT_MAX_WORDS_PER_CHUNK;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--dataset") {
      datasetPaths = (argv[index + 1] ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value.length > 0);
      index += 1;
      continue;
    }

    if (arg === "--group-id") {
      groupId = argv[index + 1] ?? groupId;
      index += 1;
      continue;
    }

    if (arg === "--models") {
      models = (argv[index + 1] ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value.length > 0);
      index += 1;
      continue;
    }

    if (arg === "--models-file") {
      modelsFile = argv[index + 1] ?? modelsFile;
      index += 1;
      continue;
    }

    if (arg === "--judge-model") {
      judgeModel = argv[index + 1] ?? judgeModel;
      index += 1;
      continue;
    }

    if (arg === "--no-judge") {
      judgeModel = null;
      continue;
    }

    if (arg === "--runs" || arg === "--samples") {
      runs = Number.parseInt(argv[index + 1] ?? `${runs}`, 10);
      index += 1;
      continue;
    }

    if (arg === "--concurrency") {
      concurrency = Number.parseInt(argv[index + 1] ?? `${concurrency}`, 10);
      index += 1;
      continue;
    }

    if (arg === "--verbose") {
      verbose = true;
      continue;
    }

    if (arg === "--request-timeout-ms") {
      requestTimeoutMs = Number.parseInt(argv[index + 1] ?? "", 10);
      index += 1;
      continue;
    }

    if (arg === "--max-completion-tokens-per-turn") {
      maxCompletionTokensPerTurn = Number.parseInt(argv[index + 1] ?? "", 10);
      index += 1;
      continue;
    }

    if (arg === "--reasoning-exclude") {
      reasoningExclude = true;
      continue;
    }

    if (arg === "--reasoning-max-tokens") {
      reasoningMaxTokens = Number.parseInt(argv[index + 1] ?? "", 10);
      index += 1;
      continue;
    }

    if (arg === "--max-turns-per-chunk" || arg === "--max-turns") {
      maxTurnsPerChunk = Number.parseInt(argv[index + 1] ?? `${maxTurnsPerChunk}`, 10);
      index += 1;
      continue;
    }

    if (arg === "--max-words-per-chunk" || arg === "--chunk-size") {
      const parsed = Number.parseInt(argv[index + 1] ?? "", 10);
      maxWordsPerChunk = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
      index += 1;
      continue;
    }
  }

  return {
    datasetPaths,
    groupId,
    models,
    modelsFile,
    judgeModel,
    runs,
    concurrency,
    verbose,
    requestTimeoutMs,
    maxCompletionTokensPerTurn,
    reasoningExclude,
    reasoningMaxTokens,
    maxTurnsPerChunk,
    maxWordsPerChunk
  };
}

async function loadModels(options: CliOptions): Promise<ModelVariant[]> {
  if (options.models.length > 0) {
    return options.models.map((value, index) => withDefaultReasoningEffort(parseModelVariant(value, `--models[${index}]`)));
  }

  if (!options.modelsFile) {
    throw new Error("Provide --models or --models-file for benchmark runs");
  }

  const filePath = path.resolve(options.modelsFile);
  const parsed = await readJson<unknown>(filePath);

  if (!Array.isArray(parsed)) {
    throw new Error(`Model file "${filePath}" must be a JSON array`);
  }

  return parsed.map((value, index) =>
    withDefaultReasoningEffort(parseModelVariant(value, `Model file "${filePath}" entry ${index + 1}`))
  );
}

async function buildRunForModel(
  datasetPath: string,
  dataset: Awaited<ReturnType<typeof loadProofreadingDataset>>,
  modelVariant: ModelVariant,
  verbose: boolean,
  requestTimeoutMs: number | null,
  maxCompletionTokensPerTurn: number | null,
  reasoningExclude: boolean,
  reasoningMaxTokens: number | null,
  maxTurnsPerChunk: number,
  maxWordsPerChunk: number | null,
  onProgress?: ((update: RunProgressUpdate) => void) | null
): Promise<RunArtifact> {
  // Each concurrent attempt gets its own detached dataset snapshot so future mutations
  // inside the runner/scorer cannot leak across runs.
  const isolatedDataset = structuredClone(dataset);
  const runId = makeRunId();
  const run: RunArtifact = {
    version: "v1",
    runId,
    createdAt: new Date().toISOString(),
    datasetPath,
    maxWordsPerChunk,
    maxTurnsPerChunk,
    mode: "live",
    apiProvider: getApiProviderLabel(),
    apiEndpointLabel: getApiEndpointLabel(),
    model: modelVariant.model,
    modelLabel: modelVariant.label,
    reasoningEffort: modelVariant.reasoningEffort,
    cases: []
  };

  for (const sample of isolatedDataset) {
    run.cases.push(
      await runBenchmarkCase(sample, {
        mock: false,
        model: modelVariant.model,
        verbose,
        requestTimeoutMs,
        maxCompletionTokensPerTurn,
        reasoningEffort: modelVariant.reasoningEffort,
        reasoningExclude,
        reasoningMaxTokens,
        maxTurnsPerChunk,
        maxWordsPerChunk,
        onProgress: onProgress ?? null
      })
    );
  }

  return run;
}

function deepFreeze<T>(value: T): T {
  if (value == null || typeof value !== "object") {
    return value;
  }

  const seen = new Set<object>();

  function freezeRecursive(current: unknown): void {
    if (current == null || typeof current !== "object") {
      return;
    }

    const objectValue = current as object;

    if (seen.has(objectValue)) {
      return;
    }

    seen.add(objectValue);

    for (const nested of Object.values(current as Record<string, unknown>)) {
      freezeRecursive(nested);
    }

    Object.freeze(objectValue);
  }

  freezeRecursive(value);
  return value;
}

async function loadExistingGroup(groupId: string): Promise<ResultsArtifact | null> {
  try {
    const artifact = await readJson<ResultsArtifact>(buildResultsPath(groupId));
    return buildResultsArtifact(artifact.groupId, artifact.attempts, artifact.createdAt);
  } catch {
    return null;
  }
}

async function writeGroupArtifact(groupId: string, attempts: ResultsAttempt[], createdAt?: string | null): Promise<string> {
  const groupPath = buildResultsPath(groupId);
  const artifact = buildResultsArtifact(groupId, attempts, createdAt);
  await writeJson(groupPath, artifact);
  return groupPath;
}

function enqueueCheckpointWrite(
  checkpointWrites: Promise<void>,
  groupId: string,
  attempts: ResultsAttempt[],
  createdAt?: string | null
): Promise<void> {
  return checkpointWrites.then(async () => {
    await writeGroupArtifact(groupId, attempts, createdAt);
  });
}

function normalizeNullableNumber(value: number | null | undefined): number | null {
  return value ?? null;
}

function attemptMatchesRunConfig(
  attempt: ResultsAttempt,
  apiProvider: string | null,
  apiEndpointLabel: string | null,
  datasetPath: string,
  datasetHash: string,
  modelLabel: string,
  judgeModelLabel: string | null,
  maxWordsPerChunk: number | null,
  maxTurnsPerChunk: number
): boolean {
  return (
    (attempt.apiProvider ?? null) === apiProvider &&
    (attempt.apiEndpointLabel ?? null) === apiEndpointLabel &&
    attempt.datasetPath === datasetPath &&
    attempt.datasetHash === datasetHash &&
    attempt.model === modelLabel &&
    (attempt.judgeModel ?? null) === judgeModelLabel &&
    normalizeNullableNumber(attempt.maxWordsPerChunk) === normalizeNullableNumber(maxWordsPerChunk) &&
    (attempt.maxTurnsPerChunk ?? DEFAULT_MAX_TURNS_PER_CHUNK) === maxTurnsPerChunk
  );
}

function countMatchingSuccessfulRuns(
  attempts: ResultsAttempt[],
  apiProvider: string | null,
  apiEndpointLabel: string | null,
  datasetPath: string,
  datasetHash: string,
  modelLabel: string,
  judgeModelLabel: string | null,
  maxWordsPerChunk: number | null,
  maxTurnsPerChunk: number
): number {
  return attempts.filter(
    (attempt) =>
      attempt.succeeded &&
      attemptMatchesRunConfig(
        attempt,
        apiProvider,
        apiEndpointLabel,
        datasetPath,
        datasetHash,
        modelLabel,
        judgeModelLabel,
        maxWordsPerChunk,
        maxTurnsPerChunk
      )
  ).length;
}

function getNextRunNumber(
  attempts: ResultsAttempt[],
  apiProvider: string | null,
  apiEndpointLabel: string | null,
  datasetPath: string,
  datasetHash: string,
  modelLabel: string,
  judgeModelLabel: string | null,
  maxWordsPerChunk: number | null,
  maxTurnsPerChunk: number
): number {
  const matchingRunNumbers = attempts
    .filter((attempt) =>
      attemptMatchesRunConfig(
        attempt,
        apiProvider,
        apiEndpointLabel,
        datasetPath,
        datasetHash,
        modelLabel,
        judgeModelLabel,
        maxWordsPerChunk,
        maxTurnsPerChunk
      )
    )
    .map((attempt) => attempt.runNumber);

  if (matchingRunNumbers.length === 0) {
    return 1;
  }

  return Math.max(...matchingRunNumbers) + 1;
}

function buildDatasetRunPlan(
  models: ModelVariant[],
  targetSuccessfulRunsPerModel: number,
  existingAttempts: ResultsAttempt[],
  apiProvider: string | null,
  apiEndpointLabel: string | null,
  datasetPath: string,
  datasetHash: string,
  judgeModelLabel: string | null,
  maxWordsPerChunk: number | null,
  maxTurnsPerChunk: number
): DatasetRunPlan {
  const tasks: AttemptTask[] = [];
  const matchingAttempts: ResultsAttempt[] = [];
  let existingMatchingAttempts = 0;
  let existingMatchingSuccessfulRuns = 0;

  for (const model of models) {
    const matchingModelAttempts = existingAttempts.filter((attempt) =>
      attemptMatchesRunConfig(
        attempt,
        apiProvider,
        apiEndpointLabel,
        datasetPath,
        datasetHash,
        model.label,
        judgeModelLabel,
        maxWordsPerChunk,
        maxTurnsPerChunk
      )
    );
    const matchingAttemptCount = matchingModelAttempts.length;
    const matchingSuccessfulRuns = countMatchingSuccessfulRuns(
      existingAttempts,
      apiProvider,
      apiEndpointLabel,
      datasetPath,
      datasetHash,
      model.label,
      judgeModelLabel,
      maxWordsPerChunk,
      maxTurnsPerChunk
    );
    const nextRunNumber = getNextRunNumber(
      existingAttempts,
      apiProvider,
      apiEndpointLabel,
      datasetPath,
      datasetHash,
      model.label,
      judgeModelLabel,
      maxWordsPerChunk,
      maxTurnsPerChunk
    );
    const missingRuns = Math.max(0, targetSuccessfulRunsPerModel - matchingSuccessfulRuns);

    matchingAttempts.push(...matchingModelAttempts);
    existingMatchingAttempts += matchingAttemptCount;
    existingMatchingSuccessfulRuns += matchingSuccessfulRuns;

    for (let offset = 0; offset < missingRuns; offset += 1) {
      tasks.push({
        runNumber: nextRunNumber + offset,
        model
      });
    }
  }

  return {
    attemptTasks: tasks,
    matchingAttempts,
    existingMatchingAttempts,
    existingMatchingSuccessfulRuns
  };
}

async function expandDatasetPathEntry(entryPath: string): Promise<string[]> {
  const resolvedPath = path.resolve(entryPath);
  const stats = await stat(resolvedPath).catch(() => null);

  if (!stats) {
    throw new Error(`Dataset path "${entryPath}" does not exist`);
  }

  if (stats.isFile()) {
    if (path.extname(resolvedPath).toLowerCase() !== ".json") {
      throw new Error(`Dataset file "${entryPath}" must be a .json file`);
    }

    return [resolvedPath];
  }

  if (!stats.isDirectory()) {
    throw new Error(`Dataset path "${entryPath}" must be a .json file or directory`);
  }

  const discoveredPaths: string[] = [];

  async function walkDirectory(directoryPath: string): Promise<void> {
    const entries = await readdir(directoryPath, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        continue;
      }

      const childPath = path.join(directoryPath, entry.name);

      if (entry.isDirectory()) {
        await walkDirectory(childPath);
        continue;
      }

      if (entry.isFile() && path.extname(entry.name).toLowerCase() === ".json") {
        discoveredPaths.push(childPath);
      }
    }
  }

  await walkDirectory(resolvedPath);

  if (discoveredPaths.length === 0) {
    throw new Error(`Dataset directory "${entryPath}" does not contain any .json dataset files`);
  }

  return discoveredPaths;
}

async function expandDatasetPaths(datasetPaths: string[]): Promise<string[]> {
  const expandedPaths: string[] = [];
  const seenPaths = new Set<string>();

  for (const datasetPath of datasetPaths) {
    const expandedEntryPaths = await expandDatasetPathEntry(datasetPath);

    for (const expandedPath of expandedEntryPaths) {
      if (seenPaths.has(expandedPath)) {
        continue;
      }

      seenPaths.add(expandedPath);
      expandedPaths.push(expandedPath);
    }
  }

  return expandedPaths;
}

function mean(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sumKnown(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }

  return values.reduce((sum, value) => sum + value, 0);
}

function formatNullable(value: number | null, digits = 3): string {
  if (value == null || Number.isNaN(value)) {
    return "n/a";
  }

  return value.toFixed(digits);
}

function formatUsdShort(value: number | null): string {
  if (value == null || Number.isNaN(value)) {
    return "n/a";
  }

  return `$${value.toFixed(4)}`;
}

function clipLine(value: string, width: number): string {
  if (value.length <= width) {
    return value;
  }

  if (width <= 3) {
    return value.slice(0, width);
  }

  return `${value.slice(0, width - 3)}...`;
}

function buildProgressBar(completed: number, total: number, width: number): string {
  if (total <= 0) {
    return `[${"-".repeat(width)}]`;
  }

  const filledWidth = Math.max(0, Math.min(width, Math.round((completed / total) * width)));
  return `[${"#".repeat(filledWidth)}${"-".repeat(width - filledWidth)}]`;
}

function clipDatasetName(value: string, width = 10): string {
  if (value.length <= width) {
    return value;
  }

  if (width <= 3) {
    return value.slice(0, width);
  }

  return `${value.slice(0, width - 3)}...`;
}

function formatLiveRunProgress(
  activeRun: ActiveRunIdentity,
  progress: RunProgressUpdate | null,
  includeDatasetName: boolean
): string {
  const datasetPrefix = includeDatasetName ? `${clipDatasetName(activeRun.datasetName)} ` : "";

  if (!progress) {
    return `[${datasetPrefix}r${activeRun.runNumber} rq1]`;
  }

  return `[${datasetPrefix}r${activeRun.runNumber} c${progress.chunkIndex}/${progress.chunkCount} t${progress.turn}/${progress.maxTurnsPerChunk} rq${progress.requestCount}]`;
}

function formatLiveRuns(
  activeRuns: Map<string, ActiveRunIdentity>,
  activeRunProgress: Map<string, RunProgressUpdate | null>,
  includeDatasetName: boolean
): string {
  const sorted = [...activeRuns.values()].sort((left, right) => {
    const datasetComparison = left.datasetName.localeCompare(right.datasetName);

    if (datasetComparison !== 0) {
      return datasetComparison;
    }

    return left.runNumber - right.runNumber;
  });

  if (sorted.length === 0) {
    return "-";
  }

  return sorted
    .map((activeRun) =>
      formatLiveRunProgress(activeRun, activeRunProgress.get(activeRun.runKey) ?? null, includeDatasetName)
    )
    .join(" ");
}

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function calculateSpendTotals(attempts: ResultsAttempt[]): SpendTotals {
  return {
    total: sumKnown(attempts.map((attempt) => attempt.totalCostUsd).filter((value): value is number => value != null)),
    candidate: sumKnown(
      attempts.map((attempt) => attempt.candidateCostUsd).filter((value): value is number => value != null)
    ),
    judge: sumKnown(attempts.map((attempt) => attempt.judgeCostUsd).filter((value): value is number => value != null))
  };
}

class BenchProgressDisplay {
  private readonly interactive = Boolean(process.stdout.isTTY);
  private readonly states = new Map<string, LiveModelProgress>();
  private readonly startedAt = Date.now();
  private renderedLineCount = 0;
  private readonly targetRunsPerModel: number;
  private readonly showDatasetInLiveBadges: boolean;

  public constructor(
    private readonly groupId: string,
    private readonly apiProvider: string,
    private readonly apiEndpointLabel: string,
    private readonly datasetLabel: string,
    private readonly datasetHashLabel: string,
    private readonly datasetCount: number,
    private readonly judgeModel: string | null,
    private readonly runs: number,
    private readonly concurrency: number,
    private readonly verbose: boolean,
    private readonly requestTimeoutMs: number | null,
    private readonly maxCompletionTokensPerTurn: number | null,
    private readonly reasoningExclude: boolean,
    private readonly reasoningMaxTokens: number | null,
    private readonly maxTurnsPerChunk: number,
    private readonly maxWordsPerChunk: number | null,
    private readonly models: ModelVariant[],
    private readonly caseCount: number | null,
    private readonly baseSpend: SpendTotals,
    private readonly existingAttemptCount: number,
    private readonly existingMatchingAttempts: ResultsAttempt[],
    private readonly existingMatchingAttemptCount: number,
    private readonly existingMatchingSuccessfulRuns: number,
    private readonly scheduledAttemptCount: number
  ) {
    this.targetRunsPerModel = this.runs * this.datasetCount;
    this.showDatasetInLiveBadges = this.datasetCount > 1;

    for (const model of models) {
      const matchingAttempts = this.existingMatchingAttempts.filter((attempt) => attempt.model === model.label);
      const successfulAttempts = matchingAttempts.filter((attempt) => attempt.succeeded);

      this.states.set(model.label, {
        activeRuns: new Map<string, ActiveRunIdentity>(),
        activeRunProgress: new Map<string, RunProgressUpdate | null>(),
        succeededRuns: successfulAttempts.length,
        failedRuns: matchingAttempts.filter((attempt) => !attempt.succeeded).length,
        qualityValues: successfulAttempts
          .map((attempt) => attempt.qualityAxis)
          .filter((value): value is number => value != null),
        efficiencyValues: successfulAttempts
          .map((attempt) => attempt.efficiencyAxis)
          .filter((value): value is number => value != null),
        speedValues: successfulAttempts
          .map((attempt) => attempt.speedAxis)
          .filter((value): value is number => value != null),
        costValues: successfulAttempts
          .map((attempt) => attempt.totalCostUsd)
          .filter((value): value is number => value != null),
        candidateCostValues: successfulAttempts
          .map((attempt) => attempt.candidateCostUsd)
          .filter((value): value is number => value != null),
        judgeCostValues: successfulAttempts
          .map((attempt) => attempt.judgeCostUsd)
          .filter((value): value is number => value != null),
        lastStatus:
          successfulAttempts.length > 0 ? `resume ${successfulAttempts.length}/${this.targetRunsPerModel}` : "queued"
      });
    }
  }

  public printInitialParameters(): void {
    console.log(`group_id=${this.groupId}`);
    console.log(`api_provider=${this.apiProvider}`);
    console.log(`api_endpoint=${this.apiEndpointLabel}`);
    console.log(`dataset=${this.datasetLabel}`);
    console.log(`dataset_hash=${this.datasetHashLabel}`);
    console.log(`datasets=${this.datasetCount}`);
    console.log(`judge_model=${this.judgeModel ?? "disabled"}`);
    console.log(`runs=${this.runs}`);
    console.log(`concurrency=${this.concurrency}`);
    console.log(`verbose=${this.verbose}`);
    console.log(`request_timeout_ms=${this.requestTimeoutMs ?? "none"}`);
    console.log(`max_completion_tokens_per_turn=${this.maxCompletionTokensPerTurn ?? "default"}`);
    console.log(`reasoning_exclude=${this.reasoningExclude}`);
    console.log(`reasoning_max_tokens=${this.reasoningMaxTokens ?? "default"}`);
    console.log(`max_turns_per_chunk=${this.maxTurnsPerChunk}`);
    console.log(`max_words_per_chunk=${this.maxWordsPerChunk ?? "full"}`);
    console.log(`cases=${this.caseCount ?? "mixed"}`);
    console.log(`target_successful_runs_per_model=${this.runs}`);
    console.log(`target_successful_attempts_per_model=${this.targetRunsPerModel}`);
    console.log(`scheduled_attempts=${this.scheduledAttemptCount}`);
    console.log(`existing_matching_attempts=${this.existingMatchingAttemptCount}`);
    console.log(`existing_matching_successful_runs=${this.existingMatchingSuccessfulRuns}`);
    console.log(`existing_group_attempts=${this.existingAttemptCount}`);
    console.log(`models=${this.models.map((model) => model.label).join(",")}`);
    console.log("");

    if (this.interactive) {
      this.render();
    }
  }

  public onAttemptStart(modelLabel: string, runKey: string, runNumber: number, datasetName: string): void {
    const state = this.states.get(modelLabel);

    if (!state) {
      return;
    }

    state.activeRuns.set(runKey, { runKey, runNumber, datasetName });
    state.activeRunProgress.set(runKey, null);
    state.lastStatus = `running ${state.activeRuns.size}`;

    if (this.interactive) {
      this.render();
      return;
    }

    console.log(`running_model=${modelLabel} dataset=${datasetName} run=${runNumber}`);
  }

  public onAttemptProgress(modelLabel: string, runKey: string, update: RunProgressUpdate): void {
    const state = this.states.get(modelLabel);

    if (!state || !state.activeRuns.has(runKey)) {
      return;
    }

    state.activeRunProgress.set(runKey, update);
    state.lastStatus = `running ${state.activeRuns.size}`;

    if (this.interactive) {
      this.render();
    }
  }

  public onAttemptFinish(attempt: ResultsAttempt, runKey: string): void {
    const state = this.states.get(attempt.model);

    if (!state) {
      return;
    }

    state.activeRuns.delete(runKey);
    state.activeRunProgress.delete(runKey);

    if (attempt.succeeded) {
      state.succeededRuns += 1;

      if (attempt.qualityAxis != null) {
        state.qualityValues.push(attempt.qualityAxis);
      }

      if (attempt.efficiencyAxis != null) {
        state.efficiencyValues.push(attempt.efficiencyAxis);
      }

      if (attempt.speedAxis != null) {
        state.speedValues.push(attempt.speedAxis);
      }

      if (attempt.totalCostUsd != null) {
        state.costValues.push(attempt.totalCostUsd);
      }

      if (attempt.candidateCostUsd != null) {
        state.candidateCostValues.push(attempt.candidateCostUsd);
      }

      if (attempt.judgeCostUsd != null) {
        state.judgeCostValues.push(attempt.judgeCostUsd);
      }

      state.lastStatus = `ok ${attempt.datasetName} r${attempt.runNumber}`;
    } else {
      state.failedRuns += 1;
      state.lastStatus = `fail ${attempt.datasetName} r${attempt.runNumber}`;
    }

    if (this.interactive) {
      this.render();
      return;
    }

    const spendSummary = this.getSpendTotals();

    if (attempt.succeeded) {
      console.log(
        `model_result=${attempt.model} dataset=${attempt.datasetName} run=${attempt.runNumber} corrected_issues=${attempt.correctedIssues}/${attempt.totalIssues} quality=${
          attempt.qualityAxis?.toFixed(4) ?? "n/a"
        } restraint=${attempt.restraintAxis?.toFixed(4) ?? "n/a"} efficiency=${attempt.efficiencyAxis?.toFixed(4) ?? "n/a"} speed=${
          attempt.speedAxis?.toFixed(4) ?? "n/a"
        } cost_usd=${attempt.totalCostUsd?.toFixed(6) ?? "n/a"} group_spend_usd=${formatUsdShort(spendSummary.total)}`
      );
      return;
    }

    console.log(
      `model_failed=${attempt.model} dataset=${attempt.datasetName} run=${attempt.runNumber} error=${attempt.error} group_spend_usd=${formatUsdShort(
        spendSummary.total
      )}`
    );
  }

  public finish(): void {
    if (!this.interactive) {
      return;
    }

    process.stdout.write("\n");
  }

  private render(): void {
    const lines = this.buildLines();

    if (this.renderedLineCount > 0) {
      process.stdout.write(`\u001b[${this.renderedLineCount}A\r`);
    }

    for (const line of lines) {
      process.stdout.write("\u001b[2K");
      process.stdout.write(line);
      process.stdout.write("\n");
    }

    this.renderedLineCount = lines.length;
  }

  private buildLines(): string[] {
    const terminalWidth = Math.max(80, process.stdout.columns ?? 120);
    const totalAttempts = this.models.length * this.targetRunsPerModel;
    const completedAttempts = this.models.reduce((sum, model) => {
      const state = this.states.get(model.label);
      return sum + (state ? Math.min(state.succeededRuns, this.targetRunsPerModel) : 0);
    }, 0);
    const activeAttempts = this.models.reduce((sum, model) => {
      const state = this.states.get(model.label);
      return sum + (state ? state.activeRuns.size : 0);
    }, 0);
    const activeRequestCount = activeAttempts;
    const spendSummary = this.getSpendTotals();
    const elapsed = formatDuration(Date.now() - this.startedAt);

    const modelLines = this.models.map((model) => {
      const state = this.states.get(model.label) as LiveModelProgress;
      const completedRuns = Math.min(state.succeededRuns, this.targetRunsPerModel);
      const modelProgressBar = buildProgressBar(completedRuns, this.targetRunsPerModel, 10);
      const line = [
        model.label.padEnd(34, " "),
        modelProgressBar,
        `${completedRuns}/${this.targetRunsPerModel}`,
        `act:${state.activeRuns.size}`,
        `ok:${state.succeededRuns}`,
        `fail:${state.failedRuns}`,
        `q:${formatNullable(mean(state.qualityValues), 3)}`,
        `eff:${formatNullable(mean(state.efficiencyValues), 2)}`,
        `spd:${formatNullable(mean(state.speedValues), 2)}`,
        `$:${formatUsdShort(mean(state.costValues))}`,
        state.lastStatus,
        `live:${formatLiveRuns(state.activeRuns, state.activeRunProgress, this.showDatasetInLiveBadges)}`
      ].join("  ");

      return clipLine(line, terminalWidth);
    });

    const overallProgressBar = buildProgressBar(completedAttempts, totalAttempts, 24);
    const overallPercent = totalAttempts === 0 ? 0 : (completedAttempts / totalAttempts) * 100;
    const overallLine = clipLine(
      [
        "overall".padEnd(34, " "),
        overallProgressBar,
        `${completedAttempts}/${totalAttempts}`,
        `${overallPercent.toFixed(1)}%`,
        `active:${activeAttempts}`,
        `req:${activeRequestCount}`,
        `spent:${formatUsdShort(spendSummary.total)}`,
        `cand:${formatUsdShort(spendSummary.candidate)}`,
        `judge:${formatUsdShort(spendSummary.judge)}`,
        `elapsed:${elapsed}`
      ].join("  "),
      terminalWidth
    );

    return [...modelLines, overallLine];
  }

  private getSpendTotals(): SpendTotals {
    const sessionTotal = sumKnown(
      this.models.flatMap((model) => {
        const state = this.states.get(model.label);
        return state ? state.costValues : [];
      })
    );
    const sessionCandidate = sumKnown(
      this.models.flatMap((model) => {
        const state = this.states.get(model.label);
        return state ? state.candidateCostValues : [];
      })
    );
    const sessionJudge = sumKnown(
      this.models.flatMap((model) => {
        const state = this.states.get(model.label);
        return state ? state.judgeCostValues : [];
      })
    );

    return {
      total: this.baseSpend.total == null && sessionTotal == null ? null : (this.baseSpend.total ?? 0) + (sessionTotal ?? 0),
      candidate:
        this.baseSpend.candidate == null && sessionCandidate == null
          ? null
          : (this.baseSpend.candidate ?? 0) + (sessionCandidate ?? 0),
      judge:
        this.baseSpend.judge == null && sessionJudge == null ? null : (this.baseSpend.judge ?? 0) + (sessionJudge ?? 0)
    };
  }
}

async function runWithConcurrency<T>(
  tasks: T[],
  concurrency: number,
  shouldStop: () => boolean,
  worker: (task: T) => Promise<void>
): Promise<void> {
  let nextIndex = 0;

  async function runWorker(): Promise<void> {
    while (true) {
      if (shouldStop()) {
        return;
      }

      const taskIndex = nextIndex;
      nextIndex += 1;

      if (taskIndex >= tasks.length) {
        return;
      }

      await worker(tasks[taskIndex]);
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, tasks.length));
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const datasetPaths = await expandDatasetPaths(options.datasetPaths);
  const models = await loadModels(options);
  const apiProvider = getApiProviderLabel();
  const apiEndpointLabel = getApiEndpointLabel();
  const judgeModelVariant =
    options.judgeModel == null ? null : withDefaultReasoningEffort(parseModelVariantString(options.judgeModel));

  if (models.length === 0) {
    throw new Error("No models were provided for the benchmark run");
  }

  if (datasetPaths.length === 0) {
    throw new Error("Provide at least one dataset path with --dataset");
  }

  if (options.runs < 1) {
    throw new Error("--runs must be at least 1");
  }

  if (options.concurrency < 1) {
    throw new Error("--concurrency must be at least 1");
  }

  const groupPath = buildResultsPath(options.groupId);
  const existingGroup = await loadExistingGroup(options.groupId);
  const createdAt = existingGroup?.createdAt ?? new Date().toISOString();
  const attempts: ResultsAttempt[] = [...(existingGroup?.attempts ?? [])];
  const sessionId = makeRunId();
  let checkpointWrites = Promise.resolve();
  let stopRequested = false;

  const handleInterrupt = (): void => {
    if (stopRequested) {
      return;
    }

    stopRequested = true;
    console.error("Interrupt received. No new attempts will start; waiting for in-flight attempts and checkpoints.");
  };

  process.once("SIGINT", handleInterrupt);

  await writeGroupArtifact(options.groupId, attempts, createdAt);
  const datasetPlans: DatasetExecutionPlan[] = [];

  for (const datasetPath of datasetPaths) {
    const datasetMeta = await fingerprintProofreadingDataset(datasetPath);
    const runPlan = buildDatasetRunPlan(
      models,
      options.runs,
      attempts,
      apiProvider,
      apiEndpointLabel,
      datasetMeta.datasetPath,
      datasetMeta.datasetHash,
      judgeModelVariant?.label ?? null,
      options.maxWordsPerChunk,
      options.maxTurnsPerChunk
    );
    const dataset = deepFreeze(await loadProofreadingDataset(datasetMeta.datasetPath));

    datasetPlans.push({
      datasetMeta,
      dataset,
      caseCount: dataset.length,
      runPlan
    });
  }

  const scheduledTasks: ScheduledAttemptTask[] = [];
  const matchingAttempts = datasetPlans.flatMap((plan) => plan.runPlan.matchingAttempts);
  const existingMatchingAttemptCount = datasetPlans.reduce(
    (sum, plan) => sum + plan.runPlan.existingMatchingAttempts,
    0
  );
  const existingMatchingSuccessfulRuns = datasetPlans.reduce(
    (sum, plan) => sum + plan.runPlan.existingMatchingSuccessfulRuns,
    0
  );
  const baseSpend = calculateSpendTotals(attempts);

  for (const plan of datasetPlans) {
    for (const attemptTask of plan.runPlan.attemptTasks) {
      scheduledTasks.push({
        ...attemptTask,
        datasetMeta: plan.datasetMeta,
        dataset: plan.dataset,
        runKey: `${plan.datasetMeta.datasetHash}::${attemptTask.model.label}::${attemptTask.runNumber}`
      });
    }
  }

  const progressDisplay = new BenchProgressDisplay(
    options.groupId,
    apiProvider,
    apiEndpointLabel,
    datasetPlans.length === 1 ? datasetPlans[0].datasetMeta.datasetPath : `${datasetPlans.length} datasets`,
    datasetPlans.length === 1 ? datasetPlans[0].datasetMeta.datasetHash : "mixed",
    datasetPlans.length,
    judgeModelVariant?.label ?? null,
    options.runs,
    options.concurrency,
    options.verbose,
    options.requestTimeoutMs,
    options.maxCompletionTokensPerTurn,
    options.reasoningExclude,
    options.reasoningMaxTokens,
    options.maxTurnsPerChunk,
    options.maxWordsPerChunk,
    models,
    datasetPlans.length === 1 ? datasetPlans[0].caseCount : datasetPlans.reduce((sum, plan) => sum + plan.caseCount, 0),
    baseSpend,
    attempts.length,
    matchingAttempts,
    existingMatchingAttemptCount,
    existingMatchingSuccessfulRuns,
    scheduledTasks.length
  );

  progressDisplay.printInitialParameters();

  if (scheduledTasks.length > 0) {
    await runWithConcurrency(
      scheduledTasks,
      options.concurrency,
      () => stopRequested,
      async ({ runNumber, model, datasetMeta, dataset, runKey }) => {
        progressDisplay.onAttemptStart(model.label, runKey, runNumber, datasetMeta.datasetName);

        const metadata = {
          sessionId,
          datasetPath: datasetMeta.datasetPath,
          datasetName: datasetMeta.datasetName,
          datasetHash: datasetMeta.datasetHash,
          judgeModel: options.judgeModel ? judgeModelVariant?.label ?? null : null,
          apiProvider,
          apiEndpointLabel,
          maxTurnsPerChunk: options.maxTurnsPerChunk,
          maxWordsPerChunk: options.maxWordsPerChunk
        };
        let runArtifact: string | null = null;
        let reportArtifact: string | null = null;
        let runId: string | null = null;

        try {
          const run = await buildRunForModel(
            datasetMeta.datasetPath,
            dataset,
            model,
            options.verbose,
            options.requestTimeoutMs,
            options.maxCompletionTokensPerTurn,
            options.reasoningExclude,
            options.reasoningMaxTokens,
            options.maxTurnsPerChunk,
            options.maxWordsPerChunk,
            (update) => progressDisplay.onAttemptProgress(model.label, runKey, update)
          );
          const artifactBaseName = buildArtifactBaseName(run.runId, datasetMeta.datasetPath, run.modelLabel ?? run.model);
          runArtifact = path.resolve("artifacts/runs", `${artifactBaseName}.json`);
          reportArtifact = path.resolve("artifacts/reports", `${artifactBaseName}.json`);
          runId = run.runId;

          await writeJson(runArtifact, run);
          const report = await scoreRun(run, { judgeModel: judgeModelVariant });
          await writeJson(reportArtifact, report);

          const attempt = buildResultsAttempt(run, report, runArtifact, reportArtifact, runNumber, metadata);
          attempts.push(attempt);
          checkpointWrites = enqueueCheckpointWrite(checkpointWrites, options.groupId, attempts, createdAt);
          await checkpointWrites;
          progressDisplay.onAttemptFinish(attempt, runKey);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const attempt = buildFailedResultsAttempt(model, runNumber, message, metadata, {
            runId: typeof runId === "string" ? runId : null,
            runArtifact,
            reportArtifact
          });
          attempts.push(attempt);
          checkpointWrites = enqueueCheckpointWrite(checkpointWrites, options.groupId, attempts, createdAt);
          await checkpointWrites;
          progressDisplay.onAttemptFinish(attempt, runKey);
        }
      }
    );
  }

  await checkpointWrites;
  progressDisplay.finish();
  process.off("SIGINT", handleInterrupt);

  const resultsArtifact = buildResultsArtifact(options.groupId, attempts, createdAt);
  await writeJson(groupPath, resultsArtifact);

  console.log("ascii_summary_start");
  console.log(renderResultsAscii(resultsArtifact));
  console.log("ascii_summary_end");
  console.log(`group_artifact=${groupPath}`);
  console.log(`results_artifact=${groupPath}`);

  if (stopRequested) {
    process.exitCode = 130;
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
