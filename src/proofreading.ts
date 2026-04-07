import { createParagraphMap, getChangedParagraphIds, normalizeHtml } from "./document.js";
import { filterCaseIssues, getDisqualifiedIssueIdsByCaseSync } from "./issue-disqualifications.js";
import { judgeAlternativeIssueResolutions } from "./judge.js";
import type { ModelVariant } from "./model-config.js";
import { normalizeProofreadingText } from "./normalization.js";
import { calculateRunCostSummary } from "./pricing.js";
import type {
  CaseJudgeResult,
  CaseScore,
  IssueScore,
  ProofreadingIssue,
  RunArtifact,
  RunToolingSummary,
  ScoreArtifact,
  ToolExecution
} from "./types.js";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsExpectedText(value: string, needle: string): boolean {
  const normalizedValue = normalizeProofreadingText(value);
  const normalizedNeedle = normalizeProofreadingText(needle);

  if (/^[A-Za-z0-9']+$/.test(normalizedNeedle)) {
    const pattern = new RegExp(`(^|\\W)${escapeRegExp(normalizedNeedle)}(?=$|\\W)`);
    return pattern.test(normalizedValue);
  }

  return normalizedValue.includes(normalizedNeedle);
}

function isIssueCorrected(issue: ProofreadingIssue, finalParagraphHtml: string): boolean {
  return (
    containsExpectedText(finalParagraphHtml, issue.expectedCorrection.replace) &&
    !containsExpectedText(finalParagraphHtml, issue.expectedCorrection.find)
  );
}

function isAlternativeCandidate(issue: ProofreadingIssue, finalParagraphHtml: string): boolean {
  return (
    !containsExpectedText(finalParagraphHtml, issue.expectedCorrection.find) &&
    !containsExpectedText(finalParagraphHtml, issue.expectedCorrection.replace)
  );
}

function extractParagraphs(html: string): Array<{ id: string; html: string }> {
  return [...html.matchAll(/<p\s+id="([^"]+)">[\s\S]*?<\/p>/g)].map((match) => ({
    id: match[1],
    html: match[0]
  }));
}

function getToolArgumentChars(toolExecution: ToolExecution): number {
  if (toolExecution.toolName === "proofreading_complete") {
    return 0;
  }

  return JSON.stringify(toolExecution.arguments).length;
}

function countTurnsUsedForChunk(chunk: RunArtifact["cases"][number]["chunks"][number]): number {
  if (chunk.turnTraces.length > 0) {
    return chunk.turnTraces.length;
  }

  const turns = new Set(chunk.toolExecutions.map((execution) => execution.turn).filter((turn) => turn > 0));
  return turns.size;
}

function calculateAverageTurnsPerChunk(run: RunArtifact): number | null {
  const chunks = run.cases.flatMap((sample) => sample.chunks);

  if (chunks.length === 0) {
    return null;
  }

  const totalTurns = chunks.reduce((sum, chunk) => sum + countTurnsUsedForChunk(chunk), 0);
  return totalTurns / chunks.length;
}

