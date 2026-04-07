export const TAXONOMY_DOCUMENT_PATH = "taxonomy.md";

export const TAXONOMY_PARENTS = [
  "orthography_and_word_form",
  "lexical_choice_and_confusability",
  "grammar_and_syntax",
  "punctuation_and_boundaries",
  "semantics_discourse_and_style"
] as const;

export type TaxonomyParent = (typeof TAXONOMY_PARENTS)[number];

export type TaxonomyClass = {
  parent: TaxonomyParent;
  child: string;
  label: string;
  description: string;
};

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function isTaxonomyParent(value: string): value is TaxonomyParent {
  return (TAXONOMY_PARENTS as readonly string[]).includes(value);
}

export function buildDefaultRequiredParents(issueCount: number): TaxonomyParent[] {
  if (issueCount >= 4) {
    return TAXONOMY_PARENTS.slice(0, 4);
  }

  return TAXONOMY_PARENTS.slice(0, Math.max(1, issueCount));
}

export function buildClassificationLabel(parent: string, child: string): string {
  return `${parent}.${slugify(child)}`;
}

export function parseTaxonomyClasses(markdown: string): TaxonomyClass[] {
  let currentParent: TaxonomyParent | null = null;
  const classes: TaxonomyClass[] = [];

  for (const rawLine of markdown.split("\n")) {
    const trimmed = rawLine.trim();

    if (trimmed.length === 0) {
      continue;
    }

    const parentMatch = trimmed.match(/^- \d+\.\s+(.+)$/);

    if (parentMatch) {
      const parentSlug = slugify(parentMatch[1] ?? "");

      if (isTaxonomyParent(parentSlug)) {
        currentParent = parentSlug;
      }

      continue;
    }

    const childMatch = trimmed.match(/^- ([^:]+):\s+(.+)$/);

    if (!childMatch || currentParent == null) {
      continue;
    }

    const child = slugify(childMatch[1] ?? "");

    if (child.length === 0) {
      continue;
    }

    classes.push({
      parent: currentParent,
      child,
      label: buildClassificationLabel(currentParent, child),
      description: (childMatch[2] ?? "").trim()
    });
  }

  return classes;
}
