import { readRepoFile, loadSourceModule } from "./load-source-module.mjs";
import { sliceBetween, runSourceBlock } from "./extract-source.mjs";
import { createMemoryStorage } from "./dom-stubs.mjs";
import { createParseStub } from "./parse-stub.mjs";
import { openSignSrc, serverSrc } from "./paths.mjs";
import {
  applyDraftFieldsToPdfDetails,
  assertActiveSession,
  bindDraftActivationReceipt,
  buildDraftSavePayload,
  buildFinalizePayload,
  evaluateFinalizeGuard,
  shouldExposeSignerShareLinks
} from "../../../apps/OpenSign/src/utils/draftDocumentPreparation.js";

function fixedDate(iso) {
  return class TestDate extends Date {
    constructor(...args) {
      if (args.length === 0) super(iso);
      else super(...args);
    }
  };
}

export function placeholderSource(sourceText) {
  return sourceText ?? readRepoFile(openSignSrc("pages/PlaceHolderSign.jsx"));
}

export function customizeMailSource(sourceText) {
  return sourceText ?? readRepoFile(openSignSrc("components/pdf/CustomizeMail.jsx"));
}

export function draftDocument() {
  return {
    objectId: "doc1",
    Name: "synthetic",
    URL: "https://files.example.test/original.pdf",
    SignedUrl: undefined,
    SentToOthers: false,
    SendinOrder: false,
    TimeToCompleteDays: 15,
    SignatureType: [],
    Placeholders: [
      {
        Id: "ph-alpha",
        Role: "signer",
        signerObjId: "c1",
        placeHolder: [{ pageNumber: 3, pos: [{ key: "w1", type: "signature" }] }]
      }
    ],
    Signers: [{ objectId: "c1", Email: "alpha@example.test", Role: "signer" }],
    IsCompleted: false,
    IsDeclined: false,
    ExpiryDate: { iso: "2026-10-01T00:00:00.000Z" },
    ExtUserPtr: { objectId: "ext1", UserId: { objectId: "owner-1" } }
  };
}

function createLocalStorage() {
  const localStorage = createMemoryStorage();
  localStorage.setItem("baseUrl", "https://sign.lexyalgo.com/api/app/");
  localStorage.setItem("parseAppId", "opensign");
  localStorage.setItem("accesstoken", "session-token");
  localStorage.setItem("TenantId", "tenant1");
  return localStorage;
}

export function runSaveDocumentDetails(placeholderSrc, { pdfUrl, documentId, pdfDetails, signersdata, axiosPut }) {
  const block = sliceBetween(
    placeholderSrc,
    "const saveDocumentDetails = utils.withSessionValidation(async () => {",
    "\n  const finalizeInvitation"
  );
  const puts = [];
  const state = {
    isMailModal: false,
    isSend: false,
    isSendAlert: {},
    isUiLoading: false,
    loading: null,
    currentId: null,
    pdfDetails
  };
  const localStorage = createLocalStorage();
  const saveDocumentDetails = runSourceBlock(
    block,
    {
      utils: { withSessionValidation: (fn) => fn },
      buildDraftSavePayload,
      applyDraftFieldsToPdfDetails,
      setIsUiLoading: (v) => {
        state.isUiLoading = v;
      },
      signersdata,
      pdfDetails,
      embedPrefilllWidgets: async () => pdfUrl,
      currentId: signersdata[0].Email,
      setCurrentId: (v) => {
        state.currentId = v;
      },
      docTitle: "",
      signerPos: pdfDetails[0].Placeholders,
      axios: {
        put: async (url, data) => {
          puts.push({ url, data });
          if (axiosPut) return axiosPut(url, data);
          return { data: {} };
        }
      },
      localStorage,
      documentId,
      setIsLoading: (v) => {
        state.loading = v;
      },
      setIsSendAlert: (v) => {
        state.isSendAlert = v;
      },
      setPdfDetails: (v) => {
        state.pdfDetails = v;
      },
      setIsSend: (v) => {
        state.isSend = v;
      },
      setIsCurrUser: () => {},
      setIsMailModal: (v) => {
        state.isMailModal = v;
      },
      t: (k) => k,
      alert: () => {},
      console
    },
    "saveDocumentDetails"
  );
  return { saveDocumentDetails, puts, state };
}

