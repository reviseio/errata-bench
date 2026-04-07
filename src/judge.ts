import { requestChatCompletion, type OpenRouterMessage, type OpenRouterToolDefinition } from "./openrouter.js";
import type { ModelVariant } from "./model-config.js";
import type {
  CaseJudgeResult,
  IntroducedError,
  IssueSeverity,
  JudgeIssueVerdict,
  ProofreadingIssue,
  RunCase,
  UnnecessaryChange
} from "./types.js";

type RawJudgePayload = {
  issueVerdicts?: unknown;
  introducedErrors?: unknown;
  unnecessaryChanges?: unknown;
  summary?: unknown;
};

const SUBMIT_JUDGMENT_TOOL: OpenRouterToolDefinition = {
  type: "function",
  function: {
    name: "submit_judgment",
    description:
      "Submit the proofreading judgment for the edited document. Use this only after checking each listed original error, any new proofreading errors introduced, and any unnecessary or harmful collateral changes.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        issueVerdicts: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              issueId: { type: "string" },
              resolved: { type: "boolean" },
              notes: { type: "string" }
            },
            required: ["issueId", "resolved", "notes"]
          }
        },
        introducedErrors: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              paragraphId: { type: "string" },
              text: { type: "string" },
              severity: { type: "string", enum: ["minor", "major"] },
              notes: { type: "string" }
            },
            required: ["paragraphId", "text", "severity", "notes"]
          }
        },
        unnecessaryChanges: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              paragraphId: { type: "string" },
              originalText: { type: "string" },
              finalText: { type: "string" },
              severity: { type: "string", enum: ["minor", "major"] },
              harmful: { type: "boolean" },
              notes: { type: "string" }
            },
            required: ["paragraphId", "originalText", "finalText", "severity", "harmful", "notes"]
          }
        },
        summary: {
          type: "string"
        }
      },
      required: ["issueVerdicts", "introducedErrors", "unnecessaryChanges", "summary"]
    }
  }
};

const SUBMIT_ALTERNATIVE_RESOLUTION_TOOL: OpenRouterToolDefinition = {
  type: "function",
  function: {
    name: "submit_alternative_resolution_judgment",
    description:
      "Submit verdicts for ambiguous proofreading fixes where the original bad text is gone but the final wording differs from the canonical expected replacement.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        issueVerdicts: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              issueId: { type: "string" },
              resolved: { type: "boolean" },
              notes: { type: "string" }
            },
            required: ["issueId", "resolved", "notes"]
          }
        },
        summary: {
          type: "string"
        }
      },
      required: ["issueVerdicts", "summary"]
    }
  }
};

const SUBMIT_ALTERNATIVE_RESOLUTION_REPAIR_TOOL: OpenRouterToolDefinition = {
  type: "function",
  function: {
    name: "submit_alternative_resolution_repair",
    description:
      "Submit repaired boolean verdicts for ambiguous proofreading fixes. Use this only to correct inconsistent resolved=true/false values from a prior judgment.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        issueVerdicts: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              issueId: { type: "string" },
              resolved: { type: "boolean" }
            },
            required: ["issueId", "resolved"]
          }
        },
        summary: {
          type: "string"
        }
      },
      required: ["issueVerdicts", "summary"]
    }
  }
};

export type AlternativeIssueJudgeResult = {
  judgeModel: string;
  issueVerdicts: JudgeIssueVerdict[];
  summary: string;
  outputTokens: number;
  promptTokens: number;
};

