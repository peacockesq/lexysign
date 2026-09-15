import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadSourceModule, readRepoFile } from "./helpers/load-source-module.mjs";
import {
  createInkRaster,
  inkStats,
  registerRaster
} from "./helpers/dom-stubs.mjs";
import { loadUtilsModule } from "./helpers/utils-loader.mjs";
import { openSignSrc } from "./helpers/paths.mjs";
import {
  isDispatchedLock,
  runInterruptedSendSequence
} from "./helpers/send-state-harness.mjs";

const SPARSE_SRC = "data:image/png;base64,c3BhcnNl";
const FULL_LARGE_SRC = "data:image/png;base64,ZnVsbGxhcmdl";

function lastDrawImage(canvases) {
  for (let i = canvases.length - 1; i >= 0; i -= 1) {
    const op = canvases[i].ops.find((entry) => entry[0] === "drawImage");
    if (op) return { canvas: canvases[i], args: op[1] };
  }
  return null;
}

function replaceConvertBase64ToImg(source, implementation) {
  const start = source.indexOf("export async function convertBase64ToImg");
  const end = source.indexOf("//function to use After setting the signature URL");
  if (start < 0 || end < 0) throw new Error("convertBase64ToImg block not found");
  return source.slice(0, start) + implementation + "\n" + source.slice(end);
}

const TRIM_AND_FILL = `export async function convertBase64ToImg(base64Image, widgetDims) {
  const { Width: maxWidth, Height: maxHeight } = widgetDims;
  const img = new Image();
  img.src = base64Image;
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = reject;
  });
  const imgW = img.naturalWidth;
  const imgH = img.naturalHeight;
  const pix = img.pixels;
  let minX = imgW, minY = imgH, maxX = -1, maxY = -1;
  for (let y = 0; y < imgH; y++) {
    for (let x = 0; x < imgW; x++) {
      if (pix[(y * imgW + x) * 4 + 3] > 0) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  const trimW = Math.max(1, maxX - minX + 1);
  const trimH = Math.max(1, maxY - minY + 1);
  const scale = Math.min(maxWidth / trimW, maxHeight / trimH);
  const drawW = trimW * scale;
  const drawH = trimH * scale;
  const pxRatio = (window.devicePixelRatio || 1) * 2;
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(maxWidth * pxRatio);
  canvas.height = Math.ceil(maxHeight * pxRatio);
  const ctx = canvas.getContext("2d");
  ctx.scale(pxRatio, pxRatio);
  ctx.clearRect(0, 0, maxWidth, maxHeight);
  const x = (maxWidth - drawW) / 2;
  const y = (maxHeight - drawH) / 2;
  ctx.drawImage(img, minX, minY, trimW, trimH, x, y, drawW, drawH);
  return canvas.toDataURL("image/png");
}
`;

const BROKEN = `export async function convertBase64ToImg(base64Image, widgetDims) {
  return "data:image/png;base64,AAAA";
}
`;

describe("harness validation (not a product fix)", () => {
  it("missing module stubs fail at load instead of becoming {}", () => {
    assert.throws(
      () =>
        loadSourceModule(openSignSrc("constant/Utils.js"), {
          sourceText: 'import missingmod from "no-such-stub";\nexport const x = 1;\n',
          stubs: {}
        }),
      /Missing module stub for "no-such-stub"/
    );
  });

  it("breaking convertBase64ToImg causes the no-upscale draw assertion to fail", async () => {
    registerRaster(
      FULL_LARGE_SRC,
      createInkRaster({ width: 400, height: 200, ink: { x: 0, y: 0, w: 400, h: 200 } })
    );
    const source = replaceConvertBase64ToImg(
      readRepoFile(openSignSrc("constant/Utils.js")),
      BROKEN
    );
    const loaded = loadUtilsModule({ sourceText: source });
    await loaded.exports.convertBase64ToImg(FULL_LARGE_SRC, { Width: 150, Height: 60 });
    let failed = false;
    try {
      assert.ok(lastDrawImage(loaded.canvases), "convertBase64ToImg must call drawImage");
    } catch {
      failed = true;
    }
    assert.equal(failed, true);
  });

  it("candidate trim-and-fill makes the occupancy fit policy pass", async () => {
    registerRaster(
      SPARSE_SRC,
      createInkRaster({
        width: 800,
        height: 200,
        ink: { x: 360, y: 90, w: 80, h: 20 }
      })
    );
    const source = replaceConvertBase64ToImg(
      readRepoFile(openSignSrc("constant/Utils.js")),
      TRIM_AND_FILL
    );
    const loaded = loadUtilsModule({ sourceText: source });
    await loaded.exports.convertBase64ToImg(SPARSE_SRC, { Width: 271, Height: 50 });
    const drawn = lastDrawImage(loaded.canvases);
    assert.ok(drawn);
    const stats = inkStats(drawn.canvas);
    const pxRatio = (loaded.window.devicePixelRatio || 1) * 2;
    const heightFill = stats.bboxH / pxRatio / 50;
    assert.ok(
      heightFill >= 0.5,
      `candidate fill was ${heightFill}; trim-and-fill mutation did not change output`
    );
  });

  it("candidate reopen that ignores SignedUrl-only lock makes the send-state RED pass", async () => {
    const original = readRepoFile(openSignSrc("pages/PlaceHolderSign.jsx"));
    const mutated = original.replace(
      `        } else {
          // If document is dispatched for signing
          setIsAlreadyPlace({
            status: true,
            message: t("document-signed-alert-8")
          });
        }`,
      `        } else {
          setIsAlreadyPlace({ status: false, message: "" });
        }`
    );
    const observed = await runInterruptedSendSequence({ placeholderSrc: mutated });
    assert.equal(isDispatchedLock(observed.placed), false);
  });
});
