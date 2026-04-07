import fs from "node:fs";
import path from "node:path";

type RawRecord = Record<string, unknown>;

export type DisqualifiedIssueRecord = {
  caseId: string;
  issueId: string;
  reason?: string;
};

export type DisqualifiedIssueManifest = {
  version: "v1";
  issues: DisqualifiedIssueRecord[];
};

export const DEFAULT_DISQUALIFIED_ISSUES_PATH = path.resolve("datasets/v1/disqualified-issues.json");

function isObject(value: unknown): value is RawRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeIssueRecord(value: unknown, index: number): DisqualifiedIssueRecord {
  if (!isObject(value)) {
    throw new Error(`disqualified issue ${index + 1} must be an object`);
  }

  if (typeof value.caseId !== "string" || value.caseId.length === 0) {
    throw new Error(`disqualified issue ${index + 1}.caseId must be a non-empty string`);
  }

  if (typeof value.issueId !== "string" || value.issueId.length === 0) {
    throw new Error(`disqualified issue ${index + 1}.issueId must be a non-empty string`);
  }

  if (value.reason != null && typeof value.reason !== "string") {
    throw new Error(`disqualified issue ${index + 1}.reason must be a string when provided`);
  }

  return {
    caseId: value.caseId,
    issueId: value.issueId,
    reason: typeof value.reason === "string" && value.reason.length > 0 ? value.reason : undefined
  };
}

function normalizeManifest(value: unknown): DisqualifiedIssueManifest {
  if (!isObject(value)) {
    throw new Error("disqualified issues manifest must be an object");
  }

  const issues = Array.isArray(value.issues) ? value.issues.map((item, index) => normalizeIssueRecord(item, index)) : [];

  return {
    version: "v1",
    issues: issues.sort((left, right) =>
      left.caseId === right.caseId ? left.issueId.localeCompare(right.issueId) : left.caseId.localeCompare(right.caseId)
    )
  };
}

export function readIssueDisqualificationManifestSync(
  manifestPath = DEFAULT_DISQUALIFIED_ISSUES_PATH
): DisqualifiedIssueManifest {
  if (!fs.existsSync(manifestPath)) {
    return {
      version: "v1",
      issues: []
    };
  }

  const raw = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as unknown;
  return normalizeManifest(raw);
}

export function buildDisqualifiedIssueMap(manifest: DisqualifiedIssueManifest): Map<string, Set<string>> {
  const byCase = new Map<string, Set<string>>();

  for (const issue of manifest.issues) {
    const issueIds = byCase.get(issue.caseId) ?? new Set<string>();
    issueIds.add(issue.issueId);
    byCase.set(issue.caseId, issueIds);
  }

  return byCase;
}

export function getDisqualifiedIssueIdsByCaseSync(
  manifestPath = DEFAULT_DISQUALIFIED_ISSUES_PATH
): Map<string, Set<string>> {
  return buildDisqualifiedIssueMap(readIssueDisqualificationManifestSync(manifestPath));
}

export function getRelevantDisqualifiedIssueRecords(
  caseIds: string[],
  manifestPath = DEFAULT_DISQUALIFIED_ISSUES_PATH
): DisqualifiedIssueRecord[] {
  const caseIdSet = new Set(caseIds);
  return readIssueDisqualificationManifestSync(manifestPath).issues.filter((issue) => caseIdSet.has(issue.caseId));
}

export function filterCaseIssues<T extends { id: string }>(
  caseId: string,
  issues: T[],
  disqualifiedIssueIdsByCase: Map<string, Set<string>>
): T[] {
  const disqualifiedIssueIds = disqualifiedIssueIdsByCase.get(caseId);

  if (!disqualifiedIssueIds || disqualifiedIssueIds.size === 0) {
    return issues;
  }

  return issues.filter((issue) => !disqualifiedIssueIds.has(issue.id));
}

