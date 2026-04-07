import { createHash } from "node:crypto";
import path from "node:path";

import { readText } from "./fs.js";
import { filterCaseIssues, getRelevantDisqualifiedIssueRecords, getDisqualifiedIssueIdsByCaseSync } from "./issue-disqualifications.js";
import { normalizeProofreadingText } from "./normalization.js";
import type { IssueClassification, Paragraph, ProofreadingCase, ProofreadingIssue } from "./types.js";

export type ProofreadingDatasetFingerprint = {
  datasetPath: string;
  datasetName: string;
  datasetHash: string;
  sourcePaths: string[];
};

type RawRecord = Record<string, unknown>;
type SourceFormat = "txt" | "html";

type RawExpectedCorrection = {
  find: string;
  replace: string;
};

type RawIssueInput = {
  id: string;
  category: string;
  description: string;
  expectedCorrection: RawExpectedCorrection;
  classification?: IssueClassification;
  paragraphId?: string;
};

type RawCaseInput = {
  id: string;
  instruction: string;
  sourcePath: string;
  issues: RawIssueInput[];
};

type ResolvedCorrection = {
  find: string;
  replace: string;
};

function isObject(value: unknown): value is RawRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertClassification(value: unknown, label: string): asserts value is IssueClassification {
  if (!isObject(value)) {
    throw new Error(`${label} must be an object`);
  }

  if (typeof value.label !== "string" || value.label.length === 0) {
    throw new Error(`${label}.label must be a non-empty string`);
  }

  if (typeof value.parent !== "string" || value.parent.length === 0) {
    throw new Error(`${label}.parent must be a non-empty string`);
  }

  if (typeof value.child !== "string" || value.child.length === 0) {
    throw new Error(`${label}.child must be a non-empty string`);
  }

  if (value.severity !== "minor" && value.severity !== "major") {
    throw new Error(`${label}.severity must be "minor" or "major"`);
  }

  if (!["character", "token", "phrase", "clause", "sentence", "discourse"].includes(String(value.editScope))) {
    throw new Error(`${label}.editScope is invalid`);
  }

  if (
    !["substitution", "omission", "insertion", "transposition", "duplication", "agreement_mismatch", "boundary_error"].includes(
      String(value.operationType)
    )
  ) {
    throw new Error(`${label}.operationType is invalid`);
  }

  if (value.createsValidWord != null && typeof value.createsValidWord !== "boolean") {
    throw new Error(`${label}.createsValidWord must be boolean or null`);
  }

  if (!["orthographic", "lexical", "grammatical", "punctuation", "semantic", "stylistic"].includes(String(value.dimension))) {
    throw new Error(`${label}.dimension is invalid`);
  }
}

function assertParagraph(value: unknown, label: string): asserts value is Paragraph {
  if (!isObject(value)) {
    throw new Error(`${label} must be an object`);
  }

  if (typeof value.id !== "string" || value.id.length === 0) {
    throw new Error(`${label}.id must be a non-empty string`);
  }

  if (typeof value.html !== "string" || value.html.length === 0) {
    throw new Error(`${label}.html must be a non-empty string`);
  }

  const trimmed = value.html.trim();
  const match = trimmed.match(/^<p\s+id="([^"]+)">[\s\S]*<\/p>$/);

  if (!match) {
    throw new Error(`${label}.html must be a single <p id="...">...</p> block`);
  }

  if (match[1] !== value.id) {
    throw new Error(`${label}.html id "${match[1]}" does not match paragraph id "${value.id}"`);
  }
}

function assertIssue(value: unknown, label: string): asserts value is ProofreadingIssue {
  if (!isObject(value)) {
    throw new Error(`${label} must be an object`);
  }

  if (typeof value.id !== "string" || value.id.length === 0) {
    throw new Error(`${label}.id must be a non-empty string`);
  }

  if (typeof value.category !== "string" || value.category.length === 0) {
    throw new Error(`${label}.category must be a non-empty string`);
  }

  if (typeof value.paragraphId !== "string" || value.paragraphId.length === 0) {
    throw new Error(`${label}.paragraphId must be a non-empty string`);
  }

  if (typeof value.description !== "string" || value.description.length === 0) {
    throw new Error(`${label}.description must be a non-empty string`);
  }

  if (value.classification != null) {
    assertClassification(value.classification, `${label}.classification`);
  }

  if (!isObject(value.expectedCorrection)) {
    throw new Error(`${label}.expectedCorrection must be an object`);
  }

  if (typeof value.expectedCorrection.find !== "string" || value.expectedCorrection.find.length === 0) {
    throw new Error(`${label}.expectedCorrection.find must be a non-empty string`);
  }

  if (typeof value.expectedCorrection.replace !== "string") {
    throw new Error(`${label}.expectedCorrection.replace must be a string`);
  }
}

