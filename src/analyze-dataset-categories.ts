import path from "node:path";
import { readdir, stat } from "node:fs/promises";

import { fingerprintProofreadingDataset, loadProofreadingDataset } from "./dataset.js";
import type { ProofreadingCase, ProofreadingIssue } from "./types.js";

type CliOptions = {
  datasetPaths: string[];
  limit: number | null;
};

type DatasetCategorySummary = {
  datasetPath: string;
  datasetName: string;
  datasetHash: string;
  caseCount: number;
  issueCount: number;
  wordCount: number;
  issuesPerThousandWords: number | null;
  uniqueParents: number;
  uniqueCategories: number;
  topCategories: string[];
};

type CategoryRollup = {
  label: string;
  count: number;
  datasets: Set<string>;
  cases: Set<string>;
};

const DEFAULT_DATASET_PATH = "datasets/v1/starter-suite.json";

function parseArgs(argv: string[]): CliOptions {
  let datasetPaths = [DEFAULT_DATASET_PATH];
  let limit: number | null = null;

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

    if (arg === "--limit") {
      const parsed = Number.parseInt(argv[index + 1] ?? "", 10);
      limit = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
      index += 1;
      continue;
    }

    if (!arg.startsWith("-")) {
      datasetPaths = arg
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value.length > 0);
    }
  }

  return { datasetPaths, limit };
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

function countWordsInParagraphHtml(html: string): number {
  const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

  if (text.length === 0) {
    return 0;
  }

  return text.split(" ").length;
}

