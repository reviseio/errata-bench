import { ParagraphDocument, createParagraphMap, renderDocumentHtml } from "./document.js";
import { requestChatCompletion, type OpenRouterMessage, type OpenRouterToolCall, type OpenRouterToolDefinition } from "./openrouter.js";
import type {
  CaseChunkRun,
  ChunkDecision,
  FindAndReplaceArgs,
  PassTurnTrace,
  ProofreadingCompleteArgs,
  ProofreadingCase,
  ReplaceParagraphArgs,
  RunCase,
  ToolExecution,
  ToolName,
  ToolResult
} from "./types.js";

const EDIT_TOOLS: OpenRouterToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "find_and_replace",
      description:
        "Apply an exact text replacement inside one paragraph. Use this for local typo or punctuation fixes when the surrounding paragraph should stay unchanged. The replacement is applied to every exact match within that paragraph's inner HTML.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          paragraphId: {
            type: "string",
            description: "The paragraph id, such as p1."
          },
          find: {
            type: "string",
            description: "The exact text to find inside that paragraph."
          },
          replace: {
            type: "string",
            description: "The replacement text."
          }
        },
        required: ["paragraphId", "find", "replace"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "replace_paragraph",
      description:
        "Replace an entire paragraph when it needs a broader grammatical repair that is awkward to express as a small find/replace. The new HTML must remain a single <p> element with the same paragraph id.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          paragraphId: {
            type: "string",
            description: "The paragraph id, such as p2."
          },
          newParagraphHtml: {
            type: "string",
            description: "The full replacement paragraph HTML, for example <p id=\"p2\">Corrected text.</p>"
          }
        },
        required: ["paragraphId", "newParagraphHtml"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "proofreading_complete",
      description:
        "Finish proofreading the current document chunk. Call this only when the current chunk looks fully proofread and no more turns are needed for this chunk.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          note: {
            type: "string",
            description: "Optional brief note explaining why the document looks complete."
          }
        },
        required: []
      }
    }
  }
];

export const DEFAULT_MAX_TURNS_PER_CHUNK = 3;
export const DEFAULT_MAX_COMPLETION_TOKENS_PER_TURN = 8_192;
export const DEFAULT_MAX_WORDS_PER_CHUNK = 3_000;

export type RunProgressUpdate = {
  chunkIndex: number;
  chunkCount: number;
  turn: number;
  maxTurnsPerChunk: number;
  requestCount: number;
};

function buildChunkName(chunkIndex: number): string {
  return `proofread-chunk-${chunkIndex}`;
}

function buildChunkInstruction(chunkIndex: number, chunkCount: number, maxTurnsPerChunk: number): string {
  return `Conservatively proofread chunk ${chunkIndex} of ${chunkCount}. You may use at most ${maxTurnsPerChunk} turns for this chunk.`;
}

function summarizePriorTurnToolCounts(toolExecutions: ToolExecution[]): string {
  if (toolExecutions.length === 0) {
    return "No prior tool calls have been made for this chunk yet.";
  }

  const countsByTurn = new Map<number, number>();

  for (const execution of toolExecutions) {
    countsByTurn.set(execution.turn, (countsByTurn.get(execution.turn) ?? 0) + 1);
  }

  return `Prior tool calls by turn: ${[...countsByTurn.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([turn, count]) => `turn ${turn}: ${count}`)
    .join("; ")}.`;
}

function buildTurnStatusPrompt(turn: number, maxTurnsPerChunk: number, toolExecutions: ToolExecution[]): string {
  return [
    `This is turn ${turn} out of ${maxTurnsPerChunk} maximum turns you will get for this chunk.`,
    "You will move on to the next chunk when you call proofreading_complete or when the turn limit is reached.",
    "Fix every issue you see in this text in this turn - do not put off fixes until future turns.",
    "If you see no remaining proofreading problems in this chunk, stop only by calling proofreading_complete.",
    summarizePriorTurnToolCounts(toolExecutions)
  ].join(" ");
}