function assertRawIssue(value: unknown, label: string): asserts value is RawIssueInput {
  if (!isObject(value)) {
    throw new Error(`${label} must be an object`);
  }

  if (typeof value.id !== "string" || value.id.length === 0) {
    throw new Error(`${label}.id must be a non-empty string`);
  }

  if (typeof value.category !== "string" || value.category.length === 0) {
    throw new Error(`${label}.category must be a non-empty string`);
  }

  if (typeof value.description !== "string" || value.description.length === 0) {
    throw new Error(`${label}.description must be a non-empty string`);
  }

  if (value.paragraphId != null && (typeof value.paragraphId !== "string" || value.paragraphId.length === 0)) {
    throw new Error(`${label}.paragraphId must be a non-empty string when provided`);
  }

  if (value.classification != null) {
    assertClassification(value.classification, `${label}.classification`);
  }

  if (!isObject(value.expectedCorrection)) {
    throw new Error(`${label}.expectedCorrection must be an object`);
  }

  if (typeof value.expectedCorrection.find !== "string" || value.expectedCorrection.find.length === 0) {
    throw new Error(`${label}.expectedCorrection.find must be a non-empty string`);
  }

  if (typeof value.expectedCorrection.replace !== "string") {
    throw new Error(`${label}.expectedCorrection.replace must be a string`);
  }
}

function assertRawCase(value: unknown, index: number): asserts value is RawCaseInput {
  const label = `Dataset item ${index + 1}`;

  if (!isObject(value)) {
    throw new Error(`${label} must be an object`);
  }

  if (typeof value.id !== "string" || value.id.length === 0) {
    throw new Error(`${label}.id must be a non-empty string`);
  }

  if (typeof value.instruction !== "string" || value.instruction.length === 0) {
    throw new Error(`${label}.instruction must be a non-empty string`);
  }

  if (typeof value.sourcePath !== "string" || value.sourcePath.length === 0) {
    throw new Error(`${label}.sourcePath must be a non-empty string`);
  }

  if (!Array.isArray(value.issues)) {
    throw new Error(`${label}.issues must be an array`);
  }

  value.issues.forEach((issue, issueIndex) => assertRawIssue(issue, `${label}.issues[${issueIndex}]`));
}

function assertUniqueParagraphIds(paragraphs: Paragraph[], label: string): void {
  const ids = new Set<string>();

  for (const paragraph of paragraphs) {
    if (ids.has(paragraph.id)) {
      throw new Error(`${label} contains duplicate paragraph id "${paragraph.id}"`);
    }

    ids.add(paragraph.id);
  }
}

