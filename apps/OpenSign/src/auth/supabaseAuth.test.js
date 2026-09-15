import { afterEach, describe, expect, it } from "vitest";
import {
  clearSupabaseSession,
  isSupabaseAuthEnabled,
  persistSupabaseSession
} from "./supabaseAuth";

describe("LexySign Supabase auth bridge", () => {
  afterEach(() => {
    localStorage.clear();
    delete window.RUNTIME_ENV;
  });

  it("is disabled without runtime or build-time Supabase config", () => {
    window.RUNTIME_ENV = {};
    expect(isSupabaseAuthEnabled()).toBe(false);
  });

  it("is enabled when runtime env supplies URL and anon key", () => {
    window.RUNTIME_ENV = {
      VITE_SUPABASE_URL: "https://example.supabase.co",
      VITE_SUPABASE_ANON_KEY: "anon-key"
    };
    expect(isSupabaseAuthEnabled()).toBe(true);
  });

  it("persists and clears the LexySign session keys", () => {
    persistSupabaseSession({
      access_token: "access",
      refresh_token: "refresh",
      expires_at: 123
    });
    expect(localStorage.getItem("lexysign_supabase_access_token")).toBe("access");
    expect(localStorage.getItem("lexysign_supabase_refresh_token")).toBe("refresh");
    expect(localStorage.getItem("lexysign_supabase_expires_at")).toBe("123");
    clearSupabaseSession();
    expect(localStorage.getItem("lexysign_supabase_access_token")).toBeNull();
  });
});
