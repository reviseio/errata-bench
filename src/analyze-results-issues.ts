import path from "node:path";
import readline from "node:readline";

import { getDefaultResultsId } from "./api-config.js";
import { buildResultsPath, readJson } from "./fs.js";
import { buildResultsArtifact } from "./results-artifact.js";
import { parseModelVariantString } from "./model-config.js";
import type { ResultsArtifact, ResultsAttempt, ProofreadingIssue, RunArtifact, ScoreArtifact } from "./types.js";

type CliOptions = {
  artifactPath: string | null;
  groupId: string;
  limit: number;
  datasetPath: string | null;
  model: string | null;
};

type IssueAggregate = {
  key: string;
  datasetPath: string;
  datasetName: string;
  datasetHash: string;
  caseId: string;
  issueId: string;
  category: string;
  description: string;
  beforeText: string;
  afterText: string;
  attempts: number;
  resolved: number;
  modelStats: Map<string, ModelResolutionAggregate>;
};

type CategoryAggregate = {
  category: string;
  attempts: number;
  resolved: number;
  uniqueIssueKeys: Set<string>;
  modelStats: Map<string, ModelResolutionAggregate>;
};

type HistogramBucket = {
  label: string;
  minInclusive: number;
  maxInclusive: number;
  count: number;
};

type ModelResolutionAggregate = {
  model: string;
  attempts: number;
  resolved: number;
};

type AnalysisSection = {
  id: "histogram" | "hardestIssues" | "easiestIssues" | "hardestCategories" | "easiestCategories";
  title: string;
};

type IssueAnalysisData = {
  artifact: ResultsArtifact;
  artifactPath: string;
  matchedAttempts: number;
  analyzableAttempts: number;
  skippedAttempts: number;
  issues: IssueAggregate[];
  categories: CategoryAggregate[];
  histogram: HistogramBucket[];
  options: CliOptions;
};

const DEFAULT_GROUP_ID = getDefaultResultsId();

