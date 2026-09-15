import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, '..');
const read = relative => readFileSync(path.join(src, relative), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
const FICTIONAL_SECRET = 'fictional-native-approval-secret';

function strip(text) {
  return text
    .replace(/^import .*;\n/gm, '')
    .replace(/export default /g, '')
    .replace(/export (async )?function /g, (_, asyncKw) => `${asyncKw || ''}function `)
    .replace(/export const /g, 'const ');
}

class PError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
Object.assign(PError, {
  OPERATION_FORBIDDEN: 119,
  INVALID_SESSION_TOKEN: 209,
  OBJECT_NOT_FOUND: 101,
  INVALID_PARAMETER: 102,
  INVALID_QUERY: 102,
  DUPLICATE_VALUE: 137,
});

function canonicalDumps(value) {
  if (value === null) return 'null';
  const type = typeof value;
  if (type === 'number') {
    if (!Number.isFinite(value)) throw new Error('non_finite');
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

function fixture(options = {}) {
  const state = {
    rows: {},
    smtp: [],
    logs: [],
    queries: [],
    used: 0,
    saves: 0,
    timeout: !!options.timeout,
    barrier: null,
  };
  const ptr = (cls, id, other = {}) => ({ __type: 'Pointer', className: cls, objectId: id, ...other });
  const ext = ptr('contracts_Users', 'ext-owner', {
    UserId: ptr('_User', 'owner'),
    TenantId: ptr('partners_Tenant', 'tenant-owner'),
    Name: 'Synthetic Owner',
    Email: 'owner@example.invalid',
  });
  const placeholders = [
    {
      signerObjId: 'contact-a',
      Role: 'client',
      signerPtr: ptr('contracts_Contactbook', 'contact-a'),
      placeHolder: [{ pageNumber: 1, pos: [{ type: 'signature', key: 1, xPosition: 10, yPosition: 10, Width: 100, Height: 20 }] }],
    },
  ];
  const doc = {
    objectId: 'synthetic-document',
    Name: 'Synthetic Agreement',
    URL: 'https://files.example.invalid/parse/files/app/synthetic.pdf',
    CreatedBy: ptr('_User', 'owner'),
    ExtUserPtr: ext,
    Signers: [
      ptr('contracts_Contactbook', 'contact-a', {
        Email: 'a@example.invalid',
        Name: 'Synthetic A',
        CreatedBy: ptr('_User', 'owner'),
        TenantId: ptr('partners_Tenant', 'tenant-owner'),
        className: 'contracts_Contactbook',
      }),
    ],
    Placeholders: placeholders,
    ExpiryDate: { __type: 'Date', iso: '2099-01-01T00:00:00.000Z' },
    TimeToCompleteDays: 15,
    SendinOrder: false,
  };
  state.rows.contracts_Document = { 'synthetic-document': doc };
  state.rows.contracts_Users = { 'ext-owner': ext };
  state.rows.partners_Tenant = {
    'tenant-owner': {
      objectId: 'tenant-owner',
      SubscriptionStatus: options.inactive ? 'canceled' : 'active',
      MonthlyESignLimit: options.limit || 1000,
    },
  };
  state.rows.billing_UsageLedger = {
    usage: {
      objectId: 'usage',
      TenantId: ptr('partners_Tenant', 'tenant-owner'),
      PeriodKey: `${new Date().getUTCFullYear()}-${String(new Date().getUTCMonth() + 1).padStart(2, '0')}`,
      Used: 0,
      Limit: options.limit || 1000,
    },
  };
  state.rows.lexysign_FirmSendReservation = {};

  function encode(value) {
    if (value instanceof Date) return { __type: 'Date', iso: value.toISOString() };
    if (value instanceof Obj) return value.toJSON();
    if (Array.isArray(value)) return value.map(encode);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encode(item)]));
    }
    return value;
  }

  class Obj {
    constructor(cls, data = {}) {
      this.cls = cls;
      this.data = clone(data);
      this.id = data.objectId;
      this.dirty = {};
    }
    get(key) {
      const value = this.data[key];
      if (value && value.objectId) return new Obj(value.className || 'unknown', value);
      return value;
    }
    set(key, value) {
      const encoded = encode(value);
      this.data[key] = encoded;
      this.dirty[key] = encoded;
      return this;
    }
    increment(key, n) {
      this.data[key] = (this.data[key] || 0) + n;
      this.dirty[key] = this.data[key];
    }
    toJSON() {
      return { ...clone(this.data), objectId: this.id };
    }
    async save() {
      if (this.cls === 'lexysign_FirmSendReservation') {
        const rows = Object.values(state.rows[this.cls] || {});
        if (rows.some(row => row.documentId === this.data.documentId && row.objectId !== this.id)) {
          throw new PError(137, 'duplicate');
        }
      }
      if (this.cls === 'contracts_Document') {
        if (state.barrier) await state.barrier(this);
        const original = new Obj(this.cls, state.rows[this.cls][this.id]);
        await ctx.DocumentBeforesave({ object: this, original });
        state.saves += 1;
        const current = state.rows[this.cls][this.id] || {};
        state.rows[this.cls][this.id] = { ...current, ...this.dirty, objectId: this.id };
        this.data = clone(state.rows[this.cls][this.id]);
        this.dirty = {};
        return this;
      }
      this.id = this.id || `new-${this.cls}`;
      this.data.objectId = this.id;
      state.rows[this.cls] ||= {};
      state.rows[this.cls][this.id] = this.toJSON();
      this.dirty = {};
      return this;
    }
    async destroy() {
      if (this.id && state.rows[this.cls]) delete state.rows[this.cls][this.id];
    }
  }

  const idOf = value => (value instanceof Obj ? value.id : value?.objectId || value?.id || value);
  class Query {
    constructor(cls) {
      this.cls = cls;
      this.filters = [];
      state.queries.push(cls);
    }
    equalTo(key, value) {
      this.filters.push([key, value, false]);
      return this;
    }
    notEqualTo(key, value) {
      this.filters.push([key, value, true]);
      return this;
    }
    include() {
      return this;
    }
    async get(key) {
      const row = state.rows[this.cls]?.[key];
      if (!row) throw new Error('missing synthetic row ' + this.cls);
      return new Obj(this.cls, row);
    }
    async first() {
      const rows = Object.values(state.rows[this.cls] || {});
      const row = rows.find(item => this.filters.every(([key, value, not]) => (idOf(item[key]) === idOf(value)) !== not));
      return row ? new Obj(this.cls, row) : null;
    }
  }

  const ctx = vm.createContext({
    Buffer,
    URL,
    URLSearchParams,
    Date,
    createHmac,
    Parse: { Query, Object: Obj, Error: PError },
    process: {
      env: {
        SMTP_HOST: 'offline.invalid',
        SMTP_USER_EMAIL: 'sender@example.invalid',
        SERVER_URL: 'https://files.example.invalid/parse',
        LEXYSIGN_FIRM_APPROVAL_SECRET: FICTIONAL_SECRET,
      },
    },
    console: {
      log: (...value) => state.logs.push(value.map(String)),
      error: (...value) => state.logs.push(value.map(String)),
    },
    setDocumentCount: () => {},
    MAX_NAME_LENGTH: 250,
    MAX_NOTE_LENGTH: 200,
    MAX_DESCRIPTION_LENGTH: 200,
    appPublicUrl: 'https://files.example.invalid',
    brandColor: '#000',
    appName: 'Synthetic LexySign',
    brandEmailLogo: '',
    smtpenable: true,
    smtpsecure: true,
    updateMailCount: async () => {},
    createTransport: () => ({
      sendMail: async msg => {
        state.smtp.push(clone(msg));
        if (state.timeout) throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
        return { response: 'synthetic accepted' };
      },
      close() {},
    }),
  });

  let stripe = read('billing/stripeClient.js');
  let funcs = stripe.slice(stripe.indexOf('export function getMonthlyESignLimit'));
  vm.runInContext(funcs.replace(/export /g, ''), ctx);
  vm.runInContext(strip(read('billing/entitlements.js')), ctx);
  vm.runInContext(strip(read('cloud/parsefunction/DocumentBeforesave.js')), ctx);
  vm.runInContext(strip(read('cloud/parsefunction/sendMailv3.js')), ctx);
  const utils = read('Utils.js');
  vm.runInContext(
    utils
      .slice(utils.indexOf('export const mailTemplate ='), utils.indexOf('export const selectFormat ='))
      .replace('export const', 'var'),
    ctx
  );
  vm.runInContext(strip(read('cloud/parsefunction/lexysignFirmSendInvitations.js')), ctx);

  const user = {
    id: 'owner',
    get: key => (key === 'email' ? 'owner@example.invalid' : null),
    getSessionToken: () => 'synthetic-session-not-live',
  };

  function expectedFor(document) {
    return {
      title: document.Name,
      fileUrl: document.URL,
      fileHash: 'a'.repeat(64),
      recipients: document.Signers.map(signer => ({
        email: signer.Email,
        contact_id: signer.objectId,
        role: 'client',
        className: 'contracts_Contactbook',
        name: signer.Name,
        order: 1,
      })),
      order: document.SendinOrder ? 'sequential' : 'parallel',
      expiry: document.ExpiryDate.iso,
      timeToCompleteDays: 15,
      subject: `Synthetic Owner has requested you to sign "${document.Name}"`,
      sendMode: 'email',
      placeholders: document.Placeholders,
      documentUpdatedAt: '',
    };
  }

  function approvalFor(expected, documentId) {
    const body = {
      approval_id: 'appr-synthetic',
      document_id: documentId,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      issued_at: Math.floor(Date.now() / 1000),
      manifest_hash: 'b'.repeat(64),
      operator: 'owner',
      expected,
    };
    return { ...body, hmac: createHmac('sha256', FICTIONAL_SECRET).update(canonicalDumps(body)).digest('hex') };
  }

  const request = () => {
    const expected = expectedFor(doc);
    return {
      user,
      params: {
        documentId: doc.objectId,
        sendMode: 'email',
        expected,
        approval: approvalFor(expected, doc.objectId),
      },
    };
  };

  return { state, ctx, doc, user, request, send: req => ctx.lexysignFirmSendInvitations(req || request()) };
}

