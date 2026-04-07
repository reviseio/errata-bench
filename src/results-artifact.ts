import { parseModelVariantString, withDefaultReasoningEffort, type ModelVariant } from "./model-config.js";
import type {
  ResultsAggregateRow,
  ResultsArtifact,
  ResultsAttempt,
  ResultsDatasetSummary,
  RunArtifact,
  ScoreArtifact
} from "./types.js";

type DatasetIdentity = {
  datasetPath: string;
  datasetName: string;
  datasetHash: string;
};

type ResultsAttemptMetadata = DatasetIdentity & {
  sessionId: string;
  judgeModel: string | null;
  apiProvider: string | null;
  apiEndpointLabel: string | null;
  maxWordsPerChunk: number | null;
  maxTurnsPerChunk: number;
};

function normalizeAttemptReasoning(attempt: ResultsAttempt): ResultsAttempt {
  const normalizedModel = withDefaultReasoningEffort({
    model: attempt.baseModel,
    label: attempt.model,
    reasoningEffort: attempt.reasoningEffort
  });
  const normalizedJudgeModel =
    attempt.judgeModel == null ? null : withDefaultReasoningEffort(parseModelVariantString(attempt.judgeModel)).label;

  return {
    ...attempt,
    model: normalizedModel.label,
    baseModel: normalizedModel.model,
    reasoningEffort: normalizedModel.reasoningEffort,
    apiProvider: attempt.apiProvider ?? (attempt.model.includes("mock") ? "mock" : "openrouter"),
    apiEndpointLabel: attempt.apiEndpointLabel ?? (attempt.model.includes("mock") ? "mock" : "openrouter"),
    maxWordsPerChunk: attempt.maxWordsPerChunk ?? null,
    maxTurnsPerChunk: attempt.maxTurnsPerChunk ?? 3,
    judgeModel: normalizedJudgeModel,
    attemptedButInvalidRate:
      attempt.attemptedButInvalidRate ??
      (attempt.attemptedButInvalidIssues != null &&
      attempt.totalIssues != null &&
      attempt.totalIssues > 0
        ? attempt.attemptedButInvalidIssues / attempt.totalIssues
        : null),
    notAddressedRate:
      attempt.notAddressedRate ??
      (attempt.notAddressedIssues != null && attempt.totalIssues != null && attempt.totalIssues > 0
        ? attempt.notAddressedIssues / attempt.totalIssues
        : null)
  };
}

function mean(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const midpoint = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 1) {
    return sorted[midpoint] ?? null;
  }

  const left = sorted[midpoint - 1];
  const right = sorted[midpoint];

  if (left == null || right == null) {
    return null;
  }

  return (left + right) / 2;
}

function range(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }

  return Math.max(...values) - Math.min(...values);
}

function compactNumbers(values: Array<number | null>): number[] {
  return values.filter((value): value is number => typeof value === "number");
}

function summarizeField(attempts: ResultsAttempt[], selector: (attempt: ResultsAttempt) => number | null): number | null {
  return mean(compactNumbers(attempts.map(selector)));
}

function summarizeFieldPerDataset(
  attempts: ResultsAttempt[],
  selector: (attempt: ResultsAttempt) => number | null
): number | null {
  const groups = new Map<string, number[]>();

  for (const attempt of attempts) {
    const value = selector(attempt);

    if (value == null || Number.isNaN(value)) {
      continue;
    }

    const key = `${attempt.datasetPath}::${attempt.datasetHash}`;
    const values = groups.get(key) ?? [];
    values.push(value);
    groups.set(key, values);
  }

  return mean(
    [...groups.values()]
      .map((values) => mean(values))
      .filter((value): value is number => value != null && !Number.isNaN(value))
  );
}

function summarizePerDatasetRange(
  attempts: ResultsAttempt[],
  selector: (attempt: ResultsAttempt) => number | null
): number | null {
  const groups = new Map<string, number[]>();

  for (const attempt of attempts) {
    const value = selector(attempt);

    if (value == null || Number.isNaN(value)) {
      continue;
    }

    const key = `${attempt.datasetPath}::${attempt.datasetHash}`;
    const values = groups.get(key) ?? [];
    values.push(value);
    groups.set(key, values);
  }

  return mean(
    [...groups.values()]
      .map((values) => range(values))
      .filter((value): value is number => value != null && !Number.isNaN(value))
  );
}

