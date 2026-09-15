import { readRepoFile } from "./load-source-module.mjs";
import { sliceBetween, runSourceBlock } from "./extract-source.mjs";
import { createMemoryStorage } from "./dom-stubs.mjs";
import { openSignSrc } from "./paths.mjs";

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

export async function runInterruptedSendSequence({ placeholderSrc, customizeSrc } = {}) {
  const placeholder = placeholderSource(placeholderSrc);
  const customize = customizeMailSource(customizeSrc);
  const pdfUrl = "https://files.example.test/doc.pdf";
  const documentId = "doc1";
  const pdfDetails = [
    {
      Name: "synthetic",
      SendinOrder: false,
      TimeToCompleteDays: 15,
      SignatureType: [],
      Placeholders: [],
      ExtUserPtr: { UserId: { objectId: "owner-1" } }
    }
  ];
  const signersdata = [{ Email: "alpha@example.test", objectId: "c1", Role: "signer" }];
  const save = runSaveDocumentDetails(placeholder, {
    pdfUrl,
    documentId,
    pdfDetails,
    signersdata
  });
  await save.saveDocumentDetails();
  const close = runCustomizeMailClose(customize);
  const reopenDoc = [
    {
      SignedUrl: save.puts[0]?.data?.SignedUrl,
      IsCompleted: false,
      IsDeclined: false,
      ExpiryDate: { iso: "2026-10-01T00:00:00.000Z" }
    }
  ];
  const placed = runReopenLock(placeholder, reopenDoc, "2026-09-15T12:00:00.000Z");
  return {
    put: save.puts[0],
    mailModalAfterSave: save.state.isMailModal,
    close,
    placed
  };
}

export function isDispatchedLock(placed) {
  const lock = placed[0];
  return Boolean(lock?.status && lock?.message === "document-signed-alert-8");
}
