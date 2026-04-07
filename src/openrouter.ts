import {
  getApiEndpointLabel,
  getApiKey,
  getApiProvider,
  getApiProviderLabel,
  getChatCompletionsUrl,
  shouldIncludeReasoning
} from "./api-config.js";

type MessageContentPart = {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  arguments?: unknown;
  function?: {
    name?: string;
    arguments?: unknown;
  };
};

export type OpenRouterToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

export type OpenRouterMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id?: string;
  tool_calls?: OpenRouterToolCall[];
  reasoning?: string | null;
  reasoning_details?: unknown[];
};

export type OpenRouterToolDefinition = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required: string[];
      additionalProperties?: boolean;
    };
  };
};

export type OpenRouterToolChoice =
  | "auto"
  | "none"
  | {
      type: "function";
      function: {
        name: string;
      };
    };

type OpenRouterUsage = {
  completion_tokens?: number;
  prompt_tokens?: number;
  total_tokens?: number;
};

type ChatCompletionResponse = {
  choices?: Array<{
    finish_reason?: string | null;
    message?: {
      role?: string;
      content?: string | MessageContentPart[] | null;
      reasoning?: string | MessageContentPart[] | null;
      reasoning_details?: unknown[];
      tool_calls?: OpenRouterToolCall[];
    };
  }>;
  usage?: OpenRouterUsage;
};

type OpenRouterProviderRouting = {
  only?: string[];
  order?: string[];
  allow_fallbacks?: boolean;
  require_parameters?: boolean;
};

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const cause =
      "cause" in error && error.cause instanceof Error
        ? error.cause.message
        : "cause" in error && error.cause != null
          ? String(error.cause)
          : null;

    return cause == null ? error.message : `${error.message} (cause: ${cause})`;
  }

  return String(error);
}