function summarizePerDatasetRangeMedian(
  attempts: ResultsAttempt[],
  selector: (attempt: ResultsAttempt) => number | null
): number | null {
  const groups = new Map<string, number[]>();

  for (const attempt of attempts) {
    const value = selector(attempt);

    if (value == null || Number.isNaN(value)) {
      continue;
    }

    const key = `${attempt.datasetPath}::${attempt.datasetHash}`;
    const values = groups.get(key) ?? [];
    values.push(value);
    groups.set(key, values);
  }

  return median(
    [...groups.values()]
      .map((values) => range(values))
      .filter((value): value is number => value != null && !Number.isNaN(value))
  );
}

function sumNullable(values: Array<number | null>): number | null {
  let total = 0;
  let sawNumber = false;

  for (const value of values) {
    if (value == null || Number.isNaN(value)) {
      continue;
    }

    total += value;
    sawNumber = true;
  }

  return sawNumber ? total : null;
}

function sumSuccessfulAttemptCosts(
  attempts: ResultsAttempt[],
  selector: (attempt: ResultsAttempt) => number | null
): number | null {
  const successfulAttempts = attempts.filter((attempt) => attempt.succeeded);

  if (successfulAttempts.length === 0) {
    return null;
  }

  if (successfulAttempts.some((attempt) => selector(attempt) == null)) {
    return null;
  }

  return sumNullable(successfulAttempts.map(selector));
}

function formatNullable(value: number | null, digits = 2): string {
  if (value == null || Number.isNaN(value)) {
    return "n/a";
  }

  return value.toFixed(digits);
}

function formatUsd(value: number | null): string {
  if (value == null || Number.isNaN(value)) {
    return "n/a";
  }

  return `$${value.toFixed(4)}`;
}

function formatPercent(value: number | null, digits = 1): string {
  if (value == null || Number.isNaN(value)) {
    return "n/a";
  }

  return `${(value * 100).toFixed(digits)}%`;
}

function compareNullableDesc(left: number | null, right: number | null): number {
  const safeLeft = left ?? Number.NEGATIVE_INFINITY;
  const safeRight = right ?? Number.NEGATIVE_INFINITY;
  return safeRight - safeLeft;
}

function compareNullableAsc(left: number | null, right: number | null): number {
  const safeLeft = left ?? Number.POSITIVE_INFINITY;
  const safeRight = right ?? Number.POSITIVE_INFINITY;
  return safeLeft - safeRight;
}

function clip(value: string, width: number): string {
  if (value.length <= width) {
    return value.padEnd(width, " ");
  }

  if (width <= 3) {
    return value.slice(0, width);
  }

  return `${value.slice(0, width - 3)}...`;
}

function buildBorder(widths: number[]): string {
  return `+${widths.map((width) => "-".repeat(width + 2)).join("+")}+`;
}

function buildRow(values: string[], widths: number[]): string {
  return `| ${values.map((value, index) => clip(value, widths[index])).join(" | ")} |`;
}

function compareAttempts(left: ResultsAttempt, right: ResultsAttempt): number {
  if ((left.apiProvider ?? "") !== (right.apiProvider ?? "")) {
    return (left.apiProvider ?? "").localeCompare(right.apiProvider ?? "");
  }

  if ((left.apiEndpointLabel ?? "") !== (right.apiEndpointLabel ?? "")) {
    return (left.apiEndpointLabel ?? "").localeCompare(right.apiEndpointLabel ?? "");
  }

  const datasetComparison =
    left.datasetPath === right.datasetPath
      ? left.datasetHash.localeCompare(right.datasetHash)
      : left.datasetPath.localeCompare(right.datasetPath);

  if (datasetComparison !== 0) {
    return datasetComparison;
  }

  if (left.model !== right.model) {
    return left.model.localeCompare(right.model);
  }

  if ((left.maxWordsPerChunk ?? Number.MAX_SAFE_INTEGER) !== (right.maxWordsPerChunk ?? Number.MAX_SAFE_INTEGER)) {
    return (left.maxWordsPerChunk ?? Number.MAX_SAFE_INTEGER) - (right.maxWordsPerChunk ?? Number.MAX_SAFE_INTEGER);
  }

  if ((left.maxTurnsPerChunk ?? 3) !== (right.maxTurnsPerChunk ?? 3)) {
    return (left.maxTurnsPerChunk ?? 3) - (right.maxTurnsPerChunk ?? 3);
  }

  if (left.runNumber !== right.runNumber) {
    return left.runNumber - right.runNumber;
  }

  if (left.recordedAt !== right.recordedAt) {
    return left.recordedAt.localeCompare(right.recordedAt);
  }

  return left.sessionId.localeCompare(right.sessionId);
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0))].sort(
    (left, right) => left.localeCompare(right)
  );
}

