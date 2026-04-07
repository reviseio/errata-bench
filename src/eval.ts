import path from "node:path";

import dotenv from "dotenv";

import {
  getApiEndpointLabel,
  getApiProviderLabel,
  getDefaultJudgeModel,
  getDefaultLiveModel
} from "./api-config.js";
import { loadProofreadingDataset } from "./dataset.js";
import { buildArtifactBaseName, makeRunId, writeJson } from "./fs.js";
import { parseModelVariantString, withDefaultReasoningEffort } from "./model-config.js";
import { scoreRun } from "./proofreading.js";
import { DEFAULT_MAX_TURNS_PER_CHUNK, DEFAULT_MAX_WORDS_PER_CHUNK, runBenchmarkCase } from "./runner.js";
import type { RunArtifact } from "./types.js";

dotenv.config();

const DEFAULT_ALTERNATIVE_JUDGE_MODEL = "anthropic/claude-opus-4.6:low";

type CliOptions = {
  datasetPath: string;
  model: string | null;
  judgeModel: string | null;
  judgeDisabled: boolean;
  mock: boolean;
  verbose: boolean;
  requestTimeoutMs: number | null;
  maxCompletionTokensPerTurn: number | null;
  reasoningExclude: boolean;
  reasoningMaxTokens: number | null;
  maxTurnsPerChunk: number;
  maxWordsPerChunk: number | null;
};

function formatNullable(value: number | null, digits = 4): string {
  if (value == null || Number.isNaN(value)) {
    return "n/a";
  }

  return value.toFixed(digits);
}

