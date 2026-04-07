import path from "node:path";
import readline from "node:readline";

import { getDefaultResultsId } from "./api-config.js";
import { buildResultsPath, readJson } from "./fs.js";
import { buildResultsArtifact } from "./results-artifact.js";
import type { ResultsAggregateRow, ResultsArtifact } from "./types.js";

type CliOptions = {
  artifactPath: string | null;
  groupId: string;
};

type AxisId =
  | "quality"
  | "qualityRange"
  | "averageTurnsPerChunk"
  | "judgeAverageQuality"
  | "stability"
  | "efficiency"
  | "speed"
  | "attemptedInvalid"
  | "notAddressed"
  | "restraint"
  | "cost"
  | "toolCharsPerIssue"
  | "toolCallsPerIssue"
  | "offTargetToolShare"
  | "rewriteShare"
  | "benchmarkToolChars"
  | "offTargetToolChars";

type AxisSpec = {
  id: AxisId;
  label: string;
  format: (value: number | null) => string;
  value: (row: ResultsAggregateRow) => number | null;
  clampMinZero?: boolean;
  clampMaxOne?: boolean;
  fixedRange?: { min: number; max: number; segments: number };
};

const DEFAULT_GROUP_ID = getDefaultResultsId();
const POINT_MARKERS = "123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const REASONING_ORDER = new Map([
  ["none", 0],
  ["minimal", 1],
  ["low", 2],
  ["medium", 3],
  ["high", 4],
  ["xhigh", 5]
]);
const AXES: AxisSpec[] = [
  {
    id: "quality",
    label: "quality",
    format: (value) => formatNumber(value, 3),
    value: (row) => row.qualityAxis,
    clampMinZero: true,
    clampMaxOne: true,
    fixedRange: { min: 0, max: 1, segments: 4 }
  },
  {
    id: "qualityRange",
    label: "quality range (per-dataset mean)",
    format: (value) => formatNumber(value, 3),
    value: (row) => row.meanPerDatasetQualityRange,
    clampMinZero: true
  },
  {
    id: "averageTurnsPerChunk",
    label: "average turns/chunk",
    format: (value) => formatNumber(value, 2),
    value: (row) => row.meanAverageTurnsPerChunk,
    clampMinZero: true
  },
  {
    id: "judgeAverageQuality",
    label: "judge average quality",
    format: (value) => formatNumber(value, 3),
    value: (row) => row.meanJudgeAverageQualityScore,
    clampMinZero: true,
    clampMaxOne: true,
    fixedRange: { min: 0, max: 1, segments: 4 }
  },
  {
    id: "stability",
    label: "stability",
    format: (value) => formatNumber(value, 3),
    value: (row) => row.stabilityAxis,
    clampMinZero: true,
    clampMaxOne: true,
    fixedRange: { min: 0, max: 1, segments: 4 }
  },
  {
    id: "efficiency",
    label: "efficiency (issues/USD)",
    format: (value) => formatNumber(value, 2),
    value: (row) => row.efficiencyAxis,
    clampMinZero: true
  },
  {
    id: "speed",
    label: "speed (issues/min)",
    format: (value) => formatNumber(value, 2),
    value: (row) => row.speedAxis,
    clampMinZero: true
  },
  {
    id: "attemptedInvalid",
    label: "attempted invalid issue rate",
    format: (value) => formatPercent(value, 1),
    value: (row) => row.meanAttemptedButInvalidRate,
    clampMinZero: true,
    clampMaxOne: true,
    fixedRange: { min: 0, max: 1, segments: 4 }
  },
  {
    id: "notAddressed",
    label: "not addressed issue rate",
    format: (value) => formatPercent(value, 1),
    value: (row) => row.meanNotAddressedRate,
    clampMinZero: true,
    clampMaxOne: true,
    fixedRange: { min: 0, max: 1, segments: 4 }
  },
  {
    id: "restraint",
    label: "restraint",
    format: (value) => formatNumber(value, 3),
    value: (row) => row.restraintAxis,
    clampMinZero: true,
    clampMaxOne: true,
    fixedRange: { min: 0, max: 1, segments: 4 }
  },
  {
    id: "cost",
    label: "cost/run (USD)",
    format: (value) => formatUsd(value),
    value: (row) => row.costAxisUsd,
    clampMinZero: true
  },
  {
    id: "toolCharsPerIssue",
    label: "tool/issue (benchmark chars)",
    format: (value) => formatNumber(value, 1),
    value: (row) => row.meanBenchmarkToolCharsPerResolvedIssue,
    clampMinZero: true
  },
  {
    id: "toolCallsPerIssue",
    label: "tool calls/issue (benchmark)",
    format: (value) => formatNumber(value, 2),
    value: (row) => row.meanBenchmarkToolCallsPerResolvedIssue,
    clampMinZero: true
  },
  {
    id: "offTargetToolShare",
    label: "off-target tool share",
    format: (value) => formatNumber(value, 3),
    value: (row) => row.meanOffTargetToolCharsShare,
    clampMinZero: true,
    clampMaxOne: true,
    fixedRange: { min: 0, max: 1, segments: 4 }
  },
  {
    id: "rewriteShare",
    label: "paragraph rewrite share",
    format: (value) => formatNumber(value, 3),
    value: (row) => row.meanBenchmarkParagraphRewriteShare,
    clampMinZero: true,
    clampMaxOne: true,
    fixedRange: { min: 0, max: 1, segments: 4 }
  },
  {
    id: "benchmarkToolChars",
    label: "benchmark tool chars/run",
    format: (value) => formatNumber(value, 0),
    value: (row) => row.meanBenchmarkToolArgumentChars,
    clampMinZero: true
  },
  {
    id: "offTargetToolChars",
    label: "off-target tool chars/run",
    format: (value) => formatNumber(value, 0),
    value: (row) => row.meanOffTargetToolArgumentChars,
    clampMinZero: true
  }
];