function buildSystemPrompt(
  chunkIndex: number,
  chunkCount: number,
  maxTurnsPerChunk: number,
  chunkParagraphIds: string[]
): string {
  return [
    "You are a careful proofreader editing one chunk of a larger HTML document made of <p id=\"...\"> paragraphs.",
    "Proofread the provided chunk of text for any and all issues and mistakes you can find. Your goal is to leave the text in pristine shape while preserving its original meaning.",
    "Edit the text by calling the tools provided - do NOT print the corrected text in full.",
    "Do not provide analysis, commentary, bullet lists, or any prose outside tool calls.",
    "Begin with editing tool calls immediately. Do not spend tokens restating the task.",
    `Batch independent edits together whenever possible. In this response, emit all tool calls needed to fix every issue you spot in this chunk turn - you have a limited number of turns.`,
    "Prefer find_and_replace for small local fixes. Use replace_paragraph only when a paragraph needs a broader rewrite.",
    "Preserve paragraph ids, paragraph order, meaning, tone, and intentionally odd details that are not proofreading mistakes.",
    "Do not touch paragraphs that are already correct.",
    `You may edit only these paragraph ids in this chunk: ${chunkParagraphIds.join(", ")}.`,
    "If the current chunk now looks fully proofread, call proofreading_complete to end processing for this chunk immediately.",
    "Do not end the chunk implicitly by stopping tool use. The chunk ends only when you call proofreading_complete or when the harness reaches the chunk turn limit.",
    "If you do not call proofreading_complete, the harness will keep the current chunk open until the chunk turn limit is reached.",
    "If you call proofreading_complete, keep the note brief or omit it entirely.",
    "Do not print the full document."
  ].join(" ");
}

function buildUserPrompt(
  sample: ProofreadingCase,
  currentChunkHtml: string,
  chunkIndex: number,
  chunkCount: number,
  chunkParagraphIds: string[]
): string {
  return [
    `Task: ${sample.instruction}`,
    `Current chunk: ${chunkIndex}/${chunkCount}`,
    `Chunk paragraph ids: ${chunkParagraphIds.join(", ")}`,
    "",
    "Current chunk HTML:",
    currentChunkHtml
  ].join("\n");
}

function estimateOutputTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function buildToolResultMessageContent(toolExecution: ToolExecution): string {
  return JSON.stringify({
    turn: toolExecution.turn,
    sequence: toolExecution.sequence,
    toolName: toolExecution.toolName,
    paragraphId: toolExecution.paragraphId,
    ok: toolExecution.result.ok,
    message: toolExecution.result.message,
    ...(toolExecution.result.updatedParagraphHtml != null
      ? { updatedParagraphHtml: toolExecution.result.updatedParagraphHtml }
      : {}),
    ...(toolExecution.result.replacementsApplied != null
      ? { replacementsApplied: toolExecution.result.replacementsApplied }
      : {}),
    ...(toolExecution.result.decision != null ? { decision: toolExecution.result.decision } : {})
  });
}

function parseJsonArguments(rawArguments: string): Record<string, unknown> {
  const parsed = JSON.parse(rawArguments) as unknown;

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Tool arguments must be a JSON object.");
  }

  return parsed as Record<string, unknown>;
}