function datasetKey(value: DatasetIdentity): string {
  return `${value.datasetPath}::${value.datasetHash}`;
}

function buildDatasetSummaries(attempts: ResultsAttempt[]): ResultsDatasetSummary[] {
  const groups = new Map<string, ResultsAttempt[]>();

  for (const attempt of attempts) {
    const key = datasetKey(attempt);
    const group = groups.get(key) ?? [];
    group.push(attempt);
    groups.set(key, group);
  }

  return [...groups.entries()]
    .map(([, datasetAttempts]) => ({
      datasetPath: datasetAttempts[0].datasetPath,
      datasetName: datasetAttempts[0].datasetName,
      datasetHash: datasetAttempts[0].datasetHash,
      attemptCount: datasetAttempts.length,
      succeededAttempts: datasetAttempts.filter((attempt) => attempt.succeeded).length,
      failedAttempts: datasetAttempts.filter((attempt) => !attempt.succeeded).length,
      models: uniqueStrings(datasetAttempts.map((attempt) => attempt.model)),
      judgeModels: uniqueStrings(datasetAttempts.map((attempt) => attempt.judgeModel))
    }))
    .sort((left, right) =>
      left.datasetPath === right.datasetPath
        ? left.datasetHash.localeCompare(right.datasetHash)
        : left.datasetPath.localeCompare(right.datasetPath)
    );
}

