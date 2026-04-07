import path from "node:path";

import dotenv from "dotenv";

import { getDefaultJudgeModel } from "./api-config.js";
import { buildArtifactBaseName, getLatestJsonFile, readJson, writeJson } from "./fs.js";
import { parseModelVariantString, withDefaultReasoningEffort } from "./model-config.js";
import { scoreRun } from "./proofreading.js";
import type { RunArtifact } from "./types.js";

dotenv.config();

const DEFAULT_ALTERNATIVE_JUDGE_MODEL = "anthropic/claude-opus-4.6:low";

function formatNullable(value: number | null, digits = 4): string {
  if (value == null || Number.isNaN(value)) {
    return "n/a";
  }

  return value.toFixed(digits);
}

async function resolveRunPath(argv: string[]): Promise<string> {
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--run") {
      return path.resolve(argv[index + 1] ?? "");
    }
  }

  const latestRun = await getLatestJsonFile(path.resolve("artifacts/runs"));

  if (!latestRun) {
    throw new Error("No run artifact found. Run `npm run demo` or `npm run eval -- --model ...` first.");
  }

  return latestRun;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const runPath = await resolveRunPath(argv);
  let judgeModel: string | null = getDefaultJudgeModel() ?? DEFAULT_ALTERNATIVE_JUDGE_MODEL;

  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--judge-model") {
      judgeModel = argv[index + 1] ?? judgeModel;
      index += 1;
      continue;
    }

    if (argv[index] === "--no-judge") {
      judgeModel = null;
    }
  }

  const run = await readJson<RunArtifact>(runPath);
  const judgeModelVariant =
    judgeModel == null ? null : withDefaultReasoningEffort(parseModelVariantString(judgeModel));
  const report = await scoreRun(run, { judgeModel: judgeModelVariant });
  const artifactBaseName = buildArtifactBaseName(run.runId, run.datasetPath, run.modelLabel ?? run.model);
  const reportPath = path.resolve("artifacts/reports", `${artifactBaseName}.json`);

  await writeJson(reportPath, report);

  console.log(`run_id=${run.runId}`);
  console.log(`api_provider=${run.apiProvider ?? "unknown"}`);
  console.log(`api_endpoint=${run.apiEndpointLabel ?? "unknown"}`);
  console.log(`model=${run.model}`);
  console.log(`model_label=${run.modelLabel ?? run.model}`);
  console.log(`reasoning_effort=${run.reasoningEffort ?? "medium"}`);
  console.log(`judge_model=${report.summary.judge?.judgeModel ?? "disabled"}`);
  console.log(`max_words_per_chunk=${run.maxWordsPerChunk ?? "full"}`);
  console.log(`max_turns_per_chunk=${run.maxTurnsPerChunk ?? 3}`);
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
  console.log(`report_artifact=${reportPath}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
