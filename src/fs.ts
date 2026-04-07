import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ANCHORED_SEGMENTS = ["artifacts", "datasets", "models"];

export function resolveStoredRepoPath(filePath: string): string {
  const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);

  if (existsSync(absolutePath)) {
    return absolutePath;
  }

  if (!path.isAbsolute(filePath)) {
    return absolutePath;
  }

  for (const segment of REPO_ANCHORED_SEGMENTS) {
    const marker = `${path.sep}${segment}${path.sep}`;
    const markerIndex = absolutePath.indexOf(marker);

    if (markerIndex === -1) {
      continue;
    }

    const suffix = absolutePath.slice(markerIndex + 1);
    const remappedPath = path.join(REPO_ROOT, suffix);

    if (existsSync(remappedPath)) {
      return remappedPath;
    }

    if (suffix.startsWith(`${segment}${path.sep}`)) {
      return remappedPath;
    }
  }

  return absolutePath;
}

export async function readText(filePath: string): Promise<string> {
  return readFile(resolveStoredRepoPath(filePath), "utf8");
}

export async function writeText(filePath: string, value: string): Promise<void> {
  const resolvedPath = resolveStoredRepoPath(filePath);
  await mkdir(path.dirname(resolvedPath), { recursive: true });
  const tempPath = `${resolvedPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await writeFile(tempPath, value, "utf8");
  await rename(tempPath, resolvedPath);
}

export async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeText(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export async function readJson<T>(filePath: string): Promise<T> {
  const contents = await readText(filePath);
  return JSON.parse(contents) as T;
}

export async function getLatestJsonFile(directory: string): Promise<string | null> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();

  if (files.length === 0) {
    return null;
  }

  return path.join(directory, files[files.length - 1]);
}

export function makeRunId(now = new Date()): string {
  return now.toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

export function slugifyArtifactSegment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function buildArtifactBaseName(runId: string, datasetPath: string, model: string): string {
  const datasetName = path.basename(datasetPath, path.extname(datasetPath));
  const datasetSlug = slugifyArtifactSegment(datasetName) || "dataset";
  const modelSlug = slugifyArtifactSegment(model) || "model";
  return `${runId}--${datasetSlug}--${modelSlug}`;
}

export function buildResultsPath(groupId: string): string {
  const groupSlug = slugifyArtifactSegment(groupId) || "default";
  return path.resolve("artifacts/results", `${groupSlug}.json`);
}