function buildJudgeMessages(runCase: RunCase): OpenRouterMessage[] {
  const listedIssues = runCase.issues
    .map(
      (issue) =>
        [
          `- issueId: ${issue.id}`,
          `  paragraphId: ${issue.paragraphId}`,
          `  category: ${issue.category}`,
          `  description: ${issue.description}`,
          `  original error text: ${issue.expectedCorrection.find}`,
          `  expected correction text: ${issue.expectedCorrection.replace}`
        ].join("\n")
    )
    .join("\n");

  return [
    {
      role: "system",
      content: [
        "You are judging a proofreading edit to an HTML document.",
        "Your task is only to determine whether each listed original error was resolved and whether the edited document introduced any new proofreading errors.",
        "Also determine whether the edited document made unnecessary changes to text that was already acceptable.",
        "A rewrite can still count as resolved if it fixes the original problem cleanly.",
        "An unnecessary change is an edit that was not needed to resolve a listed issue or keep nearby grammar coherent.",
        "A harmful unnecessary change is collateral damage: it changes meaning, tone, entities, formatting, or otherwise makes the text worse.",
        "Do not count mere stylistic differences as introduced proofreading errors.",
        "Submit your judgment by calling submit_judgment."
      ].join(" ")
    },
    {
      role: "user",
      content: [
        "Original document HTML:",
        runCase.initialDocumentHtml,
        "",
        "Edited document HTML:",
        runCase.finalDocumentHtml,
        "",
        "Listed original issues:",
        listedIssues
      ].join("\n")
    }
  ];
}

function buildAlternativeResolutionJudgeMessages(
  originalParagraphHtml: string,
  finalParagraphHtml: string,
  issues: ProofreadingIssue[]
): OpenRouterMessage[] {
  const listedIssues = issues
    .map(
      (issue) =>
        [
          `- issueId: ${issue.id}`,
          `  category: ${issue.category}`,
          `  description: ${issue.description}`,
          `  original error text: ${issue.expectedCorrection.find}`,
          `  canonical expected correction text: ${issue.expectedCorrection.replace}`
        ].join("\n")
    )
    .join("\n");

  return [
    {
      role: "system",
      content: [
        "You are judging ambiguous proofreading fixes inside one paragraph.",
        "The original bad text has already disappeared from the edited paragraph.",
        "Your job is only to decide whether each listed issue was nevertheless resolved with a valid alternative correction.",
        "Accept minor wording differences if they clearly fix the original proofreading problem.",
        "If the edited wording is grammatically valid and resolves the listed proofreading error, mark resolved=true even if it is wordier, more formal, or stylistically different from the canonical correction.",
        "Reject changes that leave the issue unresolved, change the meaning in a problematic way, or replace the issue with a new mistake.",
        "Do not require the final wording to match the canonical expected correction exactly.",
        "Your notes must justify the same verdict you return. Never conclude that a fix is valid or resolves the issue while setting resolved=false.",
        "Submit your judgment by calling submit_alternative_resolution_judgment."
      ].join(" ")
    },
    {
      role: "user",
      content: [
        "Original paragraph HTML:",
        originalParagraphHtml,
        "",
        "Edited paragraph HTML:",
        finalParagraphHtml,
        "",
        "Ambiguous issues to judge:",
        listedIssues
      ].join("\n")
    }
  ];
}

function buildAlternativeResolutionRepairMessages(
  originalParagraphHtml: string,
  finalParagraphHtml: string,
  issues: ProofreadingIssue[],
  priorVerdicts: JudgeIssueVerdict[]
): OpenRouterMessage[] {
  const listedIssues = issues
    .map(
      (issue) =>
        [
          `- issueId: ${issue.id}`,
          `  category: ${issue.category}`,
          `  description: ${issue.description}`,
          `  original error text: ${issue.expectedCorrection.find}`,
          `  canonical expected correction text: ${issue.expectedCorrection.replace}`
        ].join("\n")
    )
    .join("\n");
  const priorVerdictSummary = priorVerdicts
    .map(
      (verdict) =>
        [
          `- issueId: ${verdict.issueId}`,
          `  prior resolved value: ${verdict.resolved}`,
          `  prior notes: ${verdict.notes}`
        ].join("\n")
    )
    .join("\n");

  return [
    {
      role: "system",
      content: [
        "You are repairing internally inconsistent proofreading verdicts.",
        "Return only corrected boolean verdicts.",
        "If the explanation concludes that the edited wording is a valid alternative fix that resolves the listed proofreading problem, resolved must be true.",
        "If the explanation concludes that the issue remains incorrect, unresolved, or replaced with a new mistake, resolved must be false.",
        "Prefer valid alternative corrections over overly strict canonical matching.",
        "Do not provide new explanatory notes; only repair the boolean resolved values.",
        "Submit your repaired judgment by calling submit_alternative_resolution_repair."
      ].join(" ")
    },
    {
      role: "user",
      content: [
        "Original paragraph HTML:",
        originalParagraphHtml,
        "",
        "Edited paragraph HTML:",
        finalParagraphHtml,
        "",
        "Issues to judge:",
        listedIssues,
        "",
        "Prior inconsistent verdicts to repair:",
        priorVerdictSummary
      ].join("\n")
    }
  ];
}

