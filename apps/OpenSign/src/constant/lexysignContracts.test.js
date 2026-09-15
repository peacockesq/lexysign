import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = dirname(fileURLToPath(import.meta.url));
const read = (...parts) => readFileSync(join(root, ...parts), "utf8");

describe("LexySign client merge contracts", () => {
  it("keeps LexySign branding in client Utils", () => {
    const utils = read("Utils.js");
    expect(utils).toContain('const appName = "LexySign"');
    expect(utils).toContain("https://sign.lexyalgo.com/lexysign-logo.png");
    expect(utils).toContain("This PDF is not compatible with LexySign");
  });

  it("keeps drawn-signature enforcement", () => {
    const modal = read("../components/pdf/WidgetsValueModal.jsx");
    expect(modal).toContain("REACT_APP_FORCE_DRAWN_SIGNATURES");
    expect(modal).toContain('return tabName === "draw"');
  });

  it("keeps mobile layout and accessibility fixes", () => {
    const header = read("../components/pdf/PdfHeader.jsx");
    expect(header).toContain('aria-label="Back"');
    expect(header).toContain("!isViewerSigner");
    expect(header).toContain("finishLabel");
    expect(read("../pages/SignyourselfPdf.jsx")).toContain("md:min-w-[14rem]");
    expect(read("../styles/signature.css")).toContain("overflow: visible");
  });

  it("keeps the billing route and login promo contract", () => {
    expect(read("../App.jsx")).toContain('path="/billing"');
    expect(read("../pages/Login.jsx")).toContain("loginWithSupabase");
    expect(read("../pages/Login.jsx")).toContain("LEXY90");
  });
});