function buildRunToolingSummary(run: RunArtifact, report: ScoreArtifact): RunToolingSummary {
  const disqualifiedIssueIdsByCase = getDisqualifiedIssueIdsByCaseSync();
  let totalEditToolCalls = 0;
  let totalEditToolArgumentChars = 0;
  let benchmarkToolCalls = 0;
  let benchmarkToolArgumentChars = 0;
  let benchmarkParagraphRewriteChars = 0;
  let offTargetToolCalls = 0;
  let offTargetToolArgumentChars = 0;

  for (let caseIndex = 0; caseIndex < run.cases.length; caseIndex += 1) {
    const runCase = run.cases[caseIndex];
    const reportCase = report.cases[caseIndex];
    const qualifiedIssues = filterCaseIssues(runCase.caseId, runCase.issues, disqualifiedIssueIdsByCase);
    const correctedIssueIds = new Set(reportCase.issues.filter((issue) => issue.corrected).map((issue) => issue.issueId));
    const unresolvedByParagraph = new Map<string, ProofreadingIssue[]>();

    for (const issue of qualifiedIssues) {
      if (!correctedIssueIds.has(issue.id)) {
        continue;
      }

      const paragraphIssues = unresolvedByParagraph.get(issue.paragraphId) ?? [];
      paragraphIssues.push(issue);
      unresolvedByParagraph.set(issue.paragraphId, paragraphIssues);
    }

    for (const chunkRun of runCase.chunks) {
      for (const toolExecution of chunkRun.toolExecutions) {
        if (toolExecution.toolName === "proofreading_complete") {
          continue;
        }

        const argumentChars = getToolArgumentChars(toolExecution);
        totalEditToolCalls += 1;
        totalEditToolArgumentChars += argumentChars;

        const paragraphId = toolExecution.paragraphId;

        if (!paragraphId) {
          offTargetToolCalls += 1;
          offTargetToolArgumentChars += argumentChars;
          continue;
        }

        const unresolvedIssues = unresolvedByParagraph.get(paragraphId) ?? [];
        const beforeParagraphHtml = toolExecution.beforeParagraphHtml ?? "";
        const afterParagraphHtml = toolExecution.afterParagraphHtml ?? beforeParagraphHtml;

        let resolvedByExecution = 0;

        if (unresolvedIssues.length > 0) {
          const stillUnresolved: ProofreadingIssue[] = [];

          for (const issue of unresolvedIssues) {
            const removedBadText =
              containsExpectedText(beforeParagraphHtml, issue.expectedCorrection.find) &&
              !containsExpectedText(afterParagraphHtml, issue.expectedCorrection.find);

            if (removedBadText) {
              resolvedByExecution += 1;
              continue;
            }

            stillUnresolved.push(issue);
          }

          unresolvedByParagraph.set(paragraphId, stillUnresolved);
        }

        const isBenchmarkRelevant =
          resolvedByExecution > 0 ||
          (toolExecution.toolName === "replace_paragraph" &&
            unresolvedIssues.length > 0 &&
            normalizeHtml(beforeParagraphHtml) !== normalizeHtml(afterParagraphHtml));

        if (isBenchmarkRelevant) {
          benchmarkToolCalls += 1;
          benchmarkToolArgumentChars += argumentChars;

          if (toolExecution.toolName === "replace_paragraph") {
            benchmarkParagraphRewriteChars += argumentChars;
          }

          continue;
        }

        offTargetToolCalls += 1;
        offTargetToolArgumentChars += argumentChars;
      }
    }
  }

  const resolvedIssues = report.summary.correctedIssues;

  return {
    totalEditToolCalls,
    totalEditToolArgumentChars,
    benchmarkToolCalls,
    benchmarkToolArgumentChars,
    offTargetToolCalls,
    offTargetToolArgumentChars,
    benchmarkToolCallsPerResolvedIssue: resolvedIssues === 0 ? null : benchmarkToolCalls / resolvedIssues,
    benchmarkToolCharsPerResolvedIssue: resolvedIssues === 0 ? null : benchmarkToolArgumentChars / resolvedIssues,
    offTargetToolCharsShare:
      totalEditToolArgumentChars === 0 ? null : offTargetToolArgumentChars / totalEditToolArgumentChars,
    benchmarkParagraphRewriteShare:
      benchmarkToolArgumentChars === 0 ? null : benchmarkParagraphRewriteChars / benchmarkToolArgumentChars
  };
}

