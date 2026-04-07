export type ApiProvider = "openrouter" | "openai-compatible";
export type ReasoningMode = "passthrough" | "omit";

const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_RESULT_GROUP_ID = "official-v1";

function normalizeProvider(value: string | undefined | null): ApiProvider {
  const normalized = value?.trim().toLowerCase();

  if (!normalized || normalized === "openrouter") {
    return "openrouter";
  }

  if (
    normalized === "openai-compatible" ||
    normalized === "openai_compatible" ||
    normalized === "openai-compatible-chat" ||
    normalized === "compat" ||
    normalized === "compatible"
  ) {
    return "openai-compatible";
  }

  throw new Error(
    `Unsupported ERRATA_BENCH_API_PROVIDER "${value}". Expected "openrouter" or "openai-compatible".`
  );
}

function normalizeReasoningMode(value: string | undefined | null): ReasoningMode {
  const normalized = value?.trim().toLowerCase();

  if (!normalized || normalized === "passthrough") {
    return "passthrough";
  }

  if (normalized === "omit" || normalized === "off" || normalized === "none") {
    return "omit";
  }

  throw new Error(
    `Unsupported ERRATA_BENCH_API_REASONING_MODE "${value}". Expected "passthrough" or "omit".`
  );
}

function trimEnv(value: string | undefined | null): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function resolveEndpointLabelFromBaseUrl(baseUrl: string): string {
  try {
    const parsed = new URL(baseUrl);
    const pathname = parsed.pathname.replace(/\/+$/, "");
    return pathname.length > 0 && pathname !== "/"
      ? `${parsed.host}${pathname}`
      : parsed.host;
  } catch {
    return baseUrl.replace(/\/+$/, "");
  }
}

export function getApiProvider(): ApiProvider {
  return normalizeProvider(trimEnv(process.env.ERRATA_BENCH_API_PROVIDER));
}

export function getApiBaseUrl(): string {
  const explicit = trimEnv(process.env.ERRATA_BENCH_API_BASE_URL);

  if (explicit) {
    return explicit;
  }

  const provider = getApiProvider();

  if (provider === "openrouter") {
    return DEFAULT_OPENROUTER_BASE_URL;
  }

  throw new Error(
    "ERRATA_BENCH_API_BASE_URL is required when ERRATA_BENCH_API_PROVIDER=openai-compatible."
  );
}

export function getChatCompletionsUrl(): string {
  const baseUrl = getApiBaseUrl().replace(/\/+$/, "");

  if (/\/chat\/completions$/i.test(baseUrl)) {
    return baseUrl;
  }

  return `${baseUrl}/chat/completions`;
}

export function getApiKey(): string {
  const provider = getApiProvider();
  const explicit = trimEnv(process.env.ERRATA_BENCH_API_KEY);

  if (explicit) {
    return explicit;
  }

  if (provider === "openrouter") {
    throw new Error(
      "Set ERRATA_BENCH_API_KEY for live runs. OpenRouter BYOK still authenticates with an OpenRouter API key."
    );
  }

  throw new Error(
    "Set ERRATA_BENCH_API_KEY for live runs when ERRATA_BENCH_API_PROVIDER=openai-compatible."
  );
}

export function getApiProviderLabel(): string {
  return getApiProvider();
}

export function getApiEndpointLabel(): string {
  const explicit = trimEnv(process.env.ERRATA_BENCH_API_ENDPOINT_LABEL);

  if (explicit) {
    return explicit;
  }

  const provider = getApiProvider();
  return provider === "openrouter" ? "openrouter" : resolveEndpointLabelFromBaseUrl(getApiBaseUrl());
}

export function getApiReasoningMode(): ReasoningMode {
  return normalizeReasoningMode(trimEnv(process.env.ERRATA_BENCH_API_REASONING_MODE));
}

export function shouldIncludeReasoning(): boolean {
  return getApiReasoningMode() === "passthrough";
}

export function getDefaultLiveModel(): string | null {
  return trimEnv(process.env.ERRATA_BENCH_DEFAULT_MODEL);
}

export function getDefaultJudgeModel(): string | null {
  return trimEnv(process.env.ERRATA_BENCH_DEFAULT_JUDGE_MODEL);
}

export function getDefaultCorruptionModel(): string | null {
  return trimEnv(process.env.ERRATA_BENCH_DEFAULT_CORRUPTION_MODEL) ?? getDefaultLiveModel();
}

export function getDefaultCorruptionReviewModel(): string | null {
  return trimEnv(process.env.ERRATA_BENCH_DEFAULT_CORRUPTION_REVIEW_MODEL) ?? getDefaultJudgeModel();
}

export function getDefaultResultsId(): string {
  return trimEnv(process.env.ERRATA_BENCH_DEFAULT_RESULTS_ID) ?? DEFAULT_RESULT_GROUP_ID;
}

export function getPricingOverrideEnvValue(): string | null {
  return trimEnv(process.env.ERRATA_BENCH_PRICING_FILE);
}

export function usesOpenRouterPricing(): boolean {
  return getApiProvider() === "openrouter";
}
