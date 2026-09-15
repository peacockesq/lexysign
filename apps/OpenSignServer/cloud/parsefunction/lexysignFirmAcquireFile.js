import getPresignedUrl, { presignedlocalUrl } from './getSignedUrl.js';
import { isTrustedStoredFileUrl, loadOwnedDocument, loadPrincipal } from './lexysignFirmSendInvitations.js';
import { appPublicUrl } from '../../Utils.js';

function throwGuard(guard) {
  const forbidden = ['foreign_document', 'other_tenant', 'invalid_session'];
  const code = forbidden.includes(guard.code)
    ? Parse.Error.OPERATION_FORBIDDEN
    : Parse.Error.INVALID_QUERY;
  throw new Parse.Error(code, `${guard.code}: ${guard.message}`);
}

/**
 * Narrow owner/tenant-checked file capability renewal.
 * Derives source/signed/certificate URLs from the current document only.
 * Never accepts a caller-selected URL. Does not bypass /files JWT middleware.
 */
export default async function lexysignFirmAcquireFile(request) {
  if (!request.user) {
    throw new Parse.Error(Parse.Error.INVALID_SESSION_TOKEN, 'User is not authenticated.');
  }
  const documentId = request.params?.documentId;
  const kind = request.params?.kind;
  if (!documentId || typeof documentId !== 'string') {
    throw new Parse.Error(Parse.Error.INVALID_PARAMETER, 'documentId is required.');
  }
  if (!['source', 'signed', 'certificate'].includes(kind)) {
    throw new Parse.Error(Parse.Error.INVALID_PARAMETER, 'kind must be source, signed, or certificate.');
  }

  const principal = await loadPrincipal(request.user);
  const docObj = await loadOwnedDocument(documentId);
  const document = docObj ? JSON.parse(JSON.stringify(docObj)) : null;
  if (!document) {
    throwGuard({ ok: false, code: 'missing', message: 'Document could not be loaded.' });
  }
  const createdBy = document.CreatedBy?.objectId || document.CreatedBy?.id || document.CreatedBy;
  const extUser = document.ExtUserPtr?.objectId || document.ExtUserPtr?.id || document.ExtUserPtr;
  const tenantId =
    document.ExtUserPtr?.TenantId?.objectId || document.ExtUserPtr?.TenantId?.id || document.TenantId?.objectId;
  if (createdBy !== principal.userId || extUser !== principal.extUserId) {
    throwGuard({
      ok: false,
      code: 'foreign_document',
      message: 'Document is not owned by the configured principal.',
    });
  }
  if (tenantId && tenantId !== principal.tenantId) {
    throwGuard({
      ok: false,
      code: 'other_tenant',
      message: 'Document tenant does not match the configured tenant.',
    });
  }

  let stored = '';
  if (kind === 'source') stored = document.URL;
  else if (kind === 'signed') stored = document.SignedUrl || (document.IsCompleted ? document.URL : '');
  else stored = document.CertificateUrl;

  if (!stored) {
    throw new Parse.Error(Parse.Error.INVALID_QUERY, 'missing_url: requested document file is missing.');
  }
  if (!isTrustedStoredFileUrl(stored, appPublicUrl)) {
    throw new Parse.Error(Parse.Error.INVALID_QUERY, 'invalid_origin: document file origin is not trusted.');
  }
  if (kind === 'signed' && !document.IsCompleted && !document.SignedUrl) {
    throw new Parse.Error(Parse.Error.INVALID_QUERY, 'not_completed: signed PDF is not available.');
  }

  const clean = String(stored).split('?')[0];
  if (clean.includes('/files/')) {
    return { url: presignedlocalUrl(clean), kind, source: 'document' };
  }
  const capability = await getPresignedUrl(clean);
  return { url: capability, kind, source: 'document' };
}
