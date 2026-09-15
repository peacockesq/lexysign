import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadSourceModule, readRepoFile } from "./helpers/load-source-module.mjs";
import { sliceBetween } from "./helpers/extract-source.mjs";
import { createParseStub } from "./helpers/parse-stub.mjs";
import { openSignSrc, serverSrc } from "./helpers/paths.mjs";
import {
  createPersistedDocumentStore,
  draftDocument,
  isDispatchedLock,
  isLockedAgainstEdit,
  persistAfterSave,
  placeholderSource,
  runCustomizeMailClose,
  runCustomizeMailSend,
  runFinalizeInvitation,
  runHandleActivateShareLink,
  runHandleRecipientSign,
  runInterruptedSendSequence,
  runNextCloseReopenSendSequence,
  runReopenLock,
  runSaveDocumentDetails
} from "./helpers/send-state-harness.mjs";

describe("sender cancel-dialog / send-state recovery", () => {
  const placeholderSrc = readRepoFile(openSignSrc("pages/PlaceHolderSign.jsx"));
  const customizeMailSrc = readRepoFile(openSignSrc("components/pdf/CustomizeMail.jsx"));

  it("static: Next saveDocumentDetails is draft-only; dispatch fields moved to finalizeInvitation", () => {
    // Characterization of old Next-dispatch (SentToOthers/SignedUrl in saveDocumentDetails)
    // was not required behavior. Dispatch now happens on explicit activation.
    const saveFn = sliceBetween(
      placeholderSrc,
      "const saveDocumentDetails = utils.withSessionValidation(async () => {",
      "\n  const finalizeInvitation"
    );
    assert.doesNotMatch(saveFn, /SentToOthers:\s*true/);
    assert.doesNotMatch(saveFn, /SignedUrl:\s*pdfUrl/);
    assert.match(saveFn, /buildDraftSavePayload/);
    assert.equal(saveFn.includes("sendmailv3"), false);
    assert.match(saveFn, /setIsMailModal\(true\)/);
    const finalizeFn = sliceBetween(
      placeholderSrc,
      "const finalizeInvitation = async () => {",
      "\n  const copytoclipboard"
    );
    assert.match(finalizeFn, /buildFinalizePayload/);
    assert.match(finalizeFn, /evaluateFinalizeGuard/);
    assert.match(customizeMailSrc, /props\?\.beforeSend/);
  });

  it("extracted Next save persists draft fields and URL without SignedUrl, SentToOthers, or DocSentAt", async () => {
    const observed = await runInterruptedSendSequence();
    const put = observed.put.data;
    assert.equal(Object.prototype.hasOwnProperty.call(put, "SentToOthers"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(put, "SignedUrl"), false);
    assert.equal(put.URL, "https://files.example.test/doc.pdf");
    assert.ok(Array.isArray(put.Placeholders));
    assert.ok(Array.isArray(put.Signers));
    assert.equal(put.Signers[0].objectId, "c1");
    assert.equal(observed.mailModalAfterSave, true);
    const persisted = observed.persisted.document;
    assert.notEqual(persisted.SentToOthers, true);
    assert.equal(persisted.SignedUrl, undefined);
    assert.equal(persisted.Name, "synthetic");
    assert.equal(persisted.DocSentAt, undefined);
    assert.equal(observed.persisted.provenance.putKeys.includes("SentToOthers"), false);
    assert.equal(observed.persisted.provenance.beforeSave.includes("DocSentAt"), false);
    assert.equal(observed.persisted.billing.length, 0);
    assert.equal(observed.pdfDetailsAfterSave[0].URL, put.URL);
  });

  it("extracted CustomizeMail close navigates away without sending mail", () => {
    const close = runCustomizeMailClose(customizeMailSrc);
    assert.equal(close.state.isMailModal, false);
    assert.equal(close.nav[0], "/report/1MwEuxLEkF");
  });

  it("stopped-before-Send: Next PUT is a draft and reopen is not locked", async () => {
    const original = draftDocument();
    const save = runSaveDocumentDetails(placeholderSrc, {
      pdfUrl: "https://files.example.test/doc.pdf",
      documentId: original.objectId,
      pdfDetails: [original],
      signersdata: [{ Email: "alpha@example.test", objectId: "c1", Role: "signer" }]
    });
    await save.saveDocumentDetails();
    assert.equal(save.state.isMailModal, true);
    const persisted = await persistAfterSave(original, save.puts[0].data);
    const placed = runReopenLock(placeholderSrc, [persisted.document], "2026-09-15T12:00:00.000Z");
    assert.notEqual(persisted.document.SentToOthers, true);
    assert.equal(isLockedAgainstEdit(placed), false);
  });

  it("send failure after explicit Send keeps dispatched flags and forbids editing", async () => {
    const observed = await runNextCloseReopenSendSequence({ mailStatus: "error" });
    assert.equal(observed.send.state.mailStatus, "failed");
    assert.equal(observed.send.state.mailStatus === "success", false);
    assert.equal(observed.afterSend.SentToOthers, true);
    assert.equal(observed.afterSend.SignedUrl, "https://files.example.test/doc.pdf");
    assert.equal(isLockedAgainstEdit(observed.afterSendPlaced), true);
  });

  it("true sent, completed, declined, and expired documents are not editable", () => {
    const src = placeholderSource();
    const base = {
      SignedUrl: "https://files.example.test/doc.pdf",
      SentToOthers: true,
      Placeholders: [{ Id: "ph" }],
      Signers: [{ objectId: "c1" }],
      ExpiryDate: { iso: "2026-10-01T00:00:00.000Z" }
    };
    const sent = runReopenLock(src, [{ ...base, IsCompleted: false, IsDeclined: false }], "2026-09-15T12:00:00.000Z");
    const completed = runReopenLock(src, [{ ...base, IsCompleted: true, IsDeclined: false }], "2026-09-15T12:00:00.000Z");
    const declined = runReopenLock(src, [{ ...base, IsCompleted: false, IsDeclined: true }], "2026-09-15T12:00:00.000Z");
    const expired = runReopenLock(
      src,
      [{ ...base, IsCompleted: false, IsDeclined: false, ExpiryDate: { iso: "2026-01-01T00:00:00.000Z" } }],
      "2026-09-15T12:00:00.000Z"
    );
    assert.equal(sent[0].message, "document-signed-alert-8");
    assert.equal(completed[0].message, "document-signed-alert-5");
    assert.equal(declined[0].message, "document-signed-alert-6");
    assert.equal(expired[0].message, "document-signed-alert-7");
    assert.equal(isLockedAgainstEdit(sent), true);
    assert.equal(isLockedAgainstEdit(completed), true);
    assert.equal(isLockedAgainstEdit(declined), true);
    assert.equal(isLockedAgainstEdit(expired), true);
  });

  it("historical SignedUrl without SentToOthers still locks; missing SentToOthers alone does not unlock", () => {
    const src = placeholderSource();
    const historical = runReopenLock(
      src,
      [
        {
          SignedUrl: "https://files.example.test/doc.pdf",
          Placeholders: [{ Id: "ph" }],
          Signers: [{ objectId: "c1" }],
          ExpiryDate: { iso: "2026-10-01T00:00:00.000Z" }
        }
      ],
      "2026-09-15T12:00:00.000Z"
    );
    assert.equal(isDispatchedLock(historical), true);
    assert.equal(isLockedAgainstEdit(historical), true);
  });

  it("DocumentBeforesave stamps DocSentAt when SignedUrl first appears with signers", async () => {
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
    const original = new Parse.Object("contracts_Document", {
      SignedUrl: undefined,
      ExtUserPtr: { id: "ext1" },
      Signers: [{ objectId: "a" }, { objectId: "b" }]
    });
    original.id = "doc1";
    const next = new Parse.Object("contracts_Document", {
      SignedUrl: "https://files.example.test/doc.pdf",
      ExtUserPtr: { id: "ext1" },
      Signers: [{ objectId: "a" }, { objectId: "b" }]
    });
    await exports.default({ original, object: next });
    assert.ok(next.get("DocSentAt"));
    assert.equal(typeof next.get("DocSentAt").getTime, "function");
    assert.equal(recorded[0][0], "usage");
    assert.equal(recorded[0][1], 2);
    assert.equal(recorded[1], "count");
  });

  it("close-without-send then reopen leaves a recoverable draft for first invitation", async () => {
    const observed = await runInterruptedSendSequence();
    assert.notEqual(observed.persisted.document.SentToOthers, true);
    assert.equal(observed.persisted.document.SignedUrl, undefined);
    assert.equal(
      isDispatchedLock(observed.placed),
      false,
      "draft after Next+close must remain editable for first invitation"
    );
    assert.equal(isLockedAgainstEdit(observed.placed), false);
    assert.equal(observed.persisted.document.URL, "https://files.example.test/doc.pdf");
    assert.equal(observed.persisted.document.Placeholders[0].Id, "ph-alpha");
  });

  it("Next does not charge eSign usage; close/reopen retains latest URL then explicit Send finalizes before email", async () => {
    const observed = await runNextCloseReopenSendSequence({ mailStatus: "success" });
    assert.equal(observed.afterNext.billing.length, 0);
    assert.equal(Object.prototype.hasOwnProperty.call(observed.afterNext.put.data, "SignedUrl"), false);
    assert.equal(observed.afterNext.document.URL, "https://files.example.test/doc.pdf");
    assert.equal(observed.afterNext.pdfDetails[0].URL, "https://files.example.test/doc.pdf");
    assert.equal(isLockedAgainstEdit(observed.placed), false);
    assert.equal(observed.close.state.isMailModal, false);
    assert.equal(observed.send.emailCalls.length, 1);
    assert.equal(observed.afterSend.SignedUrl, "https://files.example.test/doc.pdf");
    assert.equal(observed.afterSend.SentToOthers, true);
    assert.ok(observed.afterSend.DocSentAt);
    assert.equal(isLockedAgainstEdit(observed.afterSendPlaced), true);
    assert.equal(observed.send.state.mailStatus, "success");
  });

  it("finalize failure calls zero emails and does not show sent success", async () => {
    const send = runCustomizeMailSend(customizeMailSrc, {
      mailStatus: "success",
      beforeSend: async () => {
        throw new Error("quota or session blocked finalization");
      }
    });
    await send.handleEmailSendToSigners();
    assert.equal(send.emailCalls.length, 0);
    assert.equal(send.state.isSend, false);
    assert.equal(send.state.mailStatus, null);
    assert.equal(send.state.loader, false);
    assert.equal(send.alerts.length > 0, true);
  });

  it("repeat Send click is suppressed while the first attempt is in flight", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const send = runCustomizeMailSend(customizeMailSrc, {
      mailStatus: "success",
      contractDocument: async () => [
        {
          SignedUrl: "https://files.example.test/doc.pdf",
          SendinOrder: false,
          ExtUserPtr: { Email: "owner@example.test" },
          Signers: []
        }
      ],
      beforeSend: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 40));
        inFlight -= 1;
      }
    });
    const first = send.handleEmailSendToSigners();
    const second = send.handleEmailSendToSigners();
    await Promise.all([first, second]);
    assert.equal(maxInFlight, 1);
    assert.equal(send.emailCalls.length, 1);
    assert.equal(send.state.loader, false);
  });

  it("explicit Share activation finalizes then exposes a usable link and locks on reopen", async () => {
    const original = draftDocument();
    const memory = createPersistedDocumentStore({
      ...original,
      URL: "https://files.example.test/doc.pdf"
    });
    const finalize = runFinalizeInvitation(placeholderSrc, {
      documentId: original.objectId,
      pdfDetails: [memory.store.document],
      contractDocument: memory.contractDocument,
      axiosPut: memory.axiosPut
    });
    const share = runHandleActivateShareLink(placeholderSrc, {
      pdfDetails: [memory.store.document],
      finalizeInvitation: finalize.finalizeInvitation
    });
    await share.handleActivateShareLink({
      objectId: "c1",
      Email: "alpha@example.test"
    });
    assert.equal(memory.store.document.SentToOthers, true);
    assert.equal(memory.store.document.SignedUrl, "https://files.example.test/doc.pdf");
    assert.equal(share.copies.length, 1);
    assert.match(share.copies[0], /\/login\//);
    const placed = runReopenLock(placeholderSrc, [memory.store.document], "2026-09-15T12:00:00.000Z");
    assert.equal(isLockedAgainstEdit(placed), true);
  });

  it("owner-first self-sign finalizes before navigate and does not send mail", async () => {
    const original = {
      ...draftDocument(),
      SendinOrder: true,
      URL: "https://files.example.test/doc.pdf"
    };
    const signersdata = [
      {
        Email: "owner@example.test",
        objectId: "c1",
        Role: "signer",
        UserId: { objectId: "owner-1" }
      }
    ];
    const memory = createPersistedDocumentStore(original);
    const save = runSaveDocumentDetails(placeholderSrc, {
      pdfUrl: original.URL,
      documentId: original.objectId,
      pdfDetails: [original],
      signersdata,
      axiosPut: memory.axiosPut
    });
    await save.saveDocumentDetails();
    assert.equal(save.state.isMailModal, false);
    assert.equal(save.state.isSend, true);
    assert.equal(Object.prototype.hasOwnProperty.call(save.puts[0].data, "SignedUrl"), false);
    const finalize = runFinalizeInvitation(placeholderSrc, {
      documentId: original.objectId,
      pdfDetails: save.state.pdfDetails,
      contractDocument: memory.contractDocument,
      axiosPut: memory.axiosPut
    });
    const recipient = runHandleRecipientSign(placeholderSrc, {
      currentId: "c1",
      documentId: original.objectId,
      finalizeInvitation: finalize.finalizeInvitation
    });
    await recipient.handleRecipientSign();
    assert.equal(recipient.nav[0], "/recipientSignPdf/doc1/c1");
    assert.equal(memory.store.document.SignedUrl, original.URL);
    assert.equal(memory.store.document.SentToOthers, true);
    const placed = runReopenLock(placeholderSrc, [memory.store.document], "2026-09-15T12:00:00.000Z");
    assert.equal(isLockedAgainstEdit(placed), true);
  });

  it("stale second tab cannot re-finalize a dispatched record", async () => {
    const original = { ...draftDocument(), URL: "https://files.example.test/doc.pdf" };
    const memory = createPersistedDocumentStore(original);
    const tabA = runFinalizeInvitation(placeholderSrc, {
      documentId: original.objectId,
      pdfDetails: [original],
      contractDocument: memory.contractDocument,
      axiosPut: memory.axiosPut
    });
    await tabA.finalizeInvitation();
    const tabB = runFinalizeInvitation(placeholderSrc, {
      documentId: original.objectId,
      pdfDetails: [original],
      contractDocument: memory.contractDocument,
      axiosPut: memory.axiosPut
    });
    await assert.rejects(() => tabB.finalizeInvitation(), /already sent/);
    const signedPuts = memory.store.puts.filter((row) => row.data && row.data.SignedUrl);
    assert.equal(signedPuts.length, 1);
    const send = runCustomizeMailSend(customizeMailSrc, {
      mailStatus: "success",
      beforeSend: tabB.finalizeInvitation,
      contractDocument: memory.contractDocument
    });
    await send.handleEmailSendToSigners();
    assert.equal(send.emailCalls.length, 0);
    assert.equal(send.state.isSend, false);
  });
});
