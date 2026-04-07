import { createHash } from "node:crypto";
import path from "node:path";

import { readText } from "./fs.js";
import { parseModelVariantString, withDefaultReasoningEffort } from "./model-config.js";
import { normalizeProofreadingText } from "./normalization.js";
import { requestChatCompletion, type OpenRouterToolDefinition } from "./openrouter.js";
import {
  TAXONOMY_PARENTS,
  buildClassificationLabel,
  isTaxonomyParent,
  parseTaxonomyClasses,
  TAXONOMY_DOCUMENT_PATH,
  type TaxonomyClass,
  type TaxonomyParent
} from "./taxonomy.js";
import type { IssueClassification } from "./types.js";

type ProposedIssue = {
  description: string;
  originalText: string;
  corruptedText: string;
  classification: IssueClassification;
};

type ValidatedIssue = ProposedIssue & {
  start: number;
  end: number;
  paragraphIndex: number;
  category: string;
  issueId: string;
  targetLabel: string;
  targetDescription: string;
};

type ParagraphSpan = {
  paragraphIndex: number;
  start: number;
  end: number;
};

type ChunkWindow = {
  id: string;
  paragraphIndices: number[];
  displayText: string;
  wordCount: number;
};

export type CorruptionProgressUpdate = {
  phase: "starting" | "requesting" | "reviewing" | "accepted" | "rejected" | "done";
  acceptedIssues: number;
  targetIssueCount: number;
  attemptedIssues: number;
  targetLabel: string;
  chunkId: string | null;
  message: string | null;
};

export type GeneratedIssueRecord = {
  id: string;
  category: string;
  paragraphId: string;
  description: string;
  classification: IssueClassification;
  expectedCorrection: {
    find: string;
    replace: string;
  };
};

export type GeneratedCaseDefinition = {
  id: string;
  instruction: string;
  sourcePath: string;
  issues: GeneratedIssueRecord[];
};

export type GeneratedCaseResult = {
  corruptedText: string;
  caseDefinition: GeneratedCaseDefinition;
  selectedMutations: Array<{
    issueId: string;
    category: string;
    description: string;
    classification: IssueClassification;
    originalText: string;
    corruptedText: string;
    paragraphIndex: number;
  }>;
};

export type GenerateCorruptedCaseOptions = {
  caseId: string;
  instruction: string;
  seed: string;
  issueCount?: number | null;
  issuesPerThousandWords: number;
  model: string;
  reviewModel?: string | null;
  reviewMinConfidence?: "high" | "medium" | "low";
  requestTimeoutMs?: number | null;
  verbose?: boolean;
  requiredParents?: TaxonomyParent[];
  maxRetries?: number;
  maxCompletionTokens?: number;
  maxWordsPerChunk?: number;
  concurrency?: number;
  onProgress?: ((update: CorruptionProgressUpdate) => void) | null;
  issueOptionsPerAttempt?: number;
  balanceCategoryCounts?: Record<string, number>;
  excludedBalanceCategoryLabels?: string[];
  maxBalancedCategoryCount?: number | null;
  singleTargetClassPerChunk?: boolean;
  targetCategoryLabel?: string | null;
  targetCategoryLabels?: string[];
};

type GenerationTargetingMode = "choice" | "fixed";

const SUBMIT_ISSUES_TOOL_NAME = "submit_issues";
const REVIEW_ISSUES_TOOL_NAME = "review_issues";
const CORRUPTION_GENERATION_TEMPERATURE = 1;

const SUBMIT_ISSUES_TOOL: OpenRouterToolDefinition = {
  type: "function",
  function: {
    name: SUBMIT_ISSUES_TOOL_NAME,
    description:
      "Submit a corruption plan for the provided text chunk. Each issue must describe one exact local source substring and one corrupted replacement substring.",
    parameters: {
      type: "object",
      properties: {
        issues: {
          type: "array",
          items: {
            type: "object",
            properties: {
              description: {
                type: "string"
              },
              originalText: {
                type: "string"
              },
              corruptedText: {
                type: "string"
              },
              classification: {
                type: "object",
                properties: {
                  label: { type: "string" },
                  parent: { type: "string", enum: [...TAXONOMY_PARENTS] },
                  child: { type: "string" },
                  severity: {
                    type: "string",
                    enum: ["minor", "major"]
                  },
                  editScope: {
                    type: "string",
                    enum: ["character", "token", "phrase", "clause", "sentence", "discourse"]
                  },
                  operationType: {
                    type: "string",
                    enum: ["substitution", "omission", "insertion", "transposition", "duplication", "agreement_mismatch", "boundary_error"]
                  },
                  createsValidWord: {
                    type: ["boolean", "null"]
                  },
                  dimension: {
                    type: "string",
                    enum: ["orthographic", "lexical", "grammatical", "punctuation", "semantic", "stylistic"]
                  }
                },
                required: [
                  "label",
                  "parent",
                  "child",
                  "severity",
                  "editScope",
                  "operationType",
                  "createsValidWord",
                  "dimension"
                ],
                additionalProperties: false
              }
            },
            required: ["description", "originalText", "corruptedText", "classification"],
            additionalProperties: false
          }
        }
      },
      required: ["issues"],
      additionalProperties: false
    }
  }
};

type IssueReviewDecision = {
  issueId: string;
  accepted: boolean;
  confidence: "high" | "medium" | "low";
  reason: string;
};

const REVIEW_ISSUES_TOOL: OpenRouterToolDefinition = {
  type: "function",
  function: {
    name: REVIEW_ISSUES_TOOL_NAME,
    description:
      "Review whether each proposed corruption is a plausible proofreading error that a strong proofreader would likely correct.",
    parameters: {
      type: "object",
      properties: {
        decisions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              issueId: { type: "string" },
              accepted: { type: "boolean" },
              confidence: {
                type: "string",
                enum: ["high", "medium", "low"]
              },
              reason: { type: "string" }
            },
            required: ["issueId", "accepted", "confidence", "reason"],
            additionalProperties: false
          }
        }
      },
      required: ["decisions"],
      additionalProperties: false
    }
  }
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isRetriableRequestError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("fetch failed") ||
    normalized.includes("timed out") ||
    normalized.includes("429") ||
    normalized.includes("500") ||
    normalized.includes("502") ||
    normalized.includes("503") ||
    normalized.includes("504") ||
    normalized.includes("econnreset") ||
    normalized.includes("socket hang up")
  );
}