function extractTextContent(content: string | MessageContentPart[] | null | undefined): string | null {
  if (typeof content === "string") {
    const trimmed = content.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  if (Array.isArray(content)) {
    const text = content
      .filter((part) => (part.type === "text" || part.type === "output_text" || part.type == null) && typeof part.text === "string")
      .map((part) => part.text?.trim() ?? "")
      .join("\n")
      .trim();

    return text.length > 0 ? text : null;
  }

  return null;
}

function extractReasoningContent(content: string | MessageContentPart[] | null | undefined): string | null {
  if (typeof content === "string") {
    const trimmed = content.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  if (Array.isArray(content)) {
    const text = content
      .filter((part) => typeof part.text === "string")
      .map((part) => part.text?.trim() ?? "")
      .join("\n")
      .trim();

    return text.length > 0 ? text : null;
  }

  return null;
}

function normalizeToolCalls(
  toolCalls: OpenRouterToolCall[] | undefined,
  content: string | MessageContentPart[] | null | undefined
): OpenRouterToolCall[] | undefined {
  if (Array.isArray(toolCalls) && toolCalls.length > 0) {
    return toolCalls;
  }

  if (!Array.isArray(content)) {
    return undefined;
  }

  const inferredToolCalls: OpenRouterToolCall[] = [];

  for (const part of content) {
    const isToolishPart =
      part.type === "tool_call" || part.type === "function_call" || part.type === "tool_use";

    if (!isToolishPart && !part.function && typeof part.name !== "string") {
      continue;
    }

    const functionName =
      typeof part.function?.name === "string"
        ? part.function.name
        : typeof part.name === "string"
          ? part.name
          : null;

    if (!functionName) {
      continue;
    }

    const rawArguments = part.function?.arguments ?? part.arguments ?? part.input ?? {};
    const normalizedArguments =
      typeof rawArguments === "string" ? rawArguments : JSON.stringify(rawArguments);

    inferredToolCalls.push({
      id: typeof part.id === "string" ? part.id : `inferred-tool-call-${inferredToolCalls.length + 1}`,
      type: "function",
      function: {
        name: functionName,
        arguments: normalizedArguments
      }
    });
  }

  return inferredToolCalls.length > 0 ? inferredToolCalls : undefined;
}

function extractContentPartTypes(content: string | MessageContentPart[] | null | undefined): string[] {
  if (!Array.isArray(content)) {
    return [];
  }

  return content.map((part) => part.type ?? "unknown");
}

function extractContentPreview(content: string | MessageContentPart[] | null | undefined): string | null {
  if (typeof content === "string") {
    const trimmed = content.trim();
    return trimmed.length > 0 ? trimmed.slice(0, 240) : null;
  }

  if (!Array.isArray(content)) {
    return null;
  }

  const preview = content
    .filter((part) => typeof part.text === "string")
    .map((part) => part.text?.trim() ?? "")
    .join("\n")
    .trim();

  return preview.length > 0 ? preview.slice(0, 240) : null;
}

function resolveOpenRouterProviderRouting(model: string, tools: OpenRouterToolDefinition[]): OpenRouterProviderRouting | null {
  if (getApiProvider() !== "openrouter") {
    return null;
  }

  if (model === "google/gemma-4-31b-it") {
    if (tools.length > 0) {
      return {
        order: ["akashml/bf16", "novita/bf16"],
        allow_fallbacks: true
      };
    }

    return {
      only: ["parasail/bf16"],
      allow_fallbacks: false
    };
  }

  return null;
}

export async function requestChatCompletion(
  model: string,
  messages: OpenRouterMessage[],
  tools: OpenRouterToolDefinition[],
  options?: {
    toolChoice?: OpenRouterToolChoice;
    maxCompletionTokens?: number;
    parallelToolCalls?: boolean;
    temperature?: number;
    reasoning?: {
      effort?: string;
      exclude?: boolean;
      maxTokens?: number;
    };
    timeoutMs?: number;
    verbose?: boolean;
    debugLabel?: string;
  }
): Promise<{
  message: OpenRouterMessage;
  usage: OpenRouterUsage;
  finishReason: string | null;
  debug: {
    requestDurationMs: number;
    rawToolCallCount: number;
    rawContentPartTypes: string[];
    rawContentPreview: string | null;
    reasoningTextLength: number;
    reasoningDetailsCount: number;
  };
}> {
  const providerLabel = getApiProviderLabel();
  const endpointLabel = getApiEndpointLabel();
  const debugLabel = options?.debugLabel ?? model;
  const requestStartedAt = Date.now();
  const controller = new AbortController();
  const timeoutMs = options?.timeoutMs ?? null;
  const timeoutHandle =
    timeoutMs == null
      ? null
      : setTimeout(() => {
          controller.abort();
        }, timeoutMs);

  const payload = {
    model,
    temperature: options?.temperature ?? 0,
    max_completion_tokens: options?.maxCompletionTokens ?? 400,
    parallel_tool_calls: options?.parallelToolCalls ?? false,
    tool_choice: options?.toolChoice ?? "auto",
    messages,
    tools
  };
  const providerRouting = resolveOpenRouterProviderRouting(model, tools);

  const requestBody = {
    ...payload,
    ...(shouldIncludeReasoning() && options?.reasoning ? { reasoning: options.reasoning } : {}),
    ...(providerRouting ? { provider: providerRouting } : {})
  };

  if (options?.verbose) {
    console.error(
      `[${providerLabel}] start label=${debugLabel} endpoint=${endpointLabel} model=${model} messages=${messages.length} tools=${tools
        .map((tool) => tool.function.name)
        .join(",")} temperature=${payload.temperature} max_completion_tokens=${payload.max_completion_tokens} timeout_ms=${timeoutMs ?? "none"} provider=${
          providerRouting ? JSON.stringify(providerRouting) : "default"
        }`
    );
  }

  let response: Response;
  let responseHeadersDurationMs = 0;

  try {
    response = await fetch(getChatCompletionsUrl(), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${getApiKey()}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal
    });
    responseHeadersDurationMs = Date.now() - requestStartedAt;
  } catch (error) {
    if (timeoutHandle != null) {
      clearTimeout(timeoutHandle);
    }

    const elapsedMs = Date.now() - requestStartedAt;
    const message =
      error instanceof Error && error.name === "AbortError"
        ? `${providerLabel} request timed out after ${timeoutMs ?? elapsedMs}ms`
        : describeError(error);

    if (options?.verbose) {
      console.error(`[${providerLabel}] error label=${debugLabel} elapsed_ms=${elapsedMs} message=${message}`);
    }

    throw new Error(message);
  }

  if (!response.ok) {
    try {
      const errorText = await response.text();
      if (timeoutHandle != null) {
        clearTimeout(timeoutHandle);
      }
      const totalRequestDurationMs = Date.now() - requestStartedAt;
      if (options?.verbose) {
        console.error(
          `[${providerLabel}] error label=${debugLabel} headers_ms=${responseHeadersDurationMs} total_ms=${totalRequestDurationMs} status=${response.status} body=${errorText.slice(0, 500)}`
        );
      }
      throw new Error(`${providerLabel} request failed with ${response.status}: ${errorText}`);
    } catch (error) {
      if (timeoutHandle != null) {
        clearTimeout(timeoutHandle);
      }

      const totalRequestDurationMs = Date.now() - requestStartedAt;
      const message =
        error instanceof Error && error.name === "AbortError"
          ? `${providerLabel} request timed out after ${timeoutMs ?? totalRequestDurationMs}ms while reading error response body`
          : describeError(error);

      if (options?.verbose) {
        console.error(
          `[${providerLabel}] error label=${debugLabel} headers_ms=${responseHeadersDurationMs} total_ms=${totalRequestDurationMs} status=${response.status} message=${message}`
        );
      }

      throw new Error(message);
    }
  }

  let parsed: ChatCompletionResponse;

  try {
    parsed = (await response.json()) as ChatCompletionResponse;
  } catch (error) {
    if (timeoutHandle != null) {
      clearTimeout(timeoutHandle);
    }

    const totalRequestDurationMs = Date.now() - requestStartedAt;
    const message =
      error instanceof Error && error.name === "AbortError"
        ? `${providerLabel} request timed out after ${timeoutMs ?? totalRequestDurationMs}ms while reading response body`
        : describeError(error);

    if (options?.verbose) {
      console.error(
        `[${providerLabel}] error label=${debugLabel} headers_ms=${responseHeadersDurationMs} total_ms=${totalRequestDurationMs} message=${message}`
      );
    }

    throw new Error(message);
  }

  if (timeoutHandle != null) {
    clearTimeout(timeoutHandle);
  }
  const totalRequestDurationMs = Date.now() - requestStartedAt;
  const choice = parsed.choices?.[0];

  if (!choice?.message) {
    throw new Error(`${providerLabel} response did not contain a completion choice`);
  }

  const normalizedToolCalls = normalizeToolCalls(choice.message.tool_calls, choice.message.content);
  const reasoning = extractReasoningContent(choice.message.reasoning);
  const reasoningDetails = Array.isArray(choice.message.reasoning_details) ? choice.message.reasoning_details : undefined;
  const rawToolCallCount = Array.isArray(choice.message.tool_calls) ? choice.message.tool_calls.length : 0;
  const rawContentPartTypes = extractContentPartTypes(choice.message.content);
  const rawContentPreview = extractContentPreview(choice.message.content);
  const reasoningTextLength = reasoning?.length ?? 0;
  const reasoningDetailsCount = reasoningDetails?.length ?? 0;

  if (options?.verbose) {
    console.error(
      `[${providerLabel}] done label=${debugLabel} endpoint=${endpointLabel} headers_ms=${responseHeadersDurationMs} total_ms=${totalRequestDurationMs} finish_reason=${choice.finish_reason ?? "null"} prompt_tokens=${
        parsed.usage?.prompt_tokens ?? 0
      } completion_tokens=${parsed.usage?.completion_tokens ?? 0} normalized_tool_calls=${normalizedToolCalls?.length ?? 0} raw_tool_calls=${rawToolCallCount} reasoning_text_length=${reasoningTextLength} reasoning_details_count=${reasoningDetailsCount} content_types=${
        rawContentPartTypes.length > 0 ? rawContentPartTypes.join(",") : "none"
      } content_preview=${JSON.stringify(rawContentPreview)}`
    );
    console.error(
      `[${providerLabel}] raw_choice_preview label=${debugLabel} ${JSON.stringify(choice).slice(0, 2000)}`
    );
  }

  return {
    finishReason: choice.finish_reason ?? null,
    usage: parsed.usage ?? {},
    message: {
      role: "assistant",
      content: extractTextContent(choice.message.content),
      tool_calls: normalizedToolCalls,
      reasoning,
      reasoning_details: reasoningDetails
    },
    debug: {
      requestDurationMs: totalRequestDurationMs,
      rawToolCallCount,
      rawContentPartTypes,
      rawContentPreview,
      reasoningTextLength,
      reasoningDetailsCount
    }
  };
}
