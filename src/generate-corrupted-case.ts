import path from "node:path";
import { readdir, stat } from "node:fs/promises";

import dotenv from "dotenv";

import {
  getApiEndpointLabel,
  getApiProviderLabel,
  getDefaultCorruptionModel,
  getDefaultCorruptionReviewModel
} from "./api-config.js";
import {
  generateCorruptedCase,
  summarizeSelectedMutations,
  type CorruptionProgressUpdate
} from "./corruption-engine.js";
import { loadProofreadingDataset } from "./dataset.js";
import { readText, writeJson, writeText } from "./fs.js";
import { isTaxonomyParent, type TaxonomyParent } from "./taxonomy.js";

dotenv.config();

type CliOptions = {
  sourcePath: string;
  outputSourcePath: string | null;
  outputCasePath: string | null;
  caseId: string | null;
  instruction: string | null;
  issueCount: number | null;
  issuesPerThousandWords: number;
  maxWordsPerChunk: number;
  concurrency: number;
  seed: string;
  model: string | null;
  reviewModel: string | null;
  reviewMinConfidence: "high" | "medium" | "low";
  requestTimeoutMs: number | null;
  verbose: boolean;
  requiredParents: TaxonomyParent[];
  singleTargetClassPerChunk: boolean;
  targetCategoryLabel: string | null;
  targetCategoryLabels: string[];
  datasetToBalancePaths: string[];
  balanceExcludeTopCategories: number;
  balanceMaxCategoryCount: number | null;
};