describe('LexySign firm native send control flow', () => {
  it('sends once for an authenticated owner and consumes one unit', async () => {
    const current = fixture({ limit: 1 });
    const result = await current.send();
    assert.equal(result.status, 'sent_smtp_accepted');
    assert.equal(current.state.smtp.length, 1);
    assert.equal(current.state.rows.billing_UsageLedger.usage.Used, 1);
  });

  it('rejects unauthenticated, foreign, tenant, terminal, expiry, and payload changes', async () => {
    for (const [kind, needle] of [
      ['unauthenticated', 'User is not authenticated'],
      ['owner', 'foreign_document'],
      ['tenant', 'other_tenant'],
      ['completed', 'document_terminal'],
      ['declined', 'document_terminal'],
      ['expired', 'document_expired'],
      ['title', 'payload_modified'],
      ['recipients', 'payload_modified'],
      ['order', 'payload_modified'],
      ['empty-fields', 'payload_modified'],
      ['contact', 'foreign_contact'],
    ]) {
      const current = fixture();
      const req = current.request();
      if (kind === 'unauthenticated') req.user = null;
      if (kind === 'owner') current.doc.CreatedBy.objectId = 'foreign';
      if (kind === 'tenant') {
        current.doc.ExtUserPtr = clone(current.doc.ExtUserPtr);
        current.doc.ExtUserPtr.TenantId.objectId = 'foreign';
      }
      if (kind === 'completed') current.doc.IsCompleted = true;
      if (kind === 'declined') current.doc.IsDeclined = true;
      if (kind === 'expired') current.doc.ExpiryDate.iso = '2000-01-01T00:00:00Z';
      if (kind === 'title') req.params.expected.title = 'changed';
      if (kind === 'recipients') req.params.expected.recipients[0].email = 'foreign@example.invalid';
      if (kind === 'order') req.params.expected.order = 'sequential';
      if (kind === 'empty-fields') current.doc.Placeholders = [];
      if (kind === 'contact') {
        current.doc.Signers[0].CreatedBy.objectId = 'foreign-owner';
        current.doc.Signers[0].TenantId.objectId = 'foreign-tenant';
      }
      await assert.rejects(current.send(req), error => String(error.message).includes(needle));
      assert.equal(current.state.smtp.length, 0);
    }
  });

  it('fails closed without approval and without the server secret', async () => {
    const current = fixture();
    const req = current.request();
    delete req.params.approval;
    delete req.params.expected;
    await assert.rejects(current.send(req), error => String(error.message).includes('approval_missing'));
    assert.equal(current.state.smtp.length, 0);

    const unconfigured = fixture();
    unconfigured.ctx.process.env.LEXYSIGN_FIRM_APPROVAL_SECRET = '';
    await assert.rejects(unconfigured.send(), error => String(error.message).includes('approval_unconfigured'));
  });

  it('rejects sequential and concurrent duplicate native sends', async () => {
    const sequential = fixture();
    await sequential.send();
    await assert.rejects(sequential.send(), error => String(error.message).includes('duplicate_send'));
    assert.equal(sequential.state.smtp.length, 1);

    const concurrent = fixture();
    const results = await Promise.allSettled([concurrent.send(), concurrent.send()]);
    const rejected = results.filter(item => item.status === 'rejected');
    const fulfilled = results.filter(item => item.status === 'fulfilled');
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.equal(concurrent.state.smtp.length, 1);
  });

  it('treats swallowed provider timeout as uncertain and refuses retry', async () => {
    const current = fixture({ timeout: true });
    const first = await current.send();
    assert.equal(first.status, 'uncertain');
    current.state.timeout = false;
    await assert.rejects(current.send(), error => String(error.message).includes('duplicate_send'));
    assert.equal(current.state.smtp.length, 1);
  });

  it('does not reset expiry and uses the native mail subject', async () => {
    const current = fixture();
    const before = current.doc.ExpiryDate.iso;
    const result = await current.send();
    assert.equal(result.status, 'sent_smtp_accepted');
    assert.equal(current.state.rows.contracts_Document[current.doc.objectId].ExpiryDate.iso, before);
    assert.match(current.state.smtp[0].subject, /has requested you to sign/);
  });

  it('rejects arbitrary stored file URLs', async () => {
    const current = fixture();
    current.doc.URL = 'http://127.0.0.1:9/protected-resource';
    await assert.rejects(current.send(), error => String(error.message).includes('invalid_origin'));
    assert.equal(current.state.smtp.length, 0);
  });

  it('rejects lifecycle mutation after read before mail', async () => {
    const current = fixture();
    current.state.barrier = async () => {
      current.doc.IsCompleted = true;
      current.state.barrier = null;
    };
    await assert.rejects(current.send(), error => String(error.message).includes('document_terminal'));
    assert.equal(current.state.smtp.length, 0);
  });

  it('sends with exact remaining paid quota of one signer unit', async () => {
    const current = fixture({ limit: 1 });
    const result = await current.send();
    assert.equal(result.status, 'sent_smtp_accepted');
    assert.equal(current.state.rows.billing_UsageLedger.usage.Used, 1);
    assert.equal(current.state.smtp.length, 1);
  });

  it('still denies a canceled subscription before activation', async () => {
    const current = fixture({ inactive: true });
    await assert.rejects(current.send(), error => error.code === 119);
    assert.equal(current.state.smtp.length, 0);
    assert.equal(current.state.rows.contracts_Document[current.doc.objectId].SignedUrl, undefined);
  });
});
