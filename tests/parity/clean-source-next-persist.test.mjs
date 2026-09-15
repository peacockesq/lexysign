import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadSourceModule } from "./helpers/load-source-module.mjs";
import { UTILS_STUBS } from "./helpers/utils-loader.mjs";
import { sliceBetween, runSourceBlock } from "./helpers/extract-source.mjs";
import { openSignSrc } from "./helpers/paths.mjs";
import {
  applyDraftFieldsToPdfDetails,
  buildDraftSavePayload,
  editableSourceUrl,
  isDraftSavePayload
} from "../../apps/OpenSign/src/utils/draftDocumentPreparation.js";
import * as prep from "../../apps/OpenSign/src/utils/draftDocumentPreparation.js";
import {
  createPersistedDocumentStore,
  customizeMailSource,
  draftDocument,
  placeholderSource,
  runCustomizeMailClose
} from "./helpers/send-state-harness.mjs";
import { loadTestFontBytes, requirePdfDeps } from "./helpers/pdf-deps.mjs";
import { extractPdfPageRotation, extractPdfText, pdfHasVisibleText } from "./helpers/pdf-text.mjs";

const ORIGINAL = "REVIEW_ORIGINAL_VALUE";
const CORRECTED = "REVIEW_CORRECTED_VALUE";

