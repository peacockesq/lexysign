import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { loadSourceModule } from "./helpers/load-source-module.mjs";
import { FakeImage, imageNaturalSize, installDomStubs } from "./helpers/dom-stubs.mjs";
import { openSignSrc } from "./helpers/paths.mjs";

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/synthetic-field-layout.json", import.meta.url), "utf8")
);

function loadUtils(imageSize) {
  imageNaturalSize.width = imageSize.width;
  imageNaturalSize.height = imageSize.height;
  const dom = installDomStubs();
  const { exports } = loadSourceModule(openSignSrc("constant/Utils.js"), {
    stubs: {
      axios: { post: async () => ({ data: {} }), get: async () => ({ data: {} }) },
      moment: () => ({ format: () => "", isValid: () => true }),
      "pdf-lib": { PDFDocument: {}, rgb: () => ({}), degrees: () => ({}) },
      parse: {
        User: { current: () => null },
        Object: class {},
        Query: class {},
        Cloud: { run: async () => ({}) }
      },
      "./appinfo": { appInfo: { applogo: "", appId: "opensign" } },
      "file-saver": { saveAs: () => {} },
      "print-js": () => {},
      "@pdf-lib/fontkit": {},
      "./const": { themeColor: "#000" },
      "date-fns-tz": { format: () => "", toZonedTime: (d) => d },
      "../i18n": { t: (k) => k },
      "../utils": {
        applyNumberFormulasToPages: (pages) => pages,
        buildDownloadFilename: () => "file.pdf",
        addPreferenceOpt: () => ({})
      }
    },
    globals: {
      window: dom.window,
      document: dom.document,
      localStorage: dom.localStorage,
      Image: FakeImage,
      atob: (value) => Buffer.from(value, "base64").toString("binary"),
      btoa: (value) => Buffer.from(value, "binary").toString("base64"),
      fetch: async () => ({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(8),
        blob: async () => new Blob()
      })
    }
  });
  return { exports, canvases: dom.canvases };
}

function lastDrawImage(canvases) {
  for (let i = canvases.length - 1; i >= 0; i -= 1) {
    const op = canvases[i].ops.find((entry) => entry[0] === "drawImage");
    if (op) return { canvas: canvases[i], args: op[1] };
  }
  return null;
}

describe("signature ink bounding-box fitting (Utils.convertBase64ToImg)", () => {
  const [widgetX, widgetY, widgetW, widgetH] = fixture.signature_boxes_pdf_top_origin.alpha;
  const sparse = fixture.sparse_draw_canvas;

  it("never upscales and preserves drawn-canvas whitespace instead of trimming ink", async () => {
    const { exports, canvases } = loadUtils({
      width: sparse.width,
      height: sparse.height
    });

    const png = await exports.convertBase64ToImg("data:image/png;base64,AAAA", {
      Width: widgetW,
      Height: widgetH
    });
    assert.equal(png.startsWith("data:image/png;base64,"), true);

    const drawn = lastDrawImage(canvases);
    assert.ok(drawn, "convertBase64ToImg must draw the source image onto a widget canvas");
    const [, x, y, drawW, drawH] = drawn.args;
    const expectedScale = Math.min(widgetW / sparse.width, widgetH / sparse.height, 1);
    assert.equal(expectedScale <= 1, true);
    assert.equal(drawW, sparse.width * expectedScale);
    assert.equal(drawH, sparse.height * expectedScale);
    assert.equal(x, (widgetW - drawW) / 2);
    assert.equal(y, (widgetH - drawH) / 2);
    assert.equal(widgetX >= 0 && widgetY >= 0, true);
  });

  it("keeps sparse draw ink small inside the synthetic Alpha signature box (current-code reproduction)", async () => {
    const { exports } = loadUtils({
      width: sparse.width,
      height: sparse.height
    });
    await exports.convertBase64ToImg("data:image/png;base64,AAAA", {
      Width: widgetW,
      Height: widgetH
    });
    const scale = Math.min(widgetW / sparse.width, widgetH / sparse.height, 1);
    const fittedInkWidth = sparse.ink_width * scale;
    const fittedInkHeight = sparse.ink_height * scale;
    const widthFill = fittedInkWidth / widgetW;
    const heightFill = fittedInkHeight / widgetH;
    assert.ok(
      widthFill < 0.2 && heightFill < 0.3,
      `current fit preserves pad; expected small occupancy, got widthFill=${widthFill} heightFill=${heightFill}`
    );
  });

  it("RED: fitted ink from a sparse draw canvas should fill at least half of the widget", async () => {
    const scale = Math.min(widgetW / sparse.width, widgetH / sparse.height, 1);
    const widthFill = (sparse.ink_width * scale) / widgetW;
    assert.ok(
      widthFill >= 0.5,
      `sparse drawn ink occupies only ${(widthFill * 100).toFixed(1)}% of widget width after convertBase64ToImg; whitespace is not trimmed`
    );
  });

  it("onSaveSign stores draw ink on the targeted widget without rewriting field Width/Height", () => {
    const { exports } = loadUtils({ width: 10, height: 10 });
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
