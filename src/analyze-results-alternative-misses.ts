import path from "node:path";

import { getDefaultResultsId } from "./api-config.js";
import { buildResultsPath, readJson } from "./fs.js";
import { parseModelVariantString, withDefaultReasoningEffort } from "./model-config.js";
import { normalizeProofreadingText } from "./normalization.js";
import type {
  JudgeIssueVerdict,
  ResultsArtifact,
  ResultsAttempt,
  RunArtifact,
  ScoreArtifact
} from "./types.js";

type CliOptions = {
  artifactPath: string | null;
  groupId: string;
  limit: number | null;
  datasetPath: string | null;
  model: string | null;
};

type AuditEntry = {
  model: string;
  datasetPath: string;
  datasetName: string;
  datasetHash: string;
  runNumber: number;
  runId: string | null;
  caseId: string;
  issueId: string;
  category: string;
  paragraphId: string;
  expectedFind: string;
  expectedReplace: string;
  originalParagraphText: string;
  finalParagraphText: string;
  judgeNote: string | null;
};

type IssueSummary = {
  key: string;
  datasetName: string;
  caseId: string;
  issueId: string;
  category: string;
  expectedFind: string;
  expectedReplace: string;
  hits: number;
  models: Set<string>;
};

type CategorySummary = {
  category: string;
  hits: number;
  uniqueIssues: Set<string>;
  models: Set<string>;
};

const DEFAULT_GROUP_ID = getDefaultResultsId();

function parseArgs(argv: string[]): CliOptions {
  let artifactPath: string | null = null;
  let groupId = DEFAULT_GROUP_ID;
  let limit: number | null = null;
  let datasetPath: string | null = null;
  let model: string | null = null;

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

    if (arg === "--limit") {
      const parsed = Number.parseInt(argv[index + 1] ?? "", 10);
      limit = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
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
    }
  }

  return { artifactPath, groupId, limit, datasetPath, model };
}

function matchesDatasetPath(candidatePath: string, datasetArg: string): boolean {
  const resolvedArg = path.resolve(datasetArg);
  const argName = path.basename(datasetArg, path.extname(datasetArg));
  const candidateName = path.basename(candidatePath, path.extname(candidatePath));

  return candidatePath === resolvedArg || candidateName === argName;
}

function matchesModel(candidateBaseModel: string, candidateLabel: string, modelArg: string): boolean {
  const parsed = parseModelVariantString(modelArg);

  if (parsed.reasoningEffort == null) {
    return candidateBaseModel === parsed.model || candidateLabel === withDefaultReasoningEffort(parsed).label;
  }

  return candidateLabel === parsed.label;
}

