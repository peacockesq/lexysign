// Draft preparation is not invitation dispatch.
// Next/autosave persist geometry and the prepared file URL only.
// SignedUrl / SentToOthers / ExpiryDate are written once on explicit Send,
// Share, or owner-first self-sign activation.

export function assertActiveSession({ tenantId, sessionToken } = {}) {
  if (!tenantId || !sessionToken) {
    const err = new Error("invalid session token");
    err.name = "FinalizeInvitationError";
    err.code = "invalid-session";
    throw err;
  }
}

export function buildDraftSavePayload({
  name,
  placeholders,
  signers,
  signatureType,
  url
}) {
  return {
    Name: name,
    Placeholders: placeholders,
    URL: url,
    Signers: signers,
    SignatureType: signatureType
  };
}

export function isDraftSavePayload(payload) {
  if (!payload || typeof payload !== "object") return false;
  return (
    !Object.prototype.hasOwnProperty.call(payload, "SignedUrl") &&
    !Object.prototype.hasOwnProperty.call(payload, "SentToOthers") &&
    !Object.prototype.hasOwnProperty.call(payload, "ExpiryDate") &&
    !Object.prototype.hasOwnProperty.call(payload, "DocSentAt")
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

export function evaluateFinalizeGuard(persisted) {
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
  // Historical records may omit SentToOthers. SignedUrl alone is dispatch.
  if (persisted.SignedUrl) {
    return {
      ok: false,
      code: "already-dispatched",
      message: "This document was already sent and cannot be finalized again."
    };
  }
  if (!persisted.URL) {
    return {
      ok: false,
      code: "missing-url",
      message: "Prepared document file is missing. Save the draft and try again."
    };
  }
  return { ok: true, signedUrl: persisted.URL };
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
    URL: draftPayload.URL ?? next[0].URL,
    SignatureType: draftPayload.SignatureType ?? next[0].SignatureType
  };
  return next;
}

export function shouldExposeSignerShareLinks(doc) {
  return Boolean(doc?.SignedUrl);
}
