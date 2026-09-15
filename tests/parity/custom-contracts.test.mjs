import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadSourceModule, readRepoFile } from "./helpers/load-source-module.mjs";
import { createMemoryStorage } from "./helpers/dom-stubs.mjs";
import { createParseStub } from "./helpers/parse-stub.mjs";
import { openSignSrc, serverSrc } from "./helpers/paths.mjs";

describe("custom LexySign auth / billing / DOCX contracts", () => {
  it("cloud main still registers loginWithSupabase and declinedoc", () => {
    const src = readRepoFile(serverSrc("cloud/main.js"));
    assert.match(src, /Parse\.Cloud\.define\('loginWithSupabase', loginWithSupabase\)/);
    assert.match(src, /Parse\.Cloud\.define\('declinedoc', declinedocument\)/);
    assert.match(src, /Parse\.Cloud\.beforeSave\('contracts_Document', DocumentBeforesave\)/);
  });

  it("customApp still mounts /docxtopdf and /billing", () => {
    const src = readRepoFile(serverSrc("cloud/customRoute/customApp.js"));
    assert.match(src, /app\.post\('\/docxtopdf'/);
    assert.match(src, /app\.use\('\/billing', billingRouter\)/);
  });

  it("frontend still routes /billing and uses supabase login when enabled", () => {
    const appSrc = readRepoFile(openSignSrc("App.jsx"));
    const loginSrc = readRepoFile(openSignSrc("pages/Login.jsx"));
    assert.match(appSrc, /path="\/billing"/);
    assert.match(loginSrc, /isSupabaseAuthEnabled/);
    assert.match(loginSrc, /loginWithSupabase/);
    assert.match(loginSrc, /signInWithPassword/);
  });

  it("Form.jsx still posts DOCX uploads to /docxtopdf via removeTrailingSegment(baseUrl)", () => {
    const formSrc = readRepoFile(openSignSrc("pages/Form.jsx"));
    assert.match(formSrc, /\.docx/);
    assert.match(formSrc, /removeTrailingSegment\(baseApi\) \+ "\/docxtopdf"/);
  });

  it("persistSupabaseSession writes the LexySign token keys", () => {
    const storage = createMemoryStorage();
    const { exports } = loadSourceModule(openSignSrc("auth/supabaseAuth.js"), {
      globals: {
        window: { RUNTIME_ENV: {} },
        localStorage: storage,
        fetch: async () => ({ ok: true, json: async () => ({}) })
      }
    });
    exports.persistSupabaseSession({
      access_token: "tok_abc",
      refresh_token: "ref_abc",
      expires_at: 123
    });
    assert.equal(storage.getItem("lexysign_supabase_access_token"), "tok_abc");
    assert.equal(storage.getItem("lexysign_supabase_refresh_token"), "ref_abc");
    exports.clearSupabaseSession();
    assert.equal(storage.getItem("lexysign_supabase_access_token"), null);
  });

  it("isSupabaseAuthEnabled is false without both URL and anon key", () => {
    const storage = createMemoryStorage();
    const { exports } = loadSourceModule(openSignSrc("auth/supabaseAuth.js"), {
      globals: {
        window: { RUNTIME_ENV: {} },
        localStorage: storage,
        importMetaEnv: {}
      }
    });
    assert.equal(exports.isSupabaseAuthEnabled(), false);
  });

  it("signInWithPassword posts grant_type=password and does not call a public login URL", async () => {
    const calls = [];
    const storage = createMemoryStorage();
    const { exports } = loadSourceModule(openSignSrc("auth/supabaseAuth.js"), {
      globals: {
        window: {
          RUNTIME_ENV: {
            VITE_SUPABASE_URL: "https://auth.example.test",
            VITE_SUPABASE_ANON_KEY: "anon-key"
          }
        },
        localStorage: storage,
        importMetaEnv: {},
        fetch: async (url, init) => {
          calls.push({ url, init });
          return {
            ok: true,
            json: async () => ({ access_token: "session" })
          };
        }
      }
    });
    const session = await exports.signInWithPassword("user@example.test", "secret");
    assert.equal(session.access_token, "session");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://auth.example.test/auth/v1/token?grant_type=password");
    assert.equal(calls[0].init.method, "POST");
    assert.equal(JSON.parse(calls[0].init.body).email, "user@example.test");
  });

  it("subscriptionIsActive and monthly limit defaults are LexySign billing contracts", () => {
    const { exports } = loadSourceModule(serverSrc("billing/stripeClient.js"), {
      stubs: { stripe: class Stripe {} },
      globals: { process }
    });
    assert.equal(exports.subscriptionIsActive("active"), true);
    assert.equal(exports.subscriptionIsActive("trialing"), true);
    assert.equal(exports.subscriptionIsActive("canceled"), false);
    assert.equal(exports.getMonthlyESignLimit(), 1000);
  });

  it("assertCanUseESignUnits blocks inactive tenants and over-limit usage", async () => {
    const Parse = createParseStub();
    const tenant = new Parse.Object("partners_Tenant", {
      SubscriptionStatus: "none",
      MonthlyESignLimit: 2
    });
    tenant.id = "t1";
    const ledger = new Parse.Object("billing_UsageLedger", {
      TenantId: { __type: "Pointer", className: "partners_Tenant", objectId: "t1" },
      PeriodKey: "2026-09",
      Used: 0,
      Limit: 2
    });
    ledger.id = "l1";
    Parse.records.billing_UsageLedger = [ledger];
    const { exports } = loadSourceModule(serverSrc("billing/entitlements.js"), {
      stubs: {
        "./stripeClient.js": {
          getMonthlyESignLimit: () => 1000,
          subscriptionIsActive: (status) => ["active", "trialing"].includes(status)
        }
      },
      globals: { Parse }
    });
    ledger.set("PeriodKey", exports.getPeriodKey());
    await assert.rejects(
      () => exports.assertCanUseESignUnits(tenant, 1),
      (err) => /active LexySign subscription is required/i.test(err.message)
    );
    tenant.set("SubscriptionStatus", "active");
    ledger.set("Used", 2);
    await assert.rejects(
      () => exports.assertCanUseESignUnits(tenant, 1),
      (err) => /Monthly LexySign e-sign limit reached/i.test(err.message)
    );
  });

  it("billingBaseUrl maps Parse /app base onto /billing", () => {
    const billingSrc = readRepoFile(openSignSrc("pages/Billing.jsx"));
    const fn = billingSrc.slice(
      billingSrc.indexOf("function billingBaseUrl"),
      billingSrc.indexOf("function authHeaders")
    );
    const billingBaseUrl = new Function(
      "localStorage",
      `${fn}\nreturn billingBaseUrl();`
    );
    const storage = createMemoryStorage();
    storage.setItem("baseUrl", "https://sign.lexyalgo.com/api/app/");
    assert.equal(billingBaseUrl(storage), "https://sign.lexyalgo.com/api/billing");
  });

  it("docx upload filter accepts only .docx and docxtopdf rejects a missing file", async () => {
    let fileFilter;
    const { exports } = loadSourceModule(serverSrc("cloud/customRoute/docxtopdf.js"), {
      stubs: {
        axios: {},
        multer: Object.assign(
          (opts) => {
            fileFilter = opts.fileFilter;
            return { single: () => "middleware" };
          },
          { memoryStorage: () => "memory" }
        ),
        "libreoffice-convert": { convert: () => {} },
        "child_process": { exec: () => {} },
        util: { promisify: (fn) => fn },
        "../../Utils.js": {
          cloudServerUrl: "http://localhost:8080/app",
          getSecureUrl: (url) => ({ url }),
          serverAppId: "opensign"
        }
      },
      globals: { process, Buffer }
    });
    const accepted = await new Promise((resolve) =>
      fileFilter(
        {},
        {
          originalname: "packet.docx",
          mimetype: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        },
        (_err, ok) => resolve(ok)
      )
    );
    const rejected = await new Promise((resolve) =>
      fileFilter({}, { originalname: "packet.pdf", mimetype: "application/pdf" }, (err) =>
        resolve(err)
      )
    );
    assert.equal(accepted, true);
    assert.match(String(rejected), /Only \.docx files are supported/);

    const res = {
      statusCode: 0,
      body: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        this.body = payload;
        return this;
      }
    };
    await exports.default({ file: null, headers: {} }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, "No file uploaded.");
  });

  it("withTimeout fails expired work without hanging", async () => {
    const { exports } = loadSourceModule(serverSrc("cloud/customRoute/docxtopdf.js"), {
      stubs: {
        axios: {},
        multer: Object.assign(() => ({ single: () => "middleware" }), {
          memoryStorage: () => "memory"
        }),
        "libreoffice-convert": { convert: () => {} },
        "child_process": { exec: async () => ({}) },
        util: { promisify: (fn) => fn },
        "../../Utils.js": {
          cloudServerUrl: "http://localhost:8080/app",
          getSecureUrl: (url) => ({ url }),
          serverAppId: "opensign"
        }
      },
      globals: { process, Buffer }
    });
    await assert.rejects(
      () =>
        exports.withTimeout(
          new Promise(() => {}),
          20,
          "DOCX->PDF"
        ),
      /timed out after 20ms/
    );
  });

  it("loginWithSupabase refuses a missing access token before any network call", async () => {
    const Parse = createParseStub();
    let fetched = false;
    const { exports } = loadSourceModule(serverSrc("cloud/parsefunction/loginWithSupabase.js"), {
      stubs: {
        axios: {
          get: async () => {
            fetched = true;
            return { data: {} };
          }
        },
        "node:crypto": { randomBytes: () => Buffer.from("abc") },
        "../../Utils.js": {
          cloudServerUrl: "http://localhost:8080/app",
          serverAppId: "opensign"
        }
      },
      globals: { Parse, process, Buffer }
    });
    process.env.SUPABASE_URL = "https://auth.example.test";
    process.env.SUPABASE_ANON_KEY = "anon";
    await assert.rejects(
      () => exports.default({ params: { accessToken: "" } }),
      (err) => err.code === Parse.Error.SESSION_MISSING
    );
    assert.equal(fetched, false);
  });

  it("embedDocId brands pages as LexySign DocumentId", () => {
    const utilsSrc = readRepoFile(openSignSrc("constant/Utils.js"));
    assert.match(utilsSrc, /const appName = "LexySign"/);
    assert.match(utilsSrc, /\$\{appName\} DocumentId: \$\{documentId\}/);
    const pdfSrc = readRepoFile(serverSrc("cloud/parsefunction/pdf/PDF.js"));
    assert.match(pdfSrc, /const eSignName = 'LexySign'/);
    assert.match(pdfSrc, /support@lexyalgo.com/);
  });
});
