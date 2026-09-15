// Draft preparation is not invitation dispatch.
// Next/autosave persist geometry, title, signers, and (when preparing) PreparedUrl.
// URL remains the clean editable source PDF. PreparedUrl is the prefill-embedded
// output used only at activation. SignedUrl / SentToOthers / ExpiryDate are
// written once on explicit Send, Share, or owner-first self-sign.
//
// Same-page-session activation receipt:
//   After this tab successfully writes SignedUrl, bindDraftActivationReceipt
//   records {documentId, signedUrl}. A later Send/Share/self-sign in THIS tab
//   with that matching receipt skips a second activation PUT so Share-then-Send
//   and failed-before-mail retry can proceed. Receipt is in-memory only.
//
// What is idempotent here:
//   - First explicit Send/Share/self-sign in a tab activates once (one SignedUrl PUT).
//   - Repeat activation in that same tab with a matching receipt does not PUT again.
//   - Repeat Send click while in-flight is suppressed by CustomizeMail.sendingRef.
//   - Next/close remain a draft (no SignedUrl, no billing).
//
// What is not idempotent / not claimed:
//   - Concurrent tabs that both read a draft before either writes can both PUT.
//   - Reload or another tab has no receipt: persisted SignedUrl is already-dispatched.
//   - No outbox, no per-recipient delivery key, not exactly-once mail.
//   - Historical/unknown terminal documents without this tab's receipt stay rejected.

export function assertActiveSession({ tenantId, sessionToken } = {}) {
  if (!tenantId || !sessionToken) {
    const err = new Error("invalid session token");
    err.name = "FinalizeInvitationError";
    err.code = "invalid-session";
    throw err;
  }
}

export function editableSourceUrl(doc) {
  return doc?.URL || "";
}

export function preparedOutputUrl(doc) {
  return doc?.PreparedUrl || doc?.URL || "";
}

export function bindDraftActivationReceipt({ documentId, signedUrl } = {}) {
  if (!documentId || !signedUrl) return null;
  return Object.freeze({
    documentId: String(documentId),
    signedUrl: String(signedUrl)
  });
}

export function isSameDraftActivation(persisted, receipt) {
  if (!receipt || !persisted) return false;
  const persistedId = persisted.objectId || persisted.id;
  if (!persistedId || !receipt.documentId || !receipt.signedUrl) return false;
  if (String(persistedId) !== String(receipt.documentId)) return false;
  if (!persisted.SignedUrl) return false;
  return String(persisted.SignedUrl) === String(receipt.signedUrl);
}

export function buildDraftSavePayload({
  name,
  placeholders,
  signers,
  signatureType,
  preparedUrl
}) {
  const payload = {
    Name: name,
    Placeholders: placeholders,
    Signers: signers,
    SignatureType: signatureType
  };
  if (preparedUrl) {
    payload.PreparedUrl = preparedUrl;
  }
  return payload;
}

export function isDraftSavePayload(payload) {
  if (!payload || typeof payload !== "object") return false;
  return (
    !Object.prototype.hasOwnProperty.call(payload, "SignedUrl") &&
    !Object.prototype.hasOwnProperty.call(payload, "SentToOthers") &&
    !Object.prototype.hasOwnProperty.call(payload, "ExpiryDate") &&
    !Object.prototype.hasOwnProperty.call(payload, "DocSentAt") &&
    !Object.prototype.hasOwnProperty.call(payload, "URL")
  );
}

export function buildFinalizePayload({
  signedUrl,
  timeToCompleteDays = 15,
  now = new Date()
}) {
  const expiry = new Date(now.getTime());
  expiry.setDate(expiry.getDate() + (Number(timeToCompleteDays) || 15));
  return {
    SignedUrl: signedUrl,
    SentToOthers: true,
    ExpiryDate: { iso: expiry, __type: "Date" }
  };
}

export function evaluateFinalizeGuard(persisted, receipt) {
  if (!persisted) {
    return {
      ok: false,
      code: "missing",
      message: "Document could not be loaded for invitation send."
    };
  }
  if (persisted.IsCompleted) {
    return {
      ok: false,
      code: "completed",
      message: "Completed documents cannot be sent again."
    };
  }
  if (persisted.IsDeclined) {
    return {
      ok: false,
      code: "declined",
      message: "Declined documents cannot be sent again."
    };
  }
  // Historical records may omit SentToOthers. SignedUrl alone is dispatch
  // unless this same tab just activated this same draft (receipt match).
  if (persisted.SignedUrl) {
    if (isSameDraftActivation(persisted, receipt)) {
      return {
        ok: true,
        alreadyActivated: true,
        signedUrl: persisted.SignedUrl
      };
    }
    return {
      ok: false,
      code: "already-dispatched",
      message: "This document was already sent and cannot be finalized again."
    };
  }
  const signedUrl = preparedOutputUrl(persisted);
  if (!signedUrl) {
    return {
      ok: false,
      code: "missing-url",
      message: "Prepared document file is missing. Save the draft and try again."
    };
  }
  return { ok: true, signedUrl };
}

export function applyDraftFieldsToPdfDetails(pdfDetails, draftPayload) {
  if (!Array.isArray(pdfDetails) || !pdfDetails[0]) {
    return pdfDetails;
  }
  const next = [...pdfDetails];
  next[0] = {
    ...next[0],
    Name: draftPayload.Name ?? next[0].Name,
    Placeholders: draftPayload.Placeholders ?? next[0].Placeholders,
    SignatureType: draftPayload.SignatureType ?? next[0].SignatureType
  };
  if (Object.prototype.hasOwnProperty.call(draftPayload, "PreparedUrl")) {
    next[0].PreparedUrl = draftPayload.PreparedUrl;
  }
  return next;
}

export function shouldExposeSignerShareLinks(doc) {
  return Boolean(doc?.SignedUrl);
}
