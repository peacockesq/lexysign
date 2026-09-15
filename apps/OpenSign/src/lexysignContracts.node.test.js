import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts) => readFileSync(join(root, ...parts), 'utf8');

describe('LexySign client merge contracts', () => {
  it('keeps LexySign branding in client Utils', () => {
    const utils = read('src/constant/Utils.js');
    assert.match(utils, /const appName = "LexySign"/);
    assert.match(utils, /https:\/\/sign\.lexyalgo\.com\/lexysign-logo\.png/);
    assert.match(utils, /This PDF is not compatible with LexySign/);
  });

  it('keeps drawn-signature enforcement', () => {
    const modal = read('src/components/pdf/WidgetsValueModal.jsx');
    assert.match(modal, /REACT_APP_FORCE_DRAWN_SIGNATURES/);
    assert.match(modal, /return tabName === "draw"/);
  });

  it('keeps mobile layout and accessibility fixes plus upstream viewer guards', () => {
    const header = read('src/components/pdf/PdfHeader.jsx');
    assert.match(header, /aria-label="Back"/);
    assert.match(header, /!isViewerSigner/);
    assert.match(header, /finishLabel/);
    assert.match(read('src/pages/SignyourselfPdf.jsx'), /md:min-w-\[14rem\]/);
    assert.match(read('src/styles/signature.css'), /overflow: visible/);
  });

  it('keeps the billing route and login promo contract', () => {
    assert.match(read('src/App.jsx'), /path="\/billing"/);
    assert.match(read('src/pages/Login.jsx'), /loginWithSupabase/);
    assert.match(read('src/pages/Login.jsx'), /LEXY90/);
  });

  it('injects runtime env for Supabase', () => {
    assert.match(read('index.html'), /runtime-env\.js/);
    assert.match(read('docker-entrypoint.lexysign.sh'), /VITE_SUPABASE_URL/);
  });
});