export function buildResultsAttempt(
  run: RunArtifact,
  report: ScoreArtifact,
  runArtifact: string,
  reportArtifact: string,
  runNumber: number,
  metadata: ResultsAttemptMetadata
): ResultsAttempt {
  return {
    sessionId: metadata.sessionId,
    recordedAt: new Date().toISOString(),
    model: run.modelLabel ?? run.model,
    baseModel: run.model,
    reasoningEffort: run.reasoningEffort ?? null,
    apiProvider: metadata.apiProvider,
    apiEndpointLabel: metadata.apiEndpointLabel,
    maxWordsPerChunk: metadata.maxWordsPerChunk,
    maxTurnsPerChunk: metadata.maxTurnsPerChunk,
    datasetPath: metadata.datasetPath,
    datasetName: metadata.datasetName,
    datasetHash: metadata.datasetHash,
    judgeModel: metadata.judgeModel,
    runNumber,
    succeeded: true,
    error: null,
    runId: run.runId,
    runArtifact,
    reportArtifact,
    correctedIssues: report.summary.correctedIssues,
    attemptedButInvalidIssues: report.summary.attemptedButInvalidIssues,
    notAddressedIssues: report.summary.notAddressedIssues,
    attemptedButInvalidRate: report.summary.attemptedButInvalidRate,
    notAddressedRate: report.summary.notAddressedRate,
    totalIssues: report.summary.totalIssues,
    fullIssueCoverageCases: report.summary.casesWithFullIssueCoverage,
    totalCases: report.summary.totalCases,
    totalOutputTokens: report.summary.totalOutputTokens,
    totalDurationMs: report.summary.totalDurationMs,
    averageTurnsPerChunk: report.summary.averageTurnsPerChunk,
    correctionsPerOutputToken: report.summary.correctionsPerOutputToken,
    judgePassedCases: report.summary.judge?.casesPassed ?? null,
    judgeResolvedIssues: report.summary.judge?.resolvedIssues ?? null,
    judgeTotalIssues: report.summary.judge?.totalIssues ?? null,
    judgeUnnecessaryChanges: report.summary.judge?.unnecessaryChanges ?? null,
    judgeCollateralDamage: report.summary.judge?.collateralDamageCount ?? null,
    judgeAverageRestraintScore: report.summary.judge?.averageRestraintScore ?? null,
    judgeAverageResolvedIssuesPerUsd: report.summary.judge?.averageResolvedIssuesPerUsd ?? null,
    judgeAverageQualityScore: report.summary.judge?.averageQualityScore ?? null,
    judgeAverageBenchmarkScore: report.summary.judge?.averageBenchmarkScore ?? null,
    qualityAxis: report.summary.axes?.quality ?? null,
    restraintAxis: report.summary.axes?.restraint ?? null,
    efficiencyAxis: report.summary.axes?.efficiency ?? null,
    speedAxis: report.summary.axes?.speed ?? null,
    benchmarkToolCalls: report.summary.tooling?.benchmarkToolCalls ?? null,
    benchmarkToolArgumentChars: report.summary.tooling?.benchmarkToolArgumentChars ?? null,
    offTargetToolCalls: report.summary.tooling?.offTargetToolCalls ?? null,
    offTargetToolArgumentChars: report.summary.tooling?.offTargetToolArgumentChars ?? null,
    benchmarkToolCallsPerResolvedIssue: report.summary.tooling?.benchmarkToolCallsPerResolvedIssue ?? null,
    benchmarkToolCharsPerResolvedIssue: report.summary.tooling?.benchmarkToolCharsPerResolvedIssue ?? null,
    offTargetToolCharsShare: report.summary.tooling?.offTargetToolCharsShare ?? null,
    benchmarkParagraphRewriteShare: report.summary.tooling?.benchmarkParagraphRewriteShare ?? null,
    candidateCostUsd: report.summary.cost?.candidateCostUsd ?? null,
    judgeCostUsd: report.summary.cost?.judgeCostUsd ?? null,
    totalCostUsd: report.summary.cost?.totalCostUsd ?? null
  };
}

export function buildFailedResultsAttempt(
  model: string | ModelVariant,
  runNumber: number,
  error: string,
  metadata: ResultsAttemptMetadata,
  partial?: {
    runId?: string | null;
    runArtifact?: string | null;
    reportArtifact?: string | null;
  }
): ResultsAttempt {
  const modelLabel = typeof model === "string" ? model : model.label;
  const baseModel = typeof model === "string" ? model : model.model;
  const reasoningEffort = typeof model === "string" ? null : model.reasoningEffort;

  return {
    sessionId: metadata.sessionId,
    recordedAt: new Date().toISOString(),
    model: modelLabel,
    baseModel,
    reasoningEffort,
    apiProvider: metadata.apiProvider,
    apiEndpointLabel: metadata.apiEndpointLabel,
    maxWordsPerChunk: metadata.maxWordsPerChunk,
    maxTurnsPerChunk: metadata.maxTurnsPerChunk,
    datasetPath: metadata.datasetPath,
    datasetName: metadata.datasetName,
    datasetHash: metadata.datasetHash,
    judgeModel: metadata.judgeModel,
    runNumber,
    succeeded: false,
    error,
    runId: partial?.runId ?? null,
    runArtifact: partial?.runArtifact ?? null,
    reportArtifact: partial?.reportArtifact ?? null,
    correctedIssues: null,
    attemptedButInvalidIssues: null,
    notAddressedIssues: null,
    attemptedButInvalidRate: null,
    notAddressedRate: null,
    totalIssues: null,
    fullIssueCoverageCases: null,
    totalCases: null,
    totalOutputTokens: null,
    totalDurationMs: null,
    averageTurnsPerChunk: null,
    correctionsPerOutputToken: null,
    judgePassedCases: null,
    judgeResolvedIssues: null,
    judgeTotalIssues: null,
    judgeUnnecessaryChanges: null,
    judgeCollateralDamage: null,
    judgeAverageRestraintScore: null,
    judgeAverageResolvedIssuesPerUsd: null,
    judgeAverageQualityScore: null,
    judgeAverageBenchmarkScore: null,
    qualityAxis: null,
    restraintAxis: null,
    efficiencyAxis: null,
    speedAxis: null,
    benchmarkToolCalls: null,
    benchmarkToolArgumentChars: null,
    offTargetToolCalls: null,
    offTargetToolArgumentChars: null,
    benchmarkToolCallsPerResolvedIssue: null,
    benchmarkToolCharsPerResolvedIssue: null,
    offTargetToolCharsShare: null,
    benchmarkParagraphRewriteShare: null,
    candidateCostUsd: null,
    judgeCostUsd: null,
    totalCostUsd: null
  };
}