function executeTool(
  document: ParagraphDocument,
  toolCall: OpenRouterToolCall,
  sequence: number,
  chunkIndex: number,
  turn: number,
  allowedParagraphIds?: Set<string>
): ToolExecution {
  let parsed: Record<string, unknown> = {};

  try {
    parsed = parseJsonArguments(toolCall.function.arguments);

    if (toolCall.function.name === "find_and_replace") {
      if (
        typeof parsed.paragraphId !== "string" ||
        typeof parsed.find !== "string" ||
        typeof parsed.replace !== "string"
      ) {
        throw new Error("find_and_replace requires string paragraphId, find, and replace fields.");
      }

      const args: FindAndReplaceArgs = {
        paragraphId: parsed.paragraphId,
        find: parsed.find,
        replace: parsed.replace
      };
      const beforeParagraphHtml = document.getParagraphHtml(args.paragraphId);

      if (allowedParagraphIds && !allowedParagraphIds.has(args.paragraphId)) {
        throw new Error(`Paragraph "${args.paragraphId}" is not in the current chunk.`);
      }

      const result = document.findAndReplace(args);

      return {
        sequence,
        chunkIndex,
        turn,
        paragraphId: args.paragraphId,
        beforeParagraphHtml,
        afterParagraphHtml: document.getParagraphHtml(args.paragraphId),
        toolCallId: toolCall.id,
        toolName: "find_and_replace",
        arguments: args,
        result
      };
    }

    if (toolCall.function.name === "replace_paragraph") {
      if (typeof parsed.paragraphId !== "string" || typeof parsed.newParagraphHtml !== "string") {
        throw new Error("replace_paragraph requires string paragraphId and newParagraphHtml fields.");
      }

      const args: ReplaceParagraphArgs = {
        paragraphId: parsed.paragraphId,
        newParagraphHtml: parsed.newParagraphHtml
      };
      const beforeParagraphHtml = document.getParagraphHtml(args.paragraphId);

      if (allowedParagraphIds && !allowedParagraphIds.has(args.paragraphId)) {
        throw new Error(`Paragraph "${args.paragraphId}" is not in the current chunk.`);
      }

      const result = document.replaceParagraph(args);

      return {
        sequence,
        chunkIndex,
        turn,
        paragraphId: args.paragraphId,
        beforeParagraphHtml,
        afterParagraphHtml: document.getParagraphHtml(args.paragraphId),
        toolCallId: toolCall.id,
        toolName: "replace_paragraph",
        arguments: args,
        result
      };
    }

    if (toolCall.function.name === "proofreading_complete") {
      if (parsed.note !== undefined && typeof parsed.note !== "string") {
        throw new Error("proofreading_complete accepts an optional string note.");
      }

      const args: ProofreadingCompleteArgs = {
        note: typeof parsed.note === "string" ? parsed.note : undefined
      };

      return {
        sequence,
        chunkIndex,
        turn,
        paragraphId: null,
        beforeParagraphHtml: null,
        afterParagraphHtml: null,
        toolCallId: toolCall.id,
        toolName: "proofreading_complete",
        arguments: args,
        result: {
          ok: true,
          decision: "stop",
          message: buildProofreadingCompleteMessage(args)
        }
      };
    }

    throw new Error(`Unknown tool "${toolCall.function.name}".`);
  } catch (error) {
    const result: ToolResult = {
      ok: false,
      paragraphId: "",
      updatedParagraphHtml: "",
      message: error instanceof Error ? error.message : String(error)
    };

    return {
      sequence,
      chunkIndex,
      turn,
      paragraphId: typeof parsed.paragraphId === "string" ? parsed.paragraphId : null,
      beforeParagraphHtml:
        typeof parsed.paragraphId === "string" ? document.getParagraphHtml(parsed.paragraphId as string) : null,
      afterParagraphHtml:
        typeof parsed.paragraphId === "string" ? document.getParagraphHtml(parsed.paragraphId as string) : null,
      toolCallId: toolCall.id,
      toolName: toolCall.function.name as ToolName,
      arguments: {},
      result
    };
  }
}

function buildProofreadingCompleteMessage(args: ProofreadingCompleteArgs): string {
  const note = args.note?.trim() ?? "";
  return note.length > 0 ? `STOP: ${note}` : "STOP: Model marked the current chunk as fully proofread.";
}

function buildImplicitStopMessage(reason: string): string {
  const trimmed = reason.trim();
  return trimmed.length > 0 ? `STOP: ${trimmed}` : "STOP";
}

function buildImplicitContinueMessage(reason: string): string {
  const trimmed = reason.trim();
  return trimmed.length > 0 ? `CONTINUE: ${trimmed}` : "CONTINUE";
}

function logVerbose(enabled: boolean | undefined, message: string): void {
  if (enabled) {
    console.error(`[runner] ${message}`);
  }
}

function countWordsInParagraphHtml(html: string): number {
  const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

  if (text.length === 0) {
    return 0;
  }

  return text.split(" ").length;
}

function buildParagraphChunks(paragraphs: { id: string; html: string }[], maxWordsPerChunk: number | null): string[][] {
  if (maxWordsPerChunk == null || maxWordsPerChunk <= 0) {
    return [paragraphs.map((paragraph) => paragraph.id)];
  }

  const chunks: string[][] = [];
  let currentChunk: string[] = [];
  let currentChunkWords = 0;

  for (const paragraph of paragraphs) {
    const paragraphWords = Math.max(1, countWordsInParagraphHtml(paragraph.html));

    if (currentChunk.length > 0 && currentChunkWords + paragraphWords > maxWordsPerChunk) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentChunkWords = 0;
    }

    currentChunk.push(paragraph.id);
    currentChunkWords += paragraphWords;
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  return chunks.length > 0 ? chunks : [paragraphs.map((paragraph) => paragraph.id)];
}

