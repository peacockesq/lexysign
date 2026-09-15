import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  createInkRaster,
  inkStats,
  registerRaster
} from "./helpers/dom-stubs.mjs";
import {
  createEdgeStrokeRaster,
  createRaster,
  createTransparentLeftoverRgb,
  createWhiteBackgroundInk
} from "./helpers/ink-rasters.mjs";
import { loadUtilsModule } from "./helpers/utils-loader.mjs";

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/synthetic-field-layout.json", import.meta.url), "utf8")
);

const SPARSE_SRC = "data:image/png;base64,c3BhcnNl";
const FULL_LARGE_SRC = "data:image/png;base64,ZnVsbGxhcmdl";
const FULL_SMALL_SRC = "data:image/png;base64,ZnVsbHNtYWxs";
const LEFTOVER_SRC = "data:image/png;base64,bGVmdG92ZXI=";
const WHITE_BG_SRC = "data:image/png;base64,d2hpdGViZw==";
const YELLOW_SRC = "data:image/png;base64,eWVsbG93";
const EDGE_SRC = "data:image/png;base64,ZWRnZXN0cm9rZQ==";
const BLANK_SRC = "data:image/png;base64,Ymxhbms=";
const WHITE_ONLY_SRC = "data:image/png;base64,d2hpdGVvbmx5";
const LARGE_SRC = "data:image/png;base64,bGFyZ2VpbnB1dA==";
const MISSING_SRC = "data:image/png;base64,bWlzc2luZw==";

function lastDrawImage(canvases) {
  for (let i = canvases.length - 1; i >= 0; i -= 1) {
    const op = canvases[i].ops.find((entry) => entry[0] === "drawImage");
    if (op) return { canvas: canvases[i], args: op[1] };
  }
  return null;
}

