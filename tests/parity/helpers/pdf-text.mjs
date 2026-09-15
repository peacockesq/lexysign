import { execFileSync } from "node:child_process";

export function extractPdfText(bytes) {
  try {
    return execFileSync("pdftotext", ["-layout", "-", "-"], {
      input: Buffer.from(bytes)
    }).toString();
  } catch (err) {
    throw new Error(
      "pdftotext is required for prefill PDF regressions (install poppler-utils). " +
        (err?.message || err)
    );
  }
}

export function pdfHasVisibleText(bytes, text) {
  return extractPdfText(bytes).includes(text);
}