function renderChunkHtml(document: ParagraphDocument, paragraphIds: string[]): string {
  const idSet = new Set(paragraphIds);
  return renderDocumentHtml(document.toParagraphs().filter((paragraph) => idSet.has(paragraph.id)));
}

function buildMockChunkRun(
  sample: ProofreadingCase,
  document: ParagraphDocument,
  chunkIndex: number,
  chunkCount: number,
  chunkParagraphIds: string[],
  maxTurnsPerChunk: number
): CaseChunkRun {
  const expectedById = createParagraphMap(sample.expectedParagraphs);
  const toolExecutions: ToolExecution[] = [];
  let outputTokens = 0;
  const startingDocumentHtml = renderChunkHtml(document, chunkParagraphIds);
  const issuesByParagraph = new Map<string, ProofreadingCase["issues"]>();

  for (const issue of sample.issues) {
    const paragraphIssues = issuesByParagraph.get(issue.paragraphId) ?? [];
    paragraphIssues.push(issue);
    issuesByParagraph.set(issue.paragraphId, paragraphIssues);
  }

  const chunkParagraphIdSet = new Set(chunkParagraphIds);

  for (const paragraph of sample.paragraphs) {
    if (!chunkParagraphIdSet.has(paragraph.id)) {
      continue;
    }

    const paragraphIssues = issuesByParagraph.get(paragraph.id) ?? [];

    if (paragraphIssues.length === 0) {
      continue;
    }

    const toolSequence = toolExecutions.length + 1;

    if (paragraphIssues.length === 1) {
      const issue = paragraphIssues[0];
      const args: FindAndReplaceArgs = {
        paragraphId: issue.paragraphId,
        find: issue.expectedCorrection.find,
        replace: issue.expectedCorrection.replace
      };
      const toolCall: OpenRouterToolCall = {
        id: `mock-call-${buildChunkName(chunkIndex)}-${toolSequence}`,
        type: "function",
        function: {
          name: "find_and_replace",
          arguments: JSON.stringify(args)
        }
      };

      toolExecutions.push(executeTool(document, toolCall, toolSequence, chunkIndex, 1, chunkParagraphIdSet));
      outputTokens += estimateOutputTokens(toolCall.function.arguments);
      continue;
    }

    const expectedParagraphHtml = expectedById.get(paragraph.id)?.html;

    if (!expectedParagraphHtml) {
      throw new Error(`Missing expected paragraph for "${paragraph.id}" in mock run`);
    }

    const args: ReplaceParagraphArgs = {
      paragraphId: paragraph.id,
      newParagraphHtml: expectedParagraphHtml
    };
    const toolCall: OpenRouterToolCall = {
      id: `mock-call-${buildChunkName(chunkIndex)}-${toolSequence}`,
      type: "function",
      function: {
        name: "replace_paragraph",
        arguments: JSON.stringify(args)
      }
    };

    toolExecutions.push(executeTool(document, toolCall, toolSequence, chunkIndex, 1, chunkParagraphIdSet));
    outputTokens += estimateOutputTokens(toolCall.function.arguments);
  }

  const finishArgs: ProofreadingCompleteArgs = {
    note: "Applied the proofreading edits. The current chunk is now clean."
  };
  const finishCall: OpenRouterToolCall = {
    id: `mock-call-${buildChunkName(chunkIndex)}-finish`,
    type: "function",
    function: {
      name: "proofreading_complete",
      arguments: JSON.stringify(finishArgs)
    }
  };
  const finishExecution = executeTool(document, finishCall, toolExecutions.length + 1, chunkIndex, 1);
  toolExecutions.push(finishExecution);
  const finalAssistantMessage = buildProofreadingCompleteMessage(finishArgs);
  outputTokens += estimateOutputTokens(finishCall.function.arguments);

  return {
    chunkName: buildChunkName(chunkIndex),
    chunkInstruction: buildChunkInstruction(chunkIndex, chunkCount, maxTurnsPerChunk),
    chunkIndex,
    chunkCount,
    chunkParagraphIds,
    startingDocumentHtml,
    endingDocumentHtml: renderChunkHtml(document, chunkParagraphIds),
    turnTraces: [],
    toolExecutions,
    finalAssistantMessage,
    decision: "stop",
    outputTokens,
    promptTokens: 0,
    durationMs: 0
  };
}