function compareAggregates(left: ResultsAggregateRow, right: ResultsAggregateRow): number {
  const qualityComparison = compareNullableDesc(left.qualityAxis, right.qualityAxis);
  if (qualityComparison !== 0) {
    return qualityComparison;
  }

  if (right.stabilityAxis !== left.stabilityAxis) {
    return right.stabilityAxis - left.stabilityAxis;
  }

  const efficiencyComparison = compareNullableDesc(left.efficiencyAxis, right.efficiencyAxis);
  if (efficiencyComparison !== 0) {
    return efficiencyComparison;
  }

  const speedComparison = compareNullableDesc(left.speedAxis, right.speedAxis);
  if (speedComparison !== 0) {
    return speedComparison;
  }

  const costComparison = compareNullableAsc(left.costAxisUsd, right.costAxisUsd);
  if (costComparison !== 0) {
    return costComparison;
  }

  const restraintComparison = compareNullableDesc(left.restraintAxis, right.restraintAxis);
  if (restraintComparison !== 0) {
    return restraintComparison;
  }

  return left.model.localeCompare(right.model);
}

function aggregateKey(attempt: ResultsAttempt): string {
  return `${attempt.apiProvider ?? "unknown"}::${attempt.apiEndpointLabel ?? "unknown"}::${attempt.model}::${attempt.maxWordsPerChunk ?? "full"}::${attempt.maxTurnsPerChunk}`;
}

function formatModelDisplayLabel(
  model: string,
  apiEndpointLabel: string | null,
  maxWordsPerChunk: number | null,
  maxTurnsPerChunk: number
): string {
  const chunkLabel = maxWordsPerChunk == null ? "full" : `${maxWordsPerChunk}w`;
  const endpointSuffix =
    apiEndpointLabel && apiEndpointLabel !== "openrouter" && apiEndpointLabel !== "mock"
      ? ` [${apiEndpointLabel}]`
      : "";
  return `${model}${endpointSuffix} @${chunkLabel}/${maxTurnsPerChunk}t`;
}