function parseJudgePayload(raw: string): RawJudgePayload {
  const parsed = JSON.parse(raw) as unknown;

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Judge payload must be a JSON object");
  }

  return parsed as RawJudgePayload;
}

function normalizeSeverity(value: unknown, label: string): IssueSeverity {
  if (value !== "minor" && value !== "major") {
    throw new Error(`${label} must be "minor" or "major"`);
  }

  return value;
}

function normalizeJudgeIssueVerdicts(value: unknown): JudgeIssueVerdict[] {
  if (!Array.isArray(value)) {
    throw new Error("Judge issueVerdicts must be an array");
  }

  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`Judge issueVerdicts[${index}] must be an object`);
    }

    const record = item as Record<string, unknown>;

    if (typeof record.issueId !== "string") {
      throw new Error(`Judge issueVerdicts[${index}].issueId must be a string`);
    }

    if (typeof record.resolved !== "boolean") {
      throw new Error(`Judge issueVerdicts[${index}].resolved must be a boolean`);
    }

    if (typeof record.notes !== "string") {
      throw new Error(`Judge issueVerdicts[${index}].notes must be a string`);
    }

    return {
      issueId: record.issueId,
      resolved: record.resolved,
      notes: record.notes
    };
  });
}

function normalizeIntroducedErrors(value: unknown): IntroducedError[] {
  if (!Array.isArray(value)) {
    throw new Error("Judge introducedErrors must be an array");
  }

  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`Judge introducedErrors[${index}] must be an object`);
    }

    const record = item as Record<string, unknown>;

    if (typeof record.paragraphId !== "string") {
      throw new Error(`Judge introducedErrors[${index}].paragraphId must be a string`);
    }

    if (typeof record.text !== "string") {
      throw new Error(`Judge introducedErrors[${index}].text must be a string`);
    }

    if (typeof record.notes !== "string") {
      throw new Error(`Judge introducedErrors[${index}].notes must be a string`);
    }

    return {
      paragraphId: record.paragraphId,
      text: record.text,
      severity: normalizeSeverity(record.severity, `Judge introducedErrors[${index}].severity`),
      notes: record.notes
    };
  });
}

function normalizeUnnecessaryChanges(value: unknown): UnnecessaryChange[] {
  if (!Array.isArray(value)) {
    throw new Error("Judge unnecessaryChanges must be an array");
  }

  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`Judge unnecessaryChanges[${index}] must be an object`);
    }

    const record = item as Record<string, unknown>;

    if (typeof record.paragraphId !== "string") {
      throw new Error(`Judge unnecessaryChanges[${index}].paragraphId must be a string`);
    }

    if (typeof record.originalText !== "string") {
      throw new Error(`Judge unnecessaryChanges[${index}].originalText must be a string`);
    }

    if (typeof record.finalText !== "string") {
      throw new Error(`Judge unnecessaryChanges[${index}].finalText must be a string`);
    }

    if (typeof record.notes !== "string") {
      throw new Error(`Judge unnecessaryChanges[${index}].notes must be a string`);
    }

    if (typeof record.harmful !== "boolean") {
      throw new Error(`Judge unnecessaryChanges[${index}].harmful must be a boolean`);
    }

    return {
      paragraphId: record.paragraphId,
      originalText: record.originalText,
      finalText: record.finalText,
      severity: normalizeSeverity(record.severity, `Judge unnecessaryChanges[${index}].severity`),
      harmful: record.harmful,
      notes: record.notes
    };
  });
}

