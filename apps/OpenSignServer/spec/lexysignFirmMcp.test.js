import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const read = relativePath => readFileSync(new URL(relativePath, import.meta.url), 'utf8');

describe('LexySign firm MCP native send registration', () => {
  it('wires lexysignFirmSendInvitations in cloud/main.js', () => {
    const main = read('../cloud/main.js');
    assert.match(main, /import lexysignFirmSendInvitations from '\.\/parsefunction\/lexysignFirmSendInvitations\.js'/);
    assert.match(main, /Parse\.Cloud\.define\('lexysignFirmSendInvitations', lexysignFirmSendInvitations\)/);
    assert.match(main, /import lexysignFirmAcquireFile from '\.\/parsefunction\/lexysignFirmAcquireFile\.js'/);
    assert.match(main, /Parse\.Cloud\.define\('lexysignFirmAcquireFile', lexysignFirmAcquireFile\)/);
  });

  it('keeps owner, tenant, lifecycle, and smtp-accepted-not-delivered guards', () => {
    const send = read('../cloud/parsefunction/lexysignFirmSendInvitations.js');
    assert.match(send, /export function evaluateFirmSendGuard/);
    assert.match(send, /foreign_document/);
    assert.match(send, /other_tenant/);
    assert.match(send, /document_terminal/);
    assert.match(send, /document_expired/);
    assert.match(send, /payload_modified/);
    assert.match(send, /accepted_not_delivered/);
    assert.match(send, /sendMode === 'manual'/);
    assert.match(send, /appPublicUrl/);
    assert.match(send, /request\.user/);
    assert.match(send, /LEXYSIGN_FIRM_APPROVAL_SECRET/);
    assert.match(send, /lexysign_FirmSendReservation/);
    assert.match(send, /firmQuotaAlreadyReserved/);
  });
});
