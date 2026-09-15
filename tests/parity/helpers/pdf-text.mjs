import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

export function extractPdfPageRotation(bytes, pageNumber) {
  const tmp = path.join(
    os.tmpdir(),
    `lexysign-rot-${process.pid}-${Date.now()}-${pageNumber}.pdf`
  );
  fs.writeFileSync(tmp, Buffer.from(bytes));
  try {
    const out = execFileSync(
      "pdfinfo",
      ["-f", String(pageNumber), "-l", String(pageNumber), tmp],
      { encoding: "utf8" }
    );
    const match = out.match(new RegExp(`Page\\s+${pageNumber}\\s+rot:\\s+(\\d+)`, "i"));
    if (!match) {
      throw new Error(`pdfinfo missing rotation for page ${pageNumber}: ${out}`);
    }
    return Number(match[1]);
  } catch (err) {
    if (err.message?.includes("pdfinfo missing rotation")) throw err;
    throw new Error(
      "pdfinfo is required for clean-source rotation regressions (install poppler-utils). " +
        (err?.message || err)
    );
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}