function parseArgs(argv: string[]): CliOptions {
  let artifactPath: string | null = null;
  let groupId = DEFAULT_GROUP_ID;
  let limit = 200;
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
      const parsed = Number.parseInt(argv[index + 1] ?? `${limit}`, 10);
      limit = Number.isFinite(parsed) && parsed > 0 ? parsed : limit;
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
  const variant = parseModelVariantString(modelArg);

  if (variant.reasoningEffort == null) {
    return candidateBaseModel === variant.model || candidateLabel === variant.label;
  }

  return candidateLabel === variant.label;
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

function pad(value: string, width: number, align: "left" | "right" = "left"): string {
  const clipped = clip(value, width);
  return align === "right" ? clipped.padStart(width, " ") : clipped.padEnd(width, " ");
}

function buildBorder(widths: number[]): string {
  return `+${widths.map((width) => "-".repeat(width + 2)).join("+")}+`;
}

function buildRow(values: string[], widths: number[], aligns?: Array<"left" | "right">): string {
  return `| ${values
    .map((value, index) => pad(value, widths[index], aligns?.[index] ?? "left"))
    .join(" | ")} |`;
}

function getTerminalWidth(): number {
  return Math.max(120, process.stdout.columns ?? 160);
}

function distributeWidths(
  totalWidth: number,
  minimumWidths: number[],
  growWeights: number[],
  maximumWidths?: Array<number | null>
): number[] {
  const widths = [...minimumWidths];
  const tableOverhead = widths.length * 3 + 1;
  let remaining = Math.max(0, totalWidth - tableOverhead - widths.reduce((sum, width) => sum + width, 0));

  while (remaining > 0) {
    const growableIndexes = widths
      .map((width, index) => ({ width, index, weight: growWeights[index] ?? 0, max: maximumWidths?.[index] ?? null }))
      .filter((entry) => entry.weight > 0 && (entry.max == null || widths[entry.index] < entry.max));

    if (growableIndexes.length === 0) {
      break;
    }

    const totalWeight = growableIndexes.reduce((sum, entry) => sum + entry.weight, 0);
    let allocatedThisPass = 0;

    for (const entry of growableIndexes) {
      if (remaining <= 0) {
        break;
      }

      const rawShare = Math.max(1, Math.floor((remaining * entry.weight) / totalWeight));
      const maxGrow = entry.max == null ? rawShare : Math.max(0, entry.max - widths[entry.index]);
      const growBy = Math.max(0, Math.min(rawShare, maxGrow, remaining));

      if (growBy <= 0) {
        continue;
      }

      widths[entry.index] += growBy;
      remaining -= growBy;
      allocatedThisPass += growBy;
    }

    if (allocatedThisPass === 0) {
      break;
    }
  }

  return widths;
}

function formatPercent(value: number | null): string {
  if (value == null || Number.isNaN(value)) {
    return "n/a";
  }

  return `${(value * 100).toFixed(1)}%`;
}

function summarizeText(value: string, width = 42): string {
  return clip(value.replace(/\s+/g, " ").trim(), width);
}

function buildHistogram(issues: IssueAggregate[]): HistogramBucket[] {
  const buckets: HistogramBucket[] = [
    { label: "0-19%", minInclusive: 0.0, maxInclusive: 0.199999, count: 0 },
    { label: "20-39%", minInclusive: 0.2, maxInclusive: 0.399999, count: 0 },
    { label: "40-59%", minInclusive: 0.4, maxInclusive: 0.599999, count: 0 },
    { label: "60-79%", minInclusive: 0.6, maxInclusive: 0.799999, count: 0 },
    { label: "80-99%", minInclusive: 0.8, maxInclusive: 0.999999, count: 0 },
    { label: "100%", minInclusive: 1.0, maxInclusive: 1.0, count: 0 }
  ];

  for (const issue of issues) {
    const rate = issue.attempts === 0 ? 0 : issue.resolved / issue.attempts;
    const bucket = buckets.find((entry) => rate >= entry.minInclusive && rate <= entry.maxInclusive);

    if (bucket) {
      bucket.count += 1;
    }
  }

  return buckets;
}

function renderHistogram(buckets: HistogramBucket[]): string[] {
  const maxCount = Math.max(1, ...buckets.map((bucket) => bucket.count));

  return buckets.map((bucket) => {
    const barWidth = Math.round((bucket.count / maxCount) * 24);
    return `${bucket.label.padEnd(7, " ")} ${"#".repeat(barWidth).padEnd(24, " ")} ${bucket.count}`;
  });
}

function clipLines(lines: string[], maxWidth: number, maxHeight: number): string[] {
  return lines.slice(0, maxHeight).map((line) => clip(line, maxWidth));
}

function compareIssueDifficulty(left: IssueAggregate, right: IssueAggregate): number {
  const leftRate = left.attempts === 0 ? 0 : left.resolved / left.attempts;
  const rightRate = right.attempts === 0 ? 0 : right.resolved / right.attempts;

  if (leftRate !== rightRate) {
    return leftRate - rightRate;
  }

  if (left.attempts !== right.attempts) {
    return right.attempts - left.attempts;
  }

  return left.key.localeCompare(right.key);
}

function compareCategoryDifficulty(left: CategoryAggregate, right: CategoryAggregate): number {
  const leftRate = left.attempts === 0 ? 0 : left.resolved / left.attempts;
  const rightRate = right.attempts === 0 ? 0 : right.resolved / right.attempts;

  if (leftRate !== rightRate) {
    return leftRate - rightRate;
  }

  if (left.attempts !== right.attempts) {
    return right.attempts - left.attempts;
  }

  return left.category.localeCompare(right.category);
}

async function readArtifactCached<T>(cache: Map<string, Promise<T>>, artifactPath: string): Promise<T> {
  const existing = cache.get(artifactPath);

  if (existing) {
    return existing;
  }

  const pending = readJson<T>(artifactPath);
  cache.set(artifactPath, pending);
  return pending;
}

function getRunIssueMap(run: RunArtifact): Map<string, ProofreadingIssue> {
  const map = new Map<string, ProofreadingIssue>();

  for (const runCase of run.cases) {
    for (const issue of runCase.issues) {
      map.set(`${runCase.caseId}::${issue.id}`, issue);
    }
  }

  return map;
}

function buildIssueKey(attempt: ResultsAttempt, caseId: string, issueId: string): string {
  return `${attempt.datasetPath}::${attempt.datasetHash}::${caseId}::${issueId}`;
}

function filterAttempts(attempts: ResultsAttempt[], options: CliOptions): ResultsAttempt[] {
  return attempts.filter((attempt) => {
    if (options.datasetPath && !matchesDatasetPath(attempt.datasetPath, options.datasetPath)) {
      return false;
    }

    if (options.model && !matchesModel(attempt.baseModel, attempt.model, options.model)) {
      return false;
    }

    return true;
  });
}

async function buildIssueAnalytics(attempts: ResultsAttempt[]): Promise<{
  issues: IssueAggregate[];
  categories: CategoryAggregate[];
  skippedAttempts: number;
}> {
  const issueMap = new Map<string, IssueAggregate>();
  const categoryMap = new Map<string, CategoryAggregate>();
  const runCache = new Map<string, Promise<RunArtifact>>();
  const reportCache = new Map<string, Promise<ScoreArtifact>>();
  let skippedAttempts = 0;

  for (const attempt of attempts) {
    if (!attempt.runArtifact || !attempt.reportArtifact) {
      skippedAttempts += 1;
      continue;
    }

    try {
      const [run, report] = await Promise.all([
        readArtifactCached(runCache, attempt.runArtifact),
        readArtifactCached(reportCache, attempt.reportArtifact)
      ]);
      const runIssueMap = getRunIssueMap(run);

      for (const reportCase of report.cases) {
        for (const reportIssue of reportCase.issues) {
          const runIssue = runIssueMap.get(`${reportCase.caseId}::${reportIssue.issueId}`);

          if (!runIssue) {
            continue;
          }

          const key = buildIssueKey(attempt, reportCase.caseId, reportIssue.issueId);
          const issueEntry =
            issueMap.get(key) ??
            (() => {
              const created: IssueAggregate = {
                key,
                datasetPath: attempt.datasetPath,
                datasetName: attempt.datasetName,
                datasetHash: attempt.datasetHash,
                caseId: reportCase.caseId,
                issueId: reportIssue.issueId,
                category: reportIssue.category,
                description: reportIssue.description,
                beforeText: runIssue.expectedCorrection.find,
                afterText: runIssue.expectedCorrection.replace,
                attempts: 0,
                resolved: 0,
                modelStats: new Map<string, ModelResolutionAggregate>()
              };
              issueMap.set(key, created);
              return created;
            })();

          issueEntry.attempts += 1;
          if (reportIssue.corrected) {
            issueEntry.resolved += 1;
          }
          const issueModelEntry =
            issueEntry.modelStats.get(attempt.model) ??
            (() => {
              const created: ModelResolutionAggregate = {
                model: attempt.model,
                attempts: 0,
                resolved: 0
              };
              issueEntry.modelStats.set(attempt.model, created);
              return created;
            })();
          issueModelEntry.attempts += 1;
          if (reportIssue.corrected) {
            issueModelEntry.resolved += 1;
          }

          const categoryEntry =
            categoryMap.get(reportIssue.category) ??
            (() => {
              const created: CategoryAggregate = {
                category: reportIssue.category,
                attempts: 0,
                resolved: 0,
                uniqueIssueKeys: new Set<string>(),
                modelStats: new Map<string, ModelResolutionAggregate>()
              };
              categoryMap.set(reportIssue.category, created);
              return created;
            })();

          categoryEntry.attempts += 1;
          if (reportIssue.corrected) {
            categoryEntry.resolved += 1;
          }
          categoryEntry.uniqueIssueKeys.add(key);
          const categoryModelEntry =
            categoryEntry.modelStats.get(attempt.model) ??
            (() => {
              const created: ModelResolutionAggregate = {
                model: attempt.model,
                attempts: 0,
                resolved: 0
              };
              categoryEntry.modelStats.set(attempt.model, created);
              return created;
            })();
          categoryModelEntry.attempts += 1;
          if (reportIssue.corrected) {
            categoryModelEntry.resolved += 1;
          }
        }
      }
    } catch {
      skippedAttempts += 1;
    }
  }

  return {
    issues: [...issueMap.values()].sort(compareIssueDifficulty),
    categories: [...categoryMap.values()].sort(compareCategoryDifficulty),
    skippedAttempts
  };
}

function renderIssueTable(title: string, issues: IssueAggregate[], limit: number, totalWidth: number): string[] {
  const widths = distributeWidths(
    totalWidth,
    [5, 22, 12, 28, 16, 28],
    [0, 2, 0, 3, 0, 4]
  );
  const lines = [title];
  const border = buildBorder(widths);
  lines.push(border);
  lines.push(buildRow(["rank", "dataset/case", "issue", "category", "found", "before -> after"], widths));
  lines.push(border);

  issues.slice(0, limit).forEach((issue, index) => {
    const datasetCase = `${issue.datasetName}/${issue.caseId}`;
    const rate = issue.attempts === 0 ? null : issue.resolved / issue.attempts;
    const found = `${formatPercent(rate)} (${issue.resolved}/${issue.attempts})`;
    const previewWidth = Math.max(18, Math.floor((widths[5] - 4) / 2));
    const preview = `${summarizeText(issue.beforeText, previewWidth)} -> ${summarizeText(issue.afterText, previewWidth)}`;

    lines.push(
      buildRow(
        [`${index + 1}`, datasetCase, issue.issueId, issue.category, found, preview],
        widths,
        ["right", "left", "left", "left", "left", "left"]
      )
    );
  });

  lines.push(border);
  return lines;
}

function renderCategoryTable(title: string, categories: CategoryAggregate[], limit: number, totalWidth: number): string[] {
  const widths = distributeWidths(
    totalWidth,
    [5, 40, 8, 10, 18],
    [0, 5, 0, 0, 1]
  );
  const lines = [title];
  const border = buildBorder(widths);
  lines.push(border);
  lines.push(buildRow(["rank", "category", "issues", "attempts", "found"], widths));
  lines.push(border);

  categories.slice(0, limit).forEach((category, index) => {
    const rate = category.attempts === 0 ? null : category.resolved / category.attempts;
    lines.push(
      buildRow(
        [
          `${index + 1}`,
          category.category,
          `${category.uniqueIssueKeys.size}`,
          `${category.attempts}`,
          `${formatPercent(rate)} (${category.resolved}/${category.attempts})`
        ],
        widths,
        ["right", "left", "right", "right", "left"]
      )
    );
  });

  lines.push(border);
  return lines;
}

function buildSections(): AnalysisSection[] {
  return [
    {
      id: "histogram",
      title: "Issue Difficulty Histogram",
    },
    {
      id: "hardestIssues",
      title: "Hardest Issues",
    },
    {
      id: "easiestIssues",
      title: "Easiest Issues",
    },
    {
      id: "hardestCategories",
      title: "Hardest Categories",
    },
    {
      id: "easiestCategories",
      title: "Easiest Categories",
    }
  ];
}

function getLimitedIssues(data: IssueAnalysisData, sectionId: AnalysisSection["id"]): IssueAggregate[] {
  const base = sectionId === "easiestIssues" ? [...data.issues].sort(compareIssueDifficulty).reverse() : data.issues;
  return base.slice(0, data.options.limit);
}

function getLimitedCategories(data: IssueAnalysisData, sectionId: AnalysisSection["id"]): CategoryAggregate[] {
  const base =
    sectionId === "easiestCategories"
      ? [...data.categories].sort(compareCategoryDifficulty).reverse()
      : data.categories;
  return base.slice(0, data.options.limit);
}

function clampSelection(selectedIndex: number, itemCount: number): number {
  if (itemCount <= 0) {
    return 0;
  }

  return Math.max(0, Math.min(itemCount - 1, selectedIndex));
}

function getWindowStart(selectedIndex: number, visibleCount: number, totalCount: number): number {
  const maxStart = Math.max(0, totalCount - visibleCount);
  return Math.max(0, Math.min(maxStart, selectedIndex - Math.floor(visibleCount / 2)));
}

function renderIssueTableWindow(
  issues: IssueAggregate[],
  selectedIndex: number,
  totalWidth: number,
  rowBudget: number
): { lines: string[]; selectedIssue: IssueAggregate | null; selectedIndex: number } {
  if (issues.length === 0) {
    return { lines: ["no issues"], selectedIssue: null, selectedIndex: 0 };
  }

  const widths = distributeWidths(totalWidth, [5, 22, 12, 28, 16, 28], [0, 2, 0, 3, 0, 4]);
  const clampedIndex = clampSelection(selectedIndex, issues.length);
  const border = buildBorder(widths);
  const visibleRowCount = Math.max(1, rowBudget - 5);
  const start = getWindowStart(clampedIndex, visibleRowCount, issues.length);
  const windowed = issues.slice(start, start + visibleRowCount);
  const lines = [
    `rows ${start + 1}-${start + windowed.length} of ${issues.length}`,
    border,
    buildRow(["rank", "dataset/case", "issue", "category", "found", "before -> after"], widths),
    border
  ];

  windowed.forEach((issue, offset) => {
    const index = start + offset;
    const datasetCase = `${issue.datasetName}/${issue.caseId}`;
    const rate = issue.attempts === 0 ? null : issue.resolved / issue.attempts;
    const found = `${formatPercent(rate)} (${issue.resolved}/${issue.attempts})`;
    const previewWidth = Math.max(18, Math.floor((widths[5] - 4) / 2));
    const preview = `${summarizeText(issue.beforeText, previewWidth)} -> ${summarizeText(issue.afterText, previewWidth)}`;
    const rank = index === clampedIndex ? `>${index + 1}` : `${index + 1}`;

    lines.push(
      buildRow([rank, datasetCase, issue.issueId, issue.category, found, preview], widths, [
        "right",
        "left",
        "left",
        "left",
        "left",
        "left"
      ])
    );
  });

  lines.push(border);
  return { lines, selectedIssue: issues[clampedIndex], selectedIndex: clampedIndex };
}

function renderCategoryTableWindow(
  categories: CategoryAggregate[],
  selectedIndex: number,
  totalWidth: number,
  rowBudget: number
): { lines: string[]; selectedCategory: CategoryAggregate | null; selectedIndex: number } {
  if (categories.length === 0) {
    return { lines: ["no categories"], selectedCategory: null, selectedIndex: 0 };
  }

  const widths = distributeWidths(totalWidth, [5, 40, 8, 10, 18], [0, 5, 0, 0, 1]);
  const clampedIndex = clampSelection(selectedIndex, categories.length);
  const border = buildBorder(widths);
  const visibleRowCount = Math.max(1, rowBudget - 5);
  const start = getWindowStart(clampedIndex, visibleRowCount, categories.length);
  const windowed = categories.slice(start, start + visibleRowCount);
  const lines = [
    `rows ${start + 1}-${start + windowed.length} of ${categories.length}`,
    border,
    buildRow(["rank", "category", "issues", "attempts", "found"], widths),
    border
  ];

  windowed.forEach((category, offset) => {
    const index = start + offset;
    const rate = category.attempts === 0 ? null : category.resolved / category.attempts;
    const rank = index === clampedIndex ? `>${index + 1}` : `${index + 1}`;
    lines.push(
      buildRow(
        [
          rank,
          category.category,
          `${category.uniqueIssueKeys.size}`,
          `${category.attempts}`,
          `${formatPercent(rate)} (${category.resolved}/${category.attempts})`
        ],
        widths,
        ["right", "left", "right", "right", "left"]
      )
    );
  });

  lines.push(border);
  return { lines, selectedCategory: categories[clampedIndex], selectedIndex: clampedIndex };
}

function sortModelStats(stats: ModelResolutionAggregate[], mode: "caught" | "missed"): ModelResolutionAggregate[] {
  return [...stats].sort((left, right) => {
    const leftResolvedRate = left.attempts === 0 ? 0 : left.resolved / left.attempts;
    const rightResolvedRate = right.attempts === 0 ? 0 : right.resolved / right.attempts;
    const leftMissed = left.attempts - left.resolved;
    const rightMissed = right.attempts - right.resolved;
    const leftMissRate = left.attempts === 0 ? 0 : leftMissed / left.attempts;
    const rightMissRate = right.attempts === 0 ? 0 : rightMissed / right.attempts;

    if (mode === "caught") {
      if (rightResolvedRate !== leftResolvedRate) {
        return rightResolvedRate - leftResolvedRate;
      }

      if (right.resolved !== left.resolved) {
        return right.resolved - left.resolved;
      }
    } else {
      if (rightMissRate !== leftMissRate) {
        return rightMissRate - leftMissRate;
      }

      if (rightMissed !== leftMissed) {
        return rightMissed - leftMissed;
      }
    }

    if (right.attempts !== left.attempts) {
      return right.attempts - left.attempts;
    }

    return left.model.localeCompare(right.model);
  });
}

function renderModelBreakdown(
  title: string,
  stats: Map<string, ModelResolutionAggregate>,
  mode: "caught" | "missed",
  totalWidth: number,
  maxLines: number
): string[] {
  const filtered = sortModelStats([...stats.values()], mode).filter((entry) =>
    mode === "caught" ? entry.resolved > 0 : entry.attempts - entry.resolved > 0
  );

  if (filtered.length === 0) {
    return [title, mode === "caught" ? "no models caught this selection" : "no models missed this selection"];
  }

  const widths = distributeWidths(totalWidth, [34, 18, 18], [4, 1, 1]);
  const border = buildBorder(widths);
  const lines = [title, border, buildRow(["model", "found", "missed"], widths), border];
  const visibleRows = Math.max(1, maxLines - 4);

  filtered.slice(0, visibleRows).forEach((entry) => {
    const foundRate = entry.attempts === 0 ? null : entry.resolved / entry.attempts;
    const missed = entry.attempts - entry.resolved;
    const missedRate = entry.attempts === 0 ? null : missed / entry.attempts;
    lines.push(
      buildRow(
        [
          entry.model,
          `${formatPercent(foundRate)} (${entry.resolved}/${entry.attempts})`,
          `${formatPercent(missedRate)} (${missed}/${entry.attempts})`
        ],
        widths
      )
    );
  });

  lines.push(border);

  if (filtered.length > visibleRows) {
    lines.push(`... ${filtered.length - visibleRows} more models hidden`);
  }

  return lines;
}

function renderPlainTextReport(data: IssueAnalysisData): string {
  const terminalWidth = getTerminalWidth();
  const sections = buildSections();
  const lines = [
    `group_id=${data.artifact.groupId}`,
    `artifact=${data.artifactPath}`,
    `matched_attempts=${data.matchedAttempts}`,
    `analyzed_attempts=${data.analyzableAttempts}`,
    `skipped_attempts=${data.skippedAttempts}`,
    `unique_issues=${data.issues.length}`,
    `unique_categories=${data.categories.length}`,
    `dataset_filter=${data.options.datasetPath ?? "none"}`,
    `model_filter=${data.options.model ?? "none"}`
  ];

  for (const section of sections) {
    lines.push("");
    if (section.id === "histogram") {
      lines.push("issue difficulty histogram:", ...renderHistogram(data.histogram));
      continue;
    }

    if (section.id === "hardestIssues") {
      lines.push(...renderIssueTable("hardest issues:", getLimitedIssues(data, section.id), data.options.limit, terminalWidth));
      continue;
    }

    if (section.id === "easiestIssues") {
      lines.push(...renderIssueTable("easiest issues:", getLimitedIssues(data, section.id), data.options.limit, terminalWidth));
      continue;
    }

    if (section.id === "hardestCategories") {
      lines.push(...renderCategoryTable("hardest categories:", getLimitedCategories(data, section.id), data.options.limit, terminalWidth));
      continue;
    }

    lines.push(...renderCategoryTable("easiest categories:", getLimitedCategories(data, section.id), data.options.limit, terminalWidth));
  }

  return lines.join("\n");
}

function renderInteractiveScreen(data: IssueAnalysisData, sectionIndex: number, rowSelections: number[]): string {
  const columns = Math.max(120, process.stdout.columns ?? 160);
  const rows = Math.max(28, process.stdout.rows ?? 40);
  const sections = buildSections();
  const section = sections[sectionIndex];
  const selectedRow = rowSelections[sectionIndex] ?? 0;
  const headerLines = [
    `group: ${data.artifact.groupId}   section: ${sectionIndex + 1}/${sections.length} ${section.title}   attempts: ${data.analyzableAttempts}/${data.matchedAttempts} analyzed`,
    `dataset filter: ${data.options.datasetPath ?? "none"}   model filter: ${data.options.model ?? "none"}   limit: ${data.options.limit}`,
    "controls: left/right change section, up/down move row, q quits",
    ""
  ];
  const availableHeight = Math.max(8, rows - headerLines.length);
  let bodyLines: string[] = [];

  if (section.id === "histogram") {
    bodyLines = clipLines(["issue difficulty histogram:", ...renderHistogram(data.histogram)], columns, availableHeight);
  } else if (section.id === "hardestIssues" || section.id === "easiestIssues") {
    const issues = getLimitedIssues(data, section.id);
    const modelBudget = Math.max(7, Math.min(14, Math.floor(availableHeight * 0.4)));
    const tableBudget = Math.max(8, availableHeight - modelBudget - 1);
    const table = renderIssueTableWindow(issues, selectedRow, columns, tableBudget);
    rowSelections[sectionIndex] = table.selectedIndex;
    const breakdown = table.selectedIssue
      ? renderModelBreakdown(
          section.id === "hardestIssues" ? "models that caught this issue:" : "models that missed this issue:",
          table.selectedIssue.modelStats,
          section.id === "hardestIssues" ? "caught" : "missed",
          columns,
          availableHeight - table.lines.length - 1
        )
      : [];
    bodyLines = [...table.lines, "", ...breakdown];
  } else {
    const categories = getLimitedCategories(data, section.id);
    const modelBudget = Math.max(7, Math.min(14, Math.floor(availableHeight * 0.4)));
    const tableBudget = Math.max(8, availableHeight - modelBudget - 1);
    const table = renderCategoryTableWindow(categories, selectedRow, columns, tableBudget);
    rowSelections[sectionIndex] = table.selectedIndex;
    const breakdown = table.selectedCategory
      ? renderModelBreakdown(
          section.id === "hardestCategories"
            ? "models that catch this category most often:"
            : "models that miss this category most often:",
          table.selectedCategory.modelStats,
          section.id === "hardestCategories" ? "caught" : "missed",
          columns,
          availableHeight - table.lines.length - 1
        )
      : [];
    bodyLines = [...table.lines, "", ...breakdown];
  }

  const clipped = clipLines(bodyLines, columns, availableHeight);
  if (bodyLines.length > clipped.length) {
    const overflowNote = clip(
      `... ${bodyLines.length - clipped.length} more lines hidden; reduce --limit or enlarge terminal`,
      columns
    );

    if (clipped.length >= availableHeight && clipped.length > 0) {
      clipped[clipped.length - 1] = overflowNote;
    } else {
      clipped.push(overflowNote);
    }
  }

  return [...headerLines, ...clipped].join("\n");
}

async function runInteractiveViewer(data: IssueAnalysisData): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("bench:issues interactive mode requires an interactive TTY");
  }

  let sectionIndex = 0;
  const sections = buildSections();
  const sectionCount = sections.length;
  const rowSelections = Array.from({ length: sectionCount }, () => 0);

  const cleanup = (): void => {
    process.stdout.write("\u001b[?25h");
    process.stdout.write("\u001b[?1049l");
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    process.stdin.removeAllListeners("keypress");
  };

  const render = (): void => {
    process.stdout.write("\u001b[H\u001b[2J");
    process.stdout.write(renderInteractiveScreen(data, sectionIndex, rowSelections));
  };

  await new Promise<void>((resolve) => {
    readline.emitKeypressEvents(process.stdin);
    process.stdout.write("\u001b[?1049h");
    process.stdout.write("\u001b[?25l");
    process.stdin.setRawMode(true);
    process.stdin.resume();
    render();

    const onKeypress = (_input: string, key: readline.Key): void => {
      if (key.name === "q" || (key.ctrl && key.name === "c")) {
        cleanup();
        resolve();
        return;
      }

      if (key.name === "left") {
        sectionIndex = (sectionIndex - 1 + sectionCount) % sectionCount;
        render();
        return;
      }

      if (key.name === "right") {
        sectionIndex = (sectionIndex + 1) % sectionCount;
        render();
        return;
      }

      if (key.name === "up") {
        if (sections[sectionIndex].id !== "histogram") {
          rowSelections[sectionIndex] = Math.max(0, rowSelections[sectionIndex] - 1);
          render();
        }
        return;
      }

      if (key.name === "down") {
        if (sections[sectionIndex].id !== "histogram") {
          rowSelections[sectionIndex] += 1;
          render();
        }
      }
    };

    process.stdin.on("keypress", onKeypress);
  });
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const artifactPath =
    options.artifactPath != null ? path.resolve(options.artifactPath) : buildResultsPath(options.groupId);
  const rawArtifact = await readJson<ResultsArtifact>(artifactPath);
  const artifact = buildResultsArtifact(rawArtifact.groupId, rawArtifact.attempts, rawArtifact.createdAt);
  const matchedAttempts = filterAttempts(artifact.attempts, options);
  const analyzableAttempts = matchedAttempts.filter(
    (attempt) => attempt.succeeded && Boolean(attempt.runArtifact) && Boolean(attempt.reportArtifact)
  );
  const { issues, categories, skippedAttempts } = await buildIssueAnalytics(analyzableAttempts);
  const data: IssueAnalysisData = {
    artifact,
    artifactPath,
    matchedAttempts: matchedAttempts.length,
    analyzableAttempts: analyzableAttempts.length,
    skippedAttempts,
    issues,
    categories,
    histogram: buildHistogram(issues),
    options
  };

  if (process.stdin.isTTY && process.stdout.isTTY) {
    await runInteractiveViewer(data);
    return;
  }

  console.log(renderPlainTextReport(data));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