function categoryParentOf(issue: ProofreadingIssue): string {
  if (issue.classification?.parent) {
    return issue.classification.parent;
  }

  const dotIndex = issue.category.indexOf(".");
  return dotIndex === -1 ? issue.category : issue.category.slice(0, dotIndex);
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

function formatNullable(value: number | null, digits = 2): string {
  if (value == null || Number.isNaN(value)) {
    return "n/a";
  }

  return value.toFixed(digits);
}

function formatPercent(value: number, digits = 1): string {
  return `${(value * 100).toFixed(digits)}%`;
}

function takeLimited<T>(values: T[], limit: number | null): T[] {
  return limit == null ? values : values.slice(0, limit);
}

function sortRollups(rollups: CategoryRollup[]): CategoryRollup[] {
  return [...rollups].sort((left, right) => {
    if (right.count !== left.count) {
      return right.count - left.count;
    }

    return left.label.localeCompare(right.label);
  });
}

function buildRollups(
  casesByDataset: Array<{ datasetPath: string; datasetName: string; cases: ProofreadingCase[] }>
): {
  parentRollups: CategoryRollup[];
  categoryRollups: CategoryRollup[];
  totalCases: number;
  totalIssues: number;
  totalWords: number;
} {
  const parentCounts = new Map<string, CategoryRollup>();
  const categoryCounts = new Map<string, CategoryRollup>();
  let totalCases = 0;
  let totalIssues = 0;
  let totalWords = 0;

  for (const dataset of casesByDataset) {
    totalCases += dataset.cases.length;

    for (const sample of dataset.cases) {
      totalWords += sample.paragraphs.reduce((sum, paragraph) => sum + countWordsInParagraphHtml(paragraph.html), 0);

      for (const issue of sample.issues) {
        totalIssues += 1;
        const parent = categoryParentOf(issue);
        const parentEntry = parentCounts.get(parent) ?? {
          label: parent,
          count: 0,
          datasets: new Set<string>(),
          cases: new Set<string>()
        };
        parentEntry.count += 1;
        parentEntry.datasets.add(dataset.datasetPath);
        parentEntry.cases.add(`${dataset.datasetPath}::${sample.id}`);
        parentCounts.set(parent, parentEntry);

        const categoryEntry = categoryCounts.get(issue.category) ?? {
          label: issue.category,
          count: 0,
          datasets: new Set<string>(),
          cases: new Set<string>()
        };
        categoryEntry.count += 1;
        categoryEntry.datasets.add(dataset.datasetPath);
        categoryEntry.cases.add(`${dataset.datasetPath}::${sample.id}`);
        categoryCounts.set(issue.category, categoryEntry);
      }
    }
  }

  return {
    parentRollups: sortRollups([...parentCounts.values()]),
    categoryRollups: sortRollups([...categoryCounts.values()]),
    totalCases,
    totalIssues,
    totalWords
  };
}

function renderRollupTable(
  title: string,
  rows: CategoryRollup[],
  totalIssues: number,
  limit: number | null
): string[] {
  const widths = [4, 80, 8, 7, 5];
  const limitedRows = takeLimited(rows, limit);
  const border = buildBorder(widths);
  const lines = [title, border, buildRow(["rank", "label", "count", "share", "ds"], widths), border];

  limitedRows.forEach((row, index) => {
    lines.push(
      buildRow(
        [
          `${index + 1}`,
          row.label,
          `${row.count}`,
          formatPercent(totalIssues === 0 ? 0 : row.count / totalIssues),
          `${row.datasets.size}`
        ],
        widths
      )
    );
  });

  lines.push(border);
  return lines;
}

function renderDatasetTable(rows: DatasetCategorySummary[]): string[] {
  const widths = [28, 5, 6, 7, 8, 7, 7, 52];
  const border = buildBorder(widths);
  const lines = [
    "datasets",
    border,
    buildRow(["dataset", "cases", "issues", "words", "iss/1k", "parents", "cats", "top categories"], widths),
    border
  ];

  rows.forEach((row) => {
    lines.push(
      buildRow(
        [
          row.datasetName,
          `${row.caseCount}`,
          `${row.issueCount}`,
          `${row.wordCount}`,
          formatNullable(row.issuesPerThousandWords, 2),
          `${row.uniqueParents}`,
          `${row.uniqueCategories}`,
          row.topCategories.join(", ")
        ],
        widths
      )
    );
  });

  lines.push(border);
  return lines;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const datasetPaths = await expandDatasetPaths(options.datasetPaths);

  if (datasetPaths.length === 0) {
    throw new Error("Provide at least one dataset path with --dataset");
  }

  const datasets = await Promise.all(
    datasetPaths.map(async (datasetPath) => {
      const [fingerprint, cases] = await Promise.all([
        fingerprintProofreadingDataset(datasetPath),
        loadProofreadingDataset(datasetPath)
      ]);

      const categoryCounts = new Map<string, number>();
      const parentCounts = new Set<string>();
      let issueCount = 0;
      let wordCount = 0;

      for (const sample of cases) {
        wordCount += sample.paragraphs.reduce((sum, paragraph) => sum + countWordsInParagraphHtml(paragraph.html), 0);

        for (const issue of sample.issues) {
          issueCount += 1;
          categoryCounts.set(issue.category, (categoryCounts.get(issue.category) ?? 0) + 1);
          parentCounts.add(categoryParentOf(issue));
        }
      }

      const topCategories = [...categoryCounts.entries()]
        .sort((left, right) => {
          if (right[1] !== left[1]) {
            return right[1] - left[1];
          }

          return left[0].localeCompare(right[0]);
        })
        .slice(0, 4)
        .map(([label, count]) => `${label} (${count})`);

      const issuesPerThousandWords = wordCount === 0 ? null : (issueCount / wordCount) * 1000;

      return {
        datasetPath: fingerprint.datasetPath,
        datasetName: fingerprint.datasetName,
        datasetHash: fingerprint.datasetHash,
        caseCount: cases.length,
        issueCount,
        wordCount,
        issuesPerThousandWords,
        uniqueParents: parentCounts.size,
        uniqueCategories: categoryCounts.size,
        topCategories,
        cases
      };
    })
  );

  const datasetSummaries: DatasetCategorySummary[] = datasets
    .map(({ cases, ...summary }) => summary)
    .sort((left, right) => left.datasetPath.localeCompare(right.datasetPath));
  const rollups = buildRollups(
    datasets.map((dataset) => ({
      datasetPath: dataset.datasetPath,
      datasetName: dataset.datasetName,
      cases: dataset.cases
    }))
  );
  const overallIssuesPerThousandWords = rollups.totalWords === 0 ? null : (rollups.totalIssues / rollups.totalWords) * 1000;

  const lines = [
    `dataset_inputs=${options.datasetPaths.join(",")}`,
    `dataset_files=${datasetPaths.length}`,
    `case_count=${rollups.totalCases}`,
    `issue_count=${rollups.totalIssues}`,
    `word_count=${rollups.totalWords}`,
    `issues_per_1000_words=${formatNullable(overallIssuesPerThousandWords, 2)}`,
    `unique_parent_categories=${rollups.parentRollups.length}`,
    `unique_issue_categories=${rollups.categoryRollups.length}`,
    ""
  ];

  lines.push(...renderRollupTable("parent categories", rollups.parentRollups, rollups.totalIssues, options.limit));
  lines.push("");
  lines.push(...renderRollupTable("issue categories", rollups.categoryRollups, rollups.totalIssues, options.limit));
  lines.push("");
  lines.push(...renderDatasetTable(datasetSummaries));

  console.log(lines.join("\n"));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