function buildMockRun(sample: ProofreadingCase, maxTurnsPerChunk: number, maxWordsPerChunk: number | null): RunCase {
  const document = new ParagraphDocument(sample.paragraphs);
  const chunks: CaseChunkRun[] = [];
  const chunkParagraphGroups = buildParagraphChunks(sample.paragraphs, maxWordsPerChunk);

  chunkParagraphGroups.forEach((chunkParagraphIds, chunkIndex) => {
    chunks.push(
      buildMockChunkRun(sample, document, chunkIndex + 1, chunkParagraphGroups.length, chunkParagraphIds, maxTurnsPerChunk)
    );
  });

  return {
    caseId: sample.id,
    instruction: sample.instruction,
    initialDocumentHtml: renderDocumentHtml(sample.paragraphs),
    expectedDocumentHtml: renderDocumentHtml(sample.expectedParagraphs),
    finalDocumentHtml: document.toHtml(),
    issues: sample.issues,
    chunks,
    finalAssistantMessage: chunks[chunks.length - 1]?.finalAssistantMessage ?? "",
    terminationReason: "model_stop",
    outputTokens: chunks.reduce((sum, chunk) => sum + chunk.outputTokens, 0),
    promptTokens: chunks.reduce((sum, chunk) => sum + chunk.promptTokens, 0),
    durationMs: chunks.reduce((sum, chunk) => sum + chunk.durationMs, 0)
  };
}

