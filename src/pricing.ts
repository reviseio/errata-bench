import path from "node:path";

import {
  getApiBaseUrl,
  getApiKey,
  getPricingOverrideEnvValue,
  usesOpenRouterPricing
} from "./api-config.js";
import { readJson, writeJson } from "./fs.js";
import { parseModelVariantString } from "./model-config.js";
import type { RunArtifact, RunCostSummary, ScoreArtifact } from "./types.js";

type ModelPricing = {
  inputUsdPerToken: number;
  outputUsdPerToken: number;
  source: string;
};

type ModelsApiResponse = {
  data?: Array<{
    id?: string;
    canonical_slug?: string;
    pricing?: {
      prompt?: string;
      completion?: string;
    };
  }>;
};

type PricingCacheFile = {
  fetchedAt: string;
  source: string;
  prices: Record<string, ModelPricing>;
};

type PricingOverrideEntry = {
  inputUsdPerToken?: number;
  outputUsdPerToken?: number;
  inputUsdPerMillionTokens?: number;
  outputUsdPerMillionTokens?: number;
  source?: string;
};

const OPENROUTER_MODELS_API_SOURCE = "https://openrouter.ai/api/v1/models";
const PINNED_MODEL_PRICING_SOURCE = "errata-bench pinned pricing override";
const PRICING_CACHE_PATH = path.resolve("artifacts/cache/openrouter-model-pricing.json");
const DEFAULT_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

const STATIC_MODEL_PRICING: Record<string, ModelPricing> = {
  "google/gemini-3-flash-preview": {
    inputUsdPerToken: 0.5 / 1_000_000,
    outputUsdPerToken: 3 / 1_000_000,
    source: OPENROUTER_MODELS_API_SOURCE
  },
  "anthropic/claude-sonnet-4.6": {
    inputUsdPerToken: 3 / 1_000_000,
    outputUsdPerToken: 15 / 1_000_000,
    source: OPENROUTER_MODELS_API_SOURCE
  },
  "anthropic/claude-opus-4.6": {
    inputUsdPerToken: 5 / 1_000_000,
    outputUsdPerToken: 25 / 1_000_000,
    source: OPENROUTER_MODELS_API_SOURCE
  },
  "anthropic/claude-haiku-4.5": {
    inputUsdPerToken: 1 / 1_000_000,
    outputUsdPerToken: 5 / 1_000_000,
    source: OPENROUTER_MODELS_API_SOURCE
  },
  "minimax/minimax-m2.5": {
    inputUsdPerToken: 0.27 / 1_000_000,
    outputUsdPerToken: 0.95 / 1_000_000,
    source: OPENROUTER_MODELS_API_SOURCE
  },
  "openai/gpt-5.4": {
    inputUsdPerToken: 2.5 / 1_000_000,
    outputUsdPerToken: 15 / 1_000_000,
    source: OPENROUTER_MODELS_API_SOURCE
  },
  "openai/gpt-5.4-mini": {
    inputUsdPerToken: 0.75 / 1_000_000,
    outputUsdPerToken: 4.5 / 1_000_000,
    source: OPENROUTER_MODELS_API_SOURCE
  },
  "openai/gpt-oss-120b": {
    inputUsdPerToken: 0.039 / 1_000_000,
    outputUsdPerToken: 0.19 / 1_000_000,
    source: OPENROUTER_MODELS_API_SOURCE
  }
};

const PINNED_MODEL_PRICING: Record<string, ModelPricing> = {
  "z-ai/glm-5.1": {
    inputUsdPerToken: 1 / 1_000_000,
    outputUsdPerToken: 3.2 / 1_000_000,
    source: PINNED_MODEL_PRICING_SOURCE
  }
};

let pricingIndexPromise: Promise<Record<string, ModelPricing>> | null = null;