function parseArgs(argv: string[]): CliOptions {
  let artifactPath: string | null = null;
  let groupId = DEFAULT_GROUP_ID;

  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--artifact") {
      artifactPath = argv[index + 1] ?? artifactPath;
      index += 1;
      continue;
    }

    if (argv[index] === "--group-id") {
      groupId = argv[index + 1] ?? groupId;
      index += 1;
      continue;
    }

    if (!argv[index].startsWith("-") && artifactPath == null && groupId === DEFAULT_GROUP_ID) {
      groupId = argv[index];
    }
  }

  return { artifactPath, groupId };
}

function formatNumber(value: number | null, digits: number): string {
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

function formatPercent(value: number | null, digits: number): string {
  if (value == null || Number.isNaN(value)) {
    return "n/a";
  }

  return `${(value * 100).toFixed(digits)}%`;
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

function cycleAxis(currentIndex: number, direction: 1 | -1, otherIndex: number): number {
  let nextIndex = currentIndex;

  for (let attempts = 0; attempts < AXES.length; attempts += 1) {
    nextIndex = (nextIndex + direction + AXES.length) % AXES.length;

    if (nextIndex !== otherIndex) {
      return nextIndex;
    }
  }

  return currentIndex;
}

function providerOf(row: ResultsAggregateRow): string {
  const source = row.baseModel || row.model;
  const slashIndex = source.indexOf("/");
  return slashIndex === -1 ? source : source.slice(0, slashIndex);
}

function compareProviderGroupedRows(left: ResultsAggregateRow, right: ResultsAggregateRow): number {
  const leftProvider = providerOf(left);
  const rightProvider = providerOf(right);

  if (leftProvider !== rightProvider) {
    return leftProvider.localeCompare(rightProvider);
  }

  if (left.baseModel !== right.baseModel) {
    return left.baseModel.localeCompare(right.baseModel);
  }

  const leftReasoningRank = REASONING_ORDER.get(left.reasoningEffort ?? "") ?? Number.MAX_SAFE_INTEGER;
  const rightReasoningRank = REASONING_ORDER.get(right.reasoningEffort ?? "") ?? Number.MAX_SAFE_INTEGER;

  if (leftReasoningRank !== rightReasoningRank) {
    return leftReasoningRank - rightReasoningRank;
  }

  return left.model.localeCompare(right.model);
}

type AxisScale = {
  min: number;
  max: number;
  interval: number;
  ticks: number[];
};

function buildTicks(min: number, max: number, interval: number): number[] {
  const ticks: number[] = [];
  const count = Math.max(1, Math.round((max - min) / interval));

  for (let index = 0; index <= count; index += 1) {
    ticks.push(Number((min + interval * index).toPrecision(12)));
  }

  return ticks;
}

function niceStep(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0.25;
  }

  const exponent = Math.floor(Math.log10(value));
  const fraction = value / 10 ** exponent;
  let niceFraction = 1;

  if (fraction <= 1) {
    niceFraction = 1;
  } else if (fraction <= 2) {
    niceFraction = 2;
  } else if (fraction <= 2.5) {
    niceFraction = 2.5;
  } else if (fraction <= 5) {
    niceFraction = 5;
  } else {
    niceFraction = 10;
  }

  return niceFraction * 10 ** exponent;
}

function nextNiceStep(value: number): number {
  return niceStep(value * 1.01);
}

function getAxisScale(rows: ResultsAggregateRow[], axis: AxisSpec): AxisScale {
  if (axis.fixedRange) {
    const interval = (axis.fixedRange.max - axis.fixedRange.min) / axis.fixedRange.segments;
    return {
      min: axis.fixedRange.min,
      max: axis.fixedRange.max,
      interval,
      ticks: buildTicks(axis.fixedRange.min, axis.fixedRange.max, interval)
    };
  }

  const values = rows.map((row) => axis.value(row)).filter((value): value is number => value != null && Number.isFinite(value));

  if (values.length === 0) {
    return { min: 0, max: 1, interval: 0.25, ticks: [0, 0.25, 0.5, 0.75, 1] };
  }

  let min = Math.min(...values);
  let max = Math.max(...values);

  if (min === max) {
    if (axis.clampMinZero && min >= 0) {
      min = 0;
      max = max === 0 ? 1 : max;
    } else {
      const baseStep = niceStep(Math.abs(min) / 4 || 0.25);
      min -= baseStep * 2;
      max += baseStep * 2;
    }
  }

  const rawMin = min;
  const rawMax = max;
  let interval = niceStep((rawMax - rawMin) / 4);

  while (true) {
    min =
      axis.clampMinZero ? Math.max(0, Math.floor(rawMin / interval) * interval) : Math.floor(rawMin / interval) * interval;
    max = min + interval * 4;

    if (max >= rawMax - interval * 1e-9) {
      break;
    }

    interval = nextNiceStep(interval);
  }

  if (axis.clampMinZero) {
    min = Math.max(0, min);
  }

  if (axis.clampMaxOne) {
    max = Math.min(1, max);
  }

  if (max <= min) {
    max = min + interval * 4;
  }

  return { min, max, interval, ticks: buildTicks(min, max, interval) };
}

function markerForIndex(index: number): string {
  return POINT_MARKERS[index] ?? "*";
}

function normalizeCoordinate(value: number, min: number, max: number, size: number): number {
  if (size <= 1 || max <= min) {
    return 0;
  }

  const ratio = (value - min) / (max - min);
  return Math.max(0, Math.min(size - 1, Math.round(ratio * (size - 1))));
}

function buildGrid(width: number, height: number): string[][] {
  const grid = Array.from({ length: height }, () => Array.from({ length: width }, () => " "));
  const verticalGuides = [0.25, 0.5, 0.75].map((ratio) => Math.round((width - 1) * ratio));
  const horizontalGuides = [0.25, 0.5, 0.75].map((ratio) => Math.round((height - 1) * ratio));

  for (const x of verticalGuides) {
    for (let y = 0; y < height; y += 1) {
      grid[y][x] = ".";
    }
  }

  for (const y of horizontalGuides) {
    for (let x = 0; x < width; x += 1) {
      grid[y][x] = grid[y][x] === "." ? "+" : ".";
    }
  }

  return grid;
}

function canPlaceText(grid: string[][], text: string, x: number, y: number): boolean {
  if (y < 0 || y >= grid.length || x < 0 || x + text.length > grid[0].length) {
    return false;
  }

  for (let index = 0; index < text.length; index += 1) {
    const current = grid[y][x + index];

    if (current !== " " && current !== "." && current !== "+") {
      return false;
    }
  }

  return true;
}

function writeText(grid: string[][], text: string, x: number, y: number): void {
  for (let index = 0; index < text.length; index += 1) {
    grid[y][x + index] = text[index];
  }
}

function placeMarkerText(grid: string[][], text: string, anchorX: number, anchorY: number): void {
  const centeredX = Math.max(0, Math.min(grid[0].length - text.length, anchorX - Math.floor((text.length - 1) / 2)));
  const candidates = [
    { x: centeredX, y: anchorY },
    { x: centeredX, y: anchorY - 1 },
    { x: centeredX, y: anchorY + 1 },
    { x: Math.max(0, Math.min(grid[0].length - text.length, anchorX + 1)), y: anchorY },
    { x: Math.max(0, Math.min(grid[0].length - text.length, anchorX - text.length)), y: anchorY },
    { x: centeredX, y: anchorY - 2 },
    { x: centeredX, y: anchorY + 2 }
  ];

  for (const candidate of candidates) {
    if (canPlaceText(grid, text, candidate.x, candidate.y)) {
      writeText(grid, text, candidate.x, candidate.y);
      return;
    }
  }

  writeText(grid, text, centeredX, Math.max(0, Math.min(grid.length - 1, anchorY)));
}

function buildXAxisTickLine(width: number, ticks: number[], axis: AxisSpec, min: number, max: number): string {
  const line = Array.from({ length: width }, () => " ");

  for (const tick of ticks) {
    const label = axis.format(tick);
    const center = normalizeCoordinate(tick, min, max, width);
    const start = Math.max(0, Math.min(width - label.length, center - Math.floor(label.length / 2)));

    for (let index = 0; index < label.length; index += 1) {
      if (line[start + index] === " ") {
        line[start + index] = label[index];
      }
    }
  }

  return line.join("").replace(/\s+$/g, "");
}

function renderScatter(
  rows: ResultsAggregateRow[],
  xAxis: AxisSpec,
  yAxis: AxisSpec,
  width: number,
  height: number
): {
  lines: string[];
  plotted: Array<{ marker: string; row: ResultsAggregateRow; x: number | null; y: number | null }>;
} {
  const plotRows = rows.filter((row) => xAxis.value(row) != null && yAxis.value(row) != null);
  const xScale = getAxisScale(plotRows, xAxis);
  const yScale = getAxisScale(plotRows, yAxis);
  const grid = buildGrid(width, height);
  const plotted = rows.map((row, index) => ({
    marker: markerForIndex(index),
    row,
    x: xAxis.value(row),
    y: yAxis.value(row)
  }));
  const occupied = new Map<string, { x: number; y: number; markers: string[] }>();

  for (const point of plotted) {
    if (point.x == null || point.y == null) {
      continue;
    }

    const x = normalizeCoordinate(point.x, xScale.min, xScale.max, width);
    const y = height - 1 - normalizeCoordinate(point.y, yScale.min, yScale.max, height);
    const key = `${x},${y}`;
    const entry = occupied.get(key);

    if (entry) {
      entry.markers.push(point.marker);
      continue;
    }

    occupied.set(key, { x, y, markers: [point.marker] });
  }

  for (const entry of occupied.values()) {
    placeMarkerText(grid, entry.markers.join(""), entry.x, entry.y);
  }

  const yTickRows = new Map<number, string>();
  for (const tick of yScale.ticks) {
    const rowIndex = height - 1 - normalizeCoordinate(tick, yScale.min, yScale.max, height);
    yTickRows.set(rowIndex, yAxis.format(tick));
  }
  const labelWidth = Math.max(...[...yTickRows.values()].map((label) => label.length), 5);
  const lines: string[] = [];

  lines.push(`${" ".repeat(labelWidth + 3)}y: ${yAxis.label}`);
  lines.push(`${" ".repeat(labelWidth + 1)}+${"-".repeat(width)}+`);

  for (let rowIndex = 0; rowIndex < height; rowIndex += 1) {
    const label = yTickRows.get(rowIndex) ?? "";
    lines.push(`${clip(label, labelWidth)} |${grid[rowIndex].join("")}|`);
  }

  lines.push(`${" ".repeat(labelWidth + 1)}+${"-".repeat(width)}+`);
  const leftPadding = " ".repeat(labelWidth + 2);
  lines.push(`${leftPadding}${buildXAxisTickLine(width, xScale.ticks, xAxis, xScale.min, xScale.max)}`);
  lines.push(`${leftPadding}x: ${xAxis.label}`);

  return { lines, plotted };
}

function buildLegendLines(
  plotted: Array<{ marker: string; row: ResultsAggregateRow; x: number | null; y: number | null }>,
  xAxis: AxisSpec,
  yAxis: AxisSpec,
  width: number,
  maxHeight = 16
): string[] {
  const entries = plotted.map((point) =>
    `${point.marker} ${point.row.model}  x=${xAxis.format(point.x)}  y=${yAxis.format(point.y)}  runs=${point.row.totalRuns}  ds=${point.row.datasetCount}`
  );

  if (entries.length === 0) {
    return ["legend:"];
  }

  const heading = "legend:";
  const rowCount = Math.max(1, maxHeight - 1);
  const columnCount = Math.max(1, Math.ceil(entries.length / rowCount));
  const gutter = "   ";
  const columnWidth = Math.max(
    12,
    Math.floor((width - gutter.length * Math.max(0, columnCount - 1)) / columnCount)
  );
  const lines = [heading];

  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    const cells: string[] = [];

    for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
      const entryIndex = columnIndex * rowCount + rowIndex;

      if (entryIndex >= entries.length) {
        continue;
      }

      cells.push(clip(entries[entryIndex], columnWidth));
    }

    if (cells.length === 0) {
      break;
    }

    lines.push(cells.join(gutter).replace(/\s+$/g, ""));
  }

  return lines;
}

