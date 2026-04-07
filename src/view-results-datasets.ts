import path from "node:path";
import readline from "node:readline";

import { getDefaultResultsId } from "./api-config.js";
import { buildResultsPath, readJson } from "./fs.js";
import { buildResultsArtifact } from "./results-artifact.js";
import type { ResultsArtifact, ResultsAttempt, ResultsDatasetSummary } from "./types.js";

type CliOptions = {
  artifactPath: string | null;
  groupId: string;
  datasetPath: string | null;
};

type DatasetModelRow = {
  label: string;
  provider: string;
  totalRuns: number;
  succeededRuns: number;
  failedRuns: number;
  meanQuality: number | null;
  qualityRange: number | null;
  meanBadfixRate: number | null;
  meanMissedRate: number | null;
  meanCostUsd: number | null;
};

type DatasetView = {
  summary: ResultsDatasetSummary;
  rows: DatasetModelRow[];
};

const DEFAULT_GROUP_ID = getDefaultResultsId();

function parseArgs(argv: string[]): CliOptions {
  let artifactPath: string | null = null;
  let groupId = DEFAULT_GROUP_ID;
  let datasetPath: string | null = null;

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

    if (!arg.startsWith("-") && artifactPath == null && groupId === DEFAULT_GROUP_ID) {
      groupId = arg;
    }
  }

  return { artifactPath, groupId, datasetPath };
}

function matchesDatasetPath(candidatePath: string, datasetArg: string): boolean {
  const resolvedArg = path.resolve(datasetArg);
  const argName = path.basename(datasetArg, path.extname(datasetArg));
  const candidateName = path.basename(candidatePath, path.extname(candidatePath));

  return candidatePath === resolvedArg || candidateName === argName;
}

function mean(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function range(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }

  return Math.max(...values) - Math.min(...values);
}

function formatNumber(value: number | null, digits: number): string {
  if (value == null || Number.isNaN(value)) {
    return "n/a";
  }

  return value.toFixed(digits);
}

function formatPercent(value: number | null): string {
  if (value == null || Number.isNaN(value)) {
    return "n/a";
  }

  return `${(value * 100).toFixed(1)}%`;
}

function formatUsd(value: number | null): string {
  if (value == null || Number.isNaN(value)) {
    return "n/a";
  }

  return `$${value.toFixed(4)}`;
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
  return `| ${values.map((value, index) => pad(value, widths[index], aligns?.[index] ?? "left")).join(" | ")} |`;
}

function providerOf(label: string): string {
  const slashIndex = label.indexOf("/");
  return slashIndex === -1 ? label : label.slice(0, slashIndex);
}

function formatModelLabel(attempt: ResultsAttempt): string {
  const chunkLabel = attempt.maxWordsPerChunk == null ? "full" : `${attempt.maxWordsPerChunk}w`;
  const turnsLabel = `${attempt.maxTurnsPerChunk ?? 3}t`;
  return `${attempt.model} @${chunkLabel}/${turnsLabel}`;
}

function compareDatasetRows(left: DatasetModelRow, right: DatasetModelRow): number {
  const leftQuality = left.meanQuality ?? Number.NEGATIVE_INFINITY;
  const rightQuality = right.meanQuality ?? Number.NEGATIVE_INFINITY;

  if (leftQuality !== rightQuality) {
    return rightQuality - leftQuality;
  }

  if (left.succeededRuns !== right.succeededRuns) {
    return right.succeededRuns - left.succeededRuns;
  }

  const leftCost = left.meanCostUsd ?? Number.POSITIVE_INFINITY;
  const rightCost = right.meanCostUsd ?? Number.POSITIVE_INFINITY;

  if (leftCost !== rightCost) {
    return leftCost - rightCost;
  }

  return left.label.localeCompare(right.label);
}

