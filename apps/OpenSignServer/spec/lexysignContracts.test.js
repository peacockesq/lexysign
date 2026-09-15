import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { getPeriodKey } from '../billing/entitlements.js';
import {
  getMonthlyESignLimit,
  getStripeClient,
  subscriptionIsActive,
} from '../billing/stripeClient.js';

const read = relativePath => readFileSync(new URL(relativePath, import.meta.url), 'utf8');

describe('LexySign billing helpers', () => {
  it('formats UTC period keys as YYYY-MM', () => {
    assert.equal(getPeriodKey(new Date(Date.UTC(2026, 8, 15))), '2026-09');
  });

  it('treats active and trialing subscriptions as entitled', () => {
    assert.equal(subscriptionIsActive('active'), true);
    assert.equal(subscriptionIsActive('trialing'), true);
    assert.equal(subscriptionIsActive('canceled'), false);
    assert.equal(subscriptionIsActive('none'), false);
  });

  it('defaults the monthly e-sign limit to 1000', () => {
    const previous = process.env.LEXYSIGN_MONTHLY_ESIGN_LIMIT;
    delete process.env.LEXYSIGN_MONTHLY_ESIGN_LIMIT;
    try {
      assert.equal(getMonthlyESignLimit(), 1000);
    } finally {
      if (previous === undefined) {
        delete process.env.LEXYSIGN_MONTHLY_ESIGN_LIMIT;
      } else {
        process.env.LEXYSIGN_MONTHLY_ESIGN_LIMIT = previous;
      }
    }
  });

  it('refuses to construct Stripe without a secret', () => {
    const previous = process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_SECRET_KEY;
    try {
      assert.throws(() => getStripeClient(), /STRIPE_SECRET_KEY is not configured/);
    } finally {
      if (previous === undefined) {
        delete process.env.STRIPE_SECRET_KEY;
      } else {
        process.env.STRIPE_SECRET_KEY = previous;
      }
    }
  });
});

describe('LexySign merge contract sources', () => {
  it('keeps the Supabase login cloud function wired', () => {
    const main = read('../cloud/main.js');
    assert.match(main, /import loginWithSupabase from '\.\/parsefunction\/loginWithSupabase\.js'/);
    assert.match(main, /Parse\.Cloud\.define\('loginWithSupabase', loginWithSupabase\)/);
    assert.match(main, /Parse\.Cloud\.define\('createdocumentfromapp', createDocumentFromApp\)/);
  });

  it('keeps billing routes and the Stripe webhook ahead of json parsing', () => {
    const index = read('../index.js');
    const customApp = read('../cloud/customRoute/customApp.js');
    assert.match(index, /import \{ stripeWebhook \} from '\.\/cloud\/customRoute\/billing\.js'/);
    assert.match(
      index,
      /app\.post\('\/billing\/stripe-webhook', express\.raw\(\{ type: 'application\/json' \}\), stripeWebhook\)/
    );
    assert.match(index, /req\.path\?\.includes\('\/files\/'\)/);
    assert.match(customApp, /app\.use\('\/billing', billingRouter\)/);
  });

  it('does not eagerly construct S3 when local storage has no credentials', () => {
    const deleteFileUrl = read('../cloud/customRoute/deleteAccount/deleteFileUrl.js');
    assert.match(deleteFileUrl, /const hasS3Config = Boolean\(/);
    assert.match(deleteFileUrl, /const s3 = hasS3Config/);
    assert.match(deleteFileUrl, /if \(!s3\)/);
    assert.match(deleteFileUrl, /if \(!filePath\.includes\('\/files\/'\)\) return;/);
  });

  it('keeps LexySign certificate identity and the moved logo path', () => {
    const certificate = read('../cloud/parsefunction/generateCertificatebydocId.js');
    const generateCertificate = read('../cloud/parsefunction/pdf/GenerateCertificate.js');
    const pdf = read('../cloud/parsefunction/pdf/PDF.js');
    assert.match(certificate, /const eSignName = 'LexySign'/);
    assert.match(certificate, /const eSigncontact = 'support@lexyalgo.com'/);
    assert.match(pdf, /const eSignName = 'LexySign'/);
    assert.match(generateCertificate, /readFileSync\('\.\/images\/logo\.png'\)/);
  });

  it('keeps DOCX conversion branding and a single uploaded-size binding', () => {
    const docx = read('../cloud/customRoute/docxtopdf.js');
    const matches = docx.match(/const uploadedSizeBytes/g) || [];
    assert.equal(matches.length, 1);
    assert.match(docx, /contact LexySign support/);
  });

  it('uses the custom email footer on system and request mailers', () => {
    assert.match(read('../cloud/parsefunction/sendMailv3.js'), /EMAIL_FOOTER_HTML/);
    assert.match(read('../cloud/parsefunction/sendMailWithAttachment.js'), /EMAIL_FOOTER_HTML/);
    assert.match(read('../cloud/parsefunction/sendSystemMail.js'), /EMAIL_FOOTER_HTML/);
    assert.match(read('../cloud/parsefunction/sendMailv3.js'), /assertCanUseESignUnits/);
  });

  it('disables public admin bootstrap when configured', () => {
    assert.match(
      read('../cloud/parsefunction/AddAdmin.js'),
      /DISABLE_PUBLIC_ADDADMIN\?\.toLowerCase\(\) === 'true'/
    );
  });
});