export async function judgeRunCase(
  runCase: RunCase,
  judgeModel: ModelVariant,
  options?: { timeoutMs?: number | null }
): Promise<CaseJudgeResult> {
  const response = await requestChatCompletion(judgeModel.model, buildJudgeMessages(runCase), [SUBMIT_JUDGMENT_TOOL], {
    toolChoice: {
      type: "function",
      function: {
        name: "submit_judgment"
      }
    },
    maxCompletionTokens: 700,
    parallelToolCalls: false,
    reasoning:
      judgeModel.reasoningEffort == null
        ? undefined
        : {
            effort: judgeModel.reasoningEffort
          },
    timeoutMs: options?.timeoutMs ?? undefined
  });

  const toolCall = response.message.tool_calls?.find((candidate) => candidate.function.name === "submit_judgment");

  if (!toolCall) {
    throw new Error("Judge model did not call submit_judgment");
  }

  const payload = parseJudgePayload(toolCall.function.arguments);
  const issueVerdicts = normalizeJudgeIssueVerdicts(payload.issueVerdicts);
  const introducedErrors = normalizeIntroducedErrors(payload.introducedErrors);
  const unnecessaryChanges = normalizeUnnecessaryChanges(payload.unnecessaryChanges);
  if (typeof payload.summary !== "string") {
    throw new Error("Judge summary must be a string");
  }

  const resolvedIssueCount = issueVerdicts.filter((issue) => issue.resolved).length;
  const allListedErrorsResolved = issueVerdicts.every((issue) => issue.resolved);
  const introducedNewErrors = introducedErrors.length > 0;
  const collateralDamageCount = unnecessaryChanges.filter((change) => change.harmful).length;
  const resolutionDenominator = issueVerdicts.length === 0 ? 1 : issueVerdicts.length;
  const resolutionRate = issueVerdicts.length === 0 ? 1 : resolvedIssueCount / issueVerdicts.length;
  const restraintPenalty =
    (introducedErrors.length * 0.5 + unnecessaryChanges.length * 0.15 + collateralDamageCount * 0.35) /
    resolutionDenominator;
  const qualityScore = Math.max(0, resolutionRate - restraintPenalty);
  const restraintScore = Math.max(0, 1 - restraintPenalty);
  const benchmarkScore = qualityScore * 100;

  return {
    judgeModel: judgeModel.label,
    issueVerdicts,
    allListedErrorsResolved,
    introducedNewErrors,
    introducedErrors,
    unnecessaryChanges,
    collateralDamageCount,
    resolvedIssueCount,
    resolutionRate,
    restraintScore,
    qualityScore,
    benchmarkScore,
    overallPass: allListedErrorsResolved && !introducedNewErrors && collateralDamageCount === 0,
    summary: payload.summary,
    outputTokens: response.usage.completion_tokens ?? 0,
    promptTokens: response.usage.prompt_tokens ?? 0
  };
}

