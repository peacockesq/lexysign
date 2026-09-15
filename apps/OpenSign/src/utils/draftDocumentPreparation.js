// Draft preparation is not invitation dispatch.
// Next/autosave persist geometry, title, signers, and (when preparing) PreparedUrl.
// URL remains the clean editable source PDF. PreparedUrl is the prefill-embedded
// output used only at activation. When the editor PDF changed (isUploadPdf), Next
// also persists URL in the same success path so close/reopen does not depend on
// the 2s autosave timer. SignedUrl / SentToOthers / ExpiryDate are written once
// on explicit Send, Share, or owner-first self-sign.
//
// Same-page-session activation receipt:
//   After this tab successfully writes SignedUrl, bindDraftActivationReceipt
//   records {documentId, signedUrl}. A later Send/Share/self-sign in THIS tab
//   with that matching receipt skips a second activation PUT so Share-then-Send
//   and failed-before-mail retry can proceed. Receipt is in-memory only.
//   Receipt reuse still enforces persisted ExpiryDate (Parse Date { iso })
//   before alreadyActivated. Missing or unparseable iso does not authorize send.
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
//
// Same-tab draft write ordering (not a cross-tab outbox):
//   Autosave and Next share a per-documentId in-memory queue. Each write takes a
//   generation token before upload. PUT/save is serialized on that document.
//   A later Next invalidates older autosaves so a held upload cannot overwrite
//   a newer successful Next. Already-started PUTs finish, then the newer write
//   runs. Failures do not deadlock the queue. This is not cross-tab exactly-once.

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
  preparedUrl,
  url
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
  if (url) {
    payload.URL = url;
  }
  return payload;
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

// Parse Date contract used by reopen (PlaceHolderSign) and finalize:
// contracts_Document.ExpiryDate.iso. Native producers write Date objects
// (JSON → ISO-8601 Z) or ISO-8601 strings. Strict helper parse rejects
// numbers, arrays, and overflow dates such as Feb 30. This is not a proven
// native Parse-store bypass; malformed shapes were not observed from Parse.
const PARSE_ISO_DATE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;

function parseOffsetMinutes(offset) {
  if (offset === "Z") return 0;
  const match = /^([+-])(\d{2}):(\d{2})$/.exec(offset);
  if (!match) return Number.NaN;
  const sign = match[1] === "-" ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3]));
}

export function parsePersistedExpiryMs(persisted) {
  const iso = persisted?.ExpiryDate?.iso;
  if (iso == null || iso === "") return Number.NaN;
  if (iso instanceof Date) {
    const ms = iso.getTime();
    return Number.isFinite(ms) ? ms : Number.NaN;
  }
  if (typeof iso !== "string") return Number.NaN;
  const trimmed = iso.trim();
  if (!trimmed) return Number.NaN;
  const match = PARSE_ISO_DATE.exec(trimmed);
  if (!match) return Number.NaN;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const frac = match[7] ? Number(match[7].slice(1).padEnd(3, "0")) : 0;
  const offsetMin = parseOffsetMinutes(match[8]);
  if (!Number.isFinite(offsetMin)) return Number.NaN;
  const utcProbe = Date.UTC(year, month - 1, day, hour, minute, second, frac);
  const probe = new Date(utcProbe);
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() + 1 !== month ||
    probe.getUTCDate() !== day ||
    probe.getUTCHours() !== hour ||
    probe.getUTCMinutes() !== minute ||
    probe.getUTCSeconds() !== second
  ) {
    return Number.NaN;
  }
  return utcProbe - offsetMin * 60 * 1000;
}

export function isPersistedInvitationExpired(persisted, now = new Date()) {
  const expiryMs = parsePersistedExpiryMs(persisted);
  if (!Number.isFinite(expiryMs)) return true;
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (!Number.isFinite(nowMs)) return true;
  return nowMs > expiryMs;
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
      if (isPersistedInvitationExpired(persisted)) {
        return {
          ok: false,
          code: "expired",
          message: "Expired documents cannot be sent again."
        };
      }
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
  if (Object.prototype.hasOwnProperty.call(draftPayload, "URL")) {
    next[0].URL = draftPayload.URL;
  }
  return next;
}

export function shouldExposeSignerShareLinks(doc) {
  return Boolean(doc?.SignedUrl);
}

// Same-tab serialized draft persistence. Not a cross-tab transactional outbox.
const draftPersistence = new Map();

function draftPersistenceState(documentId) {
  const id = documentId == null ? "" : String(documentId);
  if (!id) return null;
  let state = draftPersistence.get(id);
  if (!state) {
    state = {
      generation: 0,
      nextGeneration: 0,
      putChain: Promise.resolve()
    };
    draftPersistence.set(id, state);
  }
  return state;
}

function enqueueDraftPut(state, task) {
  const run = state.putChain.then(task, task);
  state.putChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

export function beginDraftPersistenceWrite({ documentId, kind } = {}) {
  const state = draftPersistenceState(documentId);
  if (!state) {
    return { documentId: "", generation: 0, kind: kind === "next" ? "next" : "autosave" };
  }
  state.generation += 1;
  const token = {
    documentId: String(documentId),
    generation: state.generation,
    kind: kind === "next" ? "next" : "autosave"
  };
  if (token.kind === "next") {
    state.nextGeneration = token.generation;
  }
  return token;
}

export function isDraftPersistenceWriteCurrent(token) {
  if (!token?.documentId) return false;
  const state = draftPersistence.get(String(token.documentId));
  if (!state) return false;
  if (token.kind === "next") {
    return token.generation === state.nextGeneration;
  }
  if (state.nextGeneration > token.generation) return false;
  return token.generation === state.generation;
}

export async function commitDraftPersistenceWrite(token, writeFn) {
  if (!token?.documentId) {
    return { skipped: true, reason: "missing-document" };
  }
  const state = draftPersistence.get(String(token.documentId));
  if (!state) {
    return { skipped: true, reason: "missing-state" };
  }
  return enqueueDraftPut(state, async () => {
    if (!isDraftPersistenceWriteCurrent(token)) {
      return { skipped: true, reason: "stale" };
    }
    const value = await writeFn();
    return { skipped: false, value };
  });
}

export function resetDraftPersistenceState(documentId) {
  if (documentId == null || documentId === "") {
    draftPersistence.clear();
    return;
  }
  draftPersistence.delete(String(documentId));
}
