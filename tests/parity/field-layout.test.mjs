import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { loadSourceModule, readRepoFile } from "./helpers/load-source-module.mjs";
import { loadUtilsModule } from "./helpers/utils-loader.mjs";
import { openSignSrc } from "./helpers/paths.mjs";

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/synthetic-field-layout.json", import.meta.url), "utf8")
);

let utilsExports;
function loadUtils() {
  if (utilsExports) return utilsExports;
  utilsExports = loadUtilsModule().exports;
  return utilsExports;
}

describe("field layout utilities", () => {
  it("defaultWidthHeight matches current signature/date/initials defaults", () => {
    const utils = loadUtils();
    const signature = utils.defaultWidthHeight("signature");
    const initials = utils.defaultWidthHeight("initials");
    const date = utils.defaultWidthHeight("date");
    assert.equal(signature.width, 150);
    assert.equal(signature.height, 60);
    assert.equal(initials.width, 50);
    assert.equal(initials.height, 50);
    assert.equal(date.width, 100);
    assert.equal(date.height, 20);
  });

  it("handleWidgetResize writes widget dimensions in unscaled page space", () => {
    const utils = loadUtils();
    assert.equal(typeof utils.handleImageResize, "undefined");
    assert.equal(typeof utils.handleWidgetResize, "function");
    let next = null;
    const signerPos = [
      {
        Id: "signer-a",
        placeHolder: [
          {
            pageNumber: 3,
            pos: [{ key: "w1", type: "signature", Width: 150, Height: 60, options: {} }]
          }
        ]
      }
    ];
    utils.handleWidgetResize(
      { offsetWidth: 271, offsetHeight: 50 },
      "w1",
      signerPos,
      (value) => {
        next = value;
      },
      3,
      1,
      "signer-a",
      true
    );
    const widget = next[0].placeHolder[0].pos[0];
    assert.equal(widget.Width, 271);
    assert.equal(widget.Height, 50);
    assert.equal(widget.IsResize, true);
  });

  it("createCustomPositionWidget stores the drawn rectangle as Width/Height", () => {
    const { exports } = loadSourceModule(openSignSrc("utils/widgetUtils.js"), {
      stubs: {
        moment: () => ({ format: () => "", isValid: () => true }),
        "../constant/Utils": {
          generateTitleFromFilename: (n) => n,
          selectFormat: () => "MM/DD/YYYY",
          changeDateToMomentFormat: (f) => f,
          isBase64: () => false,
          drawWidget: "draw",
          radioButtonWidget: "radio button",
          textInputWidget: "text input",
          textWidget: "text",
          cellsWidget: "cells",
          addWidgetOptions: (type) => ({ name: type, required: true })
        },
        "./fileUtils": { base64StringtoFile: () => ({}), uploadFile: async () => "" },
        "./sanitizeFileName": { sanitizeFileName: (n) => n },
        parse: { User: { current: () => ({ id: "u1", get: () => "User" }) }, Cloud: { run: async () => ({ id: "s1" }) } }
      }
    });
    const [x, y, w, h] = fixture.signature_boxes_pdf_top_origin.alpha;
    const { dropObj } = exports.createCustomPositionWidget({
      customPosition: { xPosition: x, yPosition: y, width: w, height: h },
      key: "alpha",
      containerScale: 1,
      posZIndex: 1,
      dragTypeValue: "signature",
      pageNumber: 3,
      owner: {},
      signerPlaceHolder: [],
      roleName: "Alpha"
    });
    assert.equal(dropObj.xPosition, 54);
    assert.equal(dropObj.yPosition, 162);
    assert.equal(dropObj.Width, 271);
    assert.equal(dropObj.Height, 50);
    assert.equal(dropObj.type, "signature");
  });

  it("hasSignatureWidget is true only when a signature field exists", () => {
    const { exports } = loadSourceModule(openSignSrc("utils/widgetUtils.js"), {
      stubs: {
        moment: () => ({}),
        "../constant/Utils": {
          generateTitleFromFilename: (n) => n,
          selectFormat: () => "",
          changeDateToMomentFormat: (f) => f,
          isBase64: () => false,
          drawWidget: "draw",
          radioButtonWidget: "radio button",
          textInputWidget: "text input",
          textWidget: "text",
          cellsWidget: "cells",
          addWidgetOptions: () => ({})
        },
        "./fileUtils": {},
        "./sanitizeFileName": { sanitizeFileName: (n) => n },
        parse: { User: { current: () => null }, Cloud: { run: async () => ({}) } }
      }
    });
    assert.equal(
      exports.hasSignatureWidget({
        placeHolder: [{ pos: [{ type: "date" }, { type: "signature" }] }]
      }),
      true
    );
    assert.equal(
      exports.hasSignatureWidget({
        placeHolder: [{ pos: [{ type: "date" }] }]
      }),
      false
    );
  });

  it("copied widgets are clamped inside the target page using PlaceholderCopy padding", () => {
    const src = readRepoFile(openSignSrc("components/pdf/PlaceholderCopy.jsx"));
    assert.match(src, /if \(updatedX \+ widgetWidth > targetPageWidth\)/);
    assert.match(src, /updatedX = targetPageWidth - widgetWidth - 10/);
    const pageWidth = fixture.page_size[0];
    const widgetWidth = 271;
    let updatedX = 500;
    if (updatedX + widgetWidth > pageWidth) {
      updatedX = pageWidth - widgetWidth - 10;
    }
    assert.equal(updatedX, 612 - 271 - 10);
    assert.equal(updatedX + widgetWidth <= pageWidth, true);
  });
});