function recomputeReportSummary(report: ScoreArtifact, run: RunArtifact): void {
  const totalIssues = report.cases.reduce((sum, sample) => sum + sample.totalIssueCount, 0);
  const correctedIssues = report.cases.reduce((sum, sample) => sum + sample.correctedIssueCount, 0);
  const attemptedButInvalidIssues = report.cases.reduce((sum, sample) => sum + sample.attemptedButInvalidIssueCount, 0);
  const notAddressedIssues = report.cases.reduce((sum, sample) => sum + sample.notAddressedIssueCount, 0);
  const totalOutputTokens = report.cases.reduce((sum, sample) => sum + sample.outputTokens, 0);
  const totalDurationMs = run.cases.reduce((sum, sample) => sum + sample.durationMs, 0);
  const exactDocumentMatches = report.cases.filter((sample) => sample.exactDocumentMatch).length;
  const casesWithFullIssueCoverage = report.cases.filter((sample) => sample.correctedIssueCount === sample.totalIssueCount).length;

  report.summary.totalCases = report.cases.length;
  report.summary.exactDocumentMatches = exactDocumentMatches;
  report.summary.casesWithFullIssueCoverage = casesWithFullIssueCoverage;
  report.summary.totalIssues = totalIssues;
  report.summary.correctedIssues = correctedIssues;
  report.summary.attemptedButInvalidIssues = attemptedButInvalidIssues;
  report.summary.notAddressedIssues = notAddressedIssues;
  report.summary.attemptedButInvalidRate = totalIssues === 0 ? null : attemptedButInvalidIssues / totalIssues;
  report.summary.notAddressedRate = totalIssues === 0 ? null : notAddressedIssues / totalIssues;
  report.summary.averageIssueCoverage =
    report.cases.length === 0 ? 0 : report.cases.reduce((sum, sample) => sum + sample.issueCoverage, 0) / report.cases.length;
  report.summary.totalOutputTokens = totalOutputTokens;
  report.summary.averageOutputTokensPerCase = report.cases.length === 0 ? 0 : totalOutputTokens / report.cases.length;
  report.summary.correctionsPerOutputToken = totalOutputTokens === 0 ? correctedIssues : correctedIssues / totalOutputTokens;
  report.summary.totalDurationMs = totalDurationMs;
  report.summary.averageDurationMsPerCase = report.cases.length === 0 ? 0 : totalDurationMs / report.cases.length;
  report.summary.averageTurnsPerChunk = calculateAverageTurnsPerChunk(run);
}

export function scoreRunStatic(run: RunArtifact): ScoreArtifact {
  const disqualifiedIssueIdsByCase = getDisqualifiedIssueIdsByCaseSync();
  const cases: CaseScore[] = run.cases.map((sample) => {
    const initialParagraphs = extractParagraphs(sample.initialDocumentHtml);
    const expectedParagraphs = extractParagraphs(sample.expectedDocumentHtml);
    const finalParagraphs = extractParagraphs(sample.finalDocumentHtml);
    const qualifiedIssues = filterCaseIssues(sample.caseId, sample.issues, disqualifiedIssueIdsByCase);

    const finalById = createParagraphMap(finalParagraphs);

    const issues: IssueScore[] = qualifiedIssues.map((issue) => {
      const finalParagraphHtml = finalById.get(issue.paragraphId)?.html ?? "";
      const staticCorrected = isIssueCorrected(issue, finalParagraphHtml);
      const attemptedChange = !containsExpectedText(finalParagraphHtml, issue.expectedCorrection.find);
      const alternativeCandidate = !staticCorrected && isAlternativeCandidate(issue, finalParagraphHtml);
      return {
        issueId: issue.id,
        category: issue.category,
        paragraphId: issue.paragraphId,
        description: issue.description,
        classification: issue.classification,
        staticCorrected,
        attemptedChange,
        alternativeCandidate,
        corrected: staticCorrected,
        resolutionMethod: staticCorrected ? "exact" : alternativeCandidate ? "attempted_invalid" : "not_addressed"
      };
    });

    const correctedIssueCount = issues.filter((issue) => issue.corrected).length;
    const attemptedButInvalidIssueCount = issues.filter((issue) => issue.resolutionMethod === "attempted_invalid").length;
    const notAddressedIssueCount = issues.filter((issue) => issue.resolutionMethod === "not_addressed").length;
    const totalIssueCount = issues.length;
    const expectedChangedParagraphIds = getChangedParagraphIds(initialParagraphs, expectedParagraphs);
    const actualChangedParagraphIds = getChangedParagraphIds(initialParagraphs, finalParagraphs);
    const unexpectedParagraphChanges = actualChangedParagraphIds.filter(
      (paragraphId) => !expectedChangedParagraphIds.includes(paragraphId)
    );

    return {
      caseId: sample.caseId,
      exactDocumentMatch: normalizeHtml(sample.finalDocumentHtml) === normalizeHtml(sample.expectedDocumentHtml),
      correctedIssueCount,
      attemptedButInvalidIssueCount,
      notAddressedIssueCount,
      totalIssueCount,
      issueCoverage: totalIssueCount === 0 ? 1 : correctedIssueCount / totalIssueCount,
      outputTokens: sample.outputTokens,
      promptTokens: sample.promptTokens,
      correctionsPerOutputToken: sample.outputTokens === 0 ? correctedIssueCount : correctedIssueCount / sample.outputTokens,
      tokensPerCorrectedIssue: correctedIssueCount === 0 ? null : sample.outputTokens / correctedIssueCount,
      expectedChangedParagraphIds,
      actualChangedParagraphIds,
      unexpectedParagraphChanges,
      issues,
      finalDocumentHtml: sample.finalDocumentHtml,
      expectedDocumentHtml: sample.expectedDocumentHtml
    };
  });

  const totalIssues = cases.reduce((sum, sample) => sum + sample.totalIssueCount, 0);
  const correctedIssues = cases.reduce((sum, sample) => sum + sample.correctedIssueCount, 0);
  const attemptedButInvalidIssues = cases.reduce((sum, sample) => sum + sample.attemptedButInvalidIssueCount, 0);
  const notAddressedIssues = cases.reduce((sum, sample) => sum + sample.notAddressedIssueCount, 0);
  const totalOutputTokens = cases.reduce((sum, sample) => sum + sample.outputTokens, 0);
  const totalDurationMs = run.cases.reduce((sum, sample) => sum + sample.durationMs, 0);
  const exactDocumentMatches = cases.filter((sample) => sample.exactDocumentMatch).length;
  const casesWithFullIssueCoverage = cases.filter((sample) => sample.correctedIssueCount === sample.totalIssueCount).length;

  return {
    version: "v1",
    runId: run.runId,
    createdAt: new Date().toISOString(),
    summary: {
      totalCases: cases.length,
      exactDocumentMatches,
      casesWithFullIssueCoverage,
      totalIssues,
      correctedIssues,
      attemptedButInvalidIssues,
      notAddressedIssues,
      attemptedButInvalidRate: totalIssues === 0 ? null : attemptedButInvalidIssues / totalIssues,
      notAddressedRate: totalIssues === 0 ? null : notAddressedIssues / totalIssues,
      averageIssueCoverage:
        cases.length === 0 ? 0 : cases.reduce((sum, sample) => sum + sample.issueCoverage, 0) / cases.length,
      totalOutputTokens,
      averageOutputTokensPerCase: cases.length === 0 ? 0 : totalOutputTokens / cases.length,
      correctionsPerOutputToken: totalOutputTokens === 0 ? correctedIssues : correctedIssues / totalOutputTokens,
      totalDurationMs,
      averageDurationMsPerCase: cases.length === 0 ? 0 : totalDurationMs / cases.length,
      averageTurnsPerChunk: calculateAverageTurnsPerChunk(run)
    },
    cases
  };
}