function parseArgs(argv: string[]): CliOptions {
  let datasetPath = "datasets/v1/starter-suite.json";
  let model: string | null = getDefaultLiveModel();
  let judgeModel: string | null = getDefaultJudgeModel() ?? DEFAULT_ALTERNATIVE_JUDGE_MODEL;
  let judgeDisabled = false;
  let mock = false;
  let verbose = false;
  let requestTimeoutMs: number | null = null;
  let maxCompletionTokensPerTurn: number | null = null;
  let reasoningExclude = false;
  let reasoningMaxTokens: number | null = null;
  let maxTurnsPerChunk = DEFAULT_MAX_TURNS_PER_CHUNK;
  let maxWordsPerChunk: number | null = DEFAULT_MAX_WORDS_PER_CHUNK;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

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
      judgeDisabled = false;
      index += 1;
      continue;
    }

    if (arg === "--no-judge") {
      judgeModel = null;
      judgeDisabled = true;
      continue;
    }

    if (arg === "--max-turns-per-chunk") {
      maxTurnsPerChunk = Number.parseInt(argv[index + 1] ?? `${maxTurnsPerChunk}`, 10);
      index += 1;
      continue;
    }

    if (arg === "--mock") {
      mock = true;
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

    if (arg === "--max-words-per-chunk") {
      const parsed = Number.parseInt(argv[index + 1] ?? "", 10);
      maxWordsPerChunk = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
      index += 1;
      continue;
    }
  }

  return {
    datasetPath,
    model,
    judgeModel,
    judgeDisabled,
    mock,
    verbose,
    requestTimeoutMs,
    maxCompletionTokensPerTurn,
    reasoningExclude,
    reasoningMaxTokens,
    maxTurnsPerChunk,
    maxWordsPerChunk
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (!options.mock && !options.model) {
    throw new Error("Pass --model or set ERRATA_BENCH_DEFAULT_MODEL for a live benchmark run");
  }

  const modelVariant = options.mock
    ? parseModelVariantString("mock-proofreader:none")
    : withDefaultReasoningEffort(parseModelVariantString(options.model as string));

  const judgeModelVariant =
    options.mock || options.judgeDisabled || options.judgeModel == null
      ? null
      : withDefaultReasoningEffort(parseModelVariantString(options.judgeModel));

  const datasetPath = path.resolve(options.datasetPath);
  const dataset = await loadProofreadingDataset(datasetPath);
  const runId = makeRunId();
  const run: RunArtifact = {
    version: "v1",
    runId,
    createdAt: new Date().toISOString(),
    datasetPath,
    maxWordsPerChunk: options.maxWordsPerChunk,
    maxTurnsPerChunk: options.maxTurnsPerChunk,
    mode: options.mock ? "mock" : "live",
    apiProvider: options.mock ? "mock" : getApiProviderLabel(),
    apiEndpointLabel: options.mock ? "mock" : getApiEndpointLabel(),
    model: modelVariant.model,
    modelLabel: modelVariant.label,
    reasoningEffort: modelVariant.reasoningEffort,
    cases: []
  };

  for (const sample of dataset) {
    run.cases.push(
      await runBenchmarkCase(sample, {
        mock: options.mock,
        model: modelVariant.model,
        verbose: options.verbose,
        requestTimeoutMs: options.requestTimeoutMs,
        maxCompletionTokensPerTurn: options.maxCompletionTokensPerTurn,
        reasoningEffort: modelVariant.reasoningEffort,
        reasoningExclude: options.reasoningExclude,
        reasoningMaxTokens: options.reasoningMaxTokens,
        maxTurnsPerChunk: options.maxTurnsPerChunk,
        maxWordsPerChunk: options.maxWordsPerChunk
      })
    );
  }

  const report = await scoreRun(run, {
    judgeModel: judgeModelVariant
  });
  const artifactBaseName = buildArtifactBaseName(runId, datasetPath, run.modelLabel ?? run.model);
  const runPath = path.resolve("artifacts/runs", `${artifactBaseName}.json`);
  const reportPath = path.resolve("artifacts/reports", `${artifactBaseName}.json`);

  await writeJson(runPath, run);
  await writeJson(reportPath, report);

  console.log(`run_id=${runId}`);
  console.log(`mode=${run.mode}`);
  console.log(`api_provider=${run.apiProvider ?? "mock"}`);
  console.log(`api_endpoint=${run.apiEndpointLabel ?? "mock"}`);
  console.log(`model=${run.model}`);
  console.log(`model_label=${run.modelLabel ?? run.model}`);
  console.log(`reasoning_effort=${run.reasoningEffort ?? "medium"}`);
  console.log(`judge_model=${report.summary.judge?.judgeModel ?? "disabled"}`);
  console.log(`dataset=${datasetPath}`);
  console.log(`max_words_per_chunk=${run.maxWordsPerChunk ?? "full"}`);
  console.log(`max_turns_per_chunk=${run.maxTurnsPerChunk ?? DEFAULT_MAX_TURNS_PER_CHUNK}`);
  console.log(`corrected_issues=${report.summary.correctedIssues}/${report.summary.totalIssues}`);
  console.log(`attempted_but_invalid_issues=${report.summary.attemptedButInvalidIssues}/${report.summary.totalIssues}`);
  console.log(`not_addressed_issues=${report.summary.notAddressedIssues}/${report.summary.totalIssues}`);
  console.log(`attempted_but_invalid_rate=${formatNullable(report.summary.attemptedButInvalidRate ?? null)}`);
  console.log(`not_addressed_rate=${formatNullable(report.summary.notAddressedRate ?? null)}`);
  console.log(`full_issue_coverage_cases=${report.summary.casesWithFullIssueCoverage}/${report.summary.totalCases}`);
  console.log(`exact_document_matches=${report.summary.exactDocumentMatches}/${report.summary.totalCases}`);
  console.log(`total_output_tokens=${report.summary.totalOutputTokens}`);
  console.log(`total_duration_ms=${report.summary.totalDurationMs}`);
  console.log(`average_turns_per_chunk=${formatNullable(report.summary.averageTurnsPerChunk ?? null)}`);
  console.log(`quality_axis=${formatNullable(report.summary.axes?.quality ?? null)}`);
  console.log(`restraint_axis=${formatNullable(report.summary.axes?.restraint ?? null)}`);
  console.log(`efficiency_axis=${formatNullable(report.summary.axes?.efficiency ?? null)}`);
  console.log(`speed_axis=${formatNullable(report.summary.axes?.speed ?? null)}`);
  console.log(`benchmark_tool_calls=${report.summary.tooling?.benchmarkToolCalls ?? 0}`);
  console.log(`benchmark_tool_argument_chars=${report.summary.tooling?.benchmarkToolArgumentChars ?? 0}`);
  console.log(
    `benchmark_tool_chars_per_resolved_issue=${formatNullable(report.summary.tooling?.benchmarkToolCharsPerResolvedIssue ?? null)}`
  );
  console.log(
    `off_target_tool_chars_share=${formatNullable(report.summary.tooling?.offTargetToolCharsShare ?? null)}`
  );
  console.log(
    `benchmark_paragraph_rewrite_share=${formatNullable(report.summary.tooling?.benchmarkParagraphRewriteShare ?? null)}`
  );
  console.log(`candidate_cost_usd=${formatNullable(report.summary.cost?.candidateCostUsd ?? null, 6)}`);
  console.log(`judge_cost_usd=${formatNullable(report.summary.cost?.judgeCostUsd ?? null, 6)}`);
  console.log(`total_cost_usd=${formatNullable(report.summary.cost?.totalCostUsd ?? null, 6)}`);
  if (report.summary.judge) {
    console.log(`alternative_judge_passed_cases=${report.summary.judge.casesPassed}/${report.summary.totalCases}`);
    console.log(
      `alternative_judge_resolved_issues=${report.summary.judge.resolvedIssues}/${report.summary.judge.totalIssues}`
    );
    console.log(`alternative_judge_resolution_rate=${report.summary.judge.averageQualityScore.toFixed(4)}`);
    console.log(
      `alternative_judge_resolved_issues_per_usd=${formatNullable(report.summary.judge.averageResolvedIssuesPerUsd ?? null)}`
    );
  }
  console.log(`run_artifact=${runPath}`);
  console.log(`report_artifact=${reportPath}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
