import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  createInkRaster,
  inkStats,
  registerRaster
} from "./helpers/dom-stubs.mjs";
import { loadUtilsModule } from "./helpers/utils-loader.mjs";

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/synthetic-field-layout.json", import.meta.url), "utf8")
);

const SPARSE_SRC = "data:image/png;base64,c3BhcnNl";
const FULL_LARGE_SRC = "data:image/png;base64,ZnVsbGxhcmdl";
const FULL_SMALL_SRC = "data:image/png;base64,ZnVsbHNtYWxs";

function lastDrawImage(canvases) {
  for (let i = canvases.length - 1; i >= 0; i -= 1) {
    const op = canvases[i].ops.find((entry) => entry[0] === "drawImage");
    if (op) return { canvas: canvases[i], args: op[1] };
  }
  return null;
}

function registerSparse() {
  const sparse = fixture.sparse_draw_canvas;
  registerRaster(
    SPARSE_SRC,
    createInkRaster({
      width: sparse.width,
      height: sparse.height,
      ink: { x: 360, y: 90, w: sparse.ink_width, h: sparse.ink_height }
    })
  );
  return sparse;
}

async function fit(src, widget) {
  const loaded = loadUtilsModule();
  const png = await loaded.exports.convertBase64ToImg(src, widget);
  const drawn = lastDrawImage(loaded.canvases);
  const stats = drawn ? inkStats(drawn.canvas) : inkStats({ pixels: null, width: 0, height: 0 });
  const pxRatio = (loaded.window.devicePixelRatio || 1) * 2;
  return { png, drawn, stats, pxRatio, canvases: loaded.canvases, exports: loaded.exports };
}

describe("signature ink bounding-box fitting (Utils.convertBase64ToImg)", () => {
  const [, , widgetW, widgetH] = fixture.signature_boxes_pdf_top_origin.alpha;

  it("no-upscale and aspect: a filled source larger than the widget is scaled down, not grown", async () => {
    registerRaster(
      FULL_LARGE_SRC,
      createInkRaster({ width: 400, height: 200, ink: { x: 0, y: 0, w: 400, h: 200 } })
    );
    const { drawn, stats, pxRatio } = await fit(FULL_LARGE_SRC, { Width: 150, Height: 60 });
    assert.ok(drawn, "convertBase64ToImg must call drawImage");
    const [, , , drawW, drawH] = drawn.args;
    assert.ok(drawW <= 400 && drawH <= 200, "must not upscale a larger source");
    assert.ok(Math.abs(drawW / drawH - 400 / 200) < 0.02, "aspect of the source bitmap is preserved");
    assert.ok(stats.count > 0, "output pixels come from drawImage of the source raster");
    assert.ok(stats.bboxW / pxRatio <= 150 + 1);
    assert.ok(stats.bboxH / pxRatio <= 60 + 1);
  });

  it("no-upscale: a filled source smaller than the widget stays at native size", async () => {
    registerRaster(
      FULL_SMALL_SRC,
      createInkRaster({ width: 40, height: 20, ink: { x: 0, y: 0, w: 40, h: 20 } })
    );
    const { drawn, stats, pxRatio } = await fit(FULL_SMALL_SRC, {
      Width: widgetW,
      Height: widgetH
    });
    assert.ok(drawn);
    const [, , , drawW, drawH] = drawn.args;
    assert.equal(drawW, 40);
    assert.equal(drawH, 20);
    assert.ok(Math.abs(stats.bboxW / pxRatio - 40) <= 2);
    assert.ok(Math.abs(stats.bboxH / pxRatio - 20) <= 2);
  });

  it("baseline characterization: sparse-pad occupancy is measured from product pixels (not a regression gate)", async () => {
    const sparse = registerSparse();
    const { drawn, stats, pxRatio } = await fit(SPARSE_SRC, { Width: widgetW, Height: widgetH });
    assert.ok(drawn, "product convertBase64ToImg must draw");
    assert.ok(stats.count > 0, "output must contain ink pixels copied from the source raster");
    const cssInkH = stats.bboxH / pxRatio;
    const cssInkW = stats.bboxW / pxRatio;
    assert.ok(cssInkW > 0 && cssInkH > 0);
  });

  it("RED fit policy: trimmed sparse ink must fill at least half the widget height", async () => {
    registerSparse();
    const { stats, pxRatio, drawn } = await fit(SPARSE_SRC, { Width: widgetW, Height: widgetH });
    assert.ok(drawn, "gate is driven by convertBase64ToImg draw output");
    const heightFill = stats.bboxH / pxRatio / widgetH;
    assert.ok(
      heightFill >= 0.5,
      `product output ink height fills ${(heightFill * 100).toFixed(1)}% of the ${widgetH}pt widget; whitespace trimming is not observable`
    );
  });

  it("onSaveSign stores draw ink on the targeted widget without rewriting field Width/Height", () => {
    const { exports } = loadUtilsModule();
    const pages = [
      {
        pageNumber: 3,
        pos: [
          {
            key: "alpha-sign",
            type: "signature",
            Width: widgetW,
            Height: widgetH,
            options: { name: "alpha" }
          }
        ]
      }
    ];
    const updated = exports.onSaveSign(
      "draw",
      pages,
      0,
      "alpha-sign",
      "data:image/png;base64,draw",
      {},
      false,
      "",
      false,
      "signature",
      "Fasthand",
      "blue"
    );
    const widget = updated[0].pos[0];
    assert.equal(widget.Width, widgetW);
    assert.equal(widget.Height, widgetH);
    assert.equal(widget.SignUrl, "data:image/png;base64,draw");
    assert.equal(widget.options.response, "data:image/png;base64,draw");
    assert.equal(widget.signatureType, "draw");
  });
});
