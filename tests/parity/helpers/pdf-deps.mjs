import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { OPEN_SIGN, OPEN_SIGN_SERVER } from "./paths.mjs";

const LOCAL_REVIEW_DEPS = "/home/trixie/lexysign-independent-80ba54-d2okJJ/review-deps";

function candidateRoots() {
  const extra = process.env.LEXYSIGN_REVIEW_DEPS;
  return [
    path.join(OPEN_SIGN, "node_modules"),
    path.join(OPEN_SIGN_SERVER, "node_modules"),
    extra ? path.join(extra, "node_modules") : null,
    path.join(LOCAL_REVIEW_DEPS, "node_modules")
  ].filter(Boolean);
}

export function resolvePdfDependencyRoot() {
  for (const root of candidateRoots()) {
    const pdfLib = path.join(root, "pdf-lib", "package.json");
    const fontkit = path.join(root, "@pdf-lib", "fontkit", "package.json");
    if (fs.existsSync(pdfLib) && fs.existsSync(fontkit)) return root;
  }
  return null;
}

export function requirePdfDeps() {
  const root = resolvePdfDependencyRoot();
  if (!root) {
    throw new Error(
      "pdf-lib and @pdf-lib/fontkit not found under apps/OpenSign/node_modules, apps/OpenSignServer/node_modules, or LEXYSIGN_REVIEW_DEPS. Install from the OpenSign lockfile (CI parity-tests npm ci); do not assume a global install."
    );
  }
  const require = createRequire(path.join(root, "probe.cjs"));
  return {
    root,
    pdfLib: require("pdf-lib"),
    fontkit: require("@pdf-lib/fontkit"),
    version: require("pdf-lib/package.json").version
  };
}

export function loadTestFontBytes() {
  const fonts = [
    "/usr/share/fonts/truetype/noto/NotoMono-Regular.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    "/usr/share/fonts/truetype/freefont/FreeSans.ttf"
  ];
  for (const file of fonts) {
    if (!fs.existsSync(file)) continue;
    const buf = fs.readFileSync(file);
    return {
      path: file,
      bytes: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    };
  }
  throw new Error("No system TTF found for prefill embed regression");
}