describe("Next persists changed clean source without baking prefill", () => {
  it("rotate, Next, close before autosave, reopen keeps 90° clean source; prefill edits stay off URL", async () => {
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

    const src = placeholderSource();
    const embed = sliceBetween(src, "const embedPrefilllWidgets = async () => {", "\n  const handleSaveDoc");
    const save = sliceBetween(
      src,
      "const saveDocumentDetails = utils.withSessionValidation(async () => {",
      "\n  const finalizeInvitation"
    );
    const load = sliceBetween(src, "const url = editableSourceUrl(documentData[0]);", "\n      setOwner(");
    const auto = sliceBetween(src, "const autosavedetails = async () => {", "\n  // Next persists");
    const effect = sliceBetween(src, "useEffect(() => {\n    const timer = setTimeout", "\n  // `autosavedetails`");

    const pdfs = new Map();
    let serial = 0;
    const startDoc = await pdfLib.PDFDocument.create();
    startDoc.addPage([612, 792]).drawText("FICTIONAL_CLEAN_SOURCE_PAGE_1", { x: 30, y: 740, size: 12 });
    startDoc.addPage([612, 792]).drawText("FICTIONAL_CLEAN_SOURCE_PAGE_2", { x: 30, y: 740, size: 12 });
    const originalBytes = await startDoc.save();
    const cleanUrl = "https://example.test/clean-source.pdf";
    pdfs.set(cleanUrl, Buffer.from(originalBytes));

    function loadEditable(doc) {
      let bytes;
      let base64;
      const requests = [];
      const fn = runSourceBlock(
        `const loadReviewed = async () => {${load}\n};`,
        {
          ...prep,
          documentData: [doc],
          convertPdfArrayBuffer: async (url) => {
            requests.push(url);
            assert.equal(pdfs.has(url), true, `missing fixture ${url}`);
            return Uint8Array.from(pdfs.get(url));
          },
          getBase64FromUrl: async (url) => pdfs.get(url).toString("base64"),
          setPdfArrayBuffer: (x) => {
            bytes = x;
          },
          setPdfBase64Url: (x) => {
            base64 = x;
          },
          setHandleError: () => {
            throw new Error("load error");
          },
          t: (x) => x
        },
        "loadReviewed"
      );
      return fn().then(() => ({ bytes, base64, requests }));
    }

    function textWidget(text, x = 30, y = 100, pageNumber = 1) {
      return [
        {
          Role: "prefill",
          placeHolder: [
            {
              pageNumber,
              pos: [
                {
                  key: "synthetic-prefill",
                  type: "text",
                  Width: 260,
                  Height: 30,
                  xPosition: x,
                  yPosition: y,
                  options: { response: text, fontSize: 12 }
                }
              ]
            }
          ]
        }
      ];
    }

    async function next(mem, widgets, { failUpload = false, failPut = false, loaded, isUploadPdf = true } = {}) {
      const doc = mem.store.document;
      const input = loaded || (await loadEditable(doc));
      const state = { loading: null, modal: false, alerts: [], puts: [], details: [doc] };
      const fn = runSourceBlock(
        `${embed}\n${save}`,
        {
          ...prep,
          applyDraftFieldsToPdfDetails,
          buildDraftSavePayload,
          isUploadPdf,
          utils: { withSessionValidation: (fn) => fn },
          signerPos: widgets,
          pdfArrayBuffer: input.bytes,
          pdfBase64Url: input.base64,
          PDFDocument: pdfLib.PDFDocument,
          embedWidgetsToDoc: utils.embedWidgetsToDoc,
          scale: 1,
          prefillImg: [],
          generatePdfName: () => `fixture-${++serial}`,
          convertBase64ToFile: async (name, b64) => {
            if (failUpload) throw new Error("synthetic upload rejected");
            assert.equal(typeof b64, "string");
            const url = `https://example.test/${name}.pdf`;
            pdfs.set(url, Buffer.from(b64, "base64"));
            return url;
          },
          localStorage: {
            getItem: (k) =>
              ({ TenantId: "tenant1", accesstoken: "fictional-token", baseUrl: "https://example.test/", parseAppId: "fixture" })[k]
          },
          owner: {},
          SaveFileSize: () => {},
          atob,
          alert: (m) => state.alerts.push(m),
          console,
          pdfDetails: [doc],
          documentId: doc.objectId,
          docTitle: "fictional review",
          currentId: "alpha@example.test",
          signersdata: [
            { objectId: "c1", Email: "alpha@example.test", Role: "signer", UserId: { objectId: "user-alpha" } }
          ],
          axios: {
            put: async (...args) => {
              state.puts.push(args);
              if (failPut) throw new Error("synthetic draft PUT rejected");
              return mem.axiosPut(...args);
            }
          },
          setPdfDetails: (v) => {
            state.details = v;
          },
          setIsUiLoading: (v) => {
            state.loading = v;
          },
          setCurrentId: () => {},
          setIsLoading: () => {},
          setIsSendAlert: () => {},
          setIsSend: () => {},
          setIsCurrUser: () => {},
          setIsMailModal: (v) => {
            state.modal = v;
          },
          t: (k) => k
        },
        "saveDocumentDetails"
      );
      await fn();
      return state;
    }

    const doc = { ...draftDocument(), URL: cleanUrl, CreatedBy: { objectId: "owner-1" } };
    const mem = createPersistedDocumentStore(doc);
    const input = await loadEditable(doc);
    const rotated = await utils.rotatePdfPage(90, 1, input.bytes);
    const loaded = { bytes: rotated.arrayBuffer, base64: rotated.base64 };
    assert.equal((await pdfLib.PDFDocument.load(loaded.bytes)).getPage(1).getRotation().angle, 90);

    let autosaves = 0;
    let cleanup;
    const scheduled = [];
    runSourceBlock(
      effect,
      {
        useEffect: (fn) => {
          cleanup = fn();
        },
        setTimeout: (fn, ms) => {
          scheduled.push(ms);
          return setTimeout(fn, ms);
        },
        clearTimeout,
        pdfDetails: [doc],
        user: { objectId: "owner-1" },
        autosavedetails: () => {
          autosaves += 1;
        },
        signerPos: [],
        signersdata: [],
        signatureType: [],
        pdfBase64Url: loaded.base64
      },
      "undefined"
    );

    const signerWidgets = [
      {
        Id: "ph-alpha",
        Role: "signer",
        signerObjId: "c1",
        placeHolder: [{ pageNumber: 1, pos: [{ key: "signature-1", type: "signature" }] }]
      }
    ];
    const started = Date.now();
    const state = await next(mem, signerWidgets, { loaded });
    const elapsed = Date.now() - started;
    assert.equal(state.modal, true);
    assert.equal(isDraftSavePayload(state.puts[0][1]), true);
    assert.notEqual(mem.store.document.URL, cleanUrl);
    assert.ok(mem.store.document.PreparedUrl);
    assert.notEqual(mem.store.document.URL, mem.store.document.PreparedUrl);

    const close = runCustomizeMailClose(customizeMailSource());
    assert.equal(close.nav.length, 1);
    cleanup();
    assert.equal(autosaves, 0);
    assert.equal(scheduled[0], 2000);
    assert.equal(elapsed < 2000, true);

    const preparedBytes = pdfs.get(mem.store.document.PreparedUrl);
    const reopened = await loadEditable(mem.store.document);
    assert.deepEqual(reopened.requests, [mem.store.document.URL]);
    const reopenRotation = (await pdfLib.PDFDocument.load(reopened.bytes)).getPage(1).getRotation().angle;
    const preparedRotation = (await pdfLib.PDFDocument.load(preparedBytes)).getPage(1).getRotation().angle;
    assert.equal(preparedRotation, 90);
    assert.equal(reopenRotation, 90);
    assert.equal(extractPdfPageRotation(preparedBytes, 2), 90);
    assert.equal(extractPdfPageRotation(reopened.bytes, 2), 90);
    assert.equal(editableSourceUrl(mem.store.document), mem.store.document.URL);

    const rejected = { ...doc, URL: cleanUrl };
    const rejectedMem = createPersistedDocumentStore(rejected);
    let attrs = {};
    const rejectedAuto = runSourceBlock(
      auto,
      {
        signersdata: [],
        signerPos: [],
        signatureType: [],
        isUploadPdf: true,
        pdfBase64Url: loaded.base64,
        generatePdfName: () => "clean-autosaved-rejected",
        convertBase64ToFile: async () => {
          throw new Error("synthetic autosave upload rejected");
        },
        Parse: {
          Object: class {
            set(k, v) {
              attrs[k] = v;
            }
            async save() {
              throw new Error("synthetic autosave save rejected");
            }
          }
        },
        documentId: doc.objectId,
        pdfDetails: [rejected],
        console,
        alert: (msg) => {
          throw new Error(msg);
        },
        t: (k) => k
      },
      "autosavedetails"
    );
    await assert.rejects(rejectedAuto);
    assert.equal(rejectedMem.store.document.URL, cleanUrl);
    const recovered = await next(rejectedMem, signerWidgets, { loaded });
    assert.equal(recovered.modal, true);
    assert.equal(extractPdfPageRotation(pdfs.get(rejectedMem.store.document.URL), 2), 90);

    const failUploadMem = createPersistedDocumentStore({ ...doc, URL: cleanUrl });
    const failedUpload = await next(failUploadMem, signerWidgets, { loaded, failUpload: true });
    assert.equal(failedUpload.modal, false);
    assert.equal(failedUpload.loading, false);
    assert.equal(failUploadMem.store.document.URL, cleanUrl);
    assert.equal(failedUpload.alerts.length > 0, true);

    const failPutMem = createPersistedDocumentStore({ ...doc, URL: cleanUrl });
    const failedPut = await next(failPutMem, signerWidgets, { loaded, failPut: true });
    assert.equal(failedPut.modal, false);
    assert.equal(failPutMem.store.document.URL, cleanUrl);
    assert.equal(failedPut.alerts.length > 0, true);

    const prefillMem = createPersistedDocumentStore({ ...doc, URL: cleanUrl });
    const firstPrefill = await next(prefillMem, textWidget(ORIGINAL), { loaded });
    assert.equal(firstPrefill.modal, true);
    const firstPrepared = pdfs.get(prefillMem.store.document.PreparedUrl);
    assert.equal(pdfHasVisibleText(firstPrepared, ORIGINAL), true);
    assert.equal(pdfHasVisibleText(pdfs.get(prefillMem.store.document.URL), ORIGINAL), false);
    assert.equal(extractPdfPageRotation(pdfs.get(prefillMem.store.document.URL), 2), 90);

    const changed = await next(prefillMem, textWidget(CORRECTED, 300), {
      loaded: await loadEditable(prefillMem.store.document)
    });
    assert.equal(changed.modal, true);
    const changedText = extractPdfText(pdfs.get(prefillMem.store.document.PreparedUrl));
    assert.equal(changedText.includes(CORRECTED), true);
    assert.equal(changedText.includes(ORIGINAL), false);
    assert.equal(pdfHasVisibleText(pdfs.get(prefillMem.store.document.URL), ORIGINAL), false);
    assert.equal(pdfHasVisibleText(pdfs.get(prefillMem.store.document.URL), CORRECTED), false);

    const moved = await next(prefillMem, textWidget(CORRECTED, 120, 210, 2), {
      loaded: await loadEditable(prefillMem.store.document)
    });
    assert.equal(moved.modal, true);
    const movedText = extractPdfText(pdfs.get(prefillMem.store.document.PreparedUrl));
    assert.equal(movedText.includes(CORRECTED), true);
    assert.equal(movedText.includes(ORIGINAL), false);

    const removed = await next(prefillMem, [], { loaded: await loadEditable(prefillMem.store.document) });
    assert.equal(removed.modal, true);
    const removedText = extractPdfText(pdfs.get(prefillMem.store.document.PreparedUrl));
    assert.equal(removedText.includes(ORIGINAL), false);
    assert.equal(removedText.includes(CORRECTED), false);
    assert.equal(removedText.includes("FICTIONAL_CLEAN_SOURCE_PAGE_1"), true);
    assert.ok(version);
  });
});