function parseCommaSeparatedValues(raw: string): string[] {
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function parseArgs(argv: string[]): CliOptions {
  let sourcePath = "";
  let outputSourcePath: string | null = null;
  let outputCasePath: string | null = null;
  let caseId: string | null = null;
  let instruction: string | null = null;
  let issueCount: number | null = null;
  let issuesPerThousandWords = 5;
  let maxWordsPerChunk = 300;
  let concurrency = 2;
  let seed = "erratabench-v1";
  let model: string | null = getDefaultCorruptionModel();
  let reviewModel: string | null = getDefaultCorruptionReviewModel();
  let reviewMinConfidence: "high" | "medium" | "low" = "medium";
  let requestTimeoutMs: number | null = 120000;
  let verbose = false;
  const requiredParents: TaxonomyParent[] = [];
  let singleTargetClassPerChunk = false;
  let targetCategoryLabel: string | null = null;
  const targetCategoryLabels: string[] = [];
  let datasetToBalancePaths: string[] = [];
  let balanceExcludeTopCategories = 10;
  let balanceMaxCategoryCount: number | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--source") {
      sourcePath = argv[index + 1] ?? sourcePath;
      index += 1;
      continue;
    }

    if (arg === "--output-source") {
      outputSourcePath = argv[index + 1] ?? outputSourcePath;
      index += 1;
      continue;
    }

    if (arg === "--output-case") {
      outputCasePath = argv[index + 1] ?? outputCasePath;
      index += 1;
      continue;
    }

    if (arg === "--case-id") {
      caseId = argv[index + 1] ?? caseId;
      index += 1;
      continue;
    }

    if (arg === "--instruction") {
      instruction = argv[index + 1] ?? instruction;
      index += 1;
      continue;
    }

    if (arg === "--issue-count") {
      issueCount = Number.parseInt(argv[index + 1] ?? "", 10);
      index += 1;
      continue;
    }

    if (arg === "--issues-per-1000-words") {
      issuesPerThousandWords = Number.parseFloat(argv[index + 1] ?? `${issuesPerThousandWords}`);
      index += 1;
      continue;
    }

    if (arg === "--max-words-per-chunk" || arg === "--chunk-size") {
      maxWordsPerChunk = Number.parseInt(argv[index + 1] ?? `${maxWordsPerChunk}`, 10);
      index += 1;
      continue;
    }

    if (arg === "--concurrency") {
      concurrency = Number.parseInt(argv[index + 1] ?? `${concurrency}`, 10);
      index += 1;
      continue;
    }

    if (arg === "--seed") {
      seed = argv[index + 1] ?? seed;
      index += 1;
      continue;
    }

    if (arg === "--model") {
      model = argv[index + 1] ?? model;
      index += 1;
      continue;
    }

    if (arg === "--review-model") {
      reviewModel = argv[index + 1] ?? reviewModel;
      index += 1;
      continue;
    }

    if (arg === "--review-min-confidence") {
      const value = (argv[index + 1] ?? "").trim();

      if (value !== "high" && value !== "medium" && value !== "low") {
        throw new Error(`--review-min-confidence must be one of high, medium, or low; received "${value}"`);
      }

      reviewMinConfidence = value;
      index += 1;
      continue;
    }

    if (arg === "--request-timeout-ms") {
      requestTimeoutMs = Number.parseInt(argv[index + 1] ?? "", 10);
      index += 1;
      continue;
    }

    if (arg === "--required-parent") {
      const parent = argv[index + 1] ?? "";

      if (!isTaxonomyParent(parent)) {
        throw new Error(`--required-parent must be one of the supported taxonomy parents; received "${parent}"`);
      }

      requiredParents.push(parent);
      index += 1;
      continue;
    }

    if (arg === "--single-target-class-per-chunk") {
      singleTargetClassPerChunk = true;
      continue;
    }

    if (arg === "--target-category") {
      const value = (argv[index + 1] ?? "").trim();
      targetCategoryLabel = value.length > 0 ? value : null;
      index += 1;
      continue;
    }

    if (arg === "--target-categories") {
      targetCategoryLabels.push(...parseCommaSeparatedValues(argv[index + 1] ?? ""));
      index += 1;
      continue;
    }

    if (arg === "--dataset-to-balance") {
      datasetToBalancePaths = parseCommaSeparatedValues(argv[index + 1] ?? "");
      index += 1;
      continue;
    }

    if (arg === "--balance-exclude-top-categories") {
      balanceExcludeTopCategories = Number.parseInt(argv[index + 1] ?? `${balanceExcludeTopCategories}`, 10);
      index += 1;
      continue;
    }

    if (arg === "--balance-max-category-count") {
      const parsed = Number.parseInt(argv[index + 1] ?? "", 10);
      balanceMaxCategoryCount = Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
      index += 1;
      continue;
    }

    if (arg === "--verbose") {
      verbose = true;
    }
  }

  return {
    sourcePath,
    outputSourcePath,
    outputCasePath,
    caseId,
    instruction,
    issueCount,
    issuesPerThousandWords,
    maxWordsPerChunk,
    concurrency,
    seed,
    model,
    reviewModel,
    reviewMinConfidence,
    requestTimeoutMs,
    verbose,
    requiredParents,
    singleTargetClassPerChunk,
    targetCategoryLabel,
    targetCategoryLabels,
    datasetToBalancePaths,
    balanceExcludeTopCategories,
    balanceMaxCategoryCount
  };
}

function defaultInstruction(): string {
  return "Proofread the document. Fix the known spelling, grammar, punctuation, word-choice, and style mistakes while preserving meaning, tone, paragraph ids, and intentional wording everywhere else.";
}

