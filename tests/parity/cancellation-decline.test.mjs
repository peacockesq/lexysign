import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadSourceModule, readRepoFile } from "./helpers/load-source-module.mjs";
import { createParseStub } from "./helpers/parse-stub.mjs";
import { openSignSrc, serverSrc } from "./helpers/paths.mjs";

const UTILS_STUB = {
  appName: "LexySign",
  brandColor: "#d46b0f",
  brandEmailLogo: "<img/>",
  cloudServerUrl: "http://localhost:8080/app",
  serverAppId: "opensign"
};

function syntheticEnvelope(Parse, extra = {}) {
  const doc = new Parse.Object("contracts_Document", {
    IsEnableOTP: false,
    IsCompleted: false,
    IsArchive: false,
    Name: "synthetic-packet",
    CreatedBy: { objectId: "owner-1" },
    Placeholders: [
      {
        Role: "signer",
        email: "alpha@example.test",
        signerPtr: {
          Name: "Alpha",
          Email: "alpha@example.test",
          UserId: { objectId: "user-1" }
        }
      }
    ],
    ExtUserPtr: {
      objectId: "ext1",
      Name: "Sender",
      Email: "sender@example.test",
      UserId: { objectId: "owner-1" }
    },
    ...extra
  });
  doc.id = extra.objectId || extra.id || "doc-decline";
  return doc;
}

function loadDecline(Parse, mail) {
  return loadSourceModule(serverSrc("cloud/parsefunction/declinedocument.js"), {
    stubs: {
      "../../Utils.js": UTILS_STUB,
      "./sendSystemMail.js": async (req) => {
        mail.push(req.params);
        return { status: "success" };
      }
    },
    globals: { Parse, process }
  });
}

describe("cancellation / decline checks", () => {
  it("declinedoc requires docId", async () => {
    const Parse = createParseStub();
    const { exports } = loadDecline(Parse, []);
    await assert.rejects(
      () => exports.default({ params: {}, headers: {} }),
      (err) => {
        assert.equal(err.code, Parse.Error.SCRIPT_FAILED);
        assert.match(String(err.message), /missing parameter docId/);
        return true;
      }
    );
  });

  it("declines without OTP even when request.user is missing and sends owner mail via sendSystemMail", async () => {
    const Parse = createParseStub();
    const doc = syntheticEnvelope(Parse);
    Parse.records.contracts_Document = [doc];
    const mail = [];
    const errors = [];
    const originalError = console.log;
    console.log = (...args) => {
      if (String(args[0]).includes("err in sendnotifymail")) errors.push(args);
      else originalError(...args);
    };
    try {
      const { exports } = loadDecline(Parse, mail);
      const result = await exports.default({
        params: { docId: "doc-decline", reason: "not signing", userId: "user-1" },
        headers: { public_url: "https://sign.lexyalgo.com" }
      });
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(result, "document declined");
      assert.equal(doc.get("IsDeclined"), true);
      assert.equal(doc.get("DeclineReason"), "not signing");
      assert.equal(doc.get("DeclineBy").objectId, "user-1");
      assert.equal(errors.length, 0, "sendDeclineMail must not swallow a TypeError");
      assert.equal(mail.length, 1);
      assert.equal(mail[0].extUserId, "ext1");
      assert.equal(mail[0].from, "LexySign");
      assert.equal(mail[0].recipient, "sender@example.test");
      assert.equal(mail[0].pdfName, "synthetic-packet");
      assert.match(mail[0].subject, /declined by Alpha/);
      assert.match(mail[0].html, /not signing/);
      assert.match(mail[0].html, /sender@example.test/);
    } finally {
      console.log = originalError;
    }
  });

  it("OTP-enabled decline rejects an unauthenticated caller", async () => {
    const Parse = createParseStub();
    const doc = syntheticEnvelope(Parse, { IsEnableOTP: true, objectId: "doc-otp" });
    doc.id = "doc-otp";
    Parse.records.contracts_Document = [doc];
    const { exports } = loadDecline(Parse, []);
    await assert.rejects(
      () =>
        exports.default({
          params: { docId: "doc-otp", userId: "user-1" },
          headers: {},
          user: null
        }),
      (err) => err.code === Parse.Error.INVALID_SESSION_TOKEN
    );
    assert.equal(doc.get("IsDeclined"), undefined);
  });

  it("PdfRequestFiles still assigns pdfUrl before the declined branch (viewing is not revoked)", () => {
    const src = readRepoFile(openSignSrc("pages/PdfRequestFiles.jsx"));
    const loadChunk = src.slice(
      src.indexOf("if (documentData[0].SignedUrl)"),
      src.indexOf("else if (isNextUser)")
    );
    assert.match(loadChunk, /setPdfUrl\(documentData\[0\]\.SignedUrl\)/);
    assert.match(loadChunk, /setPdfUrl\(documentData\[0\]\.URL\)/);
    assert.match(loadChunk, /else if \(declined\)/);
    assert.match(loadChunk, /setIsDecline/);
    const urlAssignIndex = loadChunk.indexOf("setPdfUrl");
    const declineIndex = loadChunk.indexOf("else if (declined)");
    assert.ok(urlAssignIndex >= 0 && urlAssignIndex < declineIndex);
  });

  it("PdfRequestFiles declineDoc posts declinedoc with docId, reason, and userId", () => {
    const src = readRepoFile(openSignSrc("pages/PdfRequestFiles.jsx"));
    const fn = src.slice(src.indexOf("const declineDoc"), src.indexOf("const addDefaultSignature"));
    assert.match(fn, /functions\/declinedoc/);
    assert.match(fn, /docId:\s*pdfDetails\?\.\[0\]\.objectId/);
    assert.match(fn, /reason:\s*reason/);
    assert.match(fn, /userId:\s*userId/);
  });

  it("declinedocument rejects a completed envelope and does not mail the owner", async () => {
    const Parse = createParseStub();
    const doc = syntheticEnvelope(Parse, { IsCompleted: true, objectId: "doc-complete" });
    doc.id = "doc-complete";
    Parse.records.contracts_Document = [doc];
    const mail = [];
    const { exports } = loadDecline(Parse, mail);
    await assert.rejects(
      () =>
        exports.default({
          params: { docId: "doc-complete", reason: "too late", userId: "user-1" },
          headers: { public_url: "https://sign.lexyalgo.com" }
        }),
      (err) => err.code === Parse.Error.OBJECT_NOT_FOUND
    );
    assert.equal(doc.get("IsDeclined"), undefined);
    assert.equal(mail.length, 0);
  });
});