function buildDatasetViews(artifact: ResultsArtifact): DatasetView[] {
  return artifact.datasets.map((summary) => {
    const attempts = artifact.attempts.filter(
      (attempt) =>
        attempt.datasetPath === summary.datasetPath &&
        attempt.datasetHash === summary.datasetHash
    );
    const grouped = new Map<string, ResultsAttempt[]>();

    for (const attempt of attempts) {
      const label = formatModelLabel(attempt);
      const group = grouped.get(label) ?? [];
      group.push(attempt);
      grouped.set(label, group);
    }

    const rows = [...grouped.entries()]
      .map(([label, groupedAttempts]) => {
        const successful = groupedAttempts.filter((attempt) => attempt.succeeded);
        const qualityValues = successful
          .map((attempt) => attempt.qualityAxis)
          .filter((value): value is number => value != null && !Number.isNaN(value));
        const badfixRates = successful
          .map((attempt) => attempt.attemptedButInvalidRate)
          .filter((value): value is number => value != null && !Number.isNaN(value));
        const missedRates = successful
          .map((attempt) => attempt.notAddressedRate)
          .filter((value): value is number => value != null && !Number.isNaN(value));
        const costValues = successful
          .map((attempt) => attempt.totalCostUsd)
          .filter((value): value is number => value != null && !Number.isNaN(value));

        return {
          label,
          provider: providerOf(groupedAttempts[0].baseModel),
          totalRuns: groupedAttempts.length,
          succeededRuns: successful.length,
          failedRuns: groupedAttempts.length - successful.length,
          meanQuality: mean(qualityValues),
          qualityRange: range(qualityValues),
          meanBadfixRate: mean(badfixRates),
          meanMissedRate: mean(missedRates),
          meanCostUsd: mean(costValues)
        } satisfies DatasetModelRow;
      })
      .sort(compareDatasetRows);

    return { summary, rows };
  });
}

function renderDatasetTable(
  datasetView: DatasetView,
  selectedRow: number,
  terminalWidth: number,
  terminalHeight: number
): string[] {
  const widths = [4, 40, 7, 8, 7, 8, 8, 10];
  const aligns: Array<"left" | "right"> = ["right", "left", "right", "right", "right", "right", "right", "right"];
  const tableLines: string[] = [];
  const availableRows = Math.max(5, terminalHeight - 11);
  const clampedSelectedRow = Math.max(0, Math.min(selectedRow, Math.max(0, datasetView.rows.length - 1)));
  const windowStart = Math.max(
    0,
    Math.min(clampedSelectedRow - Math.floor(availableRows / 2), Math.max(0, datasetView.rows.length - availableRows))
  );
  const windowedRows = datasetView.rows.slice(windowStart, windowStart + availableRows);

  tableLines.push(buildBorder(widths));
  tableLines.push(
    buildRow(["rank", "model", "ok", "quality", "q.rng", "badfix", "missed", "cost/run"], widths, aligns)
  );
  tableLines.push(buildBorder(widths));

  windowedRows.forEach((row, offset) => {
    const absoluteIndex = windowStart + offset;
    const rank = absoluteIndex === clampedSelectedRow ? `>${absoluteIndex + 1}` : `${absoluteIndex + 1}`;
    tableLines.push(
      buildRow(
        [
          rank,
          row.label,
          `${row.succeededRuns}/${row.totalRuns}`,
          formatNumber(row.meanQuality, 3),
          formatNumber(row.qualityRange, 3),
          formatPercent(row.meanBadfixRate),
          formatPercent(row.meanMissedRate),
          formatUsd(row.meanCostUsd)
        ],
        widths,
        aligns
      )
    );
  });

  tableLines.push(buildBorder(widths));
  tableLines.push(
    clip(
      `rows ${windowStart + 1}-${Math.min(windowStart + windowedRows.length, datasetView.rows.length)}/${datasetView.rows.length}  selected=${clampedSelectedRow + 1}`,
      terminalWidth
    )
  );

  return tableLines.map((line) => clip(line, terminalWidth));
}