function getCacheTtlMs(): number {
  const raw = Number.parseInt(process.env.OPENROUTER_MODEL_PRICING_CACHE_TTL_MS ?? "", 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_CACHE_TTL_MS;
}

function getPricingOverridePath(): string | null {
  const configured = getPricingOverrideEnvValue();
  return configured && configured.length > 0 ? path.resolve(configured) : null;
}

function getModelsApiUrl(): string {
  const baseUrl = getApiBaseUrl();
  return `${baseUrl.replace(/\/+$/, "")}/models`;
}

function getModelsApiHeaders(): Record<string, string> {
  try {
    return { Authorization: `Bearer ${getApiKey()}` };
  } catch {
    return {};
  }
}

function normalizePricingMap(prices: Record<string, ModelPricing>): Record<string, ModelPricing> {
  return Object.fromEntries(
    Object.entries(prices).sort(([left], [right]) => left.localeCompare(right))
  );
}

function parsePricingOverrideEntry(
  model: string,
  value: PricingOverrideEntry
): ModelPricing {
  const inputUsdPerToken =
    typeof value.inputUsdPerToken === "number"
      ? value.inputUsdPerToken
      : typeof value.inputUsdPerMillionTokens === "number"
        ? value.inputUsdPerMillionTokens / 1_000_000
        : null;
  const outputUsdPerToken =
    typeof value.outputUsdPerToken === "number"
      ? value.outputUsdPerToken
      : typeof value.outputUsdPerMillionTokens === "number"
        ? value.outputUsdPerMillionTokens / 1_000_000
        : null;

  if (
    inputUsdPerToken == null ||
    outputUsdPerToken == null ||
    !Number.isFinite(inputUsdPerToken) ||
    !Number.isFinite(outputUsdPerToken)
  ) {
    throw new Error(
      `Pricing override for "${model}" must define input/output pricing via per-token or per-million-token fields.`
    );
  }

  return {
    inputUsdPerToken,
    outputUsdPerToken,
    source: value.source ?? (getPricingOverridePath() ?? "ERRATA_BENCH_PRICING_FILE")
  };
}

function parsePricingNumber(value: string | undefined): number | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }

  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildPricingIndexFromApi(payload: ModelsApiResponse): Record<string, ModelPricing> {
  const prices: Record<string, ModelPricing> = {};

  for (const model of payload.data ?? []) {
    const modelId = typeof model.id === "string" ? model.id : null;
    const canonicalSlug = typeof model.canonical_slug === "string" ? model.canonical_slug : null;
    const promptPrice = parsePricingNumber(model.pricing?.prompt);
    const completionPrice = parsePricingNumber(model.pricing?.completion);

    if (promptPrice == null || completionPrice == null) {
      continue;
    }

    const pricing: ModelPricing = {
      inputUsdPerToken: promptPrice,
      outputUsdPerToken: completionPrice,
      source: OPENROUTER_MODELS_API_SOURCE
    };

    if (modelId) {
      prices[modelId] = pricing;
    }

    if (canonicalSlug) {
      prices[canonicalSlug] = pricing;
    }
  }

  return normalizePricingMap(prices);
}

async function readPricingCache(): Promise<PricingCacheFile | null> {
  try {
    return await readJson<PricingCacheFile>(PRICING_CACHE_PATH);
  } catch {
    return null;
  }
}

async function readPricingOverrides(): Promise<Record<string, ModelPricing>> {
  const pricingOverridePath = getPricingOverridePath();

  if (!pricingOverridePath) {
    return {};
  }

  const payload = await readJson<Record<string, PricingOverrideEntry>>(pricingOverridePath);

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`Pricing file "${pricingOverridePath}" must be a JSON object keyed by model id.`);
  }

  return normalizePricingMap(
    Object.fromEntries(
      Object.entries(payload).map(([model, value]) => [model, parsePricingOverrideEntry(model, value)])
    )
  );
}

async function writePricingCache(prices: Record<string, ModelPricing>): Promise<void> {
  await writeJson(PRICING_CACHE_PATH, {
    fetchedAt: new Date().toISOString(),
    source: OPENROUTER_MODELS_API_SOURCE,
    prices: normalizePricingMap({ ...prices, ...PINNED_MODEL_PRICING })
  } satisfies PricingCacheFile);
}

function isFreshCache(cache: PricingCacheFile): boolean {
  const fetchedAtMs = Date.parse(cache.fetchedAt);

  if (!Number.isFinite(fetchedAtMs)) {
    return false;
  }

  return Date.now() - fetchedAtMs <= getCacheTtlMs();
}