async function runLiveChunk(
  sample: ProofreadingCase,
  document: ParagraphDocument,
  model: string,
  chunkIndex: number,
  chunkCount: number,
  chunkParagraphIds: string[],
  maxTurnsPerChunk: number,
  options?: {
    verbose?: boolean;
    requestTimeoutMs?: number | null;
    maxCompletionTokensPerTurn?: number | null;
    reasoningEffort?: string | null;
    reasoningExclude?: boolean;
    reasoningMaxTokens?: number | null;
    requestCountStart?: number;
    onProgress?: ((update: RunProgressUpdate) => void) | null;
  }
): Promise<CaseChunkRun> {
  const startedAt = Date.now();
  const allowedParagraphIds = new Set(chunkParagraphIds);
  const startingDocumentHtml = renderChunkHtml(document, chunkParagraphIds);
  const messages: OpenRouterMessage[] = [
    {
      role: "system",
      content: buildSystemPrompt(chunkIndex, chunkCount, maxTurnsPerChunk, chunkParagraphIds)
    },
    {
      role: "user",
      content: buildUserPrompt(sample, startingDocumentHtml, chunkIndex, chunkCount, chunkParagraphIds)
    }
  ];
  const toolExecutions: ToolExecution[] = [];
  const turnTraces: PassTurnTrace[] = [];
  let outputTokens = 0;
  let promptTokens = 0;
  let finalAssistantMessage = "";
  let finalDecision: ChunkDecision = "continue";
  let requestCount = options?.requestCountStart ?? 0;
  logVerbose(
    options?.verbose,
    `chunk_start case=${sample.id} chunk=${chunkIndex}/${chunkCount} model=${model} document_chars=${startingDocumentHtml.length}`
  );

  for (let turn = 1; turn <= maxTurnsPerChunk; turn += 1) {
    /*
    messages.push({
      role: "system",
      content: buildTurnStatusPrompt(turn, maxTurnsPerChunk, toolExecutions)
    });
    */
    logVerbose(
      options?.verbose,
      `turn_start case=${sample.id} chunk=${chunkIndex}/${chunkCount} turn=${turn}/${maxTurnsPerChunk} messages=${messages.length}`
    );
    options?.onProgress?.({
      chunkIndex,
      chunkCount,
      turn,
      maxTurnsPerChunk,
      requestCount: requestCount + 1
    });
    const response = await requestChatCompletion(model, messages, EDIT_TOOLS, {
      maxCompletionTokens: options?.maxCompletionTokensPerTurn ?? DEFAULT_MAX_COMPLETION_TOKENS_PER_TURN,
      parallelToolCalls: true,
      reasoning:
        options?.reasoningEffort != null || options?.reasoningExclude || options?.reasoningMaxTokens != null
          ? {
              effort: options?.reasoningEffort ?? undefined,
              exclude: options?.reasoningExclude,
              maxTokens: options?.reasoningMaxTokens ?? undefined
            }
          : undefined,
      timeoutMs: options?.requestTimeoutMs ?? undefined,
      verbose: options?.verbose,
      debugLabel: `case=${sample.id} chunk=${chunkIndex} turn=${turn}`
    });
    requestCount += 1;
    outputTokens += response.usage.completion_tokens ?? 0;
    promptTokens += response.usage.prompt_tokens ?? 0;
    messages.push(response.message);

    const toolCalls = response.message.tool_calls ?? [];
    turnTraces.push({
      turn,
      requestDurationMs: response.debug.requestDurationMs,
      finishReason: response.finishReason,
      assistantContent: response.message.content,
      toolCallCount: toolCalls.length,
      rawToolCallCount: response.debug.rawToolCallCount,
      rawContentPartTypes: response.debug.rawContentPartTypes,
      rawContentPreview: response.debug.rawContentPreview,
      reasoningTextLength: response.debug.reasoningTextLength,
      reasoningDetailsCount: response.debug.reasoningDetailsCount
    });
    logVerbose(
      options?.verbose,
      `turn_done case=${sample.id} chunk=${chunkIndex}/${chunkCount} turn=${turn} elapsed_ms=${response.debug.requestDurationMs} finish_reason=${
        response.finishReason ?? "null"
      } tool_calls=${toolCalls.length} prompt_tokens=${response.usage.prompt_tokens ?? 0} completion_tokens=${
        response.usage.completion_tokens ?? 0
      } reasoning_text_length=${response.debug.reasoningTextLength}`
    );

    if (toolCalls.length === 0) {
      logVerbose(
        options?.verbose,
        `turn_no_tools case=${sample.id} chunk=${chunkIndex}/${chunkCount} turn=${turn} assistant_message=${JSON.stringify(
          response.message.content?.trim() ?? ""
        )}`
      );

      if (turn === maxTurnsPerChunk) {
        finalDecision = "continue";
        finalAssistantMessage = buildImplicitContinueMessage(
          "Reached the turn limit for this chunk without proofreading_complete."
        );
        logVerbose(
          options?.verbose,
          `chunk_hit_turn_limit case=${sample.id} chunk=${chunkIndex}/${chunkCount} tool_executions=${toolExecutions.length}`
        );
        break;
      }

      continue;
    }

    let completionExecution: ToolExecution | null = null;

    for (const toolCall of toolCalls) {
      const toolExecution = executeTool(document, toolCall, toolExecutions.length + 1, chunkIndex, turn, allowedParagraphIds);
      toolExecutions.push(toolExecution);
      logVerbose(
        options?.verbose,
        `tool_exec case=${sample.id} chunk=${chunkIndex}/${chunkCount} turn=${turn} tool=${toolExecution.toolName} ok=${
          toolExecution.result.ok
        } message=${JSON.stringify(toolExecution.result.message)}`
      );

      if (toolExecution.toolName === "proofreading_complete") {
        completionExecution = toolExecution;
        continue;
      }

      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: buildToolResultMessageContent(toolExecution)
      });
    }

    if (completionExecution) {
      finalAssistantMessage =
        completionExecution.result.message ||
        buildImplicitStopMessage("Model marked the current chunk complete.");
      finalDecision = "stop";
      logVerbose(
        options?.verbose,
        `chunk_finish_tool case=${sample.id} chunk=${chunkIndex}/${chunkCount} decision=${finalDecision} message=${JSON.stringify(finalAssistantMessage)}`
      );
      break;
    }

    if (turn === maxTurnsPerChunk) {
      finalDecision = "continue";
      finalAssistantMessage = buildImplicitContinueMessage(
        "Reached the turn limit for this chunk after applying the latest edits."
      );
      logVerbose(
        options?.verbose,
        `chunk_hit_turn_limit case=${sample.id} chunk=${chunkIndex}/${chunkCount} tool_executions=${toolExecutions.length}`
      );
      break;
    }
  }

  if (finalAssistantMessage.length === 0) {
    finalAssistantMessage = buildImplicitContinueMessage("Reached the turn limit for this chunk.");
    finalDecision = "continue";
  }

  logVerbose(
    options?.verbose,
    `chunk_done case=${sample.id} chunk=${chunkIndex}/${chunkCount} decision=${finalDecision} tool_executions=${toolExecutions.length} output_tokens=${outputTokens} duration_ms=${
      Date.now() - startedAt
    }`
  );

  return {
    chunkName: buildChunkName(chunkIndex),
    chunkInstruction: buildChunkInstruction(chunkIndex, chunkCount, maxTurnsPerChunk),
    chunkIndex,
    chunkCount,
    chunkParagraphIds,
    startingDocumentHtml,
    endingDocumentHtml: renderChunkHtml(document, chunkParagraphIds),
    turnTraces,
    toolExecutions,
    finalAssistantMessage,
    decision: finalDecision,
    outputTokens,
    promptTokens,
    durationMs: Date.now() - startedAt
  };
}

