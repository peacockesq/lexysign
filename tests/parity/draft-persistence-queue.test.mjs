import assert from "node:assert/strict";
import { describe, it, before, beforeEach } from "node:test";
import { loadSourceModule } from "./helpers/load-source-module.mjs";
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

describe("actual draft queue: source identity vs UI lifecycle", { timeout: 30000, concurrency: false }, () => {
  const { pdfLib, fontkit } = requirePdfDeps();
  const font = loadTestFontBytes();
  const utils = loadSourceModule(
    openSignSrc("constant/Utils.js"),
    {
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
    }
  ).exports;
  const src = placeholderSource();
  const embed = sliceBetween(src, "const embedPrefilllWidgets = async () => {", "\n  const handleSaveDoc");
  const save = sliceBetween(
    src,
    "const saveDocumentDetails = utils.withSessionValidation(async () => {",
    "\n  const finalizeInvitation"
  );
  const autoSrc = sliceBetween(src, "const autosavedetails = async () => {", "\n  // Next persists");
  const loadSrc = sliceBetween(
    src,
    "const url = editableSourceUrl(documentData[0]);",
    "\n      setOwner("
  );
  const widgets = [
    {
      Id: "ph-alpha",
      Role: "signer",
      signerObjId: "c1",
      placeHolder: [{ pageNumber: 1, pos: [{ key: "sig", type: "signature" }] }]
    }
  ];
  const storage = {
    getItem: (k) =>
      ({
        baseUrl: "https://example.test/",
        TenantId: "fictional-tenant",
        accesstoken: "fictional-session",
        parseAppId: "fixture"
      })[k]
  };
  const blobs = new Map();
  let serial = 0;
  let original;
  let old;
  let latest;

  beforeEach(() => {
    prep.resetDraftPersistenceState();
  });

  async function rotate(input) {
    const block = sliceBetween(
      src,
      "const handleRotationFun = async (rotateDegree) => {",
      "\n  const handleRemovePlaceholder"
    );
    const next = { ...input };
    await runSourceBlock(
      block,
      {
        handleRotateWarning: () => false,
        signerPos: widgets,
        pageNumber: 2,
        setShowRotateAlert: () => {},
        setIsUploadPdf: (v) => {
          next.dirty = v;
        },
        rotatePdfPage: utils.rotatePdfPage,
        pdfArrayBuffer: input.bytes,
        setPdfArrayBuffer: (v) => {
          next.bytes = v;
        },
        setPdfBase64Url: (v) => {
          next.base64 = v;
        }
      },
      "handleRotationFun"
    )(90);
    return next;
  }

  before(async () => {
    const d = await pdfLib.PDFDocument.create();
    d.addPage([612, 792]).drawText("FICTIONAL QUEUE PAGE 1");
    d.addPage([612, 792]).drawText("FICTIONAL QUEUE PAGE 2");
    const clean = Buffer.from(await d.save());
    blobs.set("https://example.test/original.pdf", clean);
    original = { bytes: clean, base64: clean.toString("base64"), dirty: false };
    old = await rotate(original);
    latest = await rotate(old);
    assert.equal((await pdfLib.PDFDocument.load(old.bytes)).getPage(1).getRotation().angle, 90);
    assert.equal((await pdfLib.PDFDocument.load(latest.bytes)).getPage(1).getRotation().angle, 180);
  });

  function gate() {
    let release;
    let entered;
    const promise = new Promise((r) => {
      release = r;
    });
    const seen = new Promise((r) => {
      entered = r;
    });
    return { release, entered, promise, seen };
  }

  function memory(name) {
    return createPersistedDocumentStore({
      ...draftDocument(),
      objectId: `queue-${name}-${++serial}`,
      URL: "https://example.test/original.pdf",
      CreatedBy: { objectId: "owner-1" }
    });
  }

  function next(mem, input, opts = {}) {
    const state = { modal: false, alerts: [], puts: 0, loading: false, details: [] };
    const doc = structuredClone(mem.store.document);
    let uploads = 0;
    const f = runSourceBlock(
      `${embed}\n${save}`,
      {
        ...prep,
        utils: { withSessionValidation: (fn) => fn },
        signerPos: widgets,
        pdfArrayBuffer: input.bytes,
        pdfBase64Url: input.base64,
        isUploadPdf: input.dirty,
        PDFDocument: pdfLib.PDFDocument,
        embedWidgetsToDoc: utils.embedWidgetsToDoc,
        scale: 1,
        prefillImg: [],
        generatePdfName: () => `next-${++serial}`,
        convertBase64ToFile: async (name, b64) => {
          uploads++;
          if (uploads === 1 && opts.upload) {
            opts.upload.entered();
            await opts.upload.promise;
          }
          if (opts.failUpload || uploads === opts.failUploadAt) {
            throw Error("synthetic next upload rejection");
          }
          const url = `https://example.test/${name}.pdf`;
          blobs.set(url, Buffer.from(b64, "base64"));
          return url;
        },
        localStorage: storage,
        owner: {},
        SaveFileSize: () => {},
        atob,
        alert: (m) => state.alerts.push(m),
        console,
        pdfDetails: [doc],
        documentId: doc.objectId,
        docTitle: "fictional queue",
        currentId: "alpha@example.test",
        signersdata: [
          {
            objectId: "c1",
            Email: "alpha@example.test",
            Role: "signer",
            UserId: { objectId: "user-alpha" }
          }
        ],
        axios: {
          put: async (...args) => {
            state.puts++;
            if (opts.put) {
              opts.put.entered();
              await opts.put.promise;
            }
            if (opts.failPut) throw Error("synthetic next PUT rejection");
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
    return { f, state };
  }

  function auto(mem, input, opts = {}) {
    const doc = structuredClone(mem.store.document);
    const attrs = {};
    const state = { saves: 0, alerts: [] };
    const f = runSourceBlock(
      autoSrc,
      {
        ...prep,
        signersdata: doc.Signers,
        signerPos: widgets,
        signatureType: [],
        isUploadPdf: input.dirty,
        pdfBase64Url: input.base64,
        generatePdfName: () => `auto-${++serial}`,
        convertBase64ToFile: async (name, b64) => {
          if (opts.upload) {
            opts.upload.entered();
            await opts.upload.promise;
          }
          if (opts.failUpload) throw Error("synthetic auto upload rejection");
          const url = `https://example.test/${name}.pdf`;
          blobs.set(url, Buffer.from(b64, "base64"));
          return url;
        },
        Parse: {
          Object: class {
            set(k, v) {
              attrs[k] = v;
            }
            async save() {
              state.saves++;
              if (opts.put) {
                opts.put.entered();
                await opts.put.promise;
              }
              if (opts.failPut) throw Error("synthetic auto save rejection");
              assert.equal(this.id, doc.objectId);
              Object.assign(mem.store.document, attrs);
              return { id: doc.objectId };
            }
          }
        },
        documentId: doc.objectId,
        pdfDetails: [doc],
        console,
        alert: (m) => state.alerts.push(m),
        t: (k) => k
      },
      "autosavedetails"
    );
    return { f, state };
  }

  function debounce(mem, input, fn) {
    let cleanup;
    let pending;
    const block = sliceBetween(
      src,
      "useEffect(() => {\n    const timer = setTimeout",
      "\n  // `autosavedetails`"
    );
    runSourceBlock(
      block,
      {
        useEffect: (f) => {
          cleanup = f();
        },
        setTimeout,
        clearTimeout,
        pdfDetails: [mem.store.document],
        user: { objectId: "owner-1" },
        autosavedetails: () => {
          pending = fn();
        },
        signerPos: widgets,
        signersdata: [],
        signatureType: [],
        pdfBase64Url: input.base64
      },
      "undefined"
    );
    return { cleanup, pending: () => pending };
  }

  async function rotation(mem) {
    let bytes;
    await runSourceBlock(
      `const reopen = async()=>{${loadSrc}\n};`,
      {
        ...prep,
        documentData: [mem.store.document],
        convertPdfArrayBuffer: async (url) => Uint8Array.from(blobs.get(url)),
        getBase64FromUrl: async (url) => blobs.get(url).toString("base64"),
        setPdfArrayBuffer: (v) => {
          bytes = v;
        },
        setPdfBase64Url: () => {},
        setHandleError: () => {
          throw Error("load failure");
        },
        t: (k) => k
      },
      "reopen"
    )();
    assert.equal(extractPdfText(bytes).includes("FICTIONAL QUEUE PAGE"), true);
    return {
      angle: (await pdfLib.PDFDocument.load(bytes)).getPage(1).getRotation().angle,
      poppler: extractPdfPageRotation(bytes, 2)
    };
  }

  async function recovery(mem) {
    const n = next(mem, latest);
    await n.f();
    assert.equal(n.state.modal, true);
    const rot = await rotation(mem);
    assert.equal(rot.angle, 180);
    return true;
  }

  it("real 2000ms autosave of latest 180 survives Next clean-upload rejection", async () => {
    const m = memory("clean-upload");
    const g = gate();
    const a = auto(m, latest, { upload: g });
    const timer = debounce(m, latest, a.f);
    await g.seen;
    const n = next(m, latest, { failUpload: true });
    await n.f();
    timer.cleanup();
    runCustomizeMailClose(customizeMailSource());
    g.release();
    await timer.pending();
    const rot = await rotation(m);
    assert.equal(n.state.modal, false);
    assert.equal(a.state.saves, 1);
    assert.equal(rot.angle, 180);
    assert.equal(rot.poppler, 180);
    assert.equal(await recovery(m), true);
  });

  it("real 2000ms autosave of latest 180 survives Next prepared-upload rejection", async () => {
    const m = memory("prepared-upload");
    const g = gate();
    const a = auto(m, latest, { upload: g });
    const timer = debounce(m, latest, a.f);
    await g.seen;
    const n = next(m, latest, { failUploadAt: 2 });
    await n.f();
    timer.cleanup();
    runCustomizeMailClose(customizeMailSource());
    g.release();
    await timer.pending();
    const rot = await rotation(m);
    assert.equal(n.state.modal, false);
    assert.equal(a.state.saves, 1);
    assert.equal(rot.angle, 180);
  });

  it("real 2000ms autosave of latest 180 survives Next PUT rejection", async () => {
    const m = memory("put-reject");
    const g = gate();
    const a = auto(m, latest, { upload: g });
    const timer = debounce(m, latest, a.f);
    await g.seen;
    const n = next(m, latest, { failPut: true });
    await n.f();
    timer.cleanup();
    runCustomizeMailClose(customizeMailSource());
    g.release();
    await timer.pending();
    const rot = await rotation(m);
    assert.equal(n.state.modal, false);
    assert.equal(a.state.saves, 1);
    assert.equal(rot.angle, 180);
  });

  it("two same-snapshot autosaves keep the earlier save when the later upload fails", async () => {
    const m = memory("two-auto");
    const g = gate();
    const a = auto(m, latest, { upload: g });
    const pending = a.f();
    await g.seen;
    const b = auto(m, latest, { failUpload: true });
    await assert.rejects(b.f());
    g.release();
    await pending;
    const rot = await rotation(m);
    assert.equal(a.state.saves, 1);
    assert.equal(rot.angle, 180);
    assert.equal(await recovery(m), true);
  });

  it("older different snapshot vs failed Next is not claimed as current 180", async () => {
    const m = memory("diff-snap");
    const g = gate();
    const a = auto(m, old, { upload: g });
    const pending = a.f();
    await g.seen;
    const n = next(m, latest, { failUpload: true });
    await n.f();
    g.release();
    await pending;
    assert.equal(n.state.modal, false);
    assert.equal(a.state.saves, 0);
    const rot = await rotation(m);
    assert.notEqual(rot.angle, 180);
    assert.equal(await recovery(m), true);
  });

  it("old 90 autosave cannot overwrite a successful 180 Next", async () => {
    const m = memory("stale-auto");
    const g = gate();
    const a = auto(m, old, { upload: g });
    const timer = debounce(m, old, a.f);
    await g.seen;
    timer.cleanup();
    const n = next(m, latest);
    await n.f();
    runCustomizeMailClose(customizeMailSource());
    g.release();
    await timer.pending();
    assert.equal(n.state.modal, true);
    assert.equal(a.state.saves, 0);
    const rot = await rotation(m);
    assert.equal(rot.angle, 180);
  });

  it("obsolete Next already inside PUT does not open a stale modal when a newer Next is pending", async () => {
    const m = memory("nextput");
    const g = gate();
    const g2 = gate();
    const a = next(m, old, { put: g });
    const p = a.f();
    await g.seen;
    const b = next(m, latest, { upload: g2 });
    const q = b.f();
    await g2.seen;
    g.release();
    await p;
    assert.equal(a.state.modal, false);
    assert.equal(a.state.loading, true);
    g2.release();
    await q;
    assert.equal(b.state.modal, true);
    const rot = await rotation(m);
    assert.equal(rot.angle, 180);
  });

  it("obsolete Next PUT cannot open a success modal after a newer Next upload fails", async () => {
    const m = memory("nextputfail");
    const g = gate();
    const a = next(m, old, { put: g });
    const p = a.f();
    await g.seen;
    const b = next(m, latest, { failUpload: true });
    await b.f();
    g.release();
    await p;
    assert.equal(a.state.modal, false);
    assert.equal(b.state.modal, false);
    const rot = await rotation(m);
    assert.notEqual(rot.angle, 180);
    assert.equal(await recovery(m), true);
  });

  it("queued same-source autosave waits for in-flight Next PUT then both settle", async () => {
    const m = memory("auto-during-next-put");
    const g = gate();
    const n = next(m, latest, { put: g });
    const p = n.f();
    await g.seen;
    const a = auto(m, latest);
    const ap = a.f();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(a.state.saves, 0);
    g.release();
    await Promise.all([p, ap]);
    assert.equal(n.state.modal, true);
    const rot = await rotation(m);
    assert.equal(rot.angle, 180);
  });

  it("document ids keep independent queues", async () => {
    const m = memory("docA");
    const other = memory("docB");
    const g = gate();
    const a = auto(m, old, { put: g });
    const p = a.f();
    await g.seen;
    const n = next(other, latest);
    await n.f();
    g.release();
    await p;
    assert.equal(n.state.modal, true);
    assert.equal((await rotation(m)).angle, 90);
    assert.equal((await rotation(other)).angle, 180);
  });
});