function assertCase(value: unknown, index: number): asserts value is ProofreadingCase {
  const label = `Dataset item ${index + 1}`;

  if (!isObject(value)) {
    throw new Error(`${label} must be an object`);
  }

  if (typeof value.id !== "string" || value.id.length === 0) {
    throw new Error(`${label}.id must be a non-empty string`);
  }

  if (typeof value.instruction !== "string" || value.instruction.length === 0) {
    throw new Error(`${label}.instruction must be a non-empty string`);
  }

  if (!Array.isArray(value.paragraphs) || value.paragraphs.length === 0) {
    throw new Error(`${label}.paragraphs must be a non-empty array`);
  }

  if (!Array.isArray(value.expectedParagraphs) || value.expectedParagraphs.length === 0) {
    throw new Error(`${label}.expectedParagraphs must be a non-empty array`);
  }

  if (!Array.isArray(value.issues)) {
    throw new Error(`${label}.issues must be an array`);
  }

  value.paragraphs.forEach((paragraph, paragraphIndex) =>
    assertParagraph(paragraph, `${label}.paragraphs[${paragraphIndex}]`)
  );
  value.expectedParagraphs.forEach((paragraph, paragraphIndex) =>
    assertParagraph(paragraph, `${label}.expectedParagraphs[${paragraphIndex}]`)
  );
  value.issues.forEach((issue, issueIndex) => assertIssue(issue, `${label}.issues[${issueIndex}]`));

  assertUniqueParagraphIds(value.paragraphs, `${label}.paragraphs`);
  assertUniqueParagraphIds(value.expectedParagraphs, `${label}.expectedParagraphs`);

  const paragraphIds = new Set(value.paragraphs.map((paragraph) => paragraph.id));
  const expectedParagraphIds = new Set(value.expectedParagraphs.map((paragraph) => paragraph.id));

  if (paragraphIds.size !== expectedParagraphIds.size) {
    throw new Error(`${label} must keep the same number of paragraphs between input and expected output`);
  }

  for (const paragraphId of paragraphIds) {
    if (!expectedParagraphIds.has(paragraphId)) {
      throw new Error(`${label}.expectedParagraphs is missing paragraph id "${paragraphId}"`);
    }
  }

  for (const issue of value.issues) {
    if (!paragraphIds.has(issue.paragraphId)) {
      throw new Error(`${label}.issues references missing paragraph id "${issue.paragraphId}"`);
    }
  }
}