export async function runBenchmarkCase(
  sample: ProofreadingCase,
  options: {
    mock: boolean;
    model: string;
    maxTurnsPerChunk?: number;
    verbose?: boolean;
    requestTimeoutMs?: number | null;
    maxCompletionTokensPerTurn?: number | null;
    reasoningEffort?: string | null;
    reasoningExclude?: boolean;
    reasoningMaxTokens?: number | null;
    maxWordsPerChunk?: number | null;
    onProgress?: ((update: RunProgressUpdate) => void) | null;
  }
): Promise<RunCase> {
  const maxTurnsPerChunk = options.maxTurnsPerChunk ?? DEFAULT_MAX_TURNS_PER_CHUNK;
  const maxWordsPerChunk = options.maxWordsPerChunk ?? DEFAULT_MAX_WORDS_PER_CHUNK;

  if (options.mock) {
    return buildMockRun(sample, maxTurnsPerChunk, maxWordsPerChunk);
  }

  const document = new ParagraphDocument(sample.paragraphs);
  const chunks: CaseChunkRun[] = [];
  const chunkParagraphGroups = buildParagraphChunks(sample.paragraphs, maxWordsPerChunk);
  let hitChunkTurnLimit = false;
  let requestCount = 0;
  logVerbose(
    options.verbose,
    `case_start case=${sample.id} model=${options.model} max_turns_per_chunk=${maxTurnsPerChunk}`
  );

  for (let chunkIndex = 1; chunkIndex <= chunkParagraphGroups.length; chunkIndex += 1) {
    const chunkParagraphIds = chunkParagraphGroups[chunkIndex - 1];
    const chunkRun = await runLiveChunk(
      sample,
      document,
      options.model,
      chunkIndex,
      chunkParagraphGroups.length,
      chunkParagraphIds,
      maxTurnsPerChunk,
      {
        verbose: options.verbose,
        requestTimeoutMs: options.requestTimeoutMs ?? null,
        maxCompletionTokensPerTurn: options.maxCompletionTokensPerTurn ?? null,
        reasoningEffort: options.reasoningEffort ?? null,
        reasoningExclude: options.reasoningExclude,
        reasoningMaxTokens: options.reasoningMaxTokens ?? null,
        requestCountStart: requestCount,
        onProgress: options.onProgress ?? null
      }
    );
    chunks.push(chunkRun);
    requestCount += chunkRun.turnTraces.length;

    if (chunkRun.decision !== "stop") {
      hitChunkTurnLimit = true;
    }
  }

  return {
    caseId: sample.id,
    instruction: sample.instruction,
    initialDocumentHtml: renderDocumentHtml(sample.paragraphs),
    expectedDocumentHtml: renderDocumentHtml(sample.expectedParagraphs),
    finalDocumentHtml: document.toHtml(),
    issues: sample.issues,
    chunks,
    finalAssistantMessage: chunks[chunks.length - 1]?.finalAssistantMessage ?? "",
    terminationReason: hitChunkTurnLimit ? "max_turns" : "model_stop",
    outputTokens: chunks.reduce((sum, chunk) => sum + chunk.outputTokens, 0),
    promptTokens: chunks.reduce((sum, chunk) => sum + chunk.promptTokens, 0),
    durationMs: chunks.reduce((sum, chunk) => sum + chunk.durationMs, 0)
  };
}