async function withRequestRetries<T>(operation: () => Promise<T>): Promise<T> {
  const delaysMs = [0, 750, 2000];
  let lastError: unknown = null;

  for (let attemptIndex = 0; attemptIndex < delaysMs.length; attemptIndex += 1) {
    if (attemptIndex > 0) {
      await sleep(delaysMs[attemptIndex] as number);
    }

    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);

      if (!isRetriableRequestError(message) || attemptIndex === delaysMs.length - 1) {
        throw error;
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) {
    return 0;
  }

  return haystack.split(needle).length - 1;
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

function splitParagraphs(sourceText: string): string[] {
  return sourceText
    .trim()
    .split(/\n\s*\n/)
    .map((block) => normalizePlainTextBlock(block))
    .filter((block) => block.length > 0);
}

function countWords(value: string): number {
  const matches = value.match(/\b[\p{L}\p{N}'-]+\b/gu);
  return matches?.length ?? 0;
}

function buildParagraphWordCounts(paragraphs: string[]): number[] {
  return paragraphs.map((paragraph) => countWords(paragraph));
}

function deriveTargetIssueCount(
  totalWords: number,
  issuesPerThousandWords: number,
  minimumIssues: number,
  explicitIssueCount?: number | null
): number {
  if (explicitIssueCount != null) {
    return Math.max(minimumIssues, explicitIssueCount);
  }

  const derived = Math.round((totalWords / 1000) * issuesPerThousandWords);
  return Math.max(minimumIssues, derived, 1);
}

function buildParagraphTargetIssueCounts(paragraphWordCounts: number[], totalIssueCount: number): number[] {
  const totalWords = paragraphWordCounts.reduce((sum, count) => sum + count, 0);

  if (paragraphWordCounts.length === 0) {
    return [];
  }

  if (totalWords <= 0) {
    const even = Array.from({ length: paragraphWordCounts.length }, () => 0);
    for (let index = 0; index < totalIssueCount; index += 1) {
      even[index % even.length] += 1;
    }
    return even;
  }

  const rawTargets = paragraphWordCounts.map((count) => (count / totalWords) * totalIssueCount);
  const flooredTargets = rawTargets.map((value) => Math.floor(value));
  let remaining = totalIssueCount - flooredTargets.reduce((sum, value) => sum + value, 0);

  const order = rawTargets
    .map((value, index) => ({
      index,
      fractional: value - flooredTargets[index],
      wordCount: paragraphWordCounts[index]
    }))
    .sort((left, right) => {
      if (right.fractional !== left.fractional) {
        return right.fractional - left.fractional;
      }

      if (right.wordCount !== left.wordCount) {
        return right.wordCount - left.wordCount;
      }

      return left.index - right.index;
    });

  for (let orderIndex = 0; orderIndex < order.length && remaining > 0; orderIndex += 1) {
    flooredTargets[order[orderIndex].index] += 1;
    remaining -= 1;
  }

  return flooredTargets;
}

function buildParagraphHardCaps(targetIssueCounts: number[]): number[] {
  return targetIssueCounts.map((target) => (target <= 0 ? 1 : target + 1));
}

function buildParagraphSpans(paragraphs: string[]): ParagraphSpan[] {
  let cursor = 0;

  return paragraphs.map((paragraph, paragraphIndex) => {
    const start = cursor;
    const end = start + paragraph.length;
    cursor = end + 2;
    return {
      paragraphIndex,
      start,
      end
    };
  });
}

function escapeHtmlText(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
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

function buildDeterministicParagraphIds(paragraphs: string[]): string[] {
  const usedIds = new Set<string>();

  return paragraphs.map((paragraph, index) =>
    createDeterministicParagraphId(index, escapeHtmlText(paragraph), usedIds)
  );
}

function createSeededRandom(seed: string): () => number {
  let state = 2166136261 >>> 0;

  for (let index = 0; index < seed.length; index += 1) {
    state ^= seed.charCodeAt(index);
    state = Math.imul(state, 16777619);
  }

  return () => {
    state += 0x6d2b79f5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(values: T[], random: () => number): T[] {
  const copy = [...values];

  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }

  return copy;
}

function weightedShuffle<T>(values: T[], weightOf: (value: T) => number, random: () => number): T[] {
  const pool = [...values];
  const ordered: T[] = [];

  while (pool.length > 0) {
    const weights = pool.map((value) => {
      const weight = weightOf(value);
      return Number.isFinite(weight) && weight > 0 ? weight : 0;
    });
    const totalWeight = weights.reduce((sum, value) => sum + value, 0);

    if (totalWeight <= 0) {
      ordered.push(...shuffle(pool, random));
      break;
    }

    let remaining = random() * totalWeight;
    let selectedIndex = weights.length - 1;

    for (let index = 0; index < weights.length; index += 1) {
      remaining -= weights[index];

      if (remaining <= 0) {
        selectedIndex = index;
        break;
      }
    }

    ordered.push(pool[selectedIndex] as T);
    pool.splice(selectedIndex, 1);
  }

  return ordered;
}

function slugifyTaxonomyValue(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function assertClassification(classification: IssueClassification, label: string): IssueClassification {
  const explicitParent =
    typeof classification.parent === "string" ? slugifyTaxonomyValue(classification.parent) : null;
  const labelParent =
    typeof classification.label === "string" && classification.label.includes(".")
      ? classification.label.slice(0, classification.label.indexOf("."))
      : null;
  const normalizedParentCandidate = [explicitParent, labelParent].find(
    (value): value is string => typeof value === "string" && isTaxonomyParent(value)
  );

  if (!normalizedParentCandidate) {
    throw new Error(`${label}.parent is invalid`);
  }

  const childFromLabel =
    typeof classification.label === "string" && classification.label.startsWith(`${normalizedParentCandidate}.`)
      ? classification.label.slice(normalizedParentCandidate.length + 1)
      : null;
  const normalizedChildCandidate =
    childFromLabel ??
    (typeof classification.child === "string" ? slugifyTaxonomyValue(classification.child) : null);

  if (typeof normalizedChildCandidate !== "string" || normalizedChildCandidate.trim().length === 0) {
    throw new Error(`${label}.child must be a non-empty string`);
  }

  if (classification.severity !== "minor" && classification.severity !== "major") {
    throw new Error(`${label}.severity must be "minor" or "major"`);
  }

  if (!["character", "token", "phrase", "clause", "sentence", "discourse"].includes(classification.editScope)) {
    throw new Error(`${label}.editScope is invalid`);
  }

  if (
    !["substitution", "omission", "insertion", "transposition", "duplication", "agreement_mismatch", "boundary_error"].includes(
      classification.operationType
    )
  ) {
    throw new Error(`${label}.operationType is invalid`);
  }

  if (classification.createsValidWord != null && typeof classification.createsValidWord !== "boolean") {
    throw new Error(`${label}.createsValidWord must be boolean or null`);
  }

  if (!["orthographic", "lexical", "grammatical", "punctuation", "semantic", "stylistic"].includes(classification.dimension)) {
    throw new Error(`${label}.dimension is invalid`);
  }

  const normalizedLabel = buildClassificationLabel(normalizedParentCandidate, normalizedChildCandidate);
  const normalizedChild = normalizedLabel.slice(normalizedParentCandidate.length + 1);

  return {
    ...classification,
    parent: normalizedParentCandidate,
    child: normalizedChild,
    label: normalizedLabel
  };
}

function assertProposedIssue(value: unknown, index: number): ProposedIssue {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`issues[${index}] must be an object`);
  }

  const record = value as Record<string, unknown>;

  if (typeof record.description !== "string" || record.description.trim().length === 0) {
    throw new Error(`issues[${index}].description must be a non-empty string`);
  }

  if (typeof record.originalText !== "string" || record.originalText.length === 0) {
    throw new Error(`issues[${index}].originalText must be a non-empty string`);
  }

  if (typeof record.corruptedText !== "string" || record.corruptedText.length === 0) {
    throw new Error(`issues[${index}].corruptedText must be a non-empty string`);
  }

  if (!record.classification || typeof record.classification !== "object" || Array.isArray(record.classification)) {
    throw new Error(`issues[${index}].classification must be an object`);
  }

  return {
    description: record.description.trim(),
    originalText: record.originalText,
    corruptedText: record.corruptedText,
    classification: assertClassification(record.classification as IssueClassification, `issues[${index}].classification`)
  };
}

function parseIssuePayload(payload: unknown, expectedIssueCount: number): ProposedIssue[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Tool payload must be an object");
  }

  const record = payload as Record<string, unknown>;

  if (!Array.isArray(record.issues)) {
    throw new Error("Tool payload must contain an issues array");
  }

  if (record.issues.length !== expectedIssueCount) {
    throw new Error(`Tool payload returned ${record.issues.length} issues, expected ${expectedIssueCount}`);
  }

  return record.issues.map((issue, index) => assertProposedIssue(issue, index));
}

function parseReviewPayload(payload: unknown, expectedIssueIds: string[]): IssueReviewDecision[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Review tool payload must be an object");
  }

  const record = payload as Record<string, unknown>;

  if (!Array.isArray(record.decisions)) {
    throw new Error("Review tool payload must contain a decisions array");
  }

  const decisions = record.decisions.map((decision, index) => {
    if (!decision || typeof decision !== "object" || Array.isArray(decision)) {
      throw new Error(`decisions[${index}] must be an object`);
    }

    const value = decision as Record<string, unknown>;

    if (typeof value.issueId !== "string" || value.issueId.length === 0) {
      throw new Error(`decisions[${index}].issueId must be a non-empty string`);
    }

    if (typeof value.accepted !== "boolean") {
      throw new Error(`decisions[${index}].accepted must be a boolean`);
    }

    if (value.confidence !== "high" && value.confidence !== "medium" && value.confidence !== "low") {
      throw new Error(`decisions[${index}].confidence must be high, medium, or low`);
    }

    if (typeof value.reason !== "string" || value.reason.trim().length === 0) {
      throw new Error(`decisions[${index}].reason must be a non-empty string`);
    }

    return {
      issueId: value.issueId,
      accepted: value.accepted,
      confidence: value.confidence,
      reason: value.reason.trim()
    } satisfies IssueReviewDecision;
  });

  const seen = new Set(decisions.map((decision) => decision.issueId));

  for (const issueId of expectedIssueIds) {
    if (!seen.has(issueId)) {
      throw new Error(`Review payload is missing decision for "${issueId}"`);
    }
  }

  return decisions;
}

function buildChunkWindows(paragraphs: string[], maxWordsPerChunk: number): ChunkWindow[] {
  const normalizedMaxWordsPerChunk = Math.max(1, maxWordsPerChunk);
  const paragraphWordCounts = buildParagraphWordCounts(paragraphs);
  const windows: ChunkWindow[] = [];
  let start = 0;

  while (start < paragraphs.length) {
    const paragraphIndices: number[] = [];
    let totalWords = 0;
    let end = start;

    for (; end < paragraphs.length; end += 1) {
      const nextWords = totalWords + paragraphWordCounts[end];

      if (paragraphIndices.length > 0 && nextWords > normalizedMaxWordsPerChunk) {
        break;
      }

      paragraphIndices.push(end);
      totalWords = nextWords;

      if (totalWords >= normalizedMaxWordsPerChunk) {
        break;
      }
    }

    const displayText = paragraphIndices.map((paragraphIndex) => paragraphs[paragraphIndex]).join("\n\n");

    windows.push({
      id: `p${paragraphIndices.join("-")}`,
      paragraphIndices,
      displayText,
      wordCount: totalWords
    });

    const lastParagraphIndex = paragraphIndices[paragraphIndices.length - 1];

    if (typeof lastParagraphIndex !== "number") {
      throw new Error("Chunk builder failed to include any paragraphs");
    }

    start = lastParagraphIndex + 1;
  }

  return windows;
}

function findTaxonomyClassByLabel(classes: TaxonomyClass[], label: string): TaxonomyClass | null {
  const trimmed = label.trim();

  if (trimmed.length === 0) {
    return null;
  }

  const directMatch = classes.find((taxonomyClass) => taxonomyClass.label === trimmed);

  if (directMatch) {
    return directMatch;
  }

  const firstSeparator = trimmed.indexOf(".");

  if (firstSeparator === -1) {
    return null;
  }

  const normalizedParent = slugifyTaxonomyValue(trimmed.slice(0, firstSeparator));
  const normalizedChild = slugifyTaxonomyValue(trimmed.slice(firstSeparator + 1));

  if (!isTaxonomyParent(normalizedParent) || normalizedChild.length === 0) {
    return null;
  }

  const normalizedLabel = buildClassificationLabel(normalizedParent, normalizedChild);
  return classes.find((taxonomyClass) => taxonomyClass.label === normalizedLabel) ?? null;
}

function resolveTaxonomyClassesByLabels(classes: TaxonomyClass[], labels: string[]): TaxonomyClass[] {
  const resolved: TaxonomyClass[] = [];
  const seenLabels = new Set<string>();
  const unknownLabels: string[] = [];

  for (const label of labels) {
    const resolvedClass = findTaxonomyClassByLabel(classes, label);

    if (!resolvedClass) {
      unknownLabels.push(label);
      continue;
    }

    if (seenLabels.has(resolvedClass.label)) {
      continue;
    }

    seenLabels.add(resolvedClass.label);
    resolved.push(resolvedClass);
  }

  if (unknownLabels.length > 0) {
    throw new Error(`Unknown taxonomy categories: ${unknownLabels.join(", ")}`);
  }

  return resolved;
}

function buildTargetClassQueue(
  classes: TaxonomyClass[],
  requiredParents: TaxonomyParent[],
  issueCount: number,
  optionCount: number,
  seed: string,
  balanceCategoryCounts?: Record<string, number>,
  excludedBalanceCategoryLabels?: string[],
  maxBalancedCategoryCount?: number | null
): TaxonomyClass[] {
  const random = createSeededRandom(`${seed}:taxonomy`);
  const excludedLabels = new Set(excludedBalanceCategoryLabels ?? []);
  const prelimEligibleClasses = classes.filter((taxonomyClass) => {
    if (excludedLabels.has(taxonomyClass.label)) {
      return false;
    }

    if (maxBalancedCategoryCount != null) {
      const existingCount = balanceCategoryCounts?.[taxonomyClass.label] ?? 0;

      if (existingCount > maxBalancedCategoryCount) {
        return false;
      }
    }

    return true;
  });
  let eligibleClasses = prelimEligibleClasses;

  if (balanceCategoryCounts && prelimEligibleClasses.length > 0) {
    const minCount = Math.min(...prelimEligibleClasses.map((taxonomyClass) => balanceCategoryCounts[taxonomyClass.label] ?? 0));
    const lowestCountClasses = prelimEligibleClasses.filter(
      (taxonomyClass) => (balanceCategoryCounts[taxonomyClass.label] ?? 0) === minCount
    );

    if (lowestCountClasses.length > 0) {
      eligibleClasses = lowestCountClasses;
    }
  }

  if (eligibleClasses.length === 0) {
    throw new Error("Balancing excluded every taxonomy category; relax the balancing filter.");
  }

  const classesByParent = new Map<TaxonomyParent, TaxonomyClass[]>();

  for (const taxonomyClass of eligibleClasses) {
    const bucket = classesByParent.get(taxonomyClass.parent) ?? [];
    bucket.push(taxonomyClass);
    classesByParent.set(taxonomyClass.parent, bucket);
  }

  const weightOf = (taxonomyClass: TaxonomyClass): number => {
    const count = balanceCategoryCounts?.[taxonomyClass.label] ?? 0;
    return 1 / (count + 1);
  };

  const buildRound = (): TaxonomyClass[] => weightedShuffle(eligibleClasses, weightOf, random);
  const shuffledRequiredParents = shuffle(requiredParents, random);
  const queue: TaxonomyClass[] = [];
  const seededRound: TaxonomyClass[] = [];
  const seededLabels = new Set<string>();

  for (const parent of shuffledRequiredParents) {
    const bucket = shuffle(classesByParent.get(parent) ?? [], random);

    if (bucket.length > 0) {
      const selected = bucket[0] as TaxonomyClass;

      if (!seededLabels.has(selected.label)) {
        seededLabels.add(selected.label);
        seededRound.push(selected);
      }
    }
  }

  for (const taxonomyClass of buildRound()) {
    if (!seededLabels.has(taxonomyClass.label)) {
      seededLabels.add(taxonomyClass.label);
      seededRound.push(taxonomyClass);
    }
  }

  if (seededRound.length === 0) {
    return queue;
  }

  queue.push(...seededRound);
  const targetAttemptCount = Math.max(issueCount * 12, eligibleClasses.length * 8);
  const targetQueueLength = Math.max(queue.length, targetAttemptCount * Math.max(1, optionCount));

  while (queue.length < targetQueueLength) {
    queue.push(...buildRound());
  }

  return queue.slice(0, targetQueueLength);
}

function buildTargetClassOptions(queue: TaxonomyClass[], attemptIndex: number, optionCount: number): TaxonomyClass[] {
  if (queue.length === 0) {
    return [];
  }

  const normalizedOptionCount = Math.max(1, optionCount);
  const options: TaxonomyClass[] = [];
  const seenLabels = new Set<string>();
  const startIndex = attemptIndex * normalizedOptionCount;

  for (let index = startIndex; index < queue.length && options.length < normalizedOptionCount; index += 1) {
    const candidate = queue[index];

    if (seenLabels.has(candidate.label)) {
      continue;
    }

    seenLabels.add(candidate.label);
    options.push(candidate);
  }

  for (const candidate of queue) {
    if (options.length >= normalizedOptionCount) {
      break;
    }

    if (seenLabels.has(candidate.label)) {
      continue;
    }

    seenLabels.add(candidate.label);
    options.push(candidate);
  }

  return options;
}

function chooseChunkOrder(
  windows: ChunkWindow[],
  acceptedIssues: ValidatedIssue[],
  seed: string,
  targetLabel: string,
  paragraphHardCaps: number[]
): ChunkWindow[] {
  const paragraphLoad = new Map<number, number>();

  for (const issue of acceptedIssues) {
    paragraphLoad.set(issue.paragraphIndex, (paragraphLoad.get(issue.paragraphIndex) ?? 0) + 1);
  }

  const shuffledWindows = shuffle(windows, createSeededRandom(`${seed}:${targetLabel}:chunks`));
  const randomizedOrder = new Map<string, number>();

  shuffledWindows.forEach((window, index) => {
    randomizedOrder.set(window.id, index);
  });

  return [...shuffledWindows].sort((left, right) => {
    const leftLoad = left.paragraphIndices.reduce((sum, paragraphIndex) => sum + (paragraphLoad.get(paragraphIndex) ?? 0), 0);
    const rightLoad = right.paragraphIndices.reduce((sum, paragraphIndex) => sum + (paragraphLoad.get(paragraphIndex) ?? 0), 0);
    const leftCapacity = left.paragraphIndices.reduce((sum, paragraphIndex) => sum + (paragraphHardCaps[paragraphIndex] ?? 1), 0);
    const rightCapacity = right.paragraphIndices.reduce((sum, paragraphIndex) => sum + (paragraphHardCaps[paragraphIndex] ?? 1), 0);
    const leftUtilization = leftCapacity <= 0 ? 1 : leftLoad / leftCapacity;
    const rightUtilization = rightCapacity <= 0 ? 1 : rightLoad / rightCapacity;

    if (leftUtilization !== rightUtilization) {
      return leftUtilization - rightUtilization;
    }

    if (leftLoad !== rightLoad) {
      return leftLoad - rightLoad;
    }

    return (randomizedOrder.get(left.id) ?? 0) - (randomizedOrder.get(right.id) ?? 0);
  });
}

function applyValidatedIssues(normalizedDocument: string, issues: ValidatedIssue[]): string {
  let corrupted = normalizedDocument;
  const sortedDescending = [...issues].sort((left, right) => right.start - left.start);

  for (const issue of sortedDescending) {
    corrupted = `${corrupted.slice(0, issue.start)}${issue.corruptedText}${corrupted.slice(issue.end)}`;
  }

  return corrupted;
}

function validateChunkIssue(
  normalizedDocument: string,
  paragraphSpans: ParagraphSpan[],
  proposedIssue: ProposedIssue,
  offeredTargetClasses: TaxonomyClass[],
  chunkWindow: ChunkWindow,
  acceptedIssues: ValidatedIssue[],
  paragraphHardCaps: number[]
): ValidatedIssue {
  if (proposedIssue.originalText === proposedIssue.corruptedText) {
    throw new Error("The proposed issue did not change the text");
  }

  if (proposedIssue.originalText.includes("\n\n") || proposedIssue.corruptedText.includes("\n\n")) {
    throw new Error("The proposed issue crosses a paragraph boundary");
  }

  const chosenTargetClass = offeredTargetClasses.find(
    (targetClass) => targetClass.label === proposedIssue.classification.label
  );

  if (!chosenTargetClass) {
    throw new Error(
      `Expected one of [${offeredTargetClasses.map((targetClass) => targetClass.label).join(", ")}] but received "${proposedIssue.classification.label}"`
    );
  }

  const localMatches: Array<{
    paragraphSpan: ParagraphSpan;
    start: number;
    end: number;
  }> = [];

  for (const paragraphIndex of chunkWindow.paragraphIndices) {
    const paragraphSpan = paragraphSpans[paragraphIndex];
    const paragraphText = normalizedDocument.slice(paragraphSpan.start, paragraphSpan.end);
    let searchFrom = 0;

    while (true) {
      const localStart = paragraphText.indexOf(proposedIssue.originalText, searchFrom);

      if (localStart === -1) {
        break;
      }

      localMatches.push({
        paragraphSpan,
        start: paragraphSpan.start + localStart,
        end: paragraphSpan.start + localStart + proposedIssue.originalText.length
      });
      searchFrom = localStart + 1;
    }
  }

  if (localMatches.length !== 1) {
    throw new Error(`originalText matched ${localMatches.length} occurrence(s) in the assigned chunk`);
  }

  const localMatch = localMatches[0];
  const paragraphText = normalizedDocument.slice(localMatch.paragraphSpan.start, localMatch.paragraphSpan.end);

  if (countOccurrences(paragraphText, proposedIssue.corruptedText) !== 0) {
    throw new Error("corruptedText already appears in the target paragraph");
  }

  const validatedIssue: ValidatedIssue = {
    ...proposedIssue,
    start: localMatch.start,
    end: localMatch.end,
    paragraphIndex: localMatch.paragraphSpan.paragraphIndex,
    category: proposedIssue.classification.label,
    issueId: "",
    targetLabel: chosenTargetClass.label,
    targetDescription: chosenTargetClass.description
  };

  const acceptanceError = validateAcceptedIssueCandidate(validatedIssue, acceptedIssues, paragraphHardCaps);

  if (acceptanceError) {
    throw new Error(acceptanceError);
  }

  return validatedIssue;
}

function validateAcceptedIssueCandidate(
  issue: ValidatedIssue,
  acceptedIssues: ValidatedIssue[],
  paragraphHardCaps: number[]
): string | null {
  if (
    acceptedIssues.some(
      (candidate) => candidate.paragraphIndex === issue.paragraphIndex && candidate.corruptedText === issue.corruptedText
    )
  ) {
    return "corruptedText duplicates an already accepted issue";
  }

  if (acceptedIssues.some((candidate) => !(issue.end <= candidate.start || issue.start >= candidate.end))) {
    return "The proposed issue overlaps an already accepted issue";
  }

  const perParagraphCounts = new Map<number, number>();

  for (const candidate of acceptedIssues) {
    perParagraphCounts.set(candidate.paragraphIndex, (perParagraphCounts.get(candidate.paragraphIndex) ?? 0) + 1);
  }

  perParagraphCounts.set(issue.paragraphIndex, (perParagraphCounts.get(issue.paragraphIndex) ?? 0) + 1);

  const paragraphHardCap = paragraphHardCaps[issue.paragraphIndex] ?? 1;

  if ((perParagraphCounts.get(issue.paragraphIndex) ?? 0) > paragraphHardCap) {
    return `paragraph ${issue.paragraphIndex + 1} would exceed hard_cap=${paragraphHardCap}`;
  }

  return null;
}

function assignIssueIds(issues: ValidatedIssue[]): ValidatedIssue[] {
  return [...issues]
    .sort((left, right) => left.start - right.start)
    .map((issue, index) => ({
      ...issue,
      issueId: `issue-${String(index + 1).padStart(2, "0")}`
    }));
}

function buildGenerationReviewAlignmentLines(): string[] {
  return [
    "The reviewer is strict. Propose only an error that a strong proofreader would almost certainly fix in neutral edited prose.",
    "Prefer an accidental local slip, not a paraphrase: a typo, duplicated or omitted small unit, agreement mismatch, wrong inflection, wrong function word, or clearly wrong punctuation.",
    "Do not return an edit that is merely awkward, more verbose, more formal or informal, semantically weaker, or otherwise a plausible alternative.",
    "Do not rely on optional comma preferences, loose stylistic punctuation, or broad rewrites to satisfy the target class.",
    "Preserve meaning, entities, register, and tone outside the narrow local corruption.",
    "Prefer the smallest local change that cleanly instantiates the target class."
  ];
}

function normalizePreviousFailureForPrompt(previousFailure: string): string {
  return previousFailure
    .replace(/^Review rejected the issue:\s*/i, "")
    .replace(/^commit rejected:\s*/i, "")
    .trim();
}

function buildGenerationSystemPrompt(targetingMode: GenerationTargetingMode): string {
  if (targetingMode === "fixed") {
    return [
      "You generate corruption plans for a proofreading benchmark.",
      "Return one tool call only.",
      "You will be given a text chunk and one exact target taxonomy class.",
      "Introduce exactly one realistic proofreading error of that exact class.",
      "Do not switch to a nearby class even if it feels easier.",
      "Your output will be reviewed strictly for whether the corruption is clearly wrong and worth benchmarking.",
      "Use a long exact anchor span, not a tiny local snippet, so the selected text is likely unique in the full document.",
      "Do not introduce any other error classes.",
      "Do not rewrite the chunk."
    ].join(" ");
  }

  return [
    "You generate corruption plans for a proofreading benchmark.",
    "Return one tool call only.",
    "You will be given a text chunk and a short list of candidate taxonomy classes.",
    "Choose the single best-fitting class from that list and introduce exactly one realistic proofreading error of that class.",
    "Your output will be reviewed strictly for whether the corruption is clearly wrong and worth benchmarking.",
    "Use a long exact anchor span, not a tiny local snippet, so the selected text is likely unique in the full document.",
    "Do not introduce any other error classes.",
    "Do not rewrite the chunk."
  ].join(" ");
}

function buildChunkGenerationUserPrompt(
  chunkWindow: ChunkWindow,
  targetClasses: TaxonomyClass[],
  seed: string,
  previousFailure: string | null,
  targetingMode: GenerationTargetingMode
): string {
  const targetClassLines = targetClasses.map(
    (targetClass, index) => `${index + 1}. ${targetClass.label}: ${targetClass.description}`
  );
  const fixedTargetClass = targetingMode === "fixed" ? targetClasses[0] ?? null : null;
  const previousFailureGuidance =
    previousFailure == null
      ? []
      : [
          "Previous attempt failed validation. Do not repeat the same failure mode. Choose a different span or a stricter corruption if needed.",
          `Failure to avoid: ${normalizePreviousFailureForPrompt(previousFailure)}`,
          ""
        ];

  return [
    `Seed: ${seed}`,
    "Introduce exactly one proofreading error into the chunk below.",
    targetingMode === "fixed"
      ? `Use this exact target class and no other: ${fixedTargetClass?.label ?? "unknown"}${fixedTargetClass ? `: ${fixedTargetClass.description}` : ""}`
      : "Choose the single best-fitting target class from the offered options below.",
    targetingMode === "fixed"
      ? "Your returned classification must match that exact class."
      : "Your returned classification must match the class you chose exactly.",
    "",
    "Return one issue only.",
    "Scan the full chunk and choose a location where the requested corruption will be obviously wrong, not borderline.",
    "The chunk may be longer than the local edit you need to make. Change one local span only.",
    "The chunk may contain multiple paragraphs separated by blank lines. Keep the issue inside one paragraph only.",
    "Use an exact, longer span from the chunk as `originalText`, usually around 5 to 12 words including nearby context.",
    "Avoid short anchors. Include enough surrounding context that `originalText` is likely unique in the full document, not just in this chunk.",
    "Copy `originalText` verbatim, character-for-character, from the chunk.",
    "Set `corruptedText` to the full replacement span containing the error, preserving the surrounding context from `originalText`.",
    "Keep the issue inside one paragraph.",
    ...buildGenerationReviewAlignmentLines(),
    "",
    targetingMode === "fixed" ? "" : "Offered target classes:",
    ...(targetingMode === "fixed" ? [] : targetClassLines),
    ...(targetingMode === "fixed" ? [] : [""]),
    ...previousFailureGuidance,
    "Before returning, verify that the corrupted version is clearly worse, still plausible as a human slip, and unambiguously fits the chosen class.",
    "",
    "Chunk:",
    "```text",
    chunkWindow.displayText,
    "```"
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

function buildReviewSystemPrompt(): string {
  return [
    "You review candidate corruption issues for a proofreading benchmark.",
    "The source chunk is intentionally clean. Each proposed issue is a deliberate corruption of that clean text.",
    "Judge the corruption against the claimed benchmark taxonomy class, not against a typo-only notion of proofreading.",
    "Accept an issue if the corruption creates a clear, benchmark-worthy instance of the claimed class relative to the clean source text.",
    "For orthography, lexical, grammar, and punctuation classes, expect a high-consensus error that a careful copy editor would almost certainly correct.",
    "For semantics, discourse, and style classes, do not reject solely because the issue is semantic, discourse-level, or stylistic. Accept if the corruption clearly creates the claimed problem under the benchmark's neutral edited target.",
    "Still reject benign paraphrases, equally acceptable alternatives, optional punctuation, and cases where the claimed class is not actually instantiated."
  ].join(" ");
}

function buildReviewCategoryGuidance(validatedIssue: ValidatedIssue): string[] {
  const category = validatedIssue.category;

  if (category === "semantics_discourse_and_style.register_mismatch") {
    return [
      "Category note: register mismatch is valid when the corruption makes the phrasing clearly too informal, too formal, or otherwise inconsistent with the surrounding prose.",
      "Do not reject solely because the difference is stylistic. Reject only if both versions remain similarly appropriate in register."
    ];
  }

  if (category === "semantics_discourse_and_style.referential_ambiguity") {
    return [
      "Category note: referential ambiguity is valid when the corruption introduces a genuinely confusing reference or multiple plausible antecedents for a reader.",
      "Reject only if the referent still resolves cleanly and the change is merely an arguable pronoun/style preference."
    ];
  }

  if (category === "semantics_discourse_and_style.wordiness_or_redundancy") {
    return [
      "Category note: wordiness or redundancy is valid when the corruption adds clearly unnecessary repetition or padding that a careful editor would trim.",
      "Reject if it is only a different phrasal choice of similar directness."
    ];
  }

  if (category === "semantics_discourse_and_style.awkward_phrasing") {
    return [
      "Category note: awkward phrasing is valid when the corruption makes the sentence materially harder to process or notably unnatural for the benchmark's target prose.",
      "Reject if the wording is merely different but still comparably natural."
    ];
  }

  if (category === "semantics_discourse_and_style.nonstandard_dialect_or_colloquial_form") {
    return [
      "Category note: nonstandard dialect or colloquial form is valid when the corruption inserts a clearly nonstandard or colloquial form where the benchmark expects standardized edited prose.",
      "Do not reject solely because it is register-related; reject if the replacement still fits the same standardized register."
    ];
  }

  if (validatedIssue.classification.parent === "semantics_discourse_and_style") {
    return [
      "Category note: because this is a semantics, discourse, or style class, grammaticality alone is not enough to reject it.",
      "Accept if the corruption clearly creates the claimed semantic, discourse, or stylistic problem under the benchmark's target standard."
    ];
  }

  return [];
}

function confidenceAtLeast(
  actual: IssueReviewDecision["confidence"],
  minimum: IssueReviewDecision["confidence"]
): boolean {
  const ranking: Record<IssueReviewDecision["confidence"], number> = {
    low: 0,
    medium: 1,
    high: 2
  };

  return ranking[actual] >= ranking[minimum];
}

function buildReviewUserPrompt(chunkWindow: ChunkWindow, validatedIssue: ValidatedIssue): string {
  return [
    "Review this proposed corruption issue.",
    "The clean source text below is correct. The issue shows a deliberate corruption we might inject into it.",
    "Accept it only if the corruption genuinely instantiates the claimed taxonomy class and is worth benchmarking.",
    "Use the class definition below as part of the evaluation.",
    "",
    "Claimed taxonomy class:",
    `- label: ${validatedIssue.targetLabel}`,
    `- definition: ${validatedIssue.targetDescription}`,
    ...buildReviewCategoryGuidance(validatedIssue),
    "",
    "Chunk:",
    "```text",
    chunkWindow.displayText,
    "```",
    "",
    "Issue:",
    "```json",
    JSON.stringify(
      {
        issueId: "issue-01",
        category: validatedIssue.category,
        description: validatedIssue.description,
        classification: validatedIssue.classification,
        originalText: validatedIssue.originalText,
        corruptedText: validatedIssue.corruptedText
      },
      null,
      2
    ),
    "```"
  ].join("\n");
}

async function readTaxonomyMarkdown(): Promise<string> {
  return readText(path.resolve(TAXONOMY_DOCUMENT_PATH));
}

async function requestChunkIssue(
  chunkWindow: ChunkWindow,
  targetClasses: TaxonomyClass[],
  options: GenerateCorruptedCaseOptions,
  previousFailure: string | null,
  targetingMode: GenerationTargetingMode
): Promise<ProposedIssue> {
  const targetLabelSummary = targetClasses.map((targetClass) => targetClass.label).join("|");
  const modelVariant = withDefaultReasoningEffort(parseModelVariantString(options.model));
  const response = await withRequestRetries(() =>
    requestChatCompletion(
      modelVariant.model,
      [
        {
          role: "system",
          content: buildGenerationSystemPrompt(targetingMode)
        },
        {
          role: "user",
          content: buildChunkGenerationUserPrompt(chunkWindow, targetClasses, options.seed, previousFailure, targetingMode)
        }
      ],
      [SUBMIT_ISSUES_TOOL],
      {
        toolChoice: {
          type: "function",
          function: {
            name: SUBMIT_ISSUES_TOOL_NAME
          }
        },
        temperature: CORRUPTION_GENERATION_TEMPERATURE,
        maxCompletionTokens: options.maxCompletionTokens ?? 2200,
        parallelToolCalls: false,
        reasoning:
          modelVariant.reasoningEffort == null
            ? undefined
            : {
                effort: modelVariant.reasoningEffort,
                exclude: true
              },
        timeoutMs: options.requestTimeoutMs ?? undefined,
        verbose: options.verbose,
        debugLabel: `${options.caseId}:${modelVariant.label}:${targetLabelSummary}:${chunkWindow.id}`
      }
    )
  );

  const toolCall = response.message.tool_calls?.find((candidate) => candidate.function.name === SUBMIT_ISSUES_TOOL_NAME);

  if (!toolCall) {
    throw new Error(`Model did not return a ${SUBMIT_ISSUES_TOOL_NAME} tool call`);
  }

  return parseIssuePayload(JSON.parse(toolCall.function.arguments), 1)[0];
}

async function reviewIssue(
  chunkWindow: ChunkWindow,
  validatedIssue: ValidatedIssue,
  options: GenerateCorruptedCaseOptions
): Promise<void> {
  const reviewModel = withDefaultReasoningEffort(parseModelVariantString(options.reviewModel ?? options.model));
  const response = await withRequestRetries(() =>
    requestChatCompletion(
      reviewModel.model,
      [
        {
          role: "system",
          content: buildReviewSystemPrompt()
        },
        {
          role: "user",
          content: buildReviewUserPrompt(chunkWindow, validatedIssue)
        }
      ],
      [REVIEW_ISSUES_TOOL],
      {
        toolChoice: {
          type: "function",
          function: {
            name: REVIEW_ISSUES_TOOL_NAME
          }
        },
        maxCompletionTokens: 900,
        parallelToolCalls: false,
        reasoning:
          reviewModel.reasoningEffort == null
            ? undefined
            : {
                effort: reviewModel.reasoningEffort,
                exclude: true
              },
        timeoutMs: options.requestTimeoutMs ?? undefined,
        verbose: options.verbose,
        debugLabel: `${options.caseId}:${reviewModel.label}:${validatedIssue.targetLabel}:${chunkWindow.id}:review`
      }
    )
  );

  const toolCall = response.message.tool_calls?.find((candidate) => candidate.function.name === REVIEW_ISSUES_TOOL_NAME);

  if (!toolCall) {
    throw new Error(`Model did not return a ${REVIEW_ISSUES_TOOL_NAME} tool call`);
  }

  const decisions = parseReviewPayload(JSON.parse(toolCall.function.arguments), ["issue-01"]);
  const decision = decisions[0];
  const minimumConfidence = options.reviewMinConfidence ?? "medium";

  if (!decision.accepted || !confidenceAtLeast(decision.confidence, minimumConfidence)) {
    throw new Error(`Review rejected the issue: ${decision.reason}`);
  }
}

function reserveChunkWindow(
  orderedWindows: ChunkWindow[],
  attemptedChunkIds: Set<string>,
  reservedChunkIds: Set<string>
): ChunkWindow | null {
  for (const chunkWindow of orderedWindows) {
    if (attemptedChunkIds.has(chunkWindow.id)) {
      continue;
    }

    if (reservedChunkIds.has(chunkWindow.id)) {
      continue;
    }

    reservedChunkIds.add(chunkWindow.id);
    return chunkWindow;
  }

  return null;
}

async function generateIssueForTargetClass(
  chunkWindows: ChunkWindow[],
  normalizedDocument: string,
  paragraphSpans: ParagraphSpan[],
  paragraphHardCaps: number[],
  targetClasses: TaxonomyClass[],
  acceptedIssues: ValidatedIssue[],
  targetingMode: GenerationTargetingMode,
  reservedChunkIds: Set<string>,
  getCommittedAcceptedCount: () => number,
  options: GenerateCorruptedCaseOptions,
  targetIndex: number,
  targetCount: number,
  targetIssueCount: number
): Promise<ValidatedIssue | null> {
  const targetLabelSummary = targetClasses.map((targetClass) => targetClass.label).join("|");
  const orderedWindows = chooseChunkOrder(chunkWindows, acceptedIssues, options.seed, targetLabelSummary, paragraphHardCaps);
  const maxRetries = Math.min(
    orderedWindows.length,
    Math.max(8, options.maxRetries ?? Math.ceil(orderedWindows.length / 3))
  );
  const attemptedChunkIds = new Set<string>();
  let previousFailure: string | null = null;

  while (attemptedChunkIds.size < maxRetries) {
    const chunkWindow = reserveChunkWindow(orderedWindows, attemptedChunkIds, reservedChunkIds);

    if (!chunkWindow) {
      await sleep(25);
      continue;
    }

    attemptedChunkIds.add(chunkWindow.id);

    try {
      options.onProgress?.({
        phase: "requesting",
        acceptedIssues: getCommittedAcceptedCount(),
        targetIssueCount,
        attemptedIssues: targetIndex,
        targetLabel: targetLabelSummary,
        chunkId: chunkWindow.id,
        message: `requesting ${targetLabelSummary}`
      });
      const proposedIssue = await requestChunkIssue(chunkWindow, targetClasses, options, previousFailure, targetingMode);
      const validatedIssue = validateChunkIssue(
        normalizedDocument,
        paragraphSpans,
        proposedIssue,
        targetClasses,
        chunkWindow,
        acceptedIssues,
        paragraphHardCaps
      );
      options.onProgress?.({
        phase: "reviewing",
        acceptedIssues: getCommittedAcceptedCount(),
        targetIssueCount,
        attemptedIssues: targetIndex,
        targetLabel: validatedIssue.targetLabel,
        chunkId: chunkWindow.id,
        message: `reviewing ${validatedIssue.targetLabel}`
      });
      await reviewIssue(chunkWindow, validatedIssue, options);
      return validatedIssue;
    } catch (error) {
      previousFailure = error instanceof Error ? error.message : String(error);
      options.onProgress?.({
        phase: "rejected",
        acceptedIssues: getCommittedAcceptedCount(),
        targetIssueCount,
        attemptedIssues: targetIndex,
        targetLabel: targetLabelSummary,
        chunkId: null,
        message: previousFailure
      });

      if (options.verbose) {
        console.error(`[corruption] target=${targetLabelSummary} failed message=${previousFailure}`);
      }
    } finally {
      reservedChunkIds.delete(chunkWindow.id);
    }
  }

  return null;
}

function buildIssueRecords(issues: ValidatedIssue[], paragraphIds: string[]): GeneratedIssueRecord[] {
  return issues.map((issue) => ({
    id: issue.issueId,
    category: issue.category,
    paragraphId: paragraphIds[issue.paragraphIndex] ?? "",
    description: issue.description,
    classification: issue.classification,
    expectedCorrection: {
      find: issue.corruptedText,
      replace: issue.originalText
    }
  }));
}

export async function generateCorruptedCase(
  cleanText: string,
  sourcePath: string,
  options: GenerateCorruptedCaseOptions
): Promise<GeneratedCaseResult> {
  const paragraphs = splitParagraphs(cleanText);

  if (paragraphs.length === 0) {
    throw new Error("Source text must contain at least one paragraph");
  }

  const taxonomyMarkdown = await readTaxonomyMarkdown();
  const taxonomyClasses = parseTaxonomyClasses(taxonomyMarkdown);

  if (taxonomyClasses.length === 0) {
    throw new Error("Could not parse any taxonomy classes from taxonomy.md");
  }

  const normalizedDocument = paragraphs.join("\n\n");
  const paragraphSpans = buildParagraphSpans(paragraphs);
  const paragraphWordCounts = buildParagraphWordCounts(paragraphs);
  const totalWords = paragraphWordCounts.reduce((sum, count) => sum + count, 0);
  const requiredParents = options.requiredParents ?? [];
  const forcedTargetClass =
    options.targetCategoryLabel == null ? null : findTaxonomyClassByLabel(taxonomyClasses, options.targetCategoryLabel);
  const allowedTargetClasses =
    options.targetCategoryLabels == null || options.targetCategoryLabels.length === 0
      ? null
      : resolveTaxonomyClassesByLabels(taxonomyClasses, options.targetCategoryLabels);

  if (options.targetCategoryLabel != null && !forcedTargetClass) {
    throw new Error(`Unknown taxonomy category "${options.targetCategoryLabel}"`);
  }

  if (forcedTargetClass && allowedTargetClasses && allowedTargetClasses.length > 0) {
    throw new Error("Use either targetCategoryLabel or targetCategoryLabels, not both");
  }

  if (
    forcedTargetClass &&
    requiredParents.some((parent) => parent !== forcedTargetClass.parent)
  ) {
    throw new Error(
      `--target-category ${forcedTargetClass.label} is incompatible with required parents outside "${forcedTargetClass.parent}"`
    );
  }

  if (
    allowedTargetClasses &&
    requiredParents.some((parent) => !allowedTargetClasses.some((taxonomyClass) => taxonomyClass.parent === parent))
  ) {
    throw new Error("--target-categories excludes at least one required parent");
  }

  const minimumIssueCount = Math.max(1, requiredParents.length);
  const targetIssueCount = deriveTargetIssueCount(
    totalWords,
    options.issuesPerThousandWords,
    minimumIssueCount,
    options.issueCount ?? null
  );
  const paragraphTargetIssueCounts = buildParagraphTargetIssueCounts(paragraphWordCounts, targetIssueCount);
  const paragraphHardCaps = buildParagraphHardCaps(paragraphTargetIssueCounts);
  const chunkWindows = buildChunkWindows(paragraphs, options.maxWordsPerChunk ?? 300);
  const useSingleTargetClassPerChunk = options.singleTargetClassPerChunk === true;
  const targetingMode: GenerationTargetingMode =
    forcedTargetClass || useSingleTargetClassPerChunk ? "fixed" : "choice";
  const issueOptionsPerAttempt =
    forcedTargetClass || useSingleTargetClassPerChunk ? 1 : Math.max(1, options.issueOptionsPerAttempt ?? 3);
  const eligibleTaxonomyClasses = forcedTargetClass ? [forcedTargetClass] : (allowedTargetClasses ?? taxonomyClasses);
  const targetClassQueue = buildTargetClassQueue(
    eligibleTaxonomyClasses,
    requiredParents,
    targetIssueCount,
    issueOptionsPerAttempt,
    options.seed,
    forcedTargetClass ? undefined : options.balanceCategoryCounts,
    forcedTargetClass ? undefined : options.excludedBalanceCategoryLabels,
    forcedTargetClass ? null : (options.maxBalancedCategoryCount ?? null)
  );
  const acceptedIssues: ValidatedIssue[] = [];
  const reservedChunkIds = new Set<string>();
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 4, chunkWindows.length));
  const targetAttemptCount = Math.ceil(targetClassQueue.length / issueOptionsPerAttempt);
  let nextTargetIndex = 0;

  async function runWorker(): Promise<void> {
    while (true) {
      if (acceptedIssues.length >= targetIssueCount) {
        return;
      }

      const targetIndex = nextTargetIndex;
      nextTargetIndex += 1;

      if (targetIndex >= targetAttemptCount) {
        return;
      }

      const targetClasses = buildTargetClassOptions(targetClassQueue, targetIndex, issueOptionsPerAttempt);

      options.onProgress?.({
        phase: "starting",
        acceptedIssues: acceptedIssues.length,
        targetIssueCount,
        attemptedIssues: targetIndex + 1,
        targetLabel: targetClasses.map((targetClass) => targetClass.label).join("|"),
        chunkId: null,
        message: null
      });

      if (options.verbose) {
        console.error(
          `[corruption] targeting classes=${targetClasses.map((targetClass) => targetClass.label).join("|")} accepted=${acceptedIssues.length}/${targetIssueCount}`
        );
      }

      const issue = await generateIssueForTargetClass(
        chunkWindows,
        normalizedDocument,
        paragraphSpans,
        paragraphHardCaps,
        targetClasses,
        acceptedIssues,
        targetingMode,
        reservedChunkIds,
        () => acceptedIssues.length,
        options,
        targetIndex + 1,
        targetAttemptCount,
        targetIssueCount
      );

      if (!issue || acceptedIssues.length >= targetIssueCount) {
        continue;
      }

      const acceptanceError = validateAcceptedIssueCandidate(issue, acceptedIssues, paragraphHardCaps);

      if (acceptanceError) {
        options.onProgress?.({
          phase: "rejected",
          acceptedIssues: acceptedIssues.length,
          targetIssueCount,
          attemptedIssues: targetIndex + 1,
          targetLabel: issue.targetLabel,
          chunkId: null,
          message: `commit rejected: ${acceptanceError}`
        });
        continue;
      }

      acceptedIssues.push(issue);
      options.onProgress?.({
        phase: "accepted",
        acceptedIssues: acceptedIssues.length,
        targetIssueCount,
        attemptedIssues: targetIndex + 1,
        targetLabel: issue.targetLabel,
        chunkId: null,
        message: `accepted ${issue.targetLabel}`
      });
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, targetClassQueue.length) }, () => runWorker())
  );

  if (acceptedIssues.length < targetIssueCount) {
    throw new Error(
      `Only generated ${acceptedIssues.length}/${targetIssueCount} validated issues after ${targetAttemptCount} taxonomy attempts`
    );
  }

  const finalIssues = assignIssueIds(acceptedIssues);
  const parentCounts = new Map<string, number>();

  for (const issue of finalIssues) {
    parentCounts.set(issue.classification.parent, (parentCounts.get(issue.classification.parent) ?? 0) + 1);
  }

  for (const parent of requiredParents) {
    if ((parentCounts.get(parent) ?? 0) < 1) {
      throw new Error(`The generated issue set is missing required parent coverage for "${parent}"`);
    }
  }

  const corruptedText = applyValidatedIssues(normalizedDocument, finalIssues);
  const corruptedParagraphIds = buildDeterministicParagraphIds(splitParagraphs(corruptedText));
  options.onProgress?.({
    phase: "done",
    acceptedIssues: finalIssues.length,
    targetIssueCount,
    attemptedIssues: nextTargetIndex,
    targetLabel: "done",
    chunkId: null,
    message: null
  });

  return {
    corruptedText,
    caseDefinition: {
      id: options.caseId,
      instruction: options.instruction,
      sourcePath,
      issues: buildIssueRecords(finalIssues, corruptedParagraphIds)
    },
    selectedMutations: finalIssues.map((issue) => ({
      issueId: issue.issueId,
      category: issue.category,
      description: issue.description,
      classification: issue.classification,
      originalText: issue.originalText,
      corruptedText: issue.corruptedText,
      paragraphIndex: issue.paragraphIndex
    }))
  };
}

export function summarizeSelectedMutations(
  selectedMutations: Array<{ classification: IssueClassification }>
): Record<string, number> {
  const counts: Record<string, number> = {};

  for (const mutation of selectedMutations) {
    counts[mutation.classification.label] = (counts[mutation.classification.label] ?? 0) + 1;
  }

  return counts;
}