function destDrawSize(drawn) {
  const args = drawn.args;
  if (args.length >= 9) return { drawW: args[7], drawH: args[8] };
  return { drawW: args[3], drawH: args[4] };
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

async function fit(src, widget, widgetType = "signature") {
  const loaded = loadUtilsModule();
  const png = await loaded.exports.convertBase64ToImg(src, widget, widgetType);
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
    const { drawW, drawH } = destDrawSize(drawn);
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
    const { drawW, drawH } = destDrawSize(drawn);
    assert.equal(drawW, 40);
    assert.equal(drawH, 20);
    assert.ok(Math.abs(stats.bboxW / pxRatio - 40) <= 2);
    assert.ok(Math.abs(stats.bboxH / pxRatio - 20) <= 2);
  });

  it("characterization: cropped sparse ink occupies at least half the widget height (pre-fix was 10%)", async () => {
    const sparse = registerSparse();
    const { drawn, stats, pxRatio } = await fit(SPARSE_SRC, { Width: widgetW, Height: widgetH });
    assert.ok(drawn, "product convertBase64ToImg must draw");
    assert.ok(stats.count > 0, "output must contain ink pixels copied from the source raster");
    const cssInkH = stats.bboxH / pxRatio;
    const cssInkW = stats.bboxW / pxRatio;
    assert.ok(cssInkW > 0 && cssInkH > 0);
    const heightFill = cssInkH / widgetH;
    assert.ok(
      heightFill >= 0.5,
      `intended occupancy is >=50%; got ${(heightFill * 100).toFixed(1)}% of ${widgetH}pt (source ink ${sparse.ink_width}x${sparse.ink_height} on ${sparse.width}x${sparse.height})`
    );
  });

  it("fit policy: trimmed sparse ink must fill at least half the widget height", async () => {
    registerSparse();
    const { stats, pxRatio, drawn } = await fit(SPARSE_SRC, { Width: widgetW, Height: widgetH });
    assert.ok(drawn, "gate is driven by convertBase64ToImg draw output");
    const heightFill = stats.bboxH / pxRatio / widgetH;
    assert.ok(
      heightFill >= 0.5,
      `product output ink height fills ${(heightFill * 100).toFixed(1)}% of the ${widgetH}pt widget; whitespace trimming is not observable`
    );
  });

  it("baseline 80x20 on 800x200 into 150x50 yields >=25px ink height without distortion", async () => {
    registerSparse();
    const { drawn, stats, pxRatio } = await fit(SPARSE_SRC, { Width: 150, Height: 50 });
    assert.ok(drawn);
    const { drawW, drawH } = destDrawSize(drawn);
    const cssInkH = stats.bboxH / pxRatio;
    assert.ok(cssInkH >= 25, `ink height ${cssInkH}px < 25px`);
    assert.ok(Math.abs(drawW / drawH - 80 / 20) < 0.6, "aspect stays near the cropped ink box (pad allowed)");
    assert.ok(drawH <= 50 + 1);
    assert.ok(drawW <= 150 + 1);
  });

  it("stamp/image widgets keep full-bitmap no-upscale and are not ink-cropped", async () => {
    registerSparse();
    const { stats, pxRatio, drawn } = await fit(
      SPARSE_SRC,
      { Width: widgetW, Height: widgetH },
      "stamp"
    );
    assert.ok(drawn);
    const heightFill = stats.bboxH / pxRatio / widgetH;
    assert.ok(
      heightFill < 0.2,
      `stamp occupancy ${heightFill} shows ink-trim leaked onto stamp semantics`
    );
    const { drawW, drawH } = destDrawSize(drawn);
    assert.ok(drawW <= 800 && drawH <= 200);
  });

  it("transparent leftover RGB is not treated as ink", async () => {
    const sparse = fixture.sparse_draw_canvas;
    registerRaster(
      LEFTOVER_SRC,
      createTransparentLeftoverRgb({
        width: sparse.width,
        height: sparse.height,
        ink: { x: 360, y: 90, w: sparse.ink_width, h: sparse.ink_height, rgba: [0, 0, 0, 255] }
      })
    );
    const { stats, pxRatio, drawn } = await fit(LEFTOVER_SRC, { Width: widgetW, Height: widgetH });
    assert.ok(drawn);
    const heightFill = stats.bboxH / pxRatio / widgetH;
    assert.ok(heightFill >= 0.5, "leftover transparent RGB must not keep the full pad");
  });

  it("white-background uploads crop near-white padding but keep light colored ink", async () => {
    registerRaster(
      WHITE_BG_SRC,
      createWhiteBackgroundInk({
        width: 800,
        height: 200,
        ink: { x: 360, y: 90, w: 80, h: 20, rgba: [0, 0, 0, 255] }
      })
    );
    const white = await fit(WHITE_BG_SRC, { Width: widgetW, Height: widgetH });
    assert.ok(white.stats.bboxH / white.pxRatio / widgetH >= 0.5);

    registerRaster(
      YELLOW_SRC,
      createWhiteBackgroundInk({
        width: 800,
        height: 200,
        ink: { x: 360, y: 90, w: 80, h: 20, rgba: [255, 255, 40, 255] }
      })
    );
    const yellow = await fit(YELLOW_SRC, { Width: widgetW, Height: widgetH });
    assert.ok(yellow.stats.count > 0, "light yellow ink must not be stripped as near-white");
    assert.ok(yellow.stats.bboxH / yellow.pxRatio / widgetH >= 0.5);
  });

  it("edge-stroke ink on the bitmap border is preserved", async () => {
    registerRaster(EDGE_SRC, createEdgeStrokeRaster({ width: 80, height: 40 }));
    const { drawn, stats, pxRatio } = await fit(EDGE_SRC, { Width: 80, Height: 40 });
    assert.ok(drawn);
    assert.ok(stats.count > 0);
    assert.ok(stats.bboxW / pxRatio >= 80 - 2);
    assert.ok(stats.bboxH / pxRatio >= 40 - 2);
  });

  it("blank, transparent, invalid dims, missing src, and oversized sources fail closed", async () => {
    registerRaster(BLANK_SRC, createRaster({ width: 40, height: 20 }));
    registerRaster(WHITE_ONLY_SRC, createRaster({ width: 40, height: 20, background: [255, 255, 255, 255] }));
    registerRaster(LARGE_SRC, createRaster({ width: 4097, height: 1, ink: { x: 0, y: 0, w: 1, h: 1, rgba: [0, 0, 0, 255] } }));

    const loaded = () => loadUtilsModule().exports.convertBase64ToImg;

    await assert.rejects(() => loaded()(BLANK_SRC, { Width: 50, Height: 50 }, "signature"), /no ink|invalid/i);
    await assert.rejects(() => loaded()(WHITE_ONLY_SRC, { Width: 50, Height: 50 }, "signature"), /no ink|invalid/i);
    await assert.rejects(() => loaded()(MISSING_SRC, { Width: 50, Height: 50 }, "signature"), /load failed/i);
    await assert.rejects(() => loaded()(SPARSE_SRC, { Width: 0, Height: 50 }, "signature"), /invalid widget dimensions/);
    await assert.rejects(() => loaded()(SPARSE_SRC, { Width: -10, Height: 50 }, "signature"), /invalid widget dimensions/);
    await assert.rejects(() => loaded()(SPARSE_SRC, { Width: Number.NaN, Height: 50 }, "signature"), /invalid widget dimensions/);
    await assert.rejects(() => loaded()(SPARSE_SRC, { Width: 99999, Height: 50 }, "signature"), /invalid widget dimensions/);
    await assert.rejects(() => loaded()("", { Width: 50, Height: 50 }, "signature"), /invalid image/);
    await assert.rejects(() => loaded()(LARGE_SRC, { Width: 50, Height: 50 }, "signature"), /invalid image dimensions/);
  });

  it("initials type trims sparse ink; omitted type does not crop (stamp-safe default)", async () => {
    registerSparse();
    const initials = await fit(SPARSE_SRC, { Width: widgetW, Height: widgetH }, "initials");
    assert.ok(initials.stats.bboxH / initials.pxRatio / widgetH >= 0.5);

    const loaded = loadUtilsModule();
    await loaded.exports.convertBase64ToImg(SPARSE_SRC, { Width: widgetW, Height: widgetH });
    const drawn = lastDrawImage(loaded.canvases);
    assert.ok(drawn);
    const stats = inkStats(drawn.canvas);
    const pxRatio = (loaded.window.devicePixelRatio || 1) * 2;
    assert.ok(
      stats.bboxH / pxRatio / widgetH < 0.2,
      "omitted widget type must preserve stamp/artwork padding"
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
