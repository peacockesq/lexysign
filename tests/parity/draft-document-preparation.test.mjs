import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyDraftFieldsToPdfDetails,
  assertActiveSession,
  beginDraftPersistenceWrite,
  bindDraftActivationReceipt,
  buildDraftSavePayload,
  buildFinalizePayload,
  commitDraftPersistenceWrite,
  editableSourceUrl,
  evaluateFinalizeGuard,
  isDraftPersistenceWriteCurrent,
  isDraftSavePayload,
  isPersistedInvitationExpired,
  isSameDraftActivation,
  parsePersistedExpiryMs,
  preparedOutputUrl,
  resetDraftPersistenceState,
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

  it("draft payload may persist a changed clean URL without dispatch fields", () => {
    const payload = buildDraftSavePayload({
      name: "Deed",
      placeholders: [{ Id: "ph" }],
      signers: [{ objectId: "c1" }],
      signatureType: ["draw"],
      preparedUrl: "https://files.example.test/prepared.pdf",
      url: "https://files.example.test/clean-rotated.pdf"
    });
    assert.equal(payload.URL, "https://files.example.test/clean-rotated.pdf");
    assert.equal(payload.PreparedUrl, "https://files.example.test/prepared.pdf");
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
      SignedUrl: "https://files.example.test/prepared.pdf",
      ExpiryDate: { iso: "2099-01-01T00:00:00.000Z", __type: "Date" }
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

  it("receipt reuse enforces persisted ExpiryDate.iso and fail-closes malformed dates", () => {
    const persisted = {
      objectId: "doc1",
      URL: "https://files.example.test/original.pdf",
      PreparedUrl: "https://files.example.test/prepared.pdf",
      SignedUrl: "https://files.example.test/prepared.pdf",
      ExpiryDate: { iso: "2099-01-01T00:00:00.000Z", __type: "Date" }
    };
    const receipt = bindDraftActivationReceipt({
      documentId: "doc1",
      signedUrl: persisted.SignedUrl
    });
    assert.equal(evaluateFinalizeGuard(persisted, receipt).alreadyActivated, true);
    assert.equal(isPersistedInvitationExpired(persisted, new Date("2026-09-15T12:00:00.000Z")), false);

    const expired = {
      ...persisted,
      ExpiryDate: { iso: "2000-01-01T00:00:00.000Z", __type: "Date" }
    };
    const expiredGuard = evaluateFinalizeGuard(expired, receipt);
    assert.equal(expiredGuard.ok, false);
    assert.equal(expiredGuard.code, "expired");
    assert.equal(isPersistedInvitationExpired(expired, new Date("2026-09-15T12:00:00.000Z")), true);

    const dateObjectExpiry = {
      ...persisted,
      ExpiryDate: { iso: new Date("2000-01-01T00:00:00.000Z"), __type: "Date" }
    };
    assert.equal(evaluateFinalizeGuard(dateObjectExpiry, receipt).code, "expired");

    const now = new Date("2026-09-15T12:00:00.000Z");
    const equalExpiry = {
      ...persisted,
      ExpiryDate: { iso: "2026-09-15T12:00:00.000Z", __type: "Date" }
    };
    assert.equal(isPersistedInvitationExpired(equalExpiry, now), false);

    for (const bad of [
      { ...persisted, ExpiryDate: { iso: "not-a-date", __type: "Date" } },
      { ...persisted, ExpiryDate: { iso: "", __type: "Date" } },
      { ...persisted, ExpiryDate: { __type: "Date" } },
      { ...persisted, ExpiryDate: null },
      { ...persisted, ExpiryDate: undefined }
    ]) {
      assert.equal(Number.isFinite(parsePersistedExpiryMs(bad)), false);
      assert.equal(evaluateFinalizeGuard(bad, receipt).ok, false);
      assert.equal(evaluateFinalizeGuard(bad, receipt).alreadyActivated, undefined);
      assert.notEqual(evaluateFinalizeGuard(bad, receipt).code, undefined);
    }

    assert.equal(
      evaluateFinalizeGuard(
        { ...expired, objectId: "other" },
        receipt
      ).code,
      "already-dispatched"
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

  it("in-memory pdfDetails pick up a changed clean URL without replacing it with PreparedUrl", () => {
    const next = applyDraftFieldsToPdfDetails(
      [{ Name: "old", URL: "https://files.example.test/original.pdf", Placeholders: [] }],
      buildDraftSavePayload({
        name: "new-title",
        placeholders: [{ Id: "ph" }],
        signers: [],
        signatureType: [],
        preparedUrl: "https://files.example.test/prepared.pdf",
        url: "https://files.example.test/clean-rotated.pdf"
      })
    );
    assert.equal(next[0].URL, "https://files.example.test/clean-rotated.pdf");
    assert.equal(next[0].PreparedUrl, "https://files.example.test/prepared.pdf");
  });

  it("session guard fails closed without tenant or token", () => {
    assert.throws(() => assertActiveSession({}), /invalid session token/);
    assert.throws(() => assertActiveSession({ tenantId: "t" }), /invalid session token/);
    assert.doesNotThrow(() => assertActiveSession({ tenantId: "t", sessionToken: "s" }));
  });

  it("strict expiry helper keeps native ISO/Date producers and fail-closes invalid shapes", () => {
    const unexpired = { ExpiryDate: { iso: "2099-01-01T00:00:00.000Z", __type: "Date" } };
    const elapsed = { ExpiryDate: { iso: "2000-01-01T00:00:00.000Z", __type: "Date" } };
    const now = new Date("2026-09-15T12:00:00.000Z");
    assert.equal(isPersistedInvitationExpired(unexpired, now), false);
    assert.equal(isPersistedInvitationExpired(elapsed, now), true);
    assert.equal(
      Number.isFinite(parsePersistedExpiryMs({ ExpiryDate: { iso: new Date("2099-01-01T00:00:00.000Z") } })),
      true
    );
    assert.equal(
      Number.isFinite(parsePersistedExpiryMs({ ExpiryDate: { iso: "2099-01-01T00:00:00Z" } })),
      true
    );
    assert.equal(
      Number.isFinite(parsePersistedExpiryMs({ ExpiryDate: { iso: "2026-09-15T12:00:00.000+00:00" } })),
      true
    );
    for (const iso of [
      4070908800000,
      ["2099-01-01T00:00:00.000Z"],
      "2099-02-30T00:00:00.000Z",
      true,
      {},
      [],
      "not-a-date",
      "   "
    ]) {
      assert.equal(Number.isFinite(parsePersistedExpiryMs({ ExpiryDate: { iso, __type: "Date" } })), false);
      assert.equal(isPersistedInvitationExpired({ ExpiryDate: { iso, __type: "Date" } }, now), true);
    }
  });

  it("same-tab draft writes serialize PUTs and never let an older autosave commit after Next", async () => {
    resetDraftPersistenceState();
    const documentId = "persist-doc-a";
    const order = [];
    let releaseAutoPut;
    const autoHeld = new Promise((resolve) => {
      releaseAutoPut = resolve;
    });
    let autoPutStarted;
    const autoEntered = new Promise((resolve) => {
      autoPutStarted = resolve;
    });
    const auto = beginDraftPersistenceWrite({ documentId, kind: "autosave" });
    const autoCommit = commitDraftPersistenceWrite(auto, async () => {
      autoPutStarted();
      await autoHeld;
      order.push("auto-put");
      return "auto";
    });
    await autoEntered;
    const next = beginDraftPersistenceWrite({ documentId, kind: "next" });
    assert.equal(isDraftPersistenceWriteCurrent(auto), false);
    assert.equal(isDraftPersistenceWriteCurrent(next), true);
    const nextCommit = commitDraftPersistenceWrite(next, async () => {
      order.push("next-put");
      return "next";
    });
    releaseAutoPut();
    const autoResult = await autoCommit;
    const nextResult = await nextCommit;
    assert.equal(autoResult.skipped, false);
    assert.equal(autoResult.value, "auto");
    assert.equal(nextResult.skipped, false);
    assert.equal(nextResult.value, "next");
    assert.deepEqual(order, ["auto-put", "next-put"]);
  });

  it("held autosave upload never writes after a newer Next, and a failed write does not deadlock retry", async () => {
    resetDraftPersistenceState();
    const documentId = "persist-doc-b";
    const auto = beginDraftPersistenceWrite({ documentId, kind: "autosave" });
    assert.equal(isDraftPersistenceWriteCurrent(auto), true);
    const next = beginDraftPersistenceWrite({ documentId, kind: "next" });
    assert.equal(isDraftPersistenceWriteCurrent(auto), false);
    const autoResult = await commitDraftPersistenceWrite(auto, async () => {
      throw new Error("stale autosave must not write");
    });
    assert.equal(autoResult.skipped, true);
    const nextResult = await commitDraftPersistenceWrite(next, async () => "next");
    assert.equal(nextResult.skipped, false);
    const failed = beginDraftPersistenceWrite({ documentId, kind: "next" });
    await assert.rejects(
      commitDraftPersistenceWrite(failed, async () => {
        throw new Error("synthetic put failure");
      }),
      /synthetic put failure/
    );
    const retry = beginDraftPersistenceWrite({ documentId, kind: "next" });
    const recovered = await commitDraftPersistenceWrite(retry, async () => "retry");
    assert.equal(recovered.skipped, false);
    assert.equal(recovered.value, "retry");
    const other = beginDraftPersistenceWrite({ documentId: "persist-doc-c", kind: "autosave" });
    assert.equal(isDraftPersistenceWriteCurrent(other), true);
    assert.equal(isDraftPersistenceWriteCurrent(retry), true);
  });
});