function renderScreen(artifact: ResultsArtifact, xIndex: number, yIndex: number): string {
  const columns = Math.max(100, process.stdout.columns ?? 120);
  const rows = Math.max(30, process.stdout.rows ?? 40);
  const xAxis = AXES[xIndex];
  const yAxis = AXES[yIndex];
  const plotRows = [...artifact.ranking].sort(compareProviderGroupedRows);
  const headerLines = [
    `group: ${artifact.groupId}   datasets: ${artifact.datasets.length}   models: ${artifact.models.length}   attempts: ${artifact.attempts.length}`,
    `x [left/right]: ${xAxis.label}   y [up/down]: ${yAxis.label}`,
    "controls: arrows change axes, tab swaps axes, q quits",
    ""
  ];
  const maxLegendLines = 16;
  const legendReserve = Math.min(maxLegendLines, Math.floor(rows * 0.4));
  const plotHeight = Math.max(20, Math.min(44, rows - headerLines.length - legendReserve - 6));
  const plotWidth = Math.max(80, Math.min(180, columns - 14));
  const scatter = renderScatter(plotRows, xAxis, yAxis, plotWidth, plotHeight);
  const legendLines = buildLegendLines(scatter.plotted, xAxis, yAxis, columns, maxLegendLines);

  return [...headerLines, ...scatter.lines, "", ...legendLines].join("\n");
}