function escapeHtmlText(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function normalizePlainTextBlock(block: string): string {
  return normalizeProofreadingText(
    block
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(" ")
    .trim()
  );
}

function normalizeHtmlInnerContent(innerHtml: string): string {
  return normalizeProofreadingText(innerHtml.replace(/\r\n?/g, "\n").trim());
}

function splitPlainTextIntoParagraphs(sourceText: string): string[] {
  const blocks = sourceText
    .trim()
    .split(/\n\s*\n/)
    .map((block) => normalizePlainTextBlock(block))
    .filter((block) => block.length > 0);

  if (blocks.length === 0) {
    throw new Error("sourcePath must contain at least one paragraph");
  }

  return blocks;
}

function splitHtmlIntoParagraphs(sourceHtml: string): string[] {
  const matches = [...sourceHtml.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map((match) =>
    normalizeHtmlInnerContent(match[1] ?? "")
  );

  if (matches.length === 0) {
    throw new Error("HTML sourcePath must contain at least one <p>...</p> block");
  }

  return matches;
}

function encodeBase62(value: bigint, length: number): string {
  const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  let encoded = "";
  let remaining = value;

  for (let index = 0; index < length; index += 1) {
    encoded = alphabet[Number(remaining % 62n)] + encoded;
    remaining /= 62n;
  }

  return encoded;
}

function createDeterministicParagraphId(index: number, innerHtml: string, usedIds: Set<string>): string {
  let salt = 0;

  while (true) {
    const digest = createHash("sha1")
      .update(`paragraph:${index}:${salt}:${innerHtml}`)
      .digest();
    let numeric = 0n;

    for (let byteIndex = 0; byteIndex < 8; byteIndex += 1) {
      numeric = (numeric << 8n) | BigInt(digest[byteIndex] ?? 0);
    }

    const id = encodeBase62(numeric, 6);

    if (!usedIds.has(id)) {
      usedIds.add(id);
      return id;
    }

    salt += 1;
  }
}

function buildParagraphHtml(id: string, innerHtml: string): string {
  return `<p id="${id}">${innerHtml}</p>`;
}

function extractParagraphInnerHtml(paragraphHtml: string): string {
  const match = paragraphHtml.trim().match(/^<p\s+id="[^"]+">([\s\S]*)<\/p>$/);

  if (!match) {
    throw new Error(`Invalid paragraph HTML: ${paragraphHtml}`);
  }

  return match[1] ?? "";
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) {
    return 0;
  }

  return haystack.split(needle).length - 1;
}

function uniqueValues(values: string[]): string[] {
  return [...new Set(values)];
}

function buildCorrectionCandidates(sourceFormat: SourceFormat, correction: RawExpectedCorrection): ResolvedCorrection[] {
  const normalizedFind = normalizeProofreadingText(correction.find);
  const normalizedReplace = normalizeProofreadingText(correction.replace);

  if (sourceFormat === "txt") {
    return [
      {
        find: escapeHtmlText(normalizedFind),
        replace: escapeHtmlText(normalizedReplace)
      }
    ];
  }

  return uniqueValues([normalizedFind, escapeHtmlText(normalizedFind)]).map((find) => ({
    find,
    replace: find === normalizedFind ? normalizedReplace : escapeHtmlText(normalizedReplace)
  }));
}

function buildParagraphsFromSource(sourceText: string, sourceFormat: SourceFormat): Paragraph[] {
  const rawParagraphs =
    sourceFormat === "txt" ? splitPlainTextIntoParagraphs(sourceText) : splitHtmlIntoParagraphs(sourceText);
  const usedIds = new Set<string>();

  return rawParagraphs.map((rawParagraph, index) => {
    const innerHtml = sourceFormat === "txt" ? escapeHtmlText(rawParagraph) : normalizeHtmlInnerContent(rawParagraph);
    const id = createDeterministicParagraphId(index, innerHtml, usedIds);
    return {
      id,
      html: buildParagraphHtml(id, innerHtml)
    };
  });
}

function resolveIssue(
  issue: RawIssueInput,
  paragraphs: Paragraph[],
  sourceFormat: SourceFormat,
  label: string
): ProofreadingIssue {
  const candidates = buildCorrectionCandidates(sourceFormat, issue.expectedCorrection);
  const paragraphsToSearch =
    issue.paragraphId == null ? paragraphs : paragraphs.filter((paragraph) => paragraph.id === issue.paragraphId);

  if (issue.paragraphId != null && paragraphsToSearch.length === 0) {
    throw new Error(`${label}.paragraphId references missing paragraph id "${issue.paragraphId}"`);
  }

  const matches: Array<{ paragraphId: string; correction: ResolvedCorrection; occurrences: number }> = [];

  for (const paragraph of paragraphsToSearch) {
    const innerHtml = extractParagraphInnerHtml(paragraph.html);

    for (const correction of candidates) {
      const occurrences = countOccurrences(innerHtml, correction.find);

      if (occurrences > 0) {
        matches.push({
          paragraphId: paragraph.id,
          correction,
          occurrences
        });
      }
    }
  }

  const totalOccurrences = matches.reduce((sum, match) => sum + match.occurrences, 0);

  if (totalOccurrences === 0) {
    throw new Error(
      `${label} could not find "${issue.expectedCorrection.find}" in the normalized source paragraphs`
    );
  }

  if (totalOccurrences !== 1 || matches.length !== 1) {
    throw new Error(
      `${label} must anchor to exactly one occurrence in the source, but "${issue.expectedCorrection.find}" matched ${totalOccurrences} occurrence(s)`
    );
  }

  return {
    id: issue.id,
    category: issue.category,
    paragraphId: matches[0].paragraphId,
    description: issue.description,
    classification: issue.classification,
    expectedCorrection: matches[0].correction
  };
}

function buildExpectedParagraphs(paragraphs: Paragraph[], issues: ProofreadingIssue[], label: string): Paragraph[] {
  const expectedParagraphs = paragraphs.map((paragraph) => ({ ...paragraph }));

  for (const issue of issues) {
    const paragraphIndex = expectedParagraphs.findIndex((paragraph) => paragraph.id === issue.paragraphId);

    if (paragraphIndex === -1) {
      throw new Error(`${label}.issues references missing paragraph id "${issue.paragraphId}"`);
    }

    const currentParagraph = expectedParagraphs[paragraphIndex];
    const innerHtml = extractParagraphInnerHtml(currentParagraph.html);
    const occurrences = countOccurrences(innerHtml, issue.expectedCorrection.find);

    if (occurrences !== 1) {
      throw new Error(
        `${label}.issues[${issue.id}] expected "${issue.expectedCorrection.find}" to appear exactly once in paragraph "${issue.paragraphId}" during expected output generation, but found ${occurrences}`
      );
    }

    const updatedInnerHtml = innerHtml.replace(issue.expectedCorrection.find, issue.expectedCorrection.replace);
    expectedParagraphs[paragraphIndex] = {
      id: currentParagraph.id,
      html: buildParagraphHtml(currentParagraph.id, updatedInnerHtml)
    };
  }

  return expectedParagraphs;
}

async function expandRawCase(item: RawCaseInput, datasetPath: string, index: number): Promise<ProofreadingCase> {
  const label = `Dataset item ${index + 1}`;
  const sourcePath = path.resolve(path.dirname(datasetPath), item.sourcePath);
  const extension = path.extname(sourcePath).toLowerCase();
  let sourceFormat: SourceFormat;

  if (extension === ".txt") {
    sourceFormat = "txt";
  } else if (extension === ".html" || extension === ".htm") {
    sourceFormat = "html";
  } else {
    throw new Error(`${label}.sourcePath must point to a .txt or .html file`);
  }

  const sourceText = await readText(sourcePath);
  const paragraphs = buildParagraphsFromSource(sourceText, sourceFormat);
  const issues = item.issues.map((issue, issueIndex) =>
    resolveIssue(issue, paragraphs, sourceFormat, `${label}.issues[${issueIndex}]`)
  );
  const expectedParagraphs = buildExpectedParagraphs(paragraphs, issues, label);

  return {
    id: item.id,
    instruction: item.instruction,
    paragraphs,
    expectedParagraphs,
    issues
  };
}

function parseDataset(contents: string, extension: string): unknown[] {
  if (extension === ".json") {
    const parsed = JSON.parse(contents) as unknown;

    if (Array.isArray(parsed)) {
      return parsed;
    }

    if (isObject(parsed)) {
      return [parsed];
    }

    throw new Error("JSON dataset must contain either one case object or an array of case objects");
  }

  if (extension === ".jsonl") {
    return contents
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as unknown);
  }

  throw new Error(`Unsupported dataset extension "${extension}". Use .json or .jsonl.`);
}

