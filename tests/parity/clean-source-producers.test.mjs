import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import { loadSourceModule, readRepoFile } from "./helpers/load-source-module.mjs";
import { UTILS_STUBS } from "./helpers/utils-loader.mjs";
import { sliceBetween, runSourceBlock } from "./helpers/extract-source.mjs";
import { openSignSrc } from "./helpers/paths.mjs";
import * as prep from "../../apps/OpenSign/src/utils/draftDocumentPreparation.js";
import {
  createPersistedDocumentStore,
  customizeMailSource,
  draftDocument,
  placeholderSource,
  runCustomizeMailClose
} from "./helpers/send-state-harness.mjs";
import { loadTestFontBytes, requirePdfDeps } from "./helpers/pdf-deps.mjs";
import { extractPdfPageRotation, extractPdfText } from "./helpers/pdf-text.mjs";

describe("actual PDF producers mark clean source; overlapping draft writes stay ordered", () => {
  it("PdfTools and PdfHeader reorder set the dirty flag; Next/close keeps [2,1] clean source", async () => {
    const { pdfLib, fontkit } = requirePdfDeps();
    const font = loadTestFontBytes();
    const utils = loadSourceModule(openSignSrc("constant/Utils.js"), {
      stubs: { ...UTILS_STUBS, "pdf-lib": pdfLib, "@pdf-lib/fontkit": fontkit },
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
    const pdfs = new Map();
    let serial = 0;
    const startDoc = await pdfLib.PDFDocument.create();
    startDoc.addPage([612, 792]).drawText("FICTIONAL_CLEAN_SOURCE_PAGE_1", { x: 30, y: 740, size: 12 });
    startDoc.addPage([612, 792]).drawText("FICTIONAL_CLEAN_SOURCE_PAGE_2", { x: 30, y: 740, size: 12 });
    const originalBytes = await startDoc.save();
    const cleanUrl = "https://example.test/reorder-clean.pdf";
    pdfs.set(cleanUrl, Buffer.from(originalBytes));

    function loadEditable(doc) {
      let bytes;
      let base64;
      const fn = runSourceBlock(
        `const loadReviewed = async () => {${load}\n};`,
        {
          ...prep,
          documentData: [doc],
          convertPdfArrayBuffer: async (url) => Uint8Array.from(pdfs.get(url)),
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
      return fn().then(() => ({ bytes, base64 }));
    }

    async function next(mem, widgets, { loaded, isUploadPdf }) {
      const doc = mem.store.document;
      const state = { modal: false, alerts: [] };
      const fn = runSourceBlock(
        `${embed}\n${save}`,
        {
          ...prep,
          isUploadPdf,
          utils: { withSessionValidation: (fn) => fn },
          signerPos: widgets,
          pdfArrayBuffer: loaded.bytes,
          pdfBase64Url: loaded.base64,
          PDFDocument: pdfLib.PDFDocument,
          embedWidgetsToDoc: utils.embedWidgetsToDoc,
          scale: 1,
          prefillImg: [],
          generatePdfName: () => `fixture-${++serial}`,
          convertBase64ToFile: async (name, b64) => {
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
          docTitle: "fictional reorder",
          currentId: "alpha@example.test",
          signersdata: [{ objectId: "c1", Email: "alpha@example.test", Role: "signer", UserId: { objectId: "user-alpha" } }],
          axios: { put: async (...args) => mem.axiosPut(...args) },
          setPdfDetails: () => {},
          setIsUiLoading: () => {},
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

    function pageOrder(bytes) {
      return [...extractPdfText(bytes).matchAll(/FICTIONAL_CLEAN_SOURCE_PAGE_(\d)/g)].map((x) => Number(x[1]));
    }

    async function reorderFrom(file, loaded) {
      const tools = readRepoFile(openSignSrc(`components/pdf/${file}`));
      const block = sliceBetween(tools, "const handleReorderSave = async (order) => {", "\n\n  const handle");
      let flag = false;
      const reordered = { ...loaded };
      const reorder = runSourceBlock(
        block,
        {
          reorderPdfPages: utils.reorderPdfPages,
          props: {
            pdfArrayBuffer: loaded.bytes,
            setPdfArrayBuffer: (v) => {
              reordered.bytes = v;
            },
            setPdfBase64Url: (v) => {
              reordered.base64 = v;
            },
            setIsUploadPdf: (v) => {
              flag = v;
            },
            setAllPages: () => {},
            setPageNumber: () => {}
          },
          setIsReorderModal: () => {},
          console
        },
        "handleReorderSave"
      );
      await reorder([2, 1]);
      return { flag, reordered };
    }

    const widgets = [
      {
        Id: "ph-alpha",
        Role: "signer",
        signerObjId: "c1",
        placeHolder: [{ pageNumber: 1, pos: [{ key: "signature-1", type: "signature" }] }]
      }
    ];
    for (const file of ["PdfTools.jsx", "PdfHeader.jsx"]) {
      prep.resetDraftPersistenceState();
      const doc = { ...draftDocument(), objectId: `reorder-${file}`, URL: cleanUrl, CreatedBy: { objectId: "owner-1" } };
      const mem = createPersistedDocumentStore(doc);
      const loaded = await loadEditable(doc);
      const { flag, reordered } = await reorderFrom(file, loaded);
      assert.equal(flag, true, `${file} reorder must mark latest clean source`);
      assert.notDeepEqual(Buffer.from(reordered.bytes), Buffer.from(loaded.bytes));
      const saved = await next(mem, widgets, { loaded: reordered, isUploadPdf: flag });
      assert.equal(saved.modal, true);
      runCustomizeMailClose(customizeMailSource());
      const reopened = await loadEditable(mem.store.document);
      assert.deepEqual(pageOrder(pdfs.get(mem.store.document.PreparedUrl)), [2, 1]);
      assert.deepEqual(pageOrder(reopened.bytes), [2, 1]);
      assert.equal(extractPdfText(pdfs.get(mem.store.document.URL)).includes("FICTIONAL_CLEAN_SOURCE_PAGE_2"), true);
    }
  });

  it("started stale autosave cannot overwrite a newer successful Next; PUT-in-flight Next still wins", async () => {
    const { pdfLib, fontkit } = requirePdfDeps();
    const font = loadTestFontBytes();
    const utils = loadSourceModule(openSignSrc("constant/Utils.js"), {
      stubs: { ...UTILS_STUBS, "pdf-lib": pdfLib, "@pdf-lib/fontkit": fontkit },
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
    const autoSrc = sliceBetween(src, "const autosavedetails = async () => {", "\n  // Next persists");
    const pdfs = new Map();
    let serial = 0;
    const startDoc = await pdfLib.PDFDocument.create();
    startDoc.addPage([612, 792]).drawText("FICTIONAL_CLEAN_SOURCE_PAGE_1", { x: 30, y: 740, size: 12 });
    startDoc.addPage([612, 792]).drawText("FICTIONAL_CLEAN_SOURCE_PAGE_2", { x: 30, y: 740, size: 12 });
    const originalBytes = await startDoc.save();
    const widgets = [
      {
        Id: "ph-alpha",
        Role: "signer",
        signerObjId: "c1",
        placeHolder: [{ pageNumber: 1, pos: [{ key: "signature-1", type: "signature" }] }]
      }
    ];

    function loadEditable(doc) {
      let bytes;
      let base64;
      const fn = runSourceBlock(
        `const loadReviewed = async () => {${load}\n};`,
        {
          ...prep,
          documentData: [doc],
          convertPdfArrayBuffer: async (url) => Uint8Array.from(pdfs.get(url)),
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
      return fn().then(() => ({ bytes, base64 }));
    }

    async function rotate(input, degree) {
      const b = sliceBetween(src, "const handleRotationFun = async (rotateDegree) => {", "\n  const handleRemovePlaceholder");
      const state = { bytes: input.bytes, base64: input.base64, isUploadPdf: false };
      const f = runSourceBlock(
        b,
        {
          handleRotateWarning: () => false,
          signerPos: widgets,
          pageNumber: 2,
          setShowRotateAlert: () => {},
          setIsUploadPdf: (v) => {
            state.isUploadPdf = v;
          },
          rotatePdfPage: utils.rotatePdfPage,
          pdfArrayBuffer: input.bytes,
          setPdfArrayBuffer: (v) => {
            state.bytes = v;
          },
          setPdfBase64Url: (v) => {
            state.base64 = v;
          }
        },
        "handleRotationFun"
      );
      await f(degree);
      return state;
    }

    async function next(mem, loaded, { failUpload = false, failPut = false, holdPut } = {}) {
      const doc = mem.store.document;
      const state = { modal: false, alerts: [], loading: null };
      const fn = runSourceBlock(
        `${embed}\n${save}`,
        {
          ...prep,
          isUploadPdf: true,
          utils: { withSessionValidation: (fn) => fn },
          signerPos: widgets,
          pdfArrayBuffer: loaded.bytes,
          pdfBase64Url: loaded.base64,
          PDFDocument: pdfLib.PDFDocument,
          embedWidgetsToDoc: utils.embedWidgetsToDoc,
          scale: 1,
          prefillImg: [],
          generatePdfName: () => `fixture-${++serial}`,
          convertBase64ToFile: async (name, b64) => {
            if (failUpload) throw new Error("synthetic upload rejected");
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
          docTitle: "fictional race",
          currentId: "alpha@example.test",
          signersdata: [{ objectId: "c1", Email: "alpha@example.test", Role: "signer", UserId: { objectId: "user-alpha" } }],
          axios: {
            put: async (...args) => {
              if (holdPut) await holdPut.promise;
              if (failPut) throw new Error("synthetic draft PUT rejected");
              return mem.axiosPut(...args);
            }
          },
          setPdfDetails: () => {},
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

    function autosave(mem, loaded, { pauseUpload = false, pauseSave = false, failUpload = false, failSave = false } = {}) {
      let release;
      let started;
      const held = new Promise((r) => {
        release = r;
      });
      const entered = new Promise((r) => {
        started = r;
      });
      const attrs = {};
      const f = runSourceBlock(
        autoSrc,
        {
          ...prep,
          signersdata: mem.store.document.Signers,
          signerPos: widgets,
          signatureType: [],
          isUploadPdf: true,
          pdfBase64Url: loaded.base64,
          generatePdfName: () => `auto-${++serial}`,
          convertBase64ToFile: async (name, b64) => {
            started();
            if (pauseUpload) await held;
            if (failUpload) throw new Error("synthetic auto upload rejection");
            const url = `https://example.test/${name}.pdf`;
            pdfs.set(url, Buffer.from(b64, "base64"));
            return url;
          },
          Parse: {
            Object: class {
              set(k, v) {
                attrs[k] = v;
              }
              async save() {
                started();
                if (pauseSave) await held;
                if (failSave) throw new Error("synthetic auto write rejection");
                Object.assign(mem.store.document, attrs);
                return { id: mem.store.document.objectId };
              }
            }
          },
          documentId: mem.store.document.objectId,
          pdfDetails: [mem.store.document],
          console,
          alert: () => {},
          t: (k) => k
        },
        "autosavedetails"
      );
      return { f, entered, release };
    }

    prep.resetDraftPersistenceState();
    const cleanUrl = "https://example.test/race-clean.pdf";
    pdfs.set(cleanUrl, Buffer.from(originalBytes));
    const doc = { ...draftDocument(), objectId: "race-upload", URL: cleanUrl, CreatedBy: { objectId: "owner-1" } };
    const mem = createPersistedDocumentStore(doc);
    const input = await loadEditable(doc);
    const older = await rotate(input, 90);
    const latest = await rotate(older, 90);
    assert.equal(older.isUploadPdf, true);
    assert.equal(latest.isUploadPdf, true);
    const auto = autosave(mem, older, { pauseUpload: true });
    const pending = auto.f();
    await auto.entered;
    const state = await next(mem, latest);
    assert.equal(state.modal, true);
    assert.equal(extractPdfPageRotation(pdfs.get(mem.store.document.URL), 2), 180);
    runCustomizeMailClose(customizeMailSource());
    auto.release();
    await pending;
    const reopened = await loadEditable(mem.store.document);
    assert.equal(extractPdfPageRotation(reopened.bytes, 2), 180);
    assert.equal(extractPdfPageRotation(pdfs.get(mem.store.document.PreparedUrl), 2), 180);

    prep.resetDraftPersistenceState();
    const putDoc = { ...draftDocument(), objectId: "race-put", URL: cleanUrl, CreatedBy: { objectId: "owner-1" } };
    const putMem = createPersistedDocumentStore(putDoc);
    const putAuto = autosave(putMem, older, { pauseSave: true });
    const putPending = putAuto.f();
    await putAuto.entered;
    const afterPutNext = next(putMem, latest);
    putAuto.release();
    const putState = await afterPutNext;
    await putPending;
    assert.equal(putState.modal, true);
    assert.equal(extractPdfPageRotation((await loadEditable(putMem.store.document)).bytes, 2), 180);

    prep.resetDraftPersistenceState();
    const failDoc = { ...draftDocument(), objectId: "race-fail", URL: cleanUrl, CreatedBy: { objectId: "owner-1" } };
    const failMem = createPersistedDocumentStore(failDoc);
    const failed = await next(failMem, latest, { failPut: true });
    assert.equal(failed.modal, false);
    const recovered = await next(failMem, latest);
    assert.equal(recovered.modal, true);
    assert.equal(extractPdfPageRotation((await loadEditable(failMem.store.document)).bytes, 2), 180);

    prep.resetDraftPersistenceState();
    const otherDoc = { ...draftDocument(), objectId: "race-other", URL: cleanUrl, CreatedBy: { objectId: "owner-1" } };
    const otherMem = createPersistedDocumentStore(otherDoc);
    const otherAuto = autosave(mem, older, { pauseUpload: true });
    const otherPending = otherAuto.f();
    await otherAuto.entered;
    const otherNext = await next(otherMem, latest);
    assert.equal(otherNext.modal, true);
    otherAuto.release();
    await otherPending;
    assert.equal(extractPdfPageRotation((await loadEditable(otherMem.store.document)).bytes, 2), 180);
  });
});