async function runInteractiveViewer(artifact: ResultsArtifact): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("view:scatterplot requires an interactive TTY");
  }

  let xIndex = AXES.findIndex((axis) => axis.id === "cost");
  let yIndex = AXES.findIndex((axis) => axis.id === "quality");

  if (xIndex === -1) {
    xIndex = 0;
  }

  if (yIndex === -1 || yIndex === xIndex) {
    yIndex = xIndex === 0 ? 1 : 0;
  }

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
    process.stdout.write(renderScreen(artifact, xIndex, yIndex));
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
        xIndex = cycleAxis(xIndex, -1, yIndex);
        render();
        return;
      }

      if (key.name === "right") {
        xIndex = cycleAxis(xIndex, 1, yIndex);
        render();
        return;
      }

      if (key.name === "up") {
        yIndex = cycleAxis(yIndex, 1, xIndex);
        render();
        return;
      }

      if (key.name === "down") {
        yIndex = cycleAxis(yIndex, -1, xIndex);
        render();
        return;
      }

      if (key.name === "tab") {
        const nextX = yIndex;
        yIndex = xIndex;
        xIndex = nextX;
        render();
      }
    };

    process.stdin.on("keypress", onKeypress);
  });
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const artifactPath = options.artifactPath != null ? path.resolve(options.artifactPath) : buildResultsPath(options.groupId);
  const rawArtifact = await readJson<ResultsArtifact>(artifactPath);
  const artifact = buildResultsArtifact(rawArtifact.groupId, rawArtifact.attempts, rawArtifact.createdAt);

  await runInteractiveViewer(artifact);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