export async function loadProofreadingDataset(datasetPath: string): Promise<ProofreadingCase[]> {
  const absolutePath = path.resolve(datasetPath);
  const contents = await readText(absolutePath);
  const extension = path.extname(absolutePath).toLowerCase();
  const parsed = parseDataset(contents, extension);
  const disqualifiedIssueIdsByCase = getDisqualifiedIssueIdsByCaseSync();

  parsed.forEach((item, index) => assertRawCase(item, index));

  const filtered = parsed.map((item) => {
    const rawCase = item as RawCaseInput;
    return {
      ...rawCase,
      issues: filterCaseIssues(rawCase.id, rawCase.issues, disqualifiedIssueIdsByCase)
    };
  });

  const expanded = await Promise.all(filtered.map((item, index) => expandRawCase(item as RawCaseInput, absolutePath, index)));
  expanded.forEach((item, index) => assertCase(item, index));

  return expanded;
}

export async function fingerprintProofreadingDataset(datasetPath: string): Promise<ProofreadingDatasetFingerprint> {
  const absolutePath = path.resolve(datasetPath);
  const contents = await readText(absolutePath);
  const extension = path.extname(absolutePath).toLowerCase();
  const parsed = parseDataset(contents, extension);

  parsed.forEach((item, index) => assertRawCase(item, index));

  const sourcePaths = [...new Set(
    parsed
      .map((item) => path.resolve(path.dirname(absolutePath), (item as RawCaseInput).sourcePath))
      .sort((left, right) => left.localeCompare(right))
  )];

  const hash = createHash("sha256");
  hash.update("dataset-json\n");
  hash.update(absolutePath);
  hash.update("\n");
  hash.update(contents);

  for (const sourcePath of sourcePaths) {
    hash.update("\nsource-file\n");
    hash.update(sourcePath);
    hash.update("\n");
    hash.update(await readText(sourcePath));
  }

  const disqualifiedIssues = getRelevantDisqualifiedIssueRecords(
    parsed.map((item) => (item as RawCaseInput).id)
  );

  if (disqualifiedIssues.length > 0) {
    hash.update("\ndisqualified-issues\n");
    hash.update(JSON.stringify(disqualifiedIssues));
  }

  return {
    datasetPath: absolutePath,
    datasetName: path.basename(absolutePath, path.extname(absolutePath)),
    datasetHash: hash.digest("hex"),
    sourcePaths
  };
}
