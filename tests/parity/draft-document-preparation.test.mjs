import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyDraftFieldsToPdfDetails,
  assertActiveSession,
  buildDraftSavePayload,
  buildFinalizePayload,
  evaluateFinalizeGuard,
  isDraftSavePayload,
  shouldExposeSignerShareLinks
} from "../../apps/OpenSign/src/utils/draftDocumentPreparation.js";

describe("draft document preparation helper", () => {
  it("draft payload omits dispatch and billing fields", () => {
    const payload = buildDraftSavePayload({
      name: "Deed",
      placeholders: [{ Id: "ph" }],
      signers: [{ objectId: "c1" }],
      signatureType: ["draw"],
      url: "https://files.example.test/prepared.pdf"
    });
    assert.equal(payload.Name, "Deed");
    assert.equal(payload.URL, "https://files.example.test/prepared.pdf");
    assert.equal(isDraftSavePayload(payload), true);
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
  });

  it("guard allows drafts and fail-closes terminal or already-dispatched records", () => {
    const draft = evaluateFinalizeGuard({
      URL: "https://files.example.test/prepared.pdf",
      SignedUrl: undefined,
      IsCompleted: false,
      IsDeclined: false
    });
    assert.equal(draft.ok, true);
    assert.equal(draft.signedUrl, "https://files.example.test/prepared.pdf");
    assert.equal(evaluateFinalizeGuard({ SignedUrl: "https://files.example.test/doc.pdf" }).code, "already-dispatched");
    assert.equal(
      evaluateFinalizeGuard({
        URL: "https://files.example.test/prepared.pdf",
        SignedUrl: "https://files.example.test/doc.pdf"
      }).ok,
      false
    );
    assert.equal(evaluateFinalizeGuard({ URL: "https://x", IsCompleted: true }).code, "completed");
    assert.equal(evaluateFinalizeGuard({ URL: "https://x", IsDeclined: true }).code, "declined");
    assert.equal(evaluateFinalizeGuard({}).code, "missing-url");
    assert.equal(evaluateFinalizeGuard(null).code, "missing");
  });

  it("share links stay hidden until SignedUrl activation; historical SignedUrl is enough", () => {
    assert.equal(shouldExposeSignerShareLinks({ URL: "https://x" }), false);
    assert.equal(shouldExposeSignerShareLinks({ SignedUrl: "https://x" }), true);
    assert.equal(shouldExposeSignerShareLinks({ SignedUrl: "https://x", SentToOthers: undefined }), true);
  });

  it("in-memory pdfDetails pick up the prepared URL after draft write", () => {
    const next = applyDraftFieldsToPdfDetails(
      [{ Name: "old", URL: "https://files.example.test/original.pdf", Placeholders: [] }],
      buildDraftSavePayload({
        name: "new-title",
        placeholders: [{ Id: "ph" }],
        signers: [],
        signatureType: [],
        url: "https://files.example.test/prepared.pdf"
      })
    );
    assert.equal(next[0].Name, "new-title");
    assert.equal(next[0].URL, "https://files.example.test/prepared.pdf");
    assert.equal(next[0].Placeholders[0].Id, "ph");
  });

  it("session guard fails closed without tenant or token", () => {
    assert.throws(() => assertActiveSession({}), /invalid session token/);
    assert.throws(() => assertActiveSession({ tenantId: "t" }), /invalid session token/);
    assert.doesNotThrow(() => assertActiveSession({ tenantId: "t", sessionToken: "s" }));
  });
});
