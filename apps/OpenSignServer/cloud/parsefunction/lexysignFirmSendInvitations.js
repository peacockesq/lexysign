import { createHmac } from 'node:crypto';
import sendmailv3 from './sendMailv3.js';
import { appPublicUrl, mailTemplate } from '../../Utils.js';
import { assertCanUseESignUnits, getTenantForExtUser } from '../../billing/entitlements.js';

const REQUIRED_EXPECTED = [
  'title',
  'fileUrl',
  'fileHash',
  'recipients',
  'order',
  'expiry',
  'timeToCompleteDays',
  'subject',
  'sendMode',
  'placeholders',
];

function toBase64(str) {
  return Buffer.from(String(str), 'utf8').toString('base64');
}

function pointerId(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  return value.objectId || value.id || '';
}

function signerEmail(signer) {
  return String(signer?.Email || signer?.email || '')
    .toLowerCase()
    .replace(/\s/g, '');
}

function signerClass(signer) {
  return String(signer?.className || signer?.__type || 'contracts_Contactbook');
}

function normalizeExpiry(value) {
  if (!value) return '';
  const raw = value.iso || value;
  const time = new Date(raw).getTime();
  return Number.isFinite(time) ? new Date(time).toISOString() : String(raw);
}

function canonicalDumps(value) {
  if (value === null) return 'null';
  const type = typeof value;
  if (type === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('non_finite');
    }
    return JSON.stringify(value);
  }
  if (type === 'boolean') return value ? 'true' : 'false';
  if (type === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalDumps).join(',')}]`;
  if (type === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalDumps(value[key])}`).join(',')}}`;
  }
  throw new Error('unsupported');
}

function hmacHex(secret, text) {
  return createHmac('sha256', secret).update(text).digest('hex');
}

function canonicalPlaceholders(placeholders) {
  return (placeholders || []).map(item => ({
    signerObjId: String(item.signerObjId || pointerId(item.signerPtr) || ''),
    role: String(item.Role || item.role || ''),
    className: String(item.signerPtr?.className || 'contracts_Contactbook'),
    fields: (item.placeHolder || []).flatMap(page =>
      (page.pos || []).map(pos => ({
        page: Number(page.pageNumber),
        type: String(pos.type || ''),
        x: Number(pos.xPosition),
        y: Number(pos.yPosition),
        width: Number(pos.Width),
        height: Number(pos.Height),
        key: Number(pos.key || 0),
      }))
    ),
  }));
}

function placeholdersEqual(left, right) {
  try {
    return canonicalDumps(canonicalPlaceholders(left)) === canonicalDumps(canonicalPlaceholders(right));
  } catch {
    return false;
  }
}

export function isTrustedStoredFileUrl(url, publicOrigin) {
  const clean = String(url || '').split('?')[0];
  let parsed;
  try {
    parsed = new URL(clean);
  } catch {
    return false;
  }
  const server = process.env.SERVER_URL || publicOrigin || appPublicUrl;
  let allowed;
  try {
    allowed = new URL(server);
  } catch {
    return false;
  }
  const sameOriginFiles = parsed.origin === allowed.origin && parsed.pathname.includes('/files/');
  if (sameOriginFiles) {
    if (parsed.protocol === 'https:') return true;
    return parsed.protocol === 'http:' && allowed.protocol === 'http:';
  }
  const storage = process.env.DO_BASEURL || '';
  if (!storage) return false;
  let bucket;
  try {
    bucket = new URL(storage);
  } catch {
    return false;
  }
  return parsed.protocol === 'https:' && bucket.protocol === 'https:' && parsed.origin === bucket.origin;
}

function renderedSubject(document, principal) {
  const senderName = document.SenderName || principal.name || principal.email || '';
  return `${senderName} has requested you to sign "${document.Name}"`;
}

function throwGuard(guard) {
  const forbidden = [
    'foreign_document',
    'other_tenant',
    'invalid_session',
    'foreign_contact',
    'approval_unconfigured',
    'reservation_unprovisioned',
  ];
  const code = forbidden.includes(guard.code)
    ? Parse.Error.OPERATION_FORBIDDEN
    : Parse.Error.INVALID_QUERY;
  throw new Parse.Error(code, `${guard.code}: ${guard.message}`);
}

export function evaluateFirmSendGuard({ document, principal, expected }) {
  if (!principal?.userId || !principal?.extUserId || !principal?.tenantId) {
    return { ok: false, code: 'invalid_session', message: 'Authenticated firm principal is required.' };
  }
  if (!document) {
    return { ok: false, code: 'missing', message: 'Document could not be loaded.' };
  }
  if (document.IsArchive === true) {
    return { ok: false, code: 'document_terminal', message: 'Archived documents cannot be sent.' };
  }
  if (document.IsCompleted === true) {
    return { ok: false, code: 'document_terminal', message: 'Completed documents cannot be sent again.' };
  }
  if (document.IsDeclined === true) {
    return { ok: false, code: 'document_terminal', message: 'Declined documents cannot be sent again.' };
  }
  const createdBy = pointerId(document.CreatedBy);
  const extUser = pointerId(document.ExtUserPtr);
  const tenantId = pointerId(document.ExtUserPtr?.TenantId) || pointerId(document.TenantId);
  if (createdBy !== principal.userId || extUser !== principal.extUserId) {
    return { ok: false, code: 'foreign_document', message: 'Document is not owned by the configured principal.' };
  }
  if (tenantId && tenantId !== principal.tenantId) {
    return { ok: false, code: 'other_tenant', message: 'Document tenant does not match the configured tenant.' };
  }
  const expiry = document.ExpiryDate?.iso || document.ExpiryDate;
  if (expiry && new Date(expiry).getTime() <= Date.now()) {
    return { ok: false, code: 'document_expired', message: 'Expired documents cannot be sent.' };
  }
  if (!document.URL) {
    return { ok: false, code: 'missing_url', message: 'Prepared document file is missing.' };
  }
  if (!isTrustedStoredFileUrl(document.URL, appPublicUrl)) {
    return { ok: false, code: 'invalid_origin', message: 'Document file origin is not a trusted current source.' };
  }
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)) {
    return { ok: false, code: 'approval_missing', message: 'Canonical expected binding is required.' };
  }
  for (const key of REQUIRED_EXPECTED) {
    if (expected[key] === undefined || expected[key] === null || expected[key] === '') {
      return { ok: false, code: 'approval_missing', message: 'Canonical expected binding is required.' };
    }
  }
  if (expected.title !== document.Name) {
    return { ok: false, code: 'payload_modified', message: 'Document title no longer matches the approved manifest.' };
  }
  if (expected.fileUrl !== document.URL) {
    return { ok: false, code: 'payload_modified', message: 'Document file no longer matches the approved manifest.' };
  }
  const order = document.SendinOrder === true ? 'sequential' : 'parallel';
  if (expected.order !== order) {
    return { ok: false, code: 'payload_modified', message: 'Signing order no longer matches the approved manifest.' };
  }
  const days = Number(document.TimeToCompleteDays);
  const expectedDays = Number(expected.timeToCompleteDays);
  if (!Number.isFinite(days) || days !== expectedDays) {
    return { ok: false, code: 'payload_modified', message: 'Completion days no longer match the approved manifest.' };
  }
  if (normalizeExpiry(expiry) !== normalizeExpiry(expected.expiry)) {
    return { ok: false, code: 'payload_modified', message: 'Document expiry no longer matches the approved manifest.' };
  }
  if (expected.subject !== renderedSubject(document, principal)) {
    return { ok: false, code: 'payload_modified', message: 'Rendered subject no longer matches the approved manifest.' };
  }
  const sendMode = expected.sendMode === 'manual' ? 'manual' : 'email';
  if (expected.sendMode !== sendMode) {
    return { ok: false, code: 'payload_modified', message: 'Send mode no longer matches the approved manifest.' };
  }
  const signers = Array.isArray(document.Signers) ? document.Signers : [];
  if (signers.length === 0) {
    return { ok: false, code: 'missing_signers', message: 'Document has no signers.' };
  }
  const expectedRecipients = Array.isArray(expected.recipients) ? expected.recipients : [];
  if (expectedRecipients.length !== signers.length) {
    return { ok: false, code: 'payload_modified', message: 'Recipient list no longer matches the approved manifest.' };
  }
  const placeholders = Array.isArray(document.Placeholders) ? document.Placeholders : [];
  if (!placeholders.length) {
    return { ok: false, code: 'payload_modified', message: 'Empty signer fields cannot be sent.' };
  }
  if (!placeholdersEqual(placeholders, expected.placeholders)) {
    return { ok: false, code: 'payload_modified', message: 'Signer fields no longer match the approved manifest.' };
  }
  for (let i = 0; i < signers.length; i++) {
    const signer = signers[i];
    const want = expectedRecipients[i] || {};
    const email = signerEmail(signer);
    const contactId = pointerId(signer);
    const className = signerClass(signer);
    if (!email || email !== String(want.email || '').toLowerCase().replace(/\s/g, '')) {
      return { ok: false, code: 'payload_modified', message: 'Recipient list no longer matches the approved manifest.' };
    }
    if (contactId !== String(want.contact_id || '')) {
      return { ok: false, code: 'payload_modified', message: 'Signer contact identity no longer matches the approved manifest.' };
    }
    if (want.className && className && want.className !== className && className !== 'Pointer') {
      return { ok: false, code: 'payload_modified', message: 'Signer class no longer matches the approved manifest.' };
    }
    const placeholder = placeholders.find(item => String(item.signerObjId || pointerId(item.signerPtr)) === contactId);
    if (!placeholder) {
      return { ok: false, code: 'payload_modified', message: 'Placeholder contact linkage no longer matches the approved manifest.' };
    }
    if (want.role && String(placeholder.Role || placeholder.role || '') !== String(want.role)) {
      return { ok: false, code: 'payload_modified', message: 'Signer role no longer matches the approved manifest.' };
    }
    if (className === 'contracts_Contactbook' || !className || className === 'Pointer') {
      const contactOwner = pointerId(signer.CreatedBy);
      const contactTenant = pointerId(signer.TenantId);
      if (signer.IsDeleted === true) {
        return { ok: false, code: 'foreign_contact', message: 'Signer contact is deleted.' };
      }
      if (contactOwner && contactOwner !== principal.userId) {
        return { ok: false, code: 'foreign_contact', message: 'Signer contact is not owned by the configured principal.' };
      }
      if (contactTenant && contactTenant !== principal.tenantId) {
        return { ok: false, code: 'foreign_contact', message: 'Signer contact tenant does not match the configured tenant.' };
      }
    }
  }
  return { ok: true };
}

function recipientsForSend(document) {
  const signers = (document.Signers || []).filter(signer => signerEmail(signer));
  if (document.SendinOrder === true) {
    return signers.slice(0, 1);
  }
  return signers;
}

export async function loadPrincipal(user) {
  const query = new Parse.Query('contracts_Users');
  query.equalTo('UserId', user);
  query.include('TenantId');
  query.include('UserId');
  const extUser = await query.first({ useMasterKey: true });
  if (!extUser) {
    throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, 'User not found.');
  }
  const json = JSON.parse(JSON.stringify(extUser));
  return {
    userId: user.id,
    extUserId: extUser.id,
    tenantId: pointerId(json.TenantId),
    name: json.Name || '',
    email: json.Email || user.get('email') || '',
    company: json.Company || '',
    phone: json.Phone || '',
    useNameAsSender: json.UseNameAsSender === true,
    extJson: json,
  };
}

export async function loadOwnedDocument(documentId) {
  const query = new Parse.Query('contracts_Document');
  query.equalTo('objectId', documentId);
  query.include('ExtUserPtr');
  query.include('ExtUserPtr.TenantId');
  query.include('CreatedBy');
  query.include('Signers');
  query.include('Placeholders');
  query.notEqualTo('IsArchive', true);
  return query.first({ useMasterKey: true });
}

function approvalSecret() {
  return String(process.env.LEXYSIGN_FIRM_APPROVAL_SECRET || '').trim();
}

export function verifyNativeApproval({ approval, expected, documentId, now }) {
  const secret = approvalSecret();
  if (!secret) {
    return { ok: false, code: 'approval_unconfigured', message: 'Native firm approval secret is not configured.' };
  }
  if (!approval || typeof approval !== 'object' || Array.isArray(approval)) {
    return { ok: false, code: 'approval_missing', message: 'Server-verifiable approval is required.' };
  }
  const approvalId = String(approval.approval_id || '');
  const given = String(approval.hmac || '');
  if (!approvalId || !given) {
    return { ok: false, code: 'approval_missing', message: 'Server-verifiable approval is required.' };
  }
  const expiresAt = Number(approval.expires_at || 0);
  if (!Number.isFinite(expiresAt) || expiresAt <= (now || Math.floor(Date.now() / 1000))) {
    return { ok: false, code: 'approval_expired', message: 'Operator approval has expired.' };
  }
  if (String(approval.document_id || '') !== documentId) {
    return { ok: false, code: 'payload_modified', message: 'Approval document no longer matches.' };
  }
  const payload = {
    approval_id: approvalId,
    document_id: documentId,
    expires_at: expiresAt,
    issued_at: Number(approval.issued_at || 0),
    manifest_hash: String(approval.manifest_hash || ''),
    operator: String(approval.operator || ''),
    expected,
  };
  let expectedHmac;
  try {
    expectedHmac = hmacHex(secret, canonicalDumps(payload));
  } catch {
    return { ok: false, code: 'approval_mismatch', message: 'Approval signature is invalid.' };
  }
  const left = Buffer.from(given, 'utf8');
  const right = Buffer.from(expectedHmac, 'utf8');
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    return { ok: false, code: 'approval_mismatch', message: 'Approval signature is invalid.' };
  }
  return { ok: true, approvalId, manifestHash: payload.manifest_hash };
}

function timingSafeEqual(left, right) {
  if (typeof createHmac === 'function' && left.length === right.length) {
    let diff = 0;
    for (let i = 0; i < left.length; i++) diff |= left[i] ^ right[i];
    return diff === 0;
  }
  return false;
}

async function reserveDispatch({ documentId, approvalId, manifestHash }) {
  const obj = new Parse.Object('lexysign_FirmSendReservation');
  obj.set('documentId', documentId);
  obj.set('sendGeneration', 1);
  obj.set('approvalId', approvalId);
  obj.set('manifestHash', manifestHash);
  obj.set('state', 'in_flight');
  try {
    await obj.save(null, { useMasterKey: true });
    return obj;
  } catch (err) {
    if (err?.code === Parse.Error.DUPLICATE_VALUE || err?.code === 137) {
      throw new Parse.Error(Parse.Error.DUPLICATE_VALUE, 'duplicate_send: document send is already reserved.');
    }
    const message = String(err?.message || '');
    if (/invalid class|does not exist|ClassNotFound|unknown class|schema/i.test(message)) {
      throw new Parse.Error(
        Parse.Error.OPERATION_FORBIDDEN,
        'reservation_unprovisioned: firm send reservation class/index is not provisioned.'
      );
    }
    throw new Parse.Error(
      Parse.Error.OPERATION_FORBIDDEN,
      'reservation_unprovisioned: firm send reservation could not be created.'
    );
  }
}

async function finishReservation(reservation, state, extra) {
  if (!reservation) return;
  reservation.set('state', state);
  if (extra) {
    Object.entries(extra).forEach(([key, value]) => reservation.set(key, value));
  }
  try {
    await reservation.save(null, { useMasterKey: true });
  } catch {
    // Reservation row is the durable lock; a later state write failure stays in_flight/uncertain.
  }
}

async function releaseReservation(reservation) {
  if (!reservation) return;
  try {
    await reservation.destroy({ useMasterKey: true });
  } catch {
    try {
      reservation.set('state', 'failed_before_provider');
      await reservation.save(null, { useMasterKey: true });
    } catch {
      // fail closed: leftover in_flight still blocks retries
    }
  }
}

function signingLink(document, signer, hostUrl) {
  const email = signerEmail(signer);
  const contactId = pointerId(signer);
  const encodeBase64 = toBase64(`${document.objectId}/${email}/${contactId}`);
  return `${hostUrl}/login/${encodeBase64}`;
}

/**
 * Narrow firm-send cloud function.
 * Requires server-verifiable exact-manifest approval. Fail closed if the
 * approval secret or reservation unique index is unprovisioned.
 * Existing legacy Parse APIs are not globally approval-gated.
 */
export default async function lexysignFirmSendInvitations(request) {
  if (!request.user) {
    throw new Parse.Error(Parse.Error.INVALID_SESSION_TOKEN, 'User is not authenticated.');
  }
  const documentId = request.params?.documentId;
  const expected = request.params?.expected;
  const approval = request.params?.approval;
  if (!documentId || typeof documentId !== 'string') {
    throw new Parse.Error(Parse.Error.INVALID_PARAMETER, 'documentId is required.');
  }

  const principal = await loadPrincipal(request.user);
  const docObj = await loadOwnedDocument(documentId);
  let document = docObj ? JSON.parse(JSON.stringify(docObj)) : null;
  const guard = evaluateFirmSendGuard({ document, principal, expected });
  if (!guard.ok) throwGuard(guard);

  const verified = verifyNativeApproval({
    approval,
    expected,
    documentId,
    now: Math.floor(Date.now() / 1000),
  });
  if (!verified.ok) throwGuard(verified);

  if (document.SignedUrl || document.SentToOthers === true) {
    throw new Parse.Error(Parse.Error.DUPLICATE_VALUE, 'duplicate_send: document was already sent.');
  }

  const sendMode = expected.sendMode === 'manual' ? 'manual' : 'email';
  const signerCount = (document.Signers || []).length || 1;
  try {
    const extUser = docObj.get('ExtUserPtr');
    const tenant = await getTenantForExtUser(extUser);
    if (tenant) {
      await assertCanUseESignUnits(tenant, signerCount);
    }
  } catch (err) {
    if (err?.code === Parse.Error.OPERATION_FORBIDDEN) {
      throw err;
    }
    throw new Parse.Error(Parse.Error.OPERATION_FORBIDDEN, 'insufficient_quota: entitlement check failed.');
  }

  const reservation = await reserveDispatch({
    documentId,
    approvalId: verified.approvalId,
    manifestHash: verified.manifestHash,
  });

  const admittedObj = await loadOwnedDocument(documentId);
  const admitted = admittedObj ? JSON.parse(JSON.stringify(admittedObj)) : null;
  const admittedGuard = evaluateFirmSendGuard({ document: admitted, principal, expected });
  if (!admittedGuard.ok) {
    await releaseReservation(reservation);
    throwGuard(admittedGuard);
  }
  if (admitted.SignedUrl || admitted.SentToOthers === true) {
    await releaseReservation(reservation);
    throw new Parse.Error(Parse.Error.DUPLICATE_VALUE, 'duplicate_send: document was already sent.');
  }

  admittedObj.set('SignedUrl', admitted.URL);
  admittedObj.set('SentToOthers', true);
  try {
    await admittedObj.save(null, { sessionToken: request.user.getSessionToken() });
  } catch (err) {
    await releaseReservation(reservation);
    if (err?.code === Parse.Error.OPERATION_FORBIDDEN) {
      throw err;
    }
    throw err;
  }

  const afterObj = await loadOwnedDocument(documentId);
  const after = afterObj ? JSON.parse(JSON.stringify(afterObj)) : null;
  const afterGuard = evaluateFirmSendGuard({
    document: { ...after, SignedUrl: undefined, SentToOthers: false },
    principal,
    expected,
  });
  if (!afterGuard.ok) {
    await finishReservation(reservation, 'uncertain', { reason: afterGuard.code });
    throwGuard(afterGuard);
  }

  document = after;
  const mailRecipients = recipientsForSend(document);
  const hostUrl = new URL(appPublicUrl).origin;
  const results = [];

  if (sendMode === 'manual') {
    const artifacts = [];
    for (const signer of mailRecipients) {
      const email = signerEmail(signer);
      artifacts.push({
        email,
        contact_id: pointerId(signer),
        signing_url: signingLink(document, signer, hostUrl),
      });
      results.push({
        email,
        smtp_accepted: false,
        delivery: 'not_attempted_manual',
      });
    }
    await finishReservation(reservation, 'activated_manual', { recipientCount: results.length });
    return {
      status: 'activated_manual',
      smtp_accepted: false,
      delivered: false,
      recipients: results,
      manual_artifacts: artifacts,
    };
  }

  const expiryDate = document.ExpiryDate?.iso || document.ExpiryDate;
  const localExpireDate = expiryDate
    ? new Date(expiryDate).toLocaleDateString('en-US', { day: 'numeric', month: 'long', year: 'numeric' })
    : '';
  const senderEmail = document.SenderMail || principal.email;
  const senderName = document.SenderName || principal.name;
  const from =
    document.SenderName || principal.useNameAsSender ? principal.name || senderEmail : senderEmail;

  let uncertain = false;
  for (const signer of mailRecipients) {
    if (uncertain) {
      results.push({
        email: signerEmail(signer),
        smtp_accepted: false,
        delivery: 'not_attempted_after_uncertain',
      });
      continue;
    }
    const email = signerEmail(signer);
    const contactId = pointerId(signer);
    const encodeBase64 = toBase64(`${document.objectId}/${email}/${contactId}`);
    const signingUrl = `${hostUrl}/login/${encodeBase64}`;
    const template = mailTemplate({
      senderName,
      senderMail: senderEmail,
      title: document.Name,
      organization: principal.company || '',
      localExpireDate,
      signingUrl,
      note: document.Note || '',
    });
    if (template.subject !== expected.subject) {
      await finishReservation(reservation, 'uncertain', { reason: 'subject_mismatch' });
      throwGuard({
        ok: false,
        code: 'payload_modified',
        message: 'Rendered subject no longer matches the approved manifest.',
      });
    }
    try {
      const mailResult = await sendmailv3({
        params: {
          extUserId: principal.extUserId,
          recipient: email,
          subject: template.subject,
          from,
          replyto: senderEmail || '',
          html: template.body,
          firmQuotaAlreadyReserved: true,
        },
      });
      if (mailResult?.status === 'success') {
        results.push({
          email,
          smtp_accepted: true,
          delivery: 'accepted_not_delivered',
        });
      } else {
        // sendMailv3 swallows provider timeout/reset as {status:'error'}.
        // That is not a proven pre-provider rejection.
        uncertain = true;
        results.push({ email, smtp_accepted: false, delivery: 'uncertain' });
      }
    } catch (err) {
      if (err?.code === Parse.Error.OPERATION_FORBIDDEN) {
        await finishReservation(reservation, 'failed_before_provider', { reason: 'entitlement' });
        throw err;
      }
      uncertain = true;
      const delivery =
        err?.code === 'ETIMEDOUT' || err?.code === 'ECONNRESET' || err?.message === 'timeout'
          ? 'uncertain'
          : 'uncertain';
      results.push({ email, smtp_accepted: false, delivery });
    }
  }

  if (uncertain) {
    await finishReservation(reservation, 'uncertain', { recipientCount: results.length });
    return {
      status: 'uncertain',
      smtp_accepted: false,
      delivered: false,
      recipients: results,
    };
  }
  const acceptedCount = results.filter(item => item.smtp_accepted).length;
  let status = 'sent_smtp_accepted';
  if (acceptedCount === 0) status = 'uncertain';
  else if (acceptedCount < results.length) status = 'partial_failure';
  await finishReservation(reservation, status === 'sent_smtp_accepted' ? 'accepted' : status, {
    recipientCount: results.length,
  });
  return {
    status,
    smtp_accepted: acceptedCount > 0,
    delivered: false,
    recipients: results,
  };
}