async function fetchPricingIndexFromOpenRouter(): Promise<Record<string, ModelPricing>> {
  const response = await fetch(getModelsApiUrl(), {
    headers: getModelsApiHeaders()
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenRouter models API failed with ${response.status}: ${body}`);
  }

  const payload = (await response.json()) as ModelsApiResponse;
  const prices = buildPricingIndexFromApi(payload);

  if (Object.keys(prices).length === 0) {
    throw new Error("OpenRouter models API returned no parseable pricing data");
  }

  await writePricingCache(prices);
  return prices;
}

export function getPricingCachePath(): string {
  return PRICING_CACHE_PATH;
}

export async function refreshPricingCache(): Promise<Record<string, ModelPricing>> {
  if (!usesOpenRouterPricing()) {
    throw new Error(
      "OpenRouter pricing refresh requires ERRATA_BENCH_API_PROVIDER=openrouter."
    );
  }

  const overrides = await readPricingOverrides();
  const livePrices = await fetchPricingIndexFromOpenRouter();
  const mergedPrices = { ...STATIC_MODEL_PRICING, ...livePrices, ...PINNED_MODEL_PRICING, ...overrides };
  pricingIndexPromise = Promise.resolve(mergedPrices);
  return mergedPrices;
}

async function loadPricingIndex(): Promise<Record<string, ModelPricing>> {
  if (pricingIndexPromise) {
    return pricingIndexPromise;
  }

  pricingIndexPromise = (async () => {
    const overrides = await readPricingOverrides();

    if (!usesOpenRouterPricing()) {
      return overrides;
    }

    const cached = await readPricingCache();

    if (cached && isFreshCache(cached)) {
      return { ...STATIC_MODEL_PRICING, ...cached.prices, ...PINNED_MODEL_PRICING, ...overrides };
    }

    try {
      const livePrices = await fetchPricingIndexFromOpenRouter();
      return { ...STATIC_MODEL_PRICING, ...livePrices, ...PINNED_MODEL_PRICING, ...overrides };
    } catch {
      if (cached) {
        return { ...STATIC_MODEL_PRICING, ...cached.prices, ...PINNED_MODEL_PRICING, ...overrides };
      }

      return { ...STATIC_MODEL_PRICING, ...PINNED_MODEL_PRICING, ...overrides };
    }
  })();

  return pricingIndexPromise;
}

function sumCandidatePromptTokens(run: RunArtifact): number {
  return run.cases.reduce((sum, sample) => sum + sample.promptTokens, 0);
}

function sumCandidateOutputTokens(run: RunArtifact): number {
  return run.cases.reduce((sum, sample) => sum + sample.outputTokens, 0);
}

function sumJudgePromptTokens(report: ScoreArtifact): number {
  return report.cases.reduce((sum, sample) => sum + (sample.judge?.promptTokens ?? 0), 0);
}

function sumJudgeOutputTokens(report: ScoreArtifact): number {
  return report.cases.reduce((sum, sample) => sum + (sample.judge?.outputTokens ?? 0), 0);
}

function calculateCostUsd(
  pricing: ModelPricing | undefined,
  promptTokens: number,
  outputTokens: number
): number | null {
  if (!pricing) {
    return null;
  }

  return promptTokens * pricing.inputUsdPerToken + outputTokens * pricing.outputUsdPerToken;
}

export async function getModelPricing(model: string): Promise<ModelPricing | null> {
  const prices = await loadPricingIndex();
  const parsed = parseModelVariantString(model);
  return prices[model] ?? prices[parsed.model] ?? null;
}

export async function calculateRunCostSummary(run: RunArtifact, report: ScoreArtifact): Promise<RunCostSummary> {
  const candidatePromptTokens = sumCandidatePromptTokens(run);
  const candidateOutputTokens = sumCandidateOutputTokens(run);
  const judgePromptTokens = sumJudgePromptTokens(report);
  const judgeOutputTokens = sumJudgeOutputTokens(report);
  const candidatePricing =
    run.mode === "mock" ? undefined : (await getModelPricing(run.model)) ?? undefined;
  const judgePricing =
    report.summary.judge == null ? undefined : (await getModelPricing(report.summary.judge.judgeModel)) ?? undefined;
  const candidateCostUsd = calculateCostUsd(candidatePricing, candidatePromptTokens, candidateOutputTokens);
  const judgeCostUsd =
    report.summary.judge != null ? calculateCostUsd(judgePricing, judgePromptTokens, judgeOutputTokens) : 0;

  return {
    candidatePromptTokens,
    candidateOutputTokens,
    candidateCostUsd,
    judgePromptTokens,
    judgeOutputTokens,
    judgeCostUsd,
    totalCostUsd: candidateCostUsd == null || judgeCostUsd == null ? null : candidateCostUsd + judgeCostUsd
  };
}
