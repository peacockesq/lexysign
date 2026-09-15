import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

const store = new Map();
globalThis.localStorage = {
  getItem: key => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => {
    store.set(key, String(value));
  },
  removeItem: key => {
    store.delete(key);
  },
  clear: () => {
    store.clear();
  },
};
globalThis.window = { RUNTIME_ENV: {} };

const {
  clearSupabaseSession,
  isSupabaseAuthEnabled,
  persistSupabaseSession,
} = await import('../src/auth/supabaseAuth.js');

describe('LexySign Supabase auth bridge', () => {
  afterEach(() => {
    store.clear();
    globalThis.window.RUNTIME_ENV = {};
  });

  it('is disabled without runtime Supabase config', () => {
    assert.equal(isSupabaseAuthEnabled(), false);
  });

  it('is enabled when runtime env supplies URL and anon key', () => {
    globalThis.window.RUNTIME_ENV = {
      VITE_SUPABASE_URL: 'https://example.supabase.co',
      VITE_SUPABASE_ANON_KEY: 'anon-key',
    };
    assert.equal(isSupabaseAuthEnabled(), true);
  });

  it('persists and clears the LexySign session keys', () => {
    persistSupabaseSession({
      access_token: 'access',
      refresh_token: 'refresh',
      expires_at: 123,
    });
    assert.equal(store.get('lexysign_supabase_access_token'), 'access');
    assert.equal(store.get('lexysign_supabase_refresh_token'), 'refresh');
    assert.equal(store.get('lexysign_supabase_expires_at'), '123');
    clearSupabaseSession();
    assert.equal(store.has('lexysign_supabase_access_token'), false);
  });
});