function renderDatasetScreen(
  artifact: ResultsArtifact,
  datasetViews: DatasetView[],
  datasetIndex: number,
  selectedRow: number
): string[] {
  const terminalWidth = Math.max(120, process.stdout.columns ?? 160);
  const terminalHeight = Math.max(24, process.stdout.rows ?? 40);
  const view = datasetViews[datasetIndex];
  const lines: string[] = [];

  lines.push(
    clip(
      `group: ${artifact.groupId}  dataset: ${datasetIndex + 1}/${datasetViews.length}  models: ${view.rows.length}  attempts: ${view.summary.attemptCount}`,
      terminalWidth
    )
  );
  lines.push(
    clip(
      `${view.summary.datasetName}  hash:${view.summary.datasetHash.slice(0, 8)}  ok:${view.summary.succeededAttempts}/${view.summary.attemptCount}  fail:${view.summary.failedAttempts}`,
      terminalWidth
    )
  );
  lines.push(clip(view.summary.datasetPath, terminalWidth));
  lines.push("controls: left/right change dataset, up/down move rows, q quits");
  lines.push("");
  lines.push(...renderDatasetTable(view, selectedRow, terminalWidth, terminalHeight));

  return lines;
}

function renderPlainText(artifact: ResultsArtifact, datasetViews: DatasetView[]): void {
  const terminalWidth = Math.max(120, process.stdout.columns ?? 160);
  const terminalHeight = 10_000;

  datasetViews.forEach((view, index) => {
    if (index > 0) {
      console.log("");
    }

    for (const line of renderDatasetScreen(artifact, datasetViews, index, 0)) {
      console.log(clip(line, terminalWidth));
    }

    const extraRows = view.rows.length - Math.max(5, terminalHeight - 11);
    if (extraRows > 0) {
      console.log(`... ${extraRows} more rows`);
    }
  });
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const artifactPath = options.artifactPath
    ? path.resolve(options.artifactPath)
    : buildResultsPath(options.groupId);
  const rawArtifact = await readJson<ResultsArtifact>(artifactPath);
  const artifact = buildResultsArtifact(rawArtifact.groupId, rawArtifact.attempts, rawArtifact.createdAt);
  let datasetViews = buildDatasetViews(artifact);

  if (options.datasetPath) {
    datasetViews = datasetViews.filter((view) => matchesDatasetPath(view.summary.datasetPath, options.datasetPath as string));
  }

  if (datasetViews.length === 0) {
    throw new Error("No datasets matched the requested result group/filter");
  }

  if (!process.stdout.isTTY) {
    renderPlainText(artifact, datasetViews);
    return;
  }

  let datasetIndex = 0;
  let selectedRow = 0;
  let renderedLineCount = 0;

  const render = (): void => {
    const lines = renderDatasetScreen(artifact, datasetViews, datasetIndex, selectedRow);

    if (renderedLineCount > 0) {
      process.stdout.write(`\u001b[${renderedLineCount}A\r`);
    }

    for (const line of lines) {
      process.stdout.write("\u001b[2K");
      process.stdout.write(line);
      process.stdout.write("\n");
    }

    renderedLineCount = lines.length;
  };

  readline.emitKeypressEvents(process.stdin);

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }

  const cleanup = (): void => {
    process.stdout.write("\n");

    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }

    process.stdin.off("keypress", onKeypress);
  };

  const onKeypress = (_str: string, key: readline.Key): void => {
    if (key.name === "q" || (key.ctrl && key.name === "c")) {
      cleanup();
      process.exit(0);
    }

    if (key.name === "left") {
      datasetIndex = (datasetIndex - 1 + datasetViews.length) % datasetViews.length;
      selectedRow = 0;
      render();
      return;
    }

    if (key.name === "right") {
      datasetIndex = (datasetIndex + 1) % datasetViews.length;
      selectedRow = 0;
      render();
      return;
    }

    if (key.name === "up") {
      selectedRow = Math.max(0, selectedRow - 1);
      render();
      return;
    }

    if (key.name === "down") {
      selectedRow = Math.min(datasetViews[datasetIndex].rows.length - 1, selectedRow + 1);
      render();
    }
  };

  process.stdin.on("keypress", onKeypress);
  render();
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