export async function judgeAlternativeIssueResolutions(
  originalParagraphHtml: string,
  finalParagraphHtml: string,
  issues: ProofreadingIssue[],
  judgeModel: ModelVariant,
  options?: { timeoutMs?: number | null }
): Promise<AlternativeIssueJudgeResult> {
  async function requestAlternativeVerdicts(messages: OpenRouterMessage[]): Promise<{
    issueVerdicts: JudgeIssueVerdict[];
    summary: string;
    outputTokens: number;
    promptTokens: number;
  }> {
    const response = await requestChatCompletion(
      judgeModel.model,
      messages,
      [SUBMIT_ALTERNATIVE_RESOLUTION_TOOL],
      {
        toolChoice: {
          type: "function",
          function: {
            name: "submit_alternative_resolution_judgment"
          }
        },
        maxCompletionTokens: 500,
        parallelToolCalls: false,
        reasoning:
          judgeModel.reasoningEffort == null
            ? undefined
            : {
                effort: judgeModel.reasoningEffort
              },
        timeoutMs: options?.timeoutMs ?? undefined
      }
    );

    const toolCall = response.message.tool_calls?.find(
      (candidate) => candidate.function.name === "submit_alternative_resolution_judgment"
    );

    if (!toolCall) {
      throw new Error("Judge model did not call submit_alternative_resolution_judgment");
    }

    const payload = parseJudgePayload(toolCall.function.arguments);
    const issueVerdicts = normalizeJudgeIssueVerdicts(payload.issueVerdicts);
    const expectedIssueIds = new Set(issues.map((issue) => issue.id));
    const actualIssueIds = new Set(issueVerdicts.map((issue) => issue.issueId));

    if (issueVerdicts.length !== issues.length) {
      throw new Error(
        `Alternative judge returned ${issueVerdicts.length} verdicts for ${issues.length} requested issues`
      );
    }

    for (const issueId of expectedIssueIds) {
      if (!actualIssueIds.has(issueId)) {
        throw new Error(`Alternative judge omitted verdict for issue "${issueId}"`);
      }
    }

    for (const issueId of actualIssueIds) {
      if (!expectedIssueIds.has(issueId)) {
        throw new Error(`Alternative judge returned unexpected issue id "${issueId}"`);
      }
    }

    if (typeof payload.summary !== "string") {
      throw new Error("Judge summary must be a string");
    }

    return {
      issueVerdicts,
      summary: payload.summary,
      outputTokens: response.usage.completion_tokens ?? 0,
      promptTokens: response.usage.prompt_tokens ?? 0
    };
  }

  function inferVerdictFromNotes(notes: string): boolean | null {
    const sentences = notes
      .split(/(?<=[.!?])\s+/)
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    const conclusion = sentences.slice(-2).join(" ").toLowerCase();
    const positivePatterns = [
      /\b(valid alternative (fix|correction))\b/,
      /\b(equally valid fix|equally valid correction)\b/,
      /\b(counts as|therefore counts as)\b/,
      /\b(does resolve|is resolved|thus resolving|thus resolves|resolves the|resolving the)\b/,
      /\b(grammatically valid|grammatically correct)\b/,
      /\b(recognized english collocation)\b/
    ];
    const negativePatterns = [
      /\b(does not resolve|is not resolved)\b/,
      /\b(remains unresolved|still unresolved)\b/,
      /\b(leaves the issue unresolved)\b/,
      /\b(still incorrect)\b/,
      /\b(preserves the .* error)\b/
    ];
    const hasPositive = positivePatterns.some((pattern) => pattern.test(conclusion));
    const hasNegative = negativePatterns.some((pattern) => pattern.test(conclusion));

    if (hasPositive && !hasNegative) {
      return true;
    }

    if (hasNegative && !hasPositive) {
      return false;
    }

    return null;
  }

  function normalizeVerdictsToNotes(issueVerdicts: JudgeIssueVerdict[]): JudgeIssueVerdict[] {
    return issueVerdicts.map((verdict) => {
      const inferred = inferVerdictFromNotes(verdict.notes);

      if (inferred == null || inferred === verdict.resolved) {
        return verdict;
      }

      return {
        ...verdict,
        resolved: inferred
      };
    });
  }

  function hasVerdictNoteContradiction(verdict: JudgeIssueVerdict): boolean {
    const notes = verdict.notes.toLowerCase();
    const positiveSignals = [
      "valid alternative fix",
      "valid alternative correction",
      "equally valid fix",
      "does resolve",
      "is resolved",
      "this resolves",
      "counts as a valid alternative",
      "core issue",
      "is fixed",
      "grammatically valid and not erroneous",
      "recognized english collocation"
    ];
    const negativeSignals = [
      "does not resolve",
      "is not resolved",
      "remains unresolved",
      "still unresolved",
      "leaves the issue unresolved",
      "replaces the issue with a new mistake",
      "still incorrect"
    ];
    const impliesResolved =
      positiveSignals.some((signal) => notes.includes(signal)) &&
      !negativeSignals.some((signal) => notes.includes(signal));
    const impliesUnresolved = negativeSignals.some((signal) => notes.includes(signal));

    if (!verdict.resolved && impliesResolved) {
      return true;
    }

    if (verdict.resolved && impliesUnresolved) {
      return true;
    }

    return false;
  }

  async function requestAlternativeBooleanRepair(messages: OpenRouterMessage[]): Promise<{
    issueVerdicts: Array<{ issueId: string; resolved: boolean }>;
    summary: string;
    outputTokens: number;
    promptTokens: number;
  }> {
    const response = await requestChatCompletion(
      judgeModel.model,
      messages,
      [SUBMIT_ALTERNATIVE_RESOLUTION_REPAIR_TOOL],
      {
        toolChoice: {
          type: "function",
          function: {
            name: "submit_alternative_resolution_repair"
          }
        },
        maxCompletionTokens: 250,
        parallelToolCalls: false,
        reasoning:
          judgeModel.reasoningEffort == null
            ? undefined
            : {
                effort: judgeModel.reasoningEffort
              },
        timeoutMs: options?.timeoutMs ?? undefined
      }
    );

    const toolCall = response.message.tool_calls?.find(
      (candidate) => candidate.function.name === "submit_alternative_resolution_repair"
    );

    if (!toolCall) {
      throw new Error("Judge model did not call submit_alternative_resolution_repair");
    }

    const payload = parseJudgePayload(toolCall.function.arguments);
    if (!Array.isArray(payload.issueVerdicts)) {
      throw new Error("Alternative repair judge issueVerdicts must be an array");
    }

    const issueVerdicts = payload.issueVerdicts.map((item, index) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new Error(`Alternative repair issueVerdicts[${index}] must be an object`);
      }

      const record = item as Record<string, unknown>;

      if (typeof record.issueId !== "string") {
        throw new Error(`Alternative repair issueVerdicts[${index}].issueId must be a string`);
      }

      if (typeof record.resolved !== "boolean") {
        throw new Error(`Alternative repair issueVerdicts[${index}].resolved must be a boolean`);
      }

      return {
        issueId: record.issueId,
        resolved: record.resolved
      };
    });
    const expectedIssueIds = new Set(issues.map((issue) => issue.id));
    const actualIssueIds = new Set(issueVerdicts.map((issue) => issue.issueId));

    if (issueVerdicts.length !== issues.length) {
      throw new Error(
        `Alternative repair judge returned ${issueVerdicts.length} verdicts for ${issues.length} requested issues`
      );
    }

    for (const issueId of expectedIssueIds) {
      if (!actualIssueIds.has(issueId)) {
        throw new Error(`Alternative repair judge omitted verdict for issue "${issueId}"`);
      }
    }

    for (const issueId of actualIssueIds) {
      if (!expectedIssueIds.has(issueId)) {
        throw new Error(`Alternative repair judge returned unexpected issue id "${issueId}"`);
      }
    }

    if (typeof payload.summary !== "string") {
      throw new Error("Judge summary must be a string");
    }

    return {
      issueVerdicts,
      summary: payload.summary,
      outputTokens: response.usage.completion_tokens ?? 0,
      promptTokens: response.usage.prompt_tokens ?? 0
    };
  }

  let result = await requestAlternativeVerdicts(
    buildAlternativeResolutionJudgeMessages(originalParagraphHtml, finalParagraphHtml, issues)
  );

  if (result.issueVerdicts.some((verdict) => hasVerdictNoteContradiction(verdict))) {
    const repaired = await requestAlternativeBooleanRepair(
      buildAlternativeResolutionRepairMessages(
        originalParagraphHtml,
        finalParagraphHtml,
        issues,
        result.issueVerdicts
      )
    );
    const repairedVerdictMap = new Map(repaired.issueVerdicts.map((verdict) => [verdict.issueId, verdict.resolved]));
    result = {
      issueVerdicts: result.issueVerdicts.map((verdict) => ({
        ...verdict,
        resolved: repairedVerdictMap.get(verdict.issueId) ?? verdict.resolved
      })),
      summary: repaired.summary,
      outputTokens: result.outputTokens + repaired.outputTokens,
      promptTokens: result.promptTokens + repaired.promptTokens
    };
  }

  return {
    judgeModel: judgeModel.label,
    issueVerdicts: result.issueVerdicts,
    summary: result.summary,
    outputTokens: result.outputTokens,
    promptTokens: result.promptTokens
  };
}
