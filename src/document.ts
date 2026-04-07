import type { FindAndReplaceArgs, Paragraph, ReplaceParagraphArgs, ToolResult } from "./types.js";
import { normalizeProofreadingHtmlForComparison, normalizeProofreadingText } from "./normalization.js";

type ParsedParagraph = {
  id: string;
  openTag: string;
  innerHtml: string;
  closeTag: string;
};

function cloneParagraphs(paragraphs: Paragraph[]): Paragraph[] {
  return paragraphs.map((paragraph) => ({ ...paragraph }));
}

function parseParagraphHtml(html: string): ParsedParagraph {
  const trimmed = html.trim();
  const match = trimmed.match(/^(<p\s+id="([^"]+)">)([\s\S]*)(<\/p>)$/);

  if (!match) {
    throw new Error(`Invalid paragraph HTML: ${html}`);
  }

  return {
    openTag: match[1],
    id: match[2],
    innerHtml: match[3],
    closeTag: match[4]
  };
}

function normalizeParagraphHtml(html: string): string {
  const parsed = parseParagraphHtml(html);
  return `${parsed.openTag}${normalizeProofreadingText(parsed.innerHtml)}${parsed.closeTag}`.trim();
}

export function renderDocumentHtml(paragraphs: Paragraph[]): string {
  return paragraphs.map((paragraph) => paragraph.html).join("\n");
}

export function normalizeHtml(value: string): string {
  return normalizeProofreadingHtmlForComparison(value);
}

export function createParagraphMap(paragraphs: Paragraph[]): Map<string, Paragraph> {
  return new Map(paragraphs.map((paragraph) => [paragraph.id, paragraph]));
}

export function getChangedParagraphIds(originalParagraphs: Paragraph[], updatedParagraphs: Paragraph[]): string[] {
  const originalById = createParagraphMap(originalParagraphs);

  return updatedParagraphs
    .filter((paragraph) => normalizeHtml(originalById.get(paragraph.id)?.html ?? "") !== normalizeHtml(paragraph.html))
    .map((paragraph) => paragraph.id);
}

export class ParagraphDocument {
  private readonly paragraphs: Paragraph[];

  public constructor(paragraphs: Paragraph[]) {
    this.paragraphs = cloneParagraphs(paragraphs).map((paragraph) => ({
      ...paragraph,
      html: normalizeParagraphHtml(paragraph.html)
    }));
    for (const paragraph of this.paragraphs) {
      const parsed = parseParagraphHtml(paragraph.html);

      if (parsed.id !== paragraph.id) {
        throw new Error(`Paragraph "${paragraph.id}" has mismatched HTML id "${parsed.id}"`);
      }
    }
  }

  public toHtml(): string {
    return renderDocumentHtml(this.paragraphs);
  }

  public toParagraphs(): Paragraph[] {
    return cloneParagraphs(this.paragraphs);
  }

  public getParagraphHtml(paragraphId: string): string | null {
    return this.paragraphs.find((paragraph) => paragraph.id === paragraphId)?.html ?? null;
  }

  public replaceParagraph(args: ReplaceParagraphArgs): ToolResult {
    const index = this.paragraphs.findIndex((paragraph) => paragraph.id === args.paragraphId);

    if (index === -1) {
      return {
        ok: false,
        paragraphId: args.paragraphId,
        updatedParagraphHtml: "",
        message: `Paragraph "${args.paragraphId}" was not found.`
      };
    }

    const normalizedParagraphHtml = normalizeParagraphHtml(args.newParagraphHtml);
    const parsed = parseParagraphHtml(normalizedParagraphHtml);

    if (parsed.id !== args.paragraphId) {
      return {
        ok: false,
        paragraphId: args.paragraphId,
        updatedParagraphHtml: this.paragraphs[index].html,
        message: `Replacement paragraph id "${parsed.id}" does not match requested paragraph "${args.paragraphId}".`
      };
    }

    this.paragraphs[index] = {
      id: args.paragraphId,
      html: normalizedParagraphHtml
    };

    return {
      ok: true,
      paragraphId: args.paragraphId,
      updatedParagraphHtml: this.paragraphs[index].html,
      message: `Paragraph "${args.paragraphId}" was replaced.`
    };
  }

  public findAndReplace(args: FindAndReplaceArgs): ToolResult {
    const index = this.paragraphs.findIndex((paragraph) => paragraph.id === args.paragraphId);

    if (index === -1) {
      return {
        ok: false,
        paragraphId: args.paragraphId,
        updatedParagraphHtml: "",
        replacementsApplied: 0,
        message: `Paragraph "${args.paragraphId}" was not found.`
      };
    }

    const normalizedFind = normalizeProofreadingText(args.find);
    const normalizedReplace = normalizeProofreadingText(args.replace);

    if (normalizedFind.length === 0) {
      return {
        ok: false,
        paragraphId: args.paragraphId,
        updatedParagraphHtml: this.paragraphs[index].html,
        replacementsApplied: 0,
        message: "The find string must not be empty."
      };
    }

    const parsed = parseParagraphHtml(this.paragraphs[index].html);
    const parts = parsed.innerHtml.split(normalizedFind);
    const replacementsApplied = parts.length - 1;

    if (replacementsApplied === 0) {
      return {
        ok: false,
        paragraphId: args.paragraphId,
        updatedParagraphHtml: this.paragraphs[index].html,
        replacementsApplied,
        message: `No occurrences of "${normalizedFind}" were found in paragraph "${args.paragraphId}".`
      };
    }

    const updatedParagraphHtml = `${parsed.openTag}${parts.join(normalizedReplace)}${parsed.closeTag}`;
    this.paragraphs[index] = {
      id: args.paragraphId,
      html: updatedParagraphHtml
    };

    return {
      ok: true,
      paragraphId: args.paragraphId,
      updatedParagraphHtml,
      replacementsApplied,
      message: `Replaced ${replacementsApplied} occurrence(s) in paragraph "${args.paragraphId}".`
    };
  }
}