function stripHtml(value: string): string {
  return normalizeProofreadingText(value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

function extractParagraphMap(html: string): Map<string, string> {
  return new Map(
    [...html.matchAll(/<p\s+id="([^"]+)">[\s\S]*?<\/p>/g)].map((match) => [match[1], match[0]])
  );
}

function clip(value: string, width: number): string {
  if (value.length <= width) {
    return value;
  }

  if (width <= 3) {
    return value.slice(0, width);
  }

  return `${value.slice(0, width - 3)}...`;
}

function summarizeParagraph(value: string, width: number): string {
  return clip(stripHtml(value), width);
}

function buildDivider(width = Math.max(120, process.stdout.columns ?? 160)): string {
  return "-".repeat(width);
}

async function loadArtifact(options: CliOptions): Promise<{ artifactPath: string; artifact: ResultsArtifact }> {
  const artifactPath = options.artifactPath ?? buildResultsPath(options.groupId);
  const artifact = await readJson<ResultsArtifact>(artifactPath);
  return { artifactPath, artifact };
}

function collectMatchingAttempts(artifact: ResultsArtifact, options: CliOptions): ResultsAttempt[] {
  return artifact.attempts.filter((attempt) => {
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
  });
}

function findJudgeVerdict(report: ScoreArtifact, caseId: string, issueId: string): JudgeIssueVerdict | null {
  const reportCase = report.cases.find((entry) => entry.caseId === caseId);
  if (!reportCase?.judge) {
    return null;
  }

  return reportCase.judge.issueVerdicts.find((entry) => entry.issueId === issueId) ?? null;
}

async function collectAuditEntries(attempts: ResultsAttempt[]): Promise<AuditEntry[]> {
  const entries: AuditEntry[] = [];

  for (const attempt of attempts) {
    const [run, report] = await Promise.all([
      readJson<RunArtifact>(attempt.runArtifact as string),
      readJson<ScoreArtifact>(attempt.reportArtifact as string)
    ]);

    for (const runCase of run.cases) {
      const reportCase = report.cases.find((entry) => entry.caseId === runCase.caseId);
      if (!reportCase) {
        continue;
      }

      const issueById = new Map(runCase.issues.map((issue) => [issue.id, issue]));
      const initialParagraphs = extractParagraphMap(runCase.initialDocumentHtml);
      const finalParagraphs = extractParagraphMap(runCase.finalDocumentHtml);

      for (const reportIssue of reportCase.issues) {
        if (!reportIssue.alternativeCandidate || reportIssue.corrected) {
          continue;
        }

        const runIssue = issueById.get(reportIssue.issueId);
        if (!runIssue) {
          continue;
        }

        const verdict = findJudgeVerdict(report, runCase.caseId, reportIssue.issueId);

        entries.push({
          model: attempt.model,
          datasetPath: attempt.datasetPath,
          datasetName: attempt.datasetName,
          datasetHash: attempt.datasetHash,
          runNumber: attempt.runNumber,
          runId: attempt.runId,
          caseId: runCase.caseId,
          issueId: reportIssue.issueId,
          category: reportIssue.category,
          paragraphId: reportIssue.paragraphId,
          expectedFind: runIssue.expectedCorrection.find,
          expectedReplace: runIssue.expectedCorrection.replace,
          originalParagraphText: initialParagraphs.get(reportIssue.paragraphId) ?? "",
          finalParagraphText: finalParagraphs.get(reportIssue.paragraphId) ?? "",
          judgeNote: verdict?.notes ?? null
        });
      }
    }
  }

  return entries.sort((left, right) => {
    if (left.datasetName !== right.datasetName) {
      return left.datasetName.localeCompare(right.datasetName);
    }

    if (left.caseId !== right.caseId) {
      return left.caseId.localeCompare(right.caseId);
    }

    if (left.issueId !== right.issueId) {
      return left.issueId.localeCompare(right.issueId);
    }

    if (left.model !== right.model) {
      return left.model.localeCompare(right.model);
    }

    return left.runNumber - right.runNumber;
  });
}

function summarizeIssues(entries: AuditEntry[]): IssueSummary[] {
  const summaries = new Map<string, IssueSummary>();

  for (const entry of entries) {
    const key = `${entry.datasetPath}::${entry.caseId}::${entry.issueId}`;
    const summary = summaries.get(key) ?? {
      key,
      datasetName: entry.datasetName,
      caseId: entry.caseId,
      issueId: entry.issueId,
      category: entry.category,
      expectedFind: entry.expectedFind,
      expectedReplace: entry.expectedReplace,
      hits: 0,
      models: new Set<string>()
    };

    summary.hits += 1;
    summary.models.add(entry.model);
    summaries.set(key, summary);
  }

  return [...summaries.values()].sort((left, right) => {
    if (right.hits !== left.hits) {
      return right.hits - left.hits;
    }

    if (left.datasetName !== right.datasetName) {
      return left.datasetName.localeCompare(right.datasetName);
    }

    if (left.caseId !== right.caseId) {
      return left.caseId.localeCompare(right.caseId);
    }

    return left.issueId.localeCompare(right.issueId);
  });
}

function summarizeCategories(entries: AuditEntry[]): CategorySummary[] {
  const summaries = new Map<string, CategorySummary>();

  for (const entry of entries) {
    const summary = summaries.get(entry.category) ?? {
      category: entry.category,
      hits: 0,
      uniqueIssues: new Set<string>(),
      models: new Set<string>()
    };

    summary.hits += 1;
    summary.uniqueIssues.add(`${entry.datasetPath}::${entry.caseId}::${entry.issueId}`);
    summary.models.add(entry.model);
    summaries.set(entry.category, summary);
  }

  return [...summaries.values()].sort((left, right) => {
    if (right.hits !== left.hits) {
      return right.hits - left.hits;
    }

    return left.category.localeCompare(right.category);
  });
}

function renderIssueSummary(summaries: IssueSummary[]): string[] {
  if (summaries.length === 0) {
    return ["No unresolved alternative-candidate issues found."];
  }

  const width = Math.max(120, process.stdout.columns ?? 160);
  const lines = ["Issue Summary"];
  const divider = buildDivider(width);
  lines.push(divider);

  for (const summary of summaries) {
    lines.push(
      `${String(summary.hits).padStart(3, " ")}x  ${summary.datasetName}/${summary.caseId}/${summary.issueId}  ${summary.category}`
    );
    lines.push(
      `     expected: "${clip(summary.expectedFind, 48)}" -> "${clip(summary.expectedReplace, 48)}"  models=${summary.models.size}`
    );
  }

  lines.push(divider);
  return lines;
}

function renderCategorySummary(summaries: CategorySummary[]): string[] {
  if (summaries.length === 0) {
    return ["Category Summary", buildDivider(), "No categories with unresolved alternative-candidate issues.", buildDivider()];
  }

  const lines = ["Category Summary"];
  const divider = buildDivider();
  lines.push(divider);

  for (const summary of summaries) {
    lines.push(
      `${String(summary.hits).padStart(3, " ")}x  ${summary.category}  unique_issues=${summary.uniqueIssues.size}  models=${summary.models.size}`
    );
  }

  lines.push(divider);
  return lines;
}

function renderEntries(entries: AuditEntry[], limit: number | null): string[] {
  const width = Math.max(120, process.stdout.columns ?? 160);
  const divider = buildDivider(width);
  const displayedEntries = limit == null ? entries : entries.slice(0, limit);
  const paragraphWidth = Math.max(60, width - 12);
  const lines = [
    "Entries",
    divider
  ];

  for (let index = 0; index < displayedEntries.length; index += 1) {
    const entry = displayedEntries[index];
    lines.push(
      `[${index + 1}] model=${entry.model} dataset=${entry.datasetName} run=${entry.runNumber} case=${entry.caseId} issue=${entry.issueId}`
    );
    lines.push(`    category: ${entry.category}`);
    lines.push(`    expected: "${entry.expectedFind}" -> "${entry.expectedReplace}"`);
    lines.push(`    original: ${summarizeParagraph(entry.originalParagraphText, paragraphWidth)}`);
    lines.push(`    final:    ${summarizeParagraph(entry.finalParagraphText, paragraphWidth)}`);
    if (entry.judgeNote) {
      lines.push(`    judge:    ${clip(entry.judgeNote.replace(/\s+/g, " ").trim(), paragraphWidth)}`);
    }
    lines.push(divider);
  }

  if (limit != null && entries.length > limit) {
    lines.push(`displayed=${limit}/${entries.length} entries. Re-run with --limit ${entries.length} to print all.`);
  } else {
    lines.push(`displayed=${displayedEntries.length}/${entries.length} entries.`);
  }

  return lines;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const { artifactPath, artifact } = await loadArtifact(options);
  const attempts = collectMatchingAttempts(artifact, options);
  const entries = await collectAuditEntries(attempts);
  const issueSummaries = summarizeIssues(entries);
  const categorySummaries = summarizeCategories(entries);

  console.log(`artifact=${artifactPath}`);
  console.log(`group_id=${artifact.groupId}`);
  console.log(`matched_attempts=${attempts.length}`);
  console.log(`unresolved_changed_issue_entries=${entries.length}`);
  console.log(`unique_issues=${issueSummaries.length}`);
  console.log(`unique_categories=${categorySummaries.length}`);
  console.log("");
  console.log(renderIssueSummary(issueSummaries).join("\n"));
  console.log("");
  console.log(renderCategorySummary(categorySummaries).join("\n"));
  console.log("");
  console.log(renderEntries(entries, options.limit).join("\n"));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
