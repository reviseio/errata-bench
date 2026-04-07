export function normalizeProofreadingText(value: string): string {
  return value
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u2028\u2029]/g, "\n")
    .replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g, " ")
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035\u02BC\uFF07]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u2033\u2036\uFF02]/g, '"')
    .replace(/\u2026/g, "...");
}

export function normalizeProofreadingHtmlForComparison(value: string): string {
  return normalizeProofreadingText(value).replace(/>\s+</g, "><").replace(/\s+/g, " ").trim();
}
