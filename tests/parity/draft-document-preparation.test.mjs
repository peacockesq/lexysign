import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyDraftFieldsToPdfDetails,
  assertActiveSession,
  bindDraftActivationReceipt,
  buildDraftSavePayload,
  buildFinalizePayload,
  editableSourceUrl,
  evaluateFinalizeGuard,
  isDraftSavePayload,
  isSameDraftActivation,
  preparedOutputUrl,
  shouldExposeSignerShareLinks
} from "../../apps/OpenSign/src/utils/draftDocumentPreparation.js";

describe("draft document preparation helper", () => {
  it("draft payload writes PreparedUrl and omits URL, dispatch, and billing fields", () => {
    const payload = buildDraftSavePayload({
      name: "Deed",
      placeholders: [{ Id: "ph" }],
      signers: [{ objectId: "c1" }],
      signatureType: ["draw"],
      preparedUrl: "https://files.example.test/prepared.pdf"
    });
    assert.equal(payload.Name, "Deed");
    assert.equal(payload.PreparedUrl, "https://files.example.test/prepared.pdf");
    assert.equal(isDraftSavePayload(payload), true);
    assert.equal(Object.prototype.hasOwnProperty.call(payload, "URL"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(payload, "SignedUrl"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(payload, "SentToOthers"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(payload, "ExpiryDate"), false);
  });

  it("finalize payload writes SignedUrl, SentToOthers, and signing expiry once", () => {
    const now = new Date("2026-09-15T12:00:00.000Z");
    const payload = buildFinalizePayload({
      signedUrl: "https://files.example.test/prepared.pdf",
      timeToCompleteDays: 10,
      now
    });
    assert.equal(payload.SignedUrl, "https://files.example.test/prepared.pdf");
    assert.equal(payload.SentToOthers, true);
    assert.equal(payload.ExpiryDate.__type, "Date");
    assert.equal(payload.ExpiryDate.iso.toISOString(), "2026-09-25T12:00:00.000Z");
    assert.equal(Object.prototype.hasOwnProperty.call(payload, "URL"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(payload, "PreparedUrl"), false);
  });

  it("guard allows drafts and fail-closes terminal or already-dispatched records", () => {
    const draft = evaluateFinalizeGuard({
      URL: "https://files.example.test/original.pdf",
      PreparedUrl: "https://files.example.test/prepared.pdf",
      SignedUrl: undefined,
      IsCompleted: false,
      IsDeclined: false
    });
    assert.equal(draft.ok, true);
    assert.equal(draft.signedUrl, "https://files.example.test/prepared.pdf");
    assert.equal(evaluateFinalizeGuard({ SignedUrl: "https://files.example.test/doc.pdf" }).code, "already-dispatched");
    assert.equal(
      evaluateFinalizeGuard({
        URL: "https://files.example.test/original.pdf",
        SignedUrl: "https://files.example.test/doc.pdf"
      }).ok,
      false
    );
    assert.equal(evaluateFinalizeGuard({ URL: "https://x", IsCompleted: true }).code, "completed");
    assert.equal(evaluateFinalizeGuard({ URL: "https://x", IsDeclined: true }).code, "declined");
    assert.equal(evaluateFinalizeGuard({}).code, "missing-url");
    assert.equal(evaluateFinalizeGuard(null).code, "missing");
  });

  it("same-draft receipt lets this tab continue after activation; historical SignedUrl does not", () => {
    const persisted = {
      objectId: "doc1",
      URL: "https://files.example.test/original.pdf",
      PreparedUrl: "https://files.example.test/prepared.pdf",
      SignedUrl: "https://files.example.test/prepared.pdf"
    };
    const receipt = bindDraftActivationReceipt({
      documentId: "doc1",
      signedUrl: "https://files.example.test/prepared.pdf"
    });
    const sameDraft = evaluateFinalizeGuard(persisted, receipt);
    assert.equal(sameDraft.ok, true);
    assert.equal(sameDraft.alreadyActivated, true);
    assert.equal(sameDraft.signedUrl, persisted.SignedUrl);
    assert.equal(isSameDraftActivation(persisted, receipt), true);
    assert.equal(evaluateFinalizeGuard(persisted, null).code, "already-dispatched");
    assert.equal(
      evaluateFinalizeGuard(persisted, bindDraftActivationReceipt({
        documentId: "other",
        signedUrl: persisted.SignedUrl
      })).code,
      "already-dispatched"
    );
    assert.equal(
      evaluateFinalizeGuard(persisted, bindDraftActivationReceipt({
        documentId: "doc1",
        signedUrl: "https://files.example.test/other.pdf"
      })).code,
      "already-dispatched"
    );
    assert.equal(
      evaluateFinalizeGuard({ ...persisted, IsCompleted: true }, receipt).code,
      "completed"
    );
    assert.equal(
      evaluateFinalizeGuard({ ...persisted, IsDeclined: true }, receipt).code,
      "declined"
    );
  });

  it("editable source stays URL; prepared output prefers PreparedUrl without rewriting historical URL", () => {
    const draft = {
      URL: "https://files.example.test/original.pdf",
      PreparedUrl: "https://files.example.test/prepared.pdf"
    };
    assert.equal(editableSourceUrl(draft), "https://files.example.test/original.pdf");
    assert.equal(preparedOutputUrl(draft), "https://files.example.test/prepared.pdf");
    assert.equal(editableSourceUrl({ PreparedUrl: "https://files.example.test/prepared.pdf" }), "");
    assert.equal(
      preparedOutputUrl({ URL: "https://files.example.test/legacy.pdf" }),
      "https://files.example.test/legacy.pdf"
    );
  });

  it("share links stay hidden until SignedUrl activation; historical SignedUrl is enough", () => {
    assert.equal(shouldExposeSignerShareLinks({ URL: "https://x" }), false);
    assert.equal(shouldExposeSignerShareLinks({ SignedUrl: "https://x" }), true);
    assert.equal(shouldExposeSignerShareLinks({ SignedUrl: "https://x", SentToOthers: undefined }), true);
  });

  it("in-memory pdfDetails pick up PreparedUrl after draft write and keep the clean URL", () => {
    const next = applyDraftFieldsToPdfDetails(
      [{ Name: "old", URL: "https://files.example.test/original.pdf", Placeholders: [] }],
      buildDraftSavePayload({
        name: "new-title",
        placeholders: [{ Id: "ph" }],
        signers: [],
        signatureType: [],
        preparedUrl: "https://files.example.test/prepared.pdf"
      })
    );
    assert.equal(next[0].Name, "new-title");
    assert.equal(next[0].URL, "https://files.example.test/original.pdf");
    assert.equal(next[0].PreparedUrl, "https://files.example.test/prepared.pdf");
    assert.equal(next[0].Placeholders[0].Id, "ph");
  });

  it("session guard fails closed without tenant or token", () => {
    assert.throws(() => assertActiveSession({}), /invalid session token/);
    assert.throws(() => assertActiveSession({ tenantId: "t" }), /invalid session token/);
    assert.doesNotThrow(() => assertActiveSession({ tenantId: "t", sessionToken: "s" }));
  });
});