export function runFinalizeInvitation(placeholderSrc, { documentId, pdfDetails, contractDocument, axiosPut }) {
  const block = sliceBetween(
    placeholderSrc,
    "const finalizeInvitation = async () => {",
    "\n  const copytoclipboard"
  );
  const puts = [];
  const state = { pdfDetails };
  const localStorage = createLocalStorage();
  const draftActivationReceiptRef = { current: null };
  const finalizeInvitation = runSourceBlock(
    block,
    {
      assertActiveSession,
      evaluateFinalizeGuard,
      buildFinalizePayload,
      bindDraftActivationReceipt,
      draftActivationReceiptRef,
      contractDocument,
      documentId,
      pdfDetails,
      setPdfDetails: (v) => {
        state.pdfDetails = v;
      },
      axios: {
        put: async (url, data) => {
          puts.push({ url, data });
          if (axiosPut) return axiosPut(url, data);
          return { data: {} };
        }
      },
      localStorage,
      t: (k) => k
    },
    "finalizeInvitation"
  );
  return { finalizeInvitation, puts, state };
}

export function runCustomizeMailClose(customizeSrc) {
  const block = sliceBetween(
    customizeSrc,
    "const handleCloseSendmailModal = () => {",
    "\n\n  const handleEmailSendToSigners"
  );
  const nav = [];
  const state = { isMailModal: true };
  const handleCloseSendmailModal = runSourceBlock(
    block,
    {
      props: {
        setIsMailModal: (v) => {
          state.isMailModal = v;
        }
      },
      navigate: (path) => nav.push(path)
    },
    "handleCloseSendmailModal"
  );
  handleCloseSendmailModal();
  return { nav, state };
}

export function runCustomizeMailSend(customizeSrc, { mailStatus, beforeSend, contractDocument, sendEmailToSigners } = {}) {
  const block = sliceBetween(
    customizeSrc,
    "const handleEmailSendToSigners = async () => {",
    "\n\n  const handleReset"
  );
  const state = { isMailModal: true, isSend: false, mailStatus: null, loader: false };
  const emailCalls = [];
  const alerts = [];
  const sendingRef = { current: false };
  const handleEmailSendToSigners = runSourceBlock(
    block,
    {
      sendingRef,
      setIsLoader: (v) => {
        state.loader = v;
      },
      contractDocument:
        contractDocument ||
        (async () => [{ SendinOrder: false, ExtUserPtr: { Email: "owner@example.test" }, Signers: [] }]),
      props: {
        documentId: "doc1",
        setDocumentDetails: () => {},
        emailEditorType: "basic",
        customizeMail: { body: { basic: "hi" }, subject: "sign" },
        signerList: [],
        defaultMail: {},
        beforeSend,
        setIsMailModal: (v) => {
          state.isMailModal = v;
        },
        setIsSend: (v) => {
          state.isSend = v;
        },
        setMailStatus: (v) => {
          state.mailStatus = v;
        },
        setCurrUserId: () => {}
      },
      sendEmailToSigners:
        sendEmailToSigners ||
        (async (...args) => {
          emailCalls.push(args);
          return { status: mailStatus };
        }),
      isCustomize: false,
      statusMap: { success: "success", "quota-reached": "quotareached" },
      alert: (msg) => alerts.push(msg),
      t: (k) => k,
      console
    },
    "handleEmailSendToSigners"
  );
  return { handleEmailSendToSigners, state, emailCalls, alerts, sendingRef };
}

