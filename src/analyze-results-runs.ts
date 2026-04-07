import path from "node:path";

import { getDefaultResultsId } from "./api-config.js";
import { buildResultsPath, readJson } from "./fs.js";
import { parseModelVariantString } from "./model-config.js";
import { buildResultsArtifact } from "./results-artifact.js";
import type { ResultsArtifact, ResultsAttempt } from "./types.js";

type CliOptions = {
  artifactPath: string | null;
  groupId: string;
  datasetPath: string | null;
  model: string | null;
  limit: number | null;
};

const DEFAULT_GROUP_ID = getDefaultResultsId();

function parseArgs(argv: string[]): CliOptions {
  let artifactPath: string | null = null;
  let groupId = DEFAULT_GROUP_ID;
  let datasetPath: string | null = null;
  let model: string | null = null;
  let limit: number | null = null;

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

    if (arg === "--model") {
      model = argv[index + 1] ?? model;
      index += 1;
      continue;
    }

    if (arg === "--limit") {
      const parsed = Number.parseInt(argv[index + 1] ?? "", 10);
      limit = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
      index += 1;
      continue;
    }

    if (!arg.startsWith("-") && artifactPath == null && groupId === DEFAULT_GROUP_ID) {
      groupId = arg;
    }
  }

  return { artifactPath, groupId, datasetPath, model, limit };
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

function formatTurns(value: number | null): string {
  if (value == null || Number.isNaN(value)) {
    return "n/a";
  }

  return value.toFixed(2);
}

function formatFraction(numerator: number | null, denominator: number | null): string {
  if (numerator == null || denominator == null) {
    return "n/a";
  }

  return `${numerator}/${denominator}`;
}

function statusLabel(attempt: ResultsAttempt): string {
  return attempt.succeeded ? "ok" : "fail";
}

function sortAttempts(left: ResultsAttempt, right: ResultsAttempt): number {
  if (left.datasetName !== right.datasetName) {
    return left.datasetName.localeCompare(right.datasetName);
  }

  if (left.model !== right.model) {
    return left.model.localeCompare(right.model);
  }

  if (left.runNumber !== right.runNumber) {
    return left.runNumber - right.runNumber;
  }

  return left.recordedAt.localeCompare(right.recordedAt);
}

function filterAttempts(artifact: ResultsArtifact, options: CliOptions): ResultsAttempt[] {
  return artifact.attempts
    .filter((attempt) => {
      if (options.datasetPath && !matchesDatasetPath(attempt.datasetPath, options.datasetPath)) {
        return false;
      }

      if (options.model && !matchesModel(attempt.baseModel, attempt.model, options.model)) {
        return false;
      }

      return true;
    })
    .sort(sortAttempts);
}

function renderAttemptTable(
  attempts: ResultsAttempt[],
  options: CliOptions,
  datasetName: string,
  datasetPath: string
): string {
  const showModel = options.model == null;
  const rows = attempts.map((attempt) => {
    const values = [
      `${attempt.runNumber}`,
      statusLabel(attempt),
      formatPercent(attempt.qualityAxis),
      formatFraction(attempt.correctedIssues, attempt.totalIssues),
      formatPercent(attempt.attemptedButInvalidRate),
      formatPercent(attempt.notAddressedRate),
      formatTurns(attempt.averageTurnsPerChunk),
      formatUsd(attempt.totalCostUsd),
      attempt.runId ?? "n/a"
    ];

    if (showModel) {
      values.splice(1, 0, attempt.model);
    }

    return values;
  });

  const headers = ["run", "status", "quality", "fix", "badfix", "missed", "turns", "$/run", "run id"];
  const aligns: Array<"left" | "right"> = ["right", "left", "right", "right", "right", "right", "right", "right", "left"];

  if (showModel) {
    headers.splice(1, 0, "model");
    aligns.splice(1, 0, "left");
  }

  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index]?.length ?? 0))
  );

  const lines = [
    `dataset=${datasetName}`,
    `dataset_path=${datasetPath}`,
    buildBorder(widths),
    buildRow(headers, widths, aligns),
    buildBorder(widths)
  ];

  for (const row of rows) {
    lines.push(buildRow(row, widths, aligns));
  }

  lines.push(buildBorder(widths));

  const failedAttempts = attempts.filter((attempt) => !attempt.succeeded);
  if (failedAttempts.length > 0) {
    lines.push("failures:");
    for (const attempt of failedAttempts) {
      lines.push(`- run ${attempt.runNumber}: ${attempt.error ?? "unknown error"}`);
    }
  }

  return lines.join("\n");
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const artifactPath =
    options.artifactPath != null
      ? path.resolve(options.artifactPath)
      : buildResultsPath(options.groupId);

  if (!artifactPath) {
    throw new Error("No results artifact found. Run npm run bench first or pass --artifact.");
  }

  const rawArtifact = await readJson<ResultsArtifact>(artifactPath);
  const artifact = buildResultsArtifact(rawArtifact.groupId, rawArtifact.attempts, rawArtifact.createdAt);
  const matchedAttempts = filterAttempts(artifact, options);

  if (matchedAttempts.length === 0) {
    console.log(`group=${artifact.groupId}`);
    console.log(`results_artifact=${artifactPath}`);
    console.log("matched_attempts=0");
    return;
  }

  const limitedAttempts = options.limit == null ? matchedAttempts : matchedAttempts.slice(0, options.limit);
  const attemptsByDataset = new Map<string, { datasetName: string; datasetPath: string; attempts: ResultsAttempt[] }>();

  for (const attempt of limitedAttempts) {
    const key = `${attempt.datasetName}::${attempt.datasetHash}`;
    const entry = attemptsByDataset.get(key) ?? {
      datasetName: attempt.datasetName,
      datasetPath: attempt.datasetPath,
      attempts: []
    };
    entry.attempts.push(attempt);
    attemptsByDataset.set(key, entry);
  }

  console.log(`group=${artifact.groupId}`);
  console.log(`results_artifact=${artifactPath}`);
  console.log(`matched_attempts=${matchedAttempts.length}`);
  if (options.limit != null && limitedAttempts.length !== matchedAttempts.length) {
    console.log(`shown_attempts=${limitedAttempts.length}`);
  }
  if (options.model) {
    console.log(`model=${options.model}`);
  }
  if (options.datasetPath) {
    console.log(`dataset=${options.datasetPath}`);
  }
  console.log("");

  const sections = [...attemptsByDataset.values()].map((entry) =>
    renderAttemptTable(entry.attempts, options, entry.datasetName, entry.datasetPath)
  );
  console.log(sections.join("\n\n"));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
