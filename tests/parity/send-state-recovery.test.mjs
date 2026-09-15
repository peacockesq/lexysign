import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadSourceModule, readRepoFile } from "./helpers/load-source-module.mjs";
import { sliceBetween } from "./helpers/extract-source.mjs";
import { createParseStub } from "./helpers/parse-stub.mjs";
import { openSignSrc, serverSrc } from "./helpers/paths.mjs";
import {
  draftDocument,
  isDispatchedLock,
  isLockedAgainstEdit,
  persistAfterSave,
  placeholderSource,
  runCustomizeMailClose,
  runCustomizeMailSend,
  runInterruptedSendSequence,
  runReopenLock,
  runSaveDocumentDetails
} from "./helpers/send-state-harness.mjs";

describe("sender cancel-dialog / send-state recovery", () => {
  const placeholderSrc = readRepoFile(openSignSrc("pages/PlaceHolderSign.jsx"));
  const customizeMailSrc = readRepoFile(openSignSrc("components/pdf/CustomizeMail.jsx"));

  it("static: saveDocumentDetails PUT text includes SentToOthers before mail helpers", () => {
    const saveFn = sliceBetween(
      placeholderSrc,
      "const saveDocumentDetails = utils.withSessionValidation(async () => {",
      "\n  const copytoclipboard"
    );
    assert.match(saveFn, /SentToOthers:\s*true/);
    assert.match(saveFn, /SignedUrl:\s*pdfUrl/);
    assert.equal(saveFn.includes("sendmailv3"), false);
    assert.match(saveFn, /setIsMailModal\(true\)/);
  });

  it("extracted save persists SignedUrl, SentToOthers, Placeholders, Signers and beforeSave DocSentAt", async () => {
    const observed = await runInterruptedSendSequence();
    const put = observed.put.data;
    assert.equal(put.SentToOthers, true);
    assert.equal(put.SignedUrl, "https://files.example.test/doc.pdf");
    assert.equal(put.URL, put.SignedUrl);
    assert.ok(Array.isArray(put.Placeholders));
    assert.ok(Array.isArray(put.Signers));
    assert.equal(put.Signers[0].objectId, "c1");
    assert.equal(observed.mailModalAfterSave, true);
    const persisted = observed.persisted.document;
    assert.equal(persisted.SentToOthers, true);
    assert.equal(persisted.Name, "synthetic");
    assert.ok(persisted.DocSentAt);
    assert.ok(observed.persisted.provenance.putKeys.includes("SentToOthers"));
    assert.ok(observed.persisted.provenance.beforeSave.includes("DocSentAt"));
  });

  it("extracted CustomizeMail close navigates away without sending mail", () => {
    const close = runCustomizeMailClose(customizeMailSrc);
    assert.equal(close.state.isMailModal, false);
    assert.equal(close.nav[0], "/report/1MwEuxLEkF");
  });

  it("stopped-before-modal: PUT is already persisted before Send is pressed", async () => {
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
    assert.equal(persisted.document.SentToOthers, true);
    assert.ok(isLockedAgainstEdit(placed), "current Next already persists dispatch flags before the mail modal");
  });

  it("send failure does not roll back PUT; persisted sent flags still forbid editing", async () => {
    const original = draftDocument();
    const save = runSaveDocumentDetails(placeholderSrc, {
      pdfUrl: "https://files.example.test/doc.pdf",
      documentId: original.objectId,
      pdfDetails: [original],
      signersdata: [{ Email: "alpha@example.test", objectId: "c1", Role: "signer" }]
    });
    await save.saveDocumentDetails();
    const send = runCustomizeMailSend(customizeMailSrc, { mailStatus: "error" });
    await send.handleEmailSendToSigners();
    assert.equal(send.state.mailStatus, "failed");
    const persisted = await persistAfterSave(original, save.puts[0].data);
    const placed = runReopenLock(placeholderSrc, [persisted.document], "2026-09-15T12:00:00.000Z");
    assert.equal(isLockedAgainstEdit(placed), true, "already-sent Parse state must not become editable after mail failure");
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

  it("RED: extracted close-without-send then reopen must not lock the sender out of first invitation", async () => {
    const observed = await runInterruptedSendSequence();
    assert.equal(observed.persisted.document.SentToOthers, true);
    assert.equal(
      isDispatchedLock(observed.placed),
      false,
      "PlaceHolderSign reopen treats persisted SignedUrl+SentToOthers as dispatched before sendmailv3"
    );
  });
});