export function buildResultsArtifact(
  groupId: string,
  attempts: ResultsAttempt[],
  createdAt?: string | null
): ResultsArtifact {
  const sortedAttempts = attempts.map(normalizeAttemptReasoning).sort(compareAttempts);
  const modelKeys = uniqueStrings(sortedAttempts.map((attempt) => aggregateKey(attempt)));
  const aggregates: ResultsAggregateRow[] = modelKeys.map((modelKey) => {
    const modelAttempts = sortedAttempts.filter((attempt) => aggregateKey(attempt) === modelKey);
    const successfulAttempts = modelAttempts.filter((attempt) => attempt.succeeded);
    const benchmarkScores = compactNumbers(modelAttempts.map((attempt) => attempt.judgeAverageBenchmarkScore));
    const qualitySeries = successfulAttempts.map((attempt) => attempt.qualityAxis);
    const qualityRange = summarizePerDatasetRange(successfulAttempts, (attempt) => attempt.qualityAxis);
    const medianQualityRange = summarizePerDatasetRangeMedian(successfulAttempts, (attempt) => attempt.qualityAxis);
    const totalRuns = modelAttempts.length;
    const successRate = totalRuns === 0 ? 0 : successfulAttempts.length / totalRuns;
    const stabilityPenalty = Math.min(1, qualityRange ?? 0);
    const stabilityAxis = successRate * (1 - stabilityPenalty);
    const datasetCount = new Set(modelAttempts.map((attempt) => datasetKey(attempt))).size;

    return {
      model: formatModelDisplayLabel(
        modelAttempts[0]?.model ?? modelKey,
        successfulAttempts[0]?.apiEndpointLabel ?? modelAttempts[0]?.apiEndpointLabel ?? null,
        modelAttempts[0]?.maxWordsPerChunk ?? null,
        modelAttempts[0]?.maxTurnsPerChunk ?? 3
      ),
      baseModel: successfulAttempts[0]?.baseModel ?? modelAttempts[0]?.baseModel ?? modelKey,
      reasoningEffort: successfulAttempts[0]?.reasoningEffort ?? modelAttempts[0]?.reasoningEffort ?? null,
      apiProvider: successfulAttempts[0]?.apiProvider ?? modelAttempts[0]?.apiProvider ?? null,
      apiEndpointLabel: successfulAttempts[0]?.apiEndpointLabel ?? modelAttempts[0]?.apiEndpointLabel ?? null,
      maxWordsPerChunk: successfulAttempts[0]?.maxWordsPerChunk ?? modelAttempts[0]?.maxWordsPerChunk ?? null,
      maxTurnsPerChunk: successfulAttempts[0]?.maxTurnsPerChunk ?? modelAttempts[0]?.maxTurnsPerChunk ?? 0,
      datasetCount,
      totalRuns,
      succeededRuns: successfulAttempts.length,
      failedRuns: modelAttempts.filter((attempt) => !attempt.succeeded).length,
      successRate,
      runIds: successfulAttempts
        .map((attempt) => attempt.runId)
        .filter((runId): runId is string => typeof runId === "string"),
      runScoreSeries: modelAttempts.map((attempt) => attempt.judgeAverageBenchmarkScore),
      runQualitySeries: qualitySeries,
      meanCorrectedIssues: summarizeFieldPerDataset(modelAttempts, (attempt) => attempt.correctedIssues),
      meanAttemptedButInvalidIssues: summarizeFieldPerDataset(modelAttempts, (attempt) => attempt.attemptedButInvalidIssues),
      meanNotAddressedIssues: summarizeFieldPerDataset(modelAttempts, (attempt) => attempt.notAddressedIssues),
      meanAttemptedButInvalidRate: summarizeFieldPerDataset(modelAttempts, (attempt) => attempt.attemptedButInvalidRate),
      meanNotAddressedRate: summarizeFieldPerDataset(modelAttempts, (attempt) => attempt.notAddressedRate),
      meanTotalIssues: summarizeFieldPerDataset(modelAttempts, (attempt) => attempt.totalIssues),
      meanFullIssueCoverageCases: summarizeFieldPerDataset(modelAttempts, (attempt) => attempt.fullIssueCoverageCases),
      meanTotalCases: summarizeFieldPerDataset(modelAttempts, (attempt) => attempt.totalCases),
      meanTotalOutputTokens: summarizeFieldPerDataset(modelAttempts, (attempt) => attempt.totalOutputTokens),
      meanTotalDurationMs: summarizeFieldPerDataset(modelAttempts, (attempt) => attempt.totalDurationMs),
      meanAverageTurnsPerChunk: summarizeFieldPerDataset(modelAttempts, (attempt) => attempt.averageTurnsPerChunk),
      meanCorrectionsPerOutputToken: summarizeFieldPerDataset(modelAttempts, (attempt) => attempt.correctionsPerOutputToken),
      meanJudgePassedCases: summarizeFieldPerDataset(modelAttempts, (attempt) => attempt.judgePassedCases),
      meanJudgeResolvedIssues: summarizeFieldPerDataset(modelAttempts, (attempt) => attempt.judgeResolvedIssues),
      meanJudgeTotalIssues: summarizeFieldPerDataset(modelAttempts, (attempt) => attempt.judgeTotalIssues),
      meanJudgeUnnecessaryChanges: summarizeFieldPerDataset(modelAttempts, (attempt) => attempt.judgeUnnecessaryChanges),
      meanJudgeCollateralDamage: summarizeFieldPerDataset(modelAttempts, (attempt) => attempt.judgeCollateralDamage),
      meanJudgeAverageRestraintScore: summarizeFieldPerDataset(modelAttempts, (attempt) => attempt.judgeAverageRestraintScore),
      meanJudgeAverageResolvedIssuesPerUsd: summarizeFieldPerDataset(
        modelAttempts,
        (attempt) => attempt.judgeAverageResolvedIssuesPerUsd
      ),
      meanJudgeAverageQualityScore: summarizeFieldPerDataset(modelAttempts, (attempt) => attempt.judgeAverageQualityScore),
      meanJudgeAverageBenchmarkScore: summarizeFieldPerDataset(
        modelAttempts,
        (attempt) => attempt.judgeAverageBenchmarkScore
      ),
      meanCandidateCostUsd: summarizeFieldPerDataset(modelAttempts, (attempt) => attempt.candidateCostUsd),
      meanJudgeCostUsd: summarizeFieldPerDataset(modelAttempts, (attempt) => attempt.judgeCostUsd),
      meanTotalCostUsd: summarizeFieldPerDataset(modelAttempts, (attempt) => attempt.totalCostUsd),
      qualityAxis: summarizeFieldPerDataset(modelAttempts, (attempt) => attempt.qualityAxis),
      restraintAxis: summarizeFieldPerDataset(modelAttempts, (attempt) => attempt.restraintAxis),
      // Average the precomputed per-run values within each dataset first, then average those
      // dataset means so missing/extra successful runs do not skew the headline model metrics.
      efficiencyAxis: summarizeFieldPerDataset(modelAttempts, (attempt) => attempt.efficiencyAxis),
      speedAxis: summarizeFieldPerDataset(modelAttempts, (attempt) => attempt.speedAxis),
      meanBenchmarkToolCalls: summarizeFieldPerDataset(modelAttempts, (attempt) => attempt.benchmarkToolCalls),
      meanBenchmarkToolArgumentChars: summarizeFieldPerDataset(modelAttempts, (attempt) => attempt.benchmarkToolArgumentChars),
      meanOffTargetToolCalls: summarizeFieldPerDataset(modelAttempts, (attempt) => attempt.offTargetToolCalls),
      meanOffTargetToolArgumentChars: summarizeFieldPerDataset(modelAttempts, (attempt) => attempt.offTargetToolArgumentChars),
      meanBenchmarkToolCallsPerResolvedIssue: summarizeFieldPerDataset(
        modelAttempts,
        (attempt) => attempt.benchmarkToolCallsPerResolvedIssue
      ),
      meanBenchmarkToolCharsPerResolvedIssue: summarizeFieldPerDataset(
        modelAttempts,
        (attempt) => attempt.benchmarkToolCharsPerResolvedIssue
      ),
      meanOffTargetToolCharsShare: summarizeFieldPerDataset(modelAttempts, (attempt) => attempt.offTargetToolCharsShare),
      meanBenchmarkParagraphRewriteShare: summarizeFieldPerDataset(
        modelAttempts,
        (attempt) => attempt.benchmarkParagraphRewriteShare
      ),
      costAxisUsd: summarizeFieldPerDataset(modelAttempts, (attempt) => attempt.totalCostUsd),
      stabilityAxis,
      meanPerDatasetQualityRange: qualityRange,
      medianPerDatasetQualityRange: medianQualityRange,
      judgeAverageBenchmarkScoreRange: range(benchmarkScores),
      bestJudgeAverageBenchmarkScore: benchmarkScores.length === 0 ? null : Math.max(...benchmarkScores),
      worstJudgeAverageBenchmarkScore: benchmarkScores.length === 0 ? null : Math.min(...benchmarkScores)
    };
  });

  const ranking = [...aggregates].sort(compareAggregates);
  const datasets = buildDatasetSummaries(sortedAttempts);

  return {
    version: "v1",
    groupId,
    createdAt: createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    models: aggregates.map((aggregate) => aggregate.model).sort((left, right) => left.localeCompare(right)),
    judgeModels: uniqueStrings(sortedAttempts.map((attempt) => attempt.judgeModel)),
    datasets,
    attempts: sortedAttempts,
    aggregates,
    ranking
  };
}