export async function scoreRun(
  run: RunArtifact,
  options?: { judgeModel?: ModelVariant | null; judgeTimeoutMs?: number | null }
): Promise<ScoreArtifact> {
  const report = scoreRunStatic(run);
  const baseCost = await calculateRunCostSummary(run, report);
  report.summary.cost = baseCost;
  report.summary.axes = {
    quality: report.summary.averageIssueCoverage,
    restraint: null,
    // Efficiency is intentionally computed per run so mixed-difficulty datasets do not get pooled
    // into one global resolved-issues-per-dollar ratio before results aggregation.
    efficiency:
      baseCost.totalCostUsd != null && baseCost.totalCostUsd > 0
        ? report.summary.correctedIssues / baseCost.totalCostUsd
        : null,
    speed:
      report.summary.totalDurationMs > 0 ? (report.summary.correctedIssues / report.summary.totalDurationMs) * 60_000 : null,
    costUsd: baseCost.totalCostUsd,
    candidateCostUsd: baseCost.candidateCostUsd,
    judgeCostUsd: baseCost.judgeCostUsd
  };
  report.summary.tooling = buildRunToolingSummary(run, report);

  if (!options?.judgeModel) {
    return report;
  }

  const caseJudgeAggregates = new Map<number, CaseJudgeResult>();
  const caseIssueMaps = new Map<number, Map<string, IssueScore>>();
  const alternativeTasks: Array<{
    caseIndex: number;
    paragraphId: string;
    originalParagraphHtml: string;
    finalParagraphHtml: string;
    issues: ProofreadingIssue[];
  }> = [];

  for (let caseIndex = 0; caseIndex < run.cases.length; caseIndex += 1) {
    const runCase = run.cases[caseIndex];
    const reportCase = report.cases[caseIndex];
    const initialById = createParagraphMap(extractParagraphs(runCase.initialDocumentHtml));
    const finalById = createParagraphMap(extractParagraphs(runCase.finalDocumentHtml));
    const issueScoresById = new Map(reportCase.issues.map((issue) => [issue.issueId, issue]));
    caseIssueMaps.set(caseIndex, issueScoresById);
    const issueDefinitionsById = new Map(runCase.issues.map((issue) => [issue.id, issue]));
    const ambiguousByParagraph = new Map<string, ProofreadingIssue[]>();

    for (const issueScore of reportCase.issues) {
      if (!issueScore.alternativeCandidate) {
        continue;
      }

      const issue = issueDefinitionsById.get(issueScore.issueId);

      if (!issue) {
        continue;
      }

      const paragraphIssues = ambiguousByParagraph.get(issue.paragraphId) ?? [];
      paragraphIssues.push(issue);
      ambiguousByParagraph.set(issue.paragraphId, paragraphIssues);
    }

    for (const [paragraphId, issues] of ambiguousByParagraph.entries()) {
      alternativeTasks.push({
        caseIndex,
        paragraphId,
        originalParagraphHtml: initialById.get(paragraphId)?.html ?? "",
        finalParagraphHtml: finalById.get(paragraphId)?.html ?? "",
        issues
      });
    }
  }

  const alternativeResults = (
    await Promise.allSettled(
      alternativeTasks.map(async (task) => ({
        ...task,
        judgment: await judgeAlternativeIssueResolutions(
          task.originalParagraphHtml,
          task.finalParagraphHtml,
          task.issues,
          options.judgeModel as ModelVariant,
          { timeoutMs: options.judgeTimeoutMs ?? null }
        )
      }))
    )
  )
    .filter((result): result is PromiseFulfilledResult<(typeof alternativeTasks)[number] & { judgment: Awaited<ReturnType<typeof judgeAlternativeIssueResolutions>> }> => result.status === "fulfilled")
    .map((result) => result.value);

  for (const result of alternativeResults) {
    const issueScoreMap = caseIssueMaps.get(result.caseIndex);

    if (!issueScoreMap) {
      continue;
    }

    const aggregate = caseJudgeAggregates.get(result.caseIndex) ?? {
      judgeModel: result.judgment.judgeModel,
      issueVerdicts: [],
      allListedErrorsResolved: true,
      introducedNewErrors: false,
      introducedErrors: [],
      unnecessaryChanges: [],
      collateralDamageCount: 0,
      resolvedIssueCount: 0,
      resolutionRate: 0,
      restraintScore: 1,
      qualityScore: 0,
      benchmarkScore: 0,
      overallPass: true,
      summary: "",
      outputTokens: 0,
      promptTokens: 0
    };

    aggregate.issueVerdicts.push(...result.judgment.issueVerdicts);
    aggregate.outputTokens += result.judgment.outputTokens;
    aggregate.promptTokens += result.judgment.promptTokens;
    aggregate.summary = [aggregate.summary, result.judgment.summary].filter((value) => value.length > 0).join(" | ");

    for (const verdict of result.judgment.issueVerdicts) {
      const issueScore = issueScoreMap.get(verdict.issueId);

      if (!issueScore) {
        continue;
      }

      if (verdict.resolved) {
        issueScore.corrected = true;
        issueScore.resolutionMethod = "alternative_judge";
      }
    }

    caseJudgeAggregates.set(result.caseIndex, aggregate);
  }

  for (let caseIndex = 0; caseIndex < report.cases.length; caseIndex += 1) {
    const reportCase = report.cases[caseIndex];
    reportCase.correctedIssueCount = reportCase.issues.filter((issue) => issue.corrected).length;
    reportCase.attemptedButInvalidIssueCount = reportCase.issues.filter(
      (issue) => issue.resolutionMethod === "attempted_invalid"
    ).length;
    reportCase.notAddressedIssueCount = reportCase.issues.filter(
      (issue) => issue.resolutionMethod === "not_addressed"
    ).length;
    reportCase.issueCoverage = reportCase.totalIssueCount === 0 ? 1 : reportCase.correctedIssueCount / reportCase.totalIssueCount;

    const aggregate = caseJudgeAggregates.get(caseIndex);
    if (!aggregate) {
      continue;
    }

    aggregate.resolvedIssueCount = aggregate.issueVerdicts.filter((issue) => issue.resolved).length;
    aggregate.allListedErrorsResolved = aggregate.issueVerdicts.every((issue) => issue.resolved);
    aggregate.overallPass = aggregate.allListedErrorsResolved;
    aggregate.resolutionRate =
      aggregate.issueVerdicts.length === 0 ? 1 : aggregate.resolvedIssueCount / aggregate.issueVerdicts.length;
    aggregate.qualityScore = aggregate.resolutionRate;
    aggregate.benchmarkScore = aggregate.qualityScore * 100;
    reportCase.judge = aggregate;
  }

  recomputeReportSummary(report, run);

  const casesPassed = report.cases.filter((sample) => !sample.judge || sample.judge.overallPass).length;
  const totalJudgedIssues = report.cases.reduce((sum, sample) => sum + (sample.judge?.issueVerdicts.length ?? 0), 0);
  const resolvedAlternativeIssues = report.cases.reduce(
    (sum, sample) => sum + (sample.judge?.issueVerdicts.filter((issue) => issue.resolved).length ?? 0),
    0
  );
  const averageQualityScore = totalJudgedIssues === 0 ? 1 : resolvedAlternativeIssues / totalJudgedIssues;
  const averageRestraintScore = 1;
  const averageBenchmarkScore = averageQualityScore * 100;
  report.summary.judge = {
    judgeModel: options.judgeModel.label,
    casesPassed,
    casesWithNewErrors: 0,
    unnecessaryChanges: 0,
    collateralDamageCount: 0,
    resolvedIssues: resolvedAlternativeIssues,
    totalIssues: totalJudgedIssues,
    averageRestraintScore,
    averageResolvedIssuesPerUsd: null,
    averageQualityScore,
    averageBenchmarkScore
  };
  const cost = await calculateRunCostSummary(run, report);
  report.summary.cost = cost;
  // Efficiency is intentionally computed per run so results aggregation can average run-level
  // cost efficiency instead of recomputing from pooled totals across heterogeneous datasets.
  const efficiencyAxis =
    cost.totalCostUsd != null && cost.totalCostUsd > 0 ? report.summary.correctedIssues / cost.totalCostUsd : null;

  report.summary.judge.averageResolvedIssuesPerUsd =
    cost.totalCostUsd != null && cost.totalCostUsd > 0 ? resolvedAlternativeIssues / cost.totalCostUsd : null;

  report.summary.axes = {
    quality: report.summary.averageIssueCoverage,
    restraint: null,
    efficiency: efficiencyAxis,
    speed:
      report.summary.totalDurationMs > 0 ? (report.summary.correctedIssues / report.summary.totalDurationMs) * 60_000 : null,
    costUsd: cost.totalCostUsd,
    candidateCostUsd: cost.candidateCostUsd,
    judgeCostUsd: cost.judgeCostUsd
  };
  report.summary.tooling = buildRunToolingSummary(run, report);

  return report;
}