export function runHandleRecipientSign(placeholderSrc, { isAlreadyPlace, currentId, documentId, finalizeInvitation, navigate }) {
  const block = sliceBetween(
    placeholderSrc,
    "const handleRecipientSign = async () => {",
    "\n  const handleLinkUser"
  );
  const nav = [];
  const alerts = [];
  const handleRecipientSign = runSourceBlock(
    block,
    {
      isAlreadyPlace: isAlreadyPlace || { status: false, message: "" },
      finalizeInvitation,
      t: (k) => k,
      alert: (msg) => alerts.push(msg),
      console,
      currentId,
      documentId,
      navigate: navigate || ((path) => nav.push(path))
    },
    "handleRecipientSign"
  );
  return { handleRecipientSign, nav, alerts };
}

export function runHandleActivateShareLink(placeholderSrc, { pdfDetails, finalizeInvitation, copied }) {
  const block = sliceBetween(
    placeholderSrc,
    "const handleActivateShareLink = async (signer) => {",
    "\n  const handleShareList"
  );
  const copies = [];
  const handleActivateShareLink = runSourceBlock(
    block,
    {
      shouldExposeSignerShareLinks,
      pdfDetails,
      finalizeInvitation,
      window: { location: { origin: "https://sign.example.test" } },
      btoa,
      copytoclipboard: (text) => copies.push(text)
    },
    "handleActivateShareLink"
  );
  return { handleActivateShareLink, copies };
}

export function runReopenLock(placeholderSrc, documentData, nowIso) {
  const block = sliceBetween(
    placeholderSrc,
    "const alreadyPlaceholder = documentData[0]?.SignedUrl;",
    "\n      const userSignatureType ="
  );
  const placed = [];
  runSourceBlock(
    `const Date = DateBinding;\n${block}`,
    {
      documentData,
      DateBinding: fixedDate(nowIso),
      setIsAlreadyPlace: (v) => placed.push(v),
      t: (k) => k
    },
    "alreadyPlaceholder"
  );
  return placed;
}

export function isLockedAgainstEdit(placed) {
  return Boolean(placed[0]?.status);
}

export function isDispatchedLock(placed) {
  const lock = placed[0];
  return Boolean(lock?.status && lock?.message === "document-signed-alert-8");
}

function jsonClone(value) {
  return JSON.parse(JSON.stringify(value, (_k, v) => (v === undefined ? null : v)));
}

export function mergePersistedDocument(original, putPayload) {
  const merged = { ...original, ...putPayload };
  if (putPayload?.ExpiryDate?.iso instanceof Date) {
    merged.ExpiryDate = { iso: putPayload.ExpiryDate.iso.toISOString(), __type: "Date" };
  }
  return merged;
}

export async function applyDocumentBeforesaveStamps(original, nextAttrs) {
  const Parse = createParseStub();
  const recorded = [];
  const { exports } = loadSourceModule(serverSrc("cloud/parsefunction/DocumentBeforesave.js"), {
    stubs: {
      "../../Utils.js": {
        MAX_DESCRIPTION_LENGTH: 500,
        MAX_NAME_LENGTH: 250,
        MAX_NOTE_LENGTH: 200
      },
      "../../utils/CountUtils.js": { setDocumentCount: () => recorded.push("count") },
      "../../billing/entitlements.js": {
        getTenantForExtUser: async () => ({ id: "tenant1" }),
        recordESignUsage: async (_tenant, units) => recorded.push(["usage", units])
      }
    },
    globals: { Parse }
  });
  const originalObj = new Parse.Object("contracts_Document", {
    ...original,
    ExtUserPtr: original.ExtUserPtr?.id ? original.ExtUserPtr : { id: original.ExtUserPtr?.objectId }
  });
  const nextObj = new Parse.Object("contracts_Document", nextAttrs);
  await exports.default({ original: originalObj, object: nextObj });
  const stamps = {};
  if (nextObj.get("DocSentAt")) stamps.DocSentAt = nextObj.get("DocSentAt");
  return { stamps, recorded };
}