export function renderResultsAscii(artifact: ResultsArtifact): string {
  const widths = [4, 34, 7, 7, 7, 9, 9, 9, 9, 9, 10, 10, 12];
  const totalBenchmarkCostUsd = sumSuccessfulAttemptCosts(artifact.attempts, (attempt) => attempt.totalCostUsd);
  const totalCandidateCostUsd = sumSuccessfulAttemptCosts(artifact.attempts, (attempt) => attempt.candidateCostUsd);
  const totalJudgeCostUsd = sumSuccessfulAttemptCosts(artifact.attempts, (attempt) => attempt.judgeCostUsd);
  const lines = [
    `group_id=${artifact.groupId}`,
    `created_at=${artifact.createdAt}`,
    `updated_at=${artifact.updatedAt}`,
    `dataset_count=${artifact.datasets.length}`,
    `judge_models=${artifact.judgeModels.length === 0 ? "disabled" : artifact.judgeModels.join(",")}`,
    `models=${artifact.models.join(",")}`,
    `attempt_count=${artifact.attempts.length}`,
    `total_benchmark_cost_usd=${formatUsd(totalBenchmarkCostUsd)}`,
    `total_candidate_cost_usd=${formatUsd(totalCandidateCostUsd)}`,
    `total_judge_cost_usd=${formatUsd(totalJudgeCostUsd)}`,
    ""
  ];
  const border = buildBorder(widths);
  lines.push(border);
  lines.push(
    buildRow(
      ["rank", "model", "ok", "quality", "q.rng", "stability", "eff", "speed", "badfix%", "missed%", "tool/iss", "cost/run", "coverage"],
      widths
    )
  );
  lines.push(border);

  artifact.ranking.forEach((row, index) => {
    lines.push(
      buildRow(
        [
          `${index + 1}`,
          row.model,
          `${row.succeededRuns}/${row.totalRuns}`,
          formatNullable(row.qualityAxis ?? null, 3),
          formatNullable(row.meanPerDatasetQualityRange, 3),
          formatNullable(row.stabilityAxis ?? null, 3),
          formatNullable(row.efficiencyAxis ?? null, 2),
          formatNullable(row.speedAxis ?? null, 2),
          formatPercent(row.meanAttemptedButInvalidRate ?? null, 1),
          formatPercent(row.meanNotAddressedRate ?? null, 1),
          formatNullable(row.meanBenchmarkToolCharsPerResolvedIssue ?? null, 1),
          formatUsd(row.costAxisUsd ?? null),
          `${row.datasetCount}ds/${row.totalRuns}r`
        ],
        widths
      )
    );
  });

  lines.push(border);

  if (artifact.datasets.length > 0) {
    lines.push("");
    lines.push("datasets:");
    for (const dataset of artifact.datasets) {
      lines.push(
        `- ${dataset.datasetName} hash=${dataset.datasetHash.slice(0, 12)} attempts=${dataset.attemptCount} ok=${dataset.succeededAttempts}/${dataset.attemptCount}`
      );
    }
  }

  lines.push("");
  lines.push("axes:");
  lines.push("- quality: share of benchmark issues corrected, including alternative repairs accepted by the judge")
  lines.push("- q.rng: mean per-dataset run-to-run quality range across successful runs")
  lines.push("- stability: success-rate-adjusted consistency using the mean per-dataset quality range")
  lines.push("- eff: resolved issues per USD of total run spend")
  lines.push("- speed: resolved issues per minute of candidate wall-clock time")
  lines.push("- badfix: mean share of issues/run where the model changed the bad text but still failed to fix it")
  lines.push("- missed: mean share of issues/run where the original bad text remained uncorrected")
  lines.push("- tool/iss: benchmark-scoped tool argument characters per resolved issue")
  lines.push("- cost/run: estimated candidate + judge cost in USD")

  /*
  const failedAttempts = artifact.attempts.filter((attempt) => !attempt.succeeded);

  if (failedAttempts.length > 0) {
    lines.push("");
    lines.push("failures:");
    for (const attempt of failedAttempts) {
      lines.push(
        `- ${attempt.model} dataset=${attempt.datasetName}#${attempt.datasetHash.slice(0, 8)} run=${attempt.runNumber}: ${attempt.error}`
      );
    }
  }
  */

  return lines.join("\n");
}