function recomputeCaseJudgeResult(caseJudge: CaseJudgeResult): void {
  caseJudge.resolvedIssueCount = caseJudge.issueVerdicts.filter((issue) => issue.resolved).length;
  caseJudge.allListedErrorsResolved = caseJudge.issueVerdicts.every((issue) => issue.resolved);
  caseJudge.overallPass = caseJudge.allListedErrorsResolved;
  caseJudge.resolutionRate = caseJudge.issueVerdicts.length === 0 ? 1 : caseJudge.resolvedIssueCount / caseJudge.issueVerdicts.length;
  caseJudge.qualityScore = caseJudge.resolutionRate;
  caseJudge.benchmarkScore = caseJudge.qualityScore * 100;
}

function recomputeJudgeSummary(report: ScoreArtifact, judgeModel: string): void {
  const casesPassed = report.cases.filter((sample) => !sample.judge || sample.judge.overallPass).length;
  const totalJudgedIssues = report.cases.reduce((sum, sample) => sum + (sample.judge?.issueVerdicts.length ?? 0), 0);
  const resolvedAlternativeIssues = report.cases.reduce(
    (sum, sample) => sum + (sample.judge?.issueVerdicts.filter((issue) => issue.resolved).length ?? 0),
    0
  );
  const averageQualityScore = totalJudgedIssues === 0 ? 1 : resolvedAlternativeIssues / totalJudgedIssues;

  report.summary.judge = {
    judgeModel,
    casesPassed,
    casesWithNewErrors: 0,
    unnecessaryChanges: 0,
    collateralDamageCount: 0,
    resolvedIssues: resolvedAlternativeIssues,
    totalIssues: totalJudgedIssues,
    averageRestraintScore: 1,
    averageResolvedIssuesPerUsd: null,
    averageQualityScore,
    averageBenchmarkScore: averageQualityScore * 100
  };
}

