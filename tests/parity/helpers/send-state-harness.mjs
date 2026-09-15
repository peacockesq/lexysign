import { readRepoFile, loadSourceModule } from "./load-source-module.mjs";
import { sliceBetween, runSourceBlock } from "./extract-source.mjs";
import { createMemoryStorage } from "./dom-stubs.mjs";
import { createParseStub } from "./parse-stub.mjs";
import { openSignSrc, serverSrc } from "./paths.mjs";

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

export function runSaveDocumentDetails(placeholderSrc, { pdfUrl, documentId, pdfDetails, signersdata }) {
  const block = sliceBetween(
    placeholderSrc,
    "const saveDocumentDetails = utils.withSessionValidation(async () => {",
    "\n  const copytoclipboard"
  );
  const puts = [];
  const state = {
    isMailModal: false,
    isSend: false,
    isSendAlert: {},
    isUiLoading: false,
    loading: null,
    currentId: null
  };
  const localStorage = createMemoryStorage();
  localStorage.setItem("baseUrl", "https://sign.lexyalgo.com/api/app/");
  localStorage.setItem("parseAppId", "opensign");
  localStorage.setItem("accesstoken", "session-token");
  const saveDocumentDetails = runSourceBlock(
    block,
    {
      utils: { withSessionValidation: (fn) => fn },
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
      setPdfDetails: () => {},
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

export function runCustomizeMailSend(customizeSrc, { mailStatus }) {
  const block = sliceBetween(
    customizeSrc,
    "const handleEmailSendToSigners = async () => {",
    "\n\n  const handleReset"
  );
  const state = { isMailModal: true, isSend: false, mailStatus: null, loader: false };
  const handleEmailSendToSigners = runSourceBlock(
    block,
    {
      setIsLoader: (v) => {
        state.loader = v;
      },
      contractDocument: async () => [{ SendinOrder: false, ExtUserPtr: { Email: "owner@example.test" }, Signers: [] }],
      props: {
        documentId: "doc1",
        setDocumentDetails: () => {},
        emailEditorType: "basic",
        customizeMail: { body: { basic: "hi" }, subject: "sign" },
        signerList: [],
        defaultMail: {},
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
      sendEmailToSigners: async () => ({ status: mailStatus }),
      isCustomize: false,
      statusMap: { success: "success", "quota-reached": "quotareached" },
      alert: () => {}
    },
    "handleEmailSendToSigners"
  );
  return { handleEmailSendToSigners, state };
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
  const { exports } = loadSourceModule(serverSrc("cloud/parsefunction/DocumentBeforesave.js"), {
    stubs: {
      "../../Utils.js": {
        MAX_DESCRIPTION_LENGTH: 500,
        MAX_NAME_LENGTH: 250,
        MAX_NOTE_LENGTH: 200
      },
      "../../utils/CountUtils.js": { setDocumentCount: () => {} },
      "../../billing/entitlements.js": {
        getTenantForExtUser: async () => ({ id: "tenant1" }),
        recordESignUsage: async () => 1
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
  return stamps;
}

export async function persistAfterSave(original, putPayload) {
  const merged = mergePersistedDocument(original, putPayload);
  const stamps = await applyDocumentBeforesaveStamps(original, merged);
  return {
    document: { ...merged, ...stamps },
    provenance: {
      originalKeys: Object.keys(original),
      putKeys: Object.keys(putPayload || {}),
      beforeSave: Object.keys(stamps)
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
    placed
  };
}

export { jsonClone };
