export type ModelVariant = {
  model: string;
  label: string;
  reasoningEffort: string | null;
};

export const DEFAULT_REASONING_EFFORT = "medium";

type RawModelVariantObject = {
  model?: unknown;
  label?: unknown;
  reasoningEffort?: unknown;
};

const REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function buildVariantLabel(model: string, reasoningEffort: string | null): string {
  return reasoningEffort == null ? model : `${model}:${reasoningEffort}`;
}

export function parseModelVariantString(value: string): ModelVariant {
  const trimmed = value.trim();

  if (trimmed.length === 0) {
    throw new Error("Model value must not be empty");
  }

  const separatorIndex = trimmed.lastIndexOf(":");

  if (separatorIndex === -1) {
    return {
      model: trimmed,
      label: trimmed,
      reasoningEffort: null
    };
  }

  const model = trimmed.slice(0, separatorIndex).trim();
  const suffix = trimmed.slice(separatorIndex + 1).trim();

  if (model.length === 0 || !REASONING_EFFORTS.has(suffix)) {
    return {
      model: trimmed,
      label: trimmed,
      reasoningEffort: null
    };
  }

  return {
    model,
    label: buildVariantLabel(model, suffix),
    reasoningEffort: suffix
  };
}

export function parseModelVariant(value: unknown, label = "model"): ModelVariant {
  if (typeof value === "string") {
    return parseModelVariantString(value);
  }

  if (!isObject(value)) {
    throw new Error(`${label} must be a string or object`);
  }

  const raw = value as RawModelVariantObject;

  if (typeof raw.model !== "string" || raw.model.trim().length === 0) {
    throw new Error(`${label}.model must be a non-empty string`);
  }

  if (raw.reasoningEffort != null && (typeof raw.reasoningEffort !== "string" || !REASONING_EFFORTS.has(raw.reasoningEffort))) {
    throw new Error(`${label}.reasoningEffort must be one of: ${[...REASONING_EFFORTS].join(", ")}`);
  }

  if (raw.label != null && (typeof raw.label !== "string" || raw.label.trim().length === 0)) {
    throw new Error(`${label}.label must be a non-empty string when provided`);
  }

  const model = raw.model.trim();
  const reasoningEffort = typeof raw.reasoningEffort === "string" ? raw.reasoningEffort : null;
  const variantLabel =
    typeof raw.label === "string" ? raw.label.trim() : buildVariantLabel(model, reasoningEffort);

  return {
    model,
    label: variantLabel,
    reasoningEffort
  };
}

export function withDefaultReasoningEffort(
  variant: ModelVariant,
  defaultReasoningEffort = DEFAULT_REASONING_EFFORT
): ModelVariant {
  if (variant.reasoningEffort != null) {
    return variant;
  }

  return {
    model: variant.model,
    label: buildVariantLabel(variant.model, defaultReasoningEffort),
    reasoningEffort: defaultReasoningEffort
  };
}