function toPosixRelativePath(fromFile: string, toFile: string): string {
  const relativePath = path.relative(path.dirname(fromFile), toFile);
  return relativePath.split(path.sep).join("/");
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

async function expandDatasetPathEntry(entryPath: string): Promise<string[]> {
  const resolvedPath = path.resolve(entryPath);
  const stats = await stat(resolvedPath);

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

async function buildBalancePlan(
  datasetPaths: string[],
  excludeTopCategories: number
): Promise<{
  datasetPaths: string[];
  categoryCounts: Record<string, number>;
  excludedCategoryLabels: string[];
  prioritizedCategoryLabels: string[];
  lowestCount: number | null;
  lowestCountCategoryLabels: string[];
}> {
  const expandedPaths = await expandDatasetPaths(datasetPaths);
  const categoryCounts = new Map<string, number>();

  for (const datasetPath of expandedPaths) {
    const dataset = await loadProofreadingDataset(datasetPath);

    for (const sample of dataset) {
      for (const issue of sample.issues) {
        categoryCounts.set(issue.category, (categoryCounts.get(issue.category) ?? 0) + 1);
      }
    }
  }

  const sortedLabels = [...categoryCounts.entries()]
    .sort((left, right) => {
      if (right[1] !== left[1]) {
        return right[1] - left[1];
      }

      return left[0].localeCompare(right[0]);
    })
    .map(([label]) => label);

  const normalizedTopCount = Math.max(0, Math.min(excludeTopCategories, Math.max(0, sortedLabels.length - 1)));
  const excludedCategoryLabels = sortedLabels.slice(0, normalizedTopCount);
  const excludedCategorySet = new Set(excludedCategoryLabels);
  const prioritizedCategoryLabels = [...categoryCounts.entries()]
    .filter(([label]) => !excludedCategorySet.has(label))
    .sort((left, right) => {
      if (left[1] !== right[1]) {
        return left[1] - right[1];
      }

      return left[0].localeCompare(right[0]);
    })
    .slice(0, 12)
    .map(([label, count]) => `${label} (${count})`);
  const eligibleEntries = [...categoryCounts.entries()].filter(([label]) => !excludedCategorySet.has(label));
  const lowestCount =
    eligibleEntries.length === 0 ? null : Math.min(...eligibleEntries.map(([, count]) => count));
  const lowestCountCategoryLabels =
    lowestCount == null
      ? []
      : eligibleEntries
          .filter(([, count]) => count === lowestCount)
          .map(([label]) => label)
          .sort((left, right) => left.localeCompare(right));

  return {
    datasetPaths: expandedPaths,
    categoryCounts: Object.fromEntries(categoryCounts),
    excludedCategoryLabels,
    prioritizedCategoryLabels,
    lowestCount,
    lowestCountCategoryLabels
  };
}

class CorruptionProgressDisplay {
  private readonly interactive = Boolean(process.stdout.isTTY);
  private rendered = false;
  private renderedLineCount = 0;
  private latest: CorruptionProgressUpdate | null = null;
  private readonly recentRejections: string[] = [];
  private readonly maxRecentRejections = 6;

  public onProgress(update: CorruptionProgressUpdate): void {
    this.latest = update;

    if (update.phase === "rejected") {
      const rejectionLine = this.buildRejectionLine(update);

      if (rejectionLine.length > 0) {
        this.recentRejections.push(rejectionLine);

        if (this.recentRejections.length > this.maxRecentRejections) {
          this.recentRejections.splice(0, this.recentRejections.length - this.maxRecentRejections);
        }
      }
    }

    if (this.interactive) {
      this.render();
      return;
    }

    if (update.phase === "rejected") {
      const rejectionLine = this.buildRejectionLine(update);

      if (rejectionLine.length > 0) {
        console.log(rejectionLine);
      }
      return;
    }

    if (update.phase === "accepted" || update.phase === "done") {
      console.log(this.buildLine());
    }
  }

  public finish(): void {
    if (this.interactive && this.rendered) {
      process.stdout.write("\n");
    }
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

    this.rendered = true;
    this.renderedLineCount = lines.length;
  }

  private buildLine(): string {
    if (!this.latest) {
      return "corruption: queued";
    }

    const width = Math.max(80, process.stdout.columns ?? 120);
    const completed = Math.min(this.latest.acceptedIssues, this.latest.targetIssueCount);
    const progressBar = buildProgressBar(completed, this.latest.targetIssueCount, 18);
    const attempted = Math.max(this.latest.attemptedIssues, completed);
    const acceptanceRate = attempted <= 0 ? null : completed / attempted;
    const suffix = [
      `phase:${this.latest.phase}`,
      `accepted:${completed}/${this.latest.targetIssueCount}`,
      `attempted:${attempted}`,
      `acc:${acceptanceRate == null ? "n/a" : `${(acceptanceRate * 100).toFixed(1)}%`}`,
      `issue:${this.latest.targetLabel}`,
      this.latest.chunkId ? `chunk:${this.latest.chunkId}` : null,
      this.latest.message ? `msg:${this.latest.message}` : null
    ]
      .filter((value): value is string => value != null && value.length > 0)
      .join("  ");

    return clipLine(`corruption  ${progressBar}  ${suffix}`, width);
  }

  private buildLines(): string[] {
    const width = Math.max(80, process.stdout.columns ?? 120);
    const lines = [this.buildLine()];

    for (const rejectionLine of this.recentRejections) {
      lines.push(clipLine(rejectionLine, width));
    }

    return lines;
  }

  private buildRejectionLine(update: CorruptionProgressUpdate): string {
    const parts = [
      "reject",
      update.targetLabel.length > 0 ? `issue:${update.targetLabel}` : null,
      update.message ? `reason:${update.message}` : null
    ].filter((value): value is string => value != null && value.length > 0);

    return parts.join("  ");
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (options.sourcePath.length === 0) {
    throw new Error("Pass --source <clean-source.txt>");
  }

  if (options.issueCount != null && options.issueCount < 1) {
    throw new Error("--issue-count must be at least 1");
  }

  if (!Number.isFinite(options.issuesPerThousandWords) || options.issuesPerThousandWords <= 0) {
    throw new Error("--issues-per-1000-words must be greater than 0");
  }

  if (options.maxWordsPerChunk < 1) {
    throw new Error("--max-words-per-chunk must be at least 1");
  }

  if (options.concurrency < 1) {
    throw new Error("--concurrency must be at least 1");
  }

  if (options.targetCategoryLabel != null && options.datasetToBalancePaths.length > 0) {
    throw new Error("--target-category cannot be combined with --dataset-to-balance");
  }

  if (options.targetCategoryLabel != null && options.targetCategoryLabels.length > 0) {
    throw new Error("Use either --target-category or --target-categories, not both");
  }

  if (!options.model) {
    throw new Error(
      "Pass --model or set ERRATA_BENCH_DEFAULT_CORRUPTION_MODEL / ERRATA_BENCH_DEFAULT_MODEL for generation"
    );
  }

  const sourcePath = path.resolve(options.sourcePath);

  if (path.extname(sourcePath).toLowerCase() !== ".txt") {
    throw new Error("The LLM corruption generator currently supports only .txt clean source files");
  }

  const sourceBaseName = path.basename(sourcePath, path.extname(sourcePath));
  const outputDirectory = path.resolve("datasets/v1/generated");
  const outputSourcePath =
    options.outputSourcePath == null
      ? path.join(outputDirectory, `${sourceBaseName}-corrupted.txt`)
      : path.resolve(options.outputSourcePath);
  const outputCasePath =
    options.outputCasePath == null
      ? path.join(outputDirectory, `${sourceBaseName}.json`)
      : path.resolve(options.outputCasePath);
  const cleanText = await readText(sourcePath);
  const caseId = options.caseId ?? sourceBaseName;
  const instruction = options.instruction ?? defaultInstruction();
  const balancePlan =
    options.datasetToBalancePaths.length === 0
      ? null
      : await buildBalancePlan(options.datasetToBalancePaths, options.balanceExcludeTopCategories);

  if (balancePlan) {
    console.log("balance_mode=enabled");
    console.log(`balance_dataset_inputs=${options.datasetToBalancePaths.join(",")}`);
    console.log(`balance_dataset_files=${balancePlan.datasetPaths.length}`);
    console.log(`balance_exclude_top_categories=${options.balanceExcludeTopCategories}`);
    console.log(`balance_max_category_count=${options.balanceMaxCategoryCount ?? "none"}`);
    console.log(`balance_excluded_labels=${JSON.stringify(balancePlan.excludedCategoryLabels)}`);
    console.log(`balance_lowest_count=${balancePlan.lowestCount ?? "n/a"}`);
    console.log(`balance_lowest_count_labels=${JSON.stringify(balancePlan.lowestCountCategoryLabels)}`);
    console.log(`balance_prioritized_labels=${JSON.stringify(balancePlan.prioritizedCategoryLabels)}`);
    console.log("");
  }

  const progressDisplay = new CorruptionProgressDisplay();
  const generated = await (async () => {
    try {
      return await generateCorruptedCase(cleanText, toPosixRelativePath(outputCasePath, outputSourcePath), {
        caseId,
        instruction,
        seed: options.seed,
        issueCount: options.issueCount,
        issuesPerThousandWords: options.issuesPerThousandWords,
        model: options.model as string,
        reviewModel: options.reviewModel ?? (options.model as string),
        reviewMinConfidence: options.reviewMinConfidence,
        maxWordsPerChunk: options.maxWordsPerChunk,
        concurrency: options.concurrency,
        requestTimeoutMs: options.requestTimeoutMs,
        verbose: options.verbose,
        requiredParents: options.requiredParents.length > 0 ? options.requiredParents : undefined,
        singleTargetClassPerChunk: options.singleTargetClassPerChunk,
        targetCategoryLabel: options.targetCategoryLabel,
        targetCategoryLabels: options.targetCategoryLabels,
        balanceCategoryCounts: balancePlan?.categoryCounts,
        excludedBalanceCategoryLabels: balancePlan?.excludedCategoryLabels,
        maxBalancedCategoryCount: options.balanceMaxCategoryCount,
        onProgress: (update) => progressDisplay.onProgress(update)
      });
    } finally {
      progressDisplay.finish();
    }
  })();

  await writeText(outputSourcePath, `${generated.corruptedText}\n`);
  await writeJson(outputCasePath, generated.caseDefinition);
  await loadProofreadingDataset(outputCasePath);

  const summary = summarizeSelectedMutations(generated.selectedMutations);
  console.log(`source=${sourcePath}`);
  console.log(`api_provider=${getApiProviderLabel()}`);
  console.log(`api_endpoint=${getApiEndpointLabel()}`);
  console.log(`output_source=${outputSourcePath}`);
  console.log(`output_case=${outputCasePath}`);
  console.log(`case_id=${generated.caseDefinition.id}`);
  console.log(`seed=${options.seed}`);
  console.log(`model=${options.model as string}`);
  console.log(`review_model=${options.reviewModel ?? (options.model as string)}`);
  console.log(`review_min_confidence=${options.reviewMinConfidence}`);
  console.log(`max_words_per_chunk=${options.maxWordsPerChunk}`);
  console.log(`concurrency=${options.concurrency}`);
  console.log(`single_target_class_per_chunk=${options.singleTargetClassPerChunk}`);
  console.log(`target_category=${options.targetCategoryLabel ?? "none"}`);
  console.log(`target_categories=${JSON.stringify(options.targetCategoryLabels)}`);
  console.log(`issues_per_1000_words=${options.issuesPerThousandWords}`);
  console.log(`issue_count=${generated.caseDefinition.issues.length}`);
  if (balancePlan) {
    console.log(`balance_dataset=${balancePlan.datasetPaths.join(",")}`);
    console.log(`balance_exclude_top_categories=${options.balanceExcludeTopCategories}`);
    console.log(`balance_max_category_count=${options.balanceMaxCategoryCount ?? "none"}`);
    console.log(`balance_excluded_labels=${JSON.stringify(balancePlan.excludedCategoryLabels)}`);
    console.log(`balance_lowest_count=${balancePlan.lowestCount ?? "n/a"}`);
    console.log(`balance_lowest_count_labels=${JSON.stringify(balancePlan.lowestCountCategoryLabels)}`);
    console.log(`balance_prioritized_labels=${JSON.stringify(balancePlan.prioritizedCategoryLabels)}`);
  }
  console.log(`class_summary=${JSON.stringify(summary)}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
