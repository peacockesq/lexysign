import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadSourceModule, readRepoFile } from "./helpers/load-source-module.mjs";
import { UTILS_STUBS } from "./helpers/utils-loader.mjs";
import { sliceBetween, runSourceBlock } from "./helpers/extract-source.mjs";
import { openSignSrc } from "./helpers/paths.mjs";
import {
  buildDraftSavePayload,
  editableSourceUrl,
  isDraftSavePayload,
  preparedOutputUrl
} from "../../apps/OpenSign/src/utils/draftDocumentPreparation.js";
import { loadTestFontBytes, requirePdfDeps } from "./helpers/pdf-deps.mjs";
import { extractPdfText, pdfHasVisibleText } from "./helpers/pdf-text.mjs";

const ORIGINAL = "REVIEW_ORIGINAL_VALUE";
const CORRECTED = "REVIEW_CORRECTED_VALUE";
const REMOVED = "REVIEW_REMOVED_VALUE";

describe("prefill clean source vs prepared output", () => {
  it("reopen/move/change/remove re-embed from URL and never keep prior burned-in text", async () => {
    const { pdfLib, fontkit, version } = requirePdfDeps();
    const font = loadTestFontBytes();
    const utils = loadSourceModule(openSignSrc("constant/Utils.js"), {
      stubs: {
        ...UTILS_STUBS,
        "pdf-lib": pdfLib,
        "@pdf-lib/fontkit": fontkit
      },
      globals: {
        window: { innerWidth: 1200, location: { origin: "https://example.test" } },
        localStorage: { getItem: () => null },
        fetch: async () => ({ arrayBuffer: async () => font.bytes }),
        Uint8Array,
        ArrayBuffer,
        atob,
        btoa
      }
    }).exports;

    const src = readRepoFile(openSignSrc("pages/PlaceHolderSign.jsx"));
    const block = sliceBetween(src, "const embedPrefilllWidgets = async () => {", "\n  const handleSaveDoc");
    const start = await pdfLib.PDFDocument.create();
    start.addPage([612, 792]);
    const originalBytes = await start.save();
    let storedBytes;

    async function prepare(sourceBytes, widgets) {
      storedBytes = undefined;
      const fn = runSourceBlock(
        block,
        {
          signerPos: widgets,
          pdfArrayBuffer: sourceBytes,
          PDFDocument: pdfLib.PDFDocument,
          embedWidgetsToDoc: utils.embedWidgetsToDoc,
          scale: 1,
          prefillImg: [],
          generatePdfName: () => "synthetic",
          convertBase64ToFile: async (_name, b64) => {
            assert.equal(typeof b64, "string");
            storedBytes = Buffer.from(b64, "base64");
            return "https://example.test/prepared.pdf";
          },
          localStorage: { getItem: () => "synthetic" },
          owner: {},
          SaveFileSize: () => {},
          atob,
          alert: (msg) => {
            throw new Error(msg);
          },
          console,
          pdfBase64Url: "",
          pdfDetails: [{ URL: "https://example.test/original.pdf" }]
        },
        "embedPrefilllWidgets"
      );
      const url = await fn();
      assert.ok(url);
      const payload = buildDraftSavePayload({
        name: "synthetic",
        placeholders: widgets,
        signers: [],
        preparedUrl: url
      });
      return { payload, bytes: storedBytes, url };
    }

    function textWidget(text, x) {
      return [
        {
          Role: "prefill",
          placeHolder: [
            {
              pageNumber: 1,
              pos: [
                {
                  key: "synthetic-prefill",
                  type: "text",
                  Width: 250,
                  Height: 30,
                  xPosition: x,
                  yPosition: 100,
                  options: { response: text, fontSize: 12 }
                }
              ]
            }
          ]
        }
      ];
    }

    const persisted = {
      URL: "https://example.test/original.pdf",
      objectId: "doc1"
    };

    const first = await prepare(originalBytes, textWidget(ORIGINAL, 30));
    assert.equal(isDraftSavePayload(first.payload), true);
    assert.equal(first.payload.PreparedUrl, "https://example.test/prepared.pdf");
    assert.equal(Object.prototype.hasOwnProperty.call(first.payload, "URL"), false);
    persisted.PreparedUrl = first.payload.PreparedUrl;
    assert.equal(editableSourceUrl(persisted), "https://example.test/original.pdf");
    assert.equal(preparedOutputUrl(persisted), "https://example.test/prepared.pdf");
    assert.equal(pdfHasVisibleText(first.bytes, ORIGINAL), true);

    // Reopen loads URL (originalBytes), never the previous prepared output.
    const second = await prepare(originalBytes, textWidget(CORRECTED, 300));
    const secondText = extractPdfText(second.bytes);
    assert.match(secondText, new RegExp(CORRECTED));
    assert.equal(secondText.includes(ORIGINAL), false);
    assert.equal(pdfHasVisibleText(second.bytes, ORIGINAL), false);
    assert.equal(pdfHasVisibleText(second.bytes, CORRECTED), true);

    const removed = await prepare(originalBytes, textWidget(REMOVED, 80));
    assert.equal(pdfHasVisibleText(removed.bytes, ORIGINAL), false);
    assert.equal(pdfHasVisibleText(removed.bytes, CORRECTED), false);
    assert.equal(pdfHasVisibleText(removed.bytes, REMOVED), true);

    const cleared = await prepare(originalBytes, []);
    assert.equal(cleared.bytes, undefined);
    assert.equal(cleared.url, "https://example.test/original.pdf");

    const movedAgain = await prepare(originalBytes, textWidget(CORRECTED, 120));
    assert.equal(pdfHasVisibleText(movedAgain.bytes, ORIGINAL), false);
    assert.equal(pdfHasVisibleText(movedAgain.bytes, REMOVED), false);
    assert.equal(pdfHasVisibleText(movedAgain.bytes, CORRECTED), true);
    assert.ok(version);
  });
});