export async function refreshReportWithCurrentIssueDisqualifications(
  run: RunArtifact,
  report: ScoreArtifact
): Promise<{ report: ScoreArtifact; excludedIssues: number }> {
  const disqualifiedIssueIdsByCase = getDisqualifiedIssueIdsByCaseSync();
  let excludedIssues = 0;

  for (let caseIndex = 0; caseIndex < report.cases.length; caseIndex += 1) {
    const reportCase = report.cases[caseIndex];
    const caseId = run.cases[caseIndex]?.caseId ?? reportCase.caseId;
    const disqualifiedIssueIds = disqualifiedIssueIdsByCase.get(caseId);

    if (!disqualifiedIssueIds || disqualifiedIssueIds.size === 0) {
      continue;
    }

    const originalIssueCount = reportCase.issues.length;
    reportCase.issues = reportCase.issues.filter((issue) => !disqualifiedIssueIds.has(issue.issueId));
    excludedIssues += originalIssueCount - reportCase.issues.length;

    if (reportCase.judge) {
      reportCase.judge.issueVerdicts = reportCase.judge.issueVerdicts.filter((issue) => !disqualifiedIssueIds.has(issue.issueId));
      recomputeCaseJudgeResult(reportCase.judge);
    }
  }

  for (const reportCase of report.cases) {
    reportCase.totalIssueCount = reportCase.issues.length;
    reportCase.correctedIssueCount = reportCase.issues.filter((issue) => issue.corrected).length;
    reportCase.attemptedButInvalidIssueCount = reportCase.issues.filter(
      (issue) => issue.resolutionMethod === "attempted_invalid"
    ).length;
    reportCase.notAddressedIssueCount = reportCase.issues.filter(
      (issue) => issue.resolutionMethod === "not_addressed"
    ).length;
    reportCase.issueCoverage = reportCase.totalIssueCount === 0 ? 1 : reportCase.correctedIssueCount / reportCase.totalIssueCount;

    if (reportCase.judge) {
      recomputeCaseJudgeResult(reportCase.judge);
    }
  }

  recomputeReportSummary(report, run);

  if (report.summary.judge) {
    recomputeJudgeSummary(report, report.summary.judge.judgeModel);
  }

  const cost = await calculateRunCostSummary(run, report);
  report.summary.cost = cost;
  report.summary.axes = {
    quality: report.summary.averageIssueCoverage,
    restraint: null,
    efficiency: cost.totalCostUsd != null && cost.totalCostUsd > 0 ? report.summary.correctedIssues / cost.totalCostUsd : null,
    speed:
      report.summary.totalDurationMs > 0 ? (report.summary.correctedIssues / report.summary.totalDurationMs) * 60_000 : null,
    costUsd: cost.totalCostUsd,
    candidateCostUsd: cost.candidateCostUsd,
    judgeCostUsd: cost.judgeCostUsd
  };

  if (report.summary.judge) {
    report.summary.judge.averageResolvedIssuesPerUsd =
      cost.totalCostUsd != null && cost.totalCostUsd > 0
        ? report.summary.judge.resolvedIssues / cost.totalCostUsd
        : null;
  }

  report.summary.tooling = buildRunToolingSummary(run, report);
  report.createdAt = new Date().toISOString();

  return { report, excludedIssues };
}
