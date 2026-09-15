import sendmailv3 from './sendMailv3.js';
import { appPublicUrl, mailTemplate } from '../../Utils.js';

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
  if (expected?.title && document.Name !== expected.title) {
    return { ok: false, code: 'payload_modified', message: 'Document title no longer matches the approved manifest.' };
  }
  if (expected?.fileUrl && document.URL !== expected.fileUrl) {
    return { ok: false, code: 'payload_modified', message: 'Document file no longer matches the approved manifest.' };
  }
  const expectedEmails = (expected?.recipients || []).map(item =>
    String(item.email || '')
      .toLowerCase()
      .replace(/\s/g, '')
  );
  const actualEmails = (document.Signers || []).map(signerEmail).filter(Boolean);
  if (expectedEmails.length > 0) {
    if (expectedEmails.length !== actualEmails.length) {
      return { ok: false, code: 'payload_modified', message: 'Recipient list no longer matches the approved manifest.' };
    }
    for (let i = 0; i < expectedEmails.length; i++) {
      if (expectedEmails[i] !== actualEmails[i]) {
        return { ok: false, code: 'payload_modified', message: 'Recipient list no longer matches the approved manifest.' };
      }
    }
  }
  if (!Array.isArray(document.Signers) || document.Signers.length === 0) {
    return { ok: false, code: 'missing_signers', message: 'Document has no signers.' };
  }
  return { ok: true, signedUrl: document.URL };
}

function recipientsForSend(document) {
  const signers = (document.Signers || []).filter(signer => signerEmail(signer));
  if (document.SendinOrder === true) {
    return signers.slice(0, 1);
  }
  return signers;
}

async function loadPrincipal(user) {
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

async function loadOwnedDocument(documentId) {
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

/**
 * Narrow firm-send cloud function.
 * Independent review is required before production activation.
 * Does not change existing signing semantics. Does not accept caller-selected
 * owner, tenant, public origin, or arbitrary mail recipients.
 */
export default async function lexysignFirmSendInvitations(request) {
  if (!request.user) {
    throw new Parse.Error(Parse.Error.INVALID_SESSION_TOKEN, 'User is not authenticated.');
  }
  const documentId = request.params?.documentId;
  const sendMode = request.params?.sendMode === 'manual' ? 'manual' : 'email';
  const expected = request.params?.expected || {};
  if (!documentId || typeof documentId !== 'string') {
    throw new Parse.Error(Parse.Error.INVALID_PARAMETER, 'documentId is required.');
  }

  const principal = await loadPrincipal(request.user);
  const docObj = await loadOwnedDocument(documentId);
  const document = docObj ? JSON.parse(JSON.stringify(docObj)) : null;
  const guard = evaluateFirmSendGuard({ document, principal, expected });
  if (!guard.ok) {
    const forbidden = ['foreign_document', 'other_tenant', 'invalid_session'];
    const code = forbidden.includes(guard.code)
      ? Parse.Error.OPERATION_FORBIDDEN
      : Parse.Error.INVALID_QUERY;
    throw new Parse.Error(code, `${guard.code}: ${guard.message}`);
  }

  const alreadyDispatched = Boolean(document.SignedUrl);
  if (alreadyDispatched && document.SignedUrl !== document.URL) {
    throw new Parse.Error(Parse.Error.DUPLICATE_VALUE, 'duplicate_send: document was already sent.');
  }

  if (!alreadyDispatched) {
    const timeToCompleteDays = Number(document.TimeToCompleteDays) || 15;
    const expiry = new Date();
    expiry.setDate(expiry.getDate() + timeToCompleteDays);
    docObj.set('SignedUrl', document.URL);
    docObj.set('SentToOthers', true);
    docObj.set('ExpiryDate', expiry);
    await docObj.save(null, { sessionToken: request.user.getSessionToken() });
  }

  const mailRecipients = recipientsForSend(document);
  const results = [];
  if (sendMode === 'manual') {
    for (const signer of mailRecipients) {
      results.push({
        email: signerEmail(signer),
        smtp_accepted: false,
        delivery: 'not_attempted_manual',
      });
    }
    return {
      status: alreadyDispatched ? 'already_dispatched' : 'activated_manual',
      smtp_accepted: false,
      delivered: false,
      recipients: results,
    };
  }

  const hostUrl = new URL(appPublicUrl).origin;
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
    try {
      const mailResult = await sendmailv3({
        params: {
          extUserId: principal.extUserId,
          recipient: email,
          subject: template.subject,
          from,
          replyto: senderEmail || '',
          html: template.body,
        },
      });
      const accepted = mailResult?.status === 'success';
      results.push({
        email,
        smtp_accepted: accepted,
        delivery: accepted ? 'accepted_not_delivered' : 'smtp_error',
      });
    } catch (err) {
      if (err?.code === 'ETIMEDOUT' || err?.code === 'ECONNRESET' || err?.message === 'timeout') {
        uncertain = true;
        results.push({ email, smtp_accepted: false, delivery: 'uncertain' });
        break;
      }
      results.push({ email, smtp_accepted: false, delivery: 'smtp_error' });
    }
  }

  if (uncertain) {
    return {
      status: 'uncertain',
      smtp_accepted: false,
      delivered: false,
      recipients: results,
    };
  }
  const acceptedCount = results.filter(item => item.smtp_accepted).length;
  let status = 'sent_smtp_accepted';
  if (acceptedCount === 0) status = 'smtp_error';
  else if (acceptedCount < results.length) status = 'partial_failure';
  return {
    status,
    smtp_accepted: acceptedCount > 0,
    delivered: false,
    recipients: results,
  };
}
