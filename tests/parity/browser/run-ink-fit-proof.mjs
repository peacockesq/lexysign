#!/usr/bin/env node
/**
 * Headless Chromium proof for convertBase64ToImg.
 * Synthetic ink only. Does not install browsers or build the client.
 *
 *   node tests/parity/browser/run-ink-fit-proof.mjs
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const utilsPath = path.join(repoRoot, "apps/OpenSign/src/constant/Utils.js");
const outDir = here;

function extractConvertBase64ToImg() {
  const source = readFileSync(utilsPath, "utf8");
  const start = source.indexOf("export async function convertBase64ToImg");
  const end = source.indexOf("//function to use After setting the signature URL");
  if (start < 0 || end < 0) {
    throw new Error("convertBase64ToImg block not found in Utils.js");
  }
  return source.slice(start, end).replace(/^export /m, "");
}

function buildHtml(fnSource) {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>ink-fit-proof</title></head>
<body>
<pre id="out">pending</pre>
<script>
${fnSource}

function syntheticSparse() {
  const c = document.createElement("canvas");
  c.width = 800;
  c.height = 200;
  const ctx = c.getContext("2d");
  ctx.clearRect(0, 0, 800, 200);
  ctx.fillStyle = "#000000";
  ctx.fillRect(360, 90, 80, 20);
  return c.toDataURL("image/png");
}

async function convertBefore(base64Image, widgetDims) {
  const { Width: maxWidth, Height: maxHeight } = widgetDims;
  const img = new Image();
  const loaded = new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = reject;
  });
  img.src = base64Image;
  await loaded;
  const imgW = img.naturalWidth;
  const imgH = img.naturalHeight;
  const scale = Math.min(maxWidth / imgW, maxHeight / imgH, 1);
  const drawW = imgW * scale;
  const drawH = imgH * scale;
  const pxRatio = (window.devicePixelRatio || 1) * 2;
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(maxWidth * pxRatio);
  canvas.height = Math.ceil(maxHeight * pxRatio);
  const ctx = canvas.getContext("2d");
  ctx.scale(pxRatio, pxRatio);
  ctx.clearRect(0, 0, maxWidth, maxHeight);
  const x = (maxWidth - drawW) / 2;
  const y = (maxHeight - drawH) / 2;
  ctx.drawImage(img, x, y, drawW, drawH);
  return canvas.toDataURL("image/png");
}

function measureInk(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const ctx = c.getContext("2d");
      ctx.drawImage(img, 0, 0);
      const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height);
      let minX = width, minY = height, maxX = -1, maxY = -1, count = 0;
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const a = data[(y * width + x) * 4 + 3];
          if (a > 0) {
            count += 1;
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
          }
        }
      }
      resolve({
        count,
        minX,
        minY,
        maxX,
        maxY,
        bboxW: maxX >= minX ? maxX - minX + 1 : 0,
        bboxH: maxY >= minY ? maxY - minY + 1 : 0,
        width,
        height
      });
    };
    img.onerror = reject;
    img.src = dataUrl;
  });
}

(async () => {
  const out = document.getElementById("out");
  try {
    const src = syntheticSparse();
    const widget150 = { Width: 150, Height: 50 };
    const widget271 = { Width: 271, Height: 50 };
    const dpr = window.devicePixelRatio || 1;
    const pxRatio = dpr * 2;
    const before150 = await convertBefore(src, widget150);
    const after150 = await convertBase64ToImg(src, widget150, "signature");
    const after271 = await convertBase64ToImg(src, widget271, "signature");
    const stamp150 = await convertBase64ToImg(src, widget150, "stamp");
    const beforeStats = await measureInk(before150);
    const afterStats = await measureInk(after150);
    const after271Stats = await measureInk(after271);
    const stampStats = await measureInk(stamp150);
    const payload = {
      ok: true,
      userAgent: navigator.userAgent,
      dpr,
      pxRatio,
      source: { width: 800, height: 200, ink: { x: 360, y: 90, w: 80, h: 20 } },
      before150: {
        cssInkH: beforeStats.bboxH / pxRatio,
        cssInkW: beforeStats.bboxW / pxRatio,
        heightFill: beforeStats.bboxH / pxRatio / 50,
        stats: beforeStats
      },
      after150: {
        cssInkH: afterStats.bboxH / pxRatio,
        cssInkW: afterStats.bboxW / pxRatio,
        heightFill: afterStats.bboxH / pxRatio / 50,
        stats: afterStats
      },
      after271: {
        cssInkH: after271Stats.bboxH / pxRatio,
        cssInkW: after271Stats.bboxW / pxRatio,
        heightFill: after271Stats.bboxH / pxRatio / 50,
        stats: after271Stats
      },
      stamp150: {
        cssInkH: stampStats.bboxH / pxRatio,
        heightFill: stampStats.bboxH / pxRatio / 50,
        stats: stampStats
      },
      beforePng: before150,
      afterPng: after150
    };
    out.textContent = JSON.stringify(payload);
  } catch (err) {
    out.textContent = JSON.stringify({ ok: false, error: String(err && err.stack || err) });
  }
})();
</script>
</body>
</html>
`;
}

function findChromium() {
  const candidates = [
    process.env.CHROMIUM_PATH,
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome"
  ].filter(Boolean);
  for (const bin of candidates) {
    const probe = spawnSync(bin, ["--version"], { encoding: "utf8" });
    if (probe.status === 0) return { bin, version: (probe.stdout || probe.stderr || "").trim() };
  }
  return null;
}

function decodeDataUrl(dataUrl) {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) throw new Error("not a data URL");
  return Buffer.from(dataUrl.slice(comma + 1), "base64");
}

function main() {
  const chromium = findChromium();
  if (!chromium) {
    const blocker = {
      ok: false,
      blocker:
        "No local Chromium/Chrome binary found. python3 -m playwright is missing. Did not install browsers."
    };
    writeFileSync(path.join(outDir, "ink-fit-proof.json"), JSON.stringify(blocker, null, 2));
    console.error(blocker.blocker);
    process.exit(2);
  }

  mkdirSync(outDir, { recursive: true });
  const htmlPath = path.join(outDir, "ink-fit-proof.html");
  writeFileSync(htmlPath, buildHtml(extractConvertBase64ToImg()), "utf8");

  const args = [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--hide-scrollbars",
    "--virtual-time-budget=8000",
    "--dump-dom",
    "file://" + htmlPath
  ];
  const run = spawnSync(chromium.bin, args, {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    timeout: 30000
  });
  if (run.status !== 0) {
    const blocker = {
      ok: false,
      blocker: "chromium dump-dom failed",
      status: run.status,
      stderr: (run.stderr || "").slice(0, 4000),
      version: chromium.version
    };
    writeFileSync(path.join(outDir, "ink-fit-proof.json"), JSON.stringify(blocker, null, 2));
    console.error(JSON.stringify(blocker, null, 2));
    process.exit(3);
  }

  const dom = run.stdout || "";
  const match = dom.match(/<pre id="out">([^<]*)<\/pre>/);
  if (!match) {
    const blocker = {
      ok: false,
      blocker: "dump-dom did not contain #out payload",
      version: chromium.version,
      stdoutHead: dom.slice(0, 500)
    };
    writeFileSync(path.join(outDir, "ink-fit-proof.json"), JSON.stringify(blocker, null, 2));
    console.error(JSON.stringify(blocker, null, 2));
    process.exit(4);
  }

  const decoded = match[1]
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
  const payload = JSON.parse(decoded);
  if (!payload.ok) {
    writeFileSync(path.join(outDir, "ink-fit-proof.json"), JSON.stringify(payload, null, 2));
    console.error(payload.error || "proof function threw");
    process.exit(5);
  }

  const beforePath = path.join(outDir, "ink-fit-before.png");
  const afterPath = path.join(outDir, "ink-fit-after.png");
  writeFileSync(beforePath, decodeDataUrl(payload.beforePng));
  writeFileSync(afterPath, decodeDataUrl(payload.afterPng));

  const summary = {
    ok: true,
    chromium: chromium.version,
    userAgent: payload.userAgent,
    dpr: payload.dpr,
    pxRatio: payload.pxRatio,
    source: payload.source,
    before150: payload.before150,
    after150: payload.after150,
    after271: payload.after271,
    stamp150: payload.stamp150,
    beforePng: beforePath,
    afterPng: afterPath
  };
  writeFileSync(path.join(outDir, "ink-fit-proof.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

main();