export async function persistAfterSave(original, putPayload) {
  const merged = mergePersistedDocument(original, putPayload);
  const { stamps, recorded } = await applyDocumentBeforesaveStamps(original, merged);
  return {
    document: { ...merged, ...stamps },
    provenance: {
      originalKeys: Object.keys(original),
      putKeys: Object.keys(putPayload || {}),
      beforeSave: Object.keys(stamps)
    },
    billing: recorded
  };
}

export function createPersistedDocumentStore(original) {
  const store = { document: { ...original }, puts: [], billing: [] };
  return {
    store,
    contractDocument: async () => [store.document],
    axiosPut: async (url, data) => {
      const persisted = await persistAfterSave(store.document, data);
      store.document = persisted.document;
      store.puts.push({ url, data });
      store.billing.push(persisted.billing);
      return { data: {} };
    }
  };
}

export async function runInterruptedSendSequence({ placeholderSrc, customizeSrc } = {}) {
  const placeholder = placeholderSource(placeholderSrc);
  const customize = customizeMailSource(customizeSrc);
  const original = draftDocument();
  const pdfUrl = "https://files.example.test/doc.pdf";
  const pdfDetails = [original];
  const signersdata = [
    { Email: "alpha@example.test", objectId: "c1", Role: "signer", UserId: { objectId: "user-alpha" } }
  ];
  const save = runSaveDocumentDetails(placeholder, {
    pdfUrl,
    documentId: original.objectId,
    pdfDetails,
    signersdata
  });
  await save.saveDocumentDetails();
  const close = runCustomizeMailClose(customize);
  const persisted = await persistAfterSave(original, save.puts[0].data);
  const placed = runReopenLock(placeholder, [persisted.document], "2026-09-15T12:00:00.000Z");
  return {
    original,
    put: save.puts[0],
    persisted,
    mailModalAfterSave: save.state.isMailModal,
    close,
    placed,
    pdfDetailsAfterSave: save.state.pdfDetails
  };
}

export async function runNextCloseReopenSendSequence({ mailStatus = "success", beforeSendImpl } = {}) {
  const placeholder = placeholderSource();
  const customize = customizeMailSource();
  const original = draftDocument();
  const pdfUrl = "https://files.example.test/doc.pdf";
  const signersdata = [
    { Email: "alpha@example.test", objectId: "c1", Role: "signer", UserId: { objectId: "user-alpha" } }
  ];
  const memory = createPersistedDocumentStore(original);
  const save = runSaveDocumentDetails(placeholder, {
    pdfUrl,
    documentId: original.objectId,
    pdfDetails: [original],
    signersdata,
    axiosPut: memory.axiosPut
  });
  await save.saveDocumentDetails();
  const afterNext = {
    document: { ...memory.store.document },
    put: save.puts[0],
    billing: memory.store.billing[0] || [],
    pdfDetails: save.state.pdfDetails
  };
  const close = runCustomizeMailClose(customize);
  const placed = runReopenLock(placeholder, [memory.store.document], "2026-09-15T12:00:00.000Z");
  const finalize = runFinalizeInvitation(placeholder, {
    documentId: original.objectId,
    pdfDetails: save.state.pdfDetails,
    contractDocument: memory.contractDocument,
    axiosPut: memory.axiosPut
  });
  const send = runCustomizeMailSend(customize, {
    mailStatus,
    beforeSend: beforeSendImpl || finalize.finalizeInvitation,
    contractDocument: memory.contractDocument
  });
  await send.handleEmailSendToSigners();
  const afterSendPlaced = runReopenLock(placeholder, [memory.store.document], "2026-09-15T12:00:00.000Z");
  return {
    original,
    afterNext,
    close,
    placed,
    send,
    finalize,
    afterSend: memory.store.document,
    afterSendPlaced,
    store: memory.store
  };
}

export { jsonClone, shouldExposeSignerShareLinks };
