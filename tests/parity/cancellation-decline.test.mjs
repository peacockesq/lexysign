import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadSourceModule, readRepoFile } from "./helpers/load-source-module.mjs";
import { createParseStub } from "./helpers/parse-stub.mjs";
import { openSignSrc, serverSrc } from "./helpers/paths.mjs";

function signerViewState(documentData, now = new Date("2026-09-15T12:00:00.000Z")) {
  const isCompleted = documentData[0].IsCompleted && documentData[0].IsCompleted;
  const expireDate = documentData[0]?.ExpiryDate?.iso;
  const declined = documentData[0].IsDeclined && documentData[0].IsDeclined;
  const expireUpdateDate = new Date(expireDate).getTime();
  const currDate = now.getTime();
  const pdfUrl = documentData[0].SignedUrl || documentData[0].URL;
  if (isCompleted) return { pdfUrl, canSign: false, reason: "completed" };
  if (declined) return { pdfUrl, canSign: false, reason: "declined" };
  if (currDate > expireUpdateDate) return { pdfUrl, canSign: false, reason: "expired" };
  return { pdfUrl, canSign: true, reason: "open" };
}

describe("cancellation / decline checks", () => {
  it("declinedoc requires docId", async () => {
    const Parse = createParseStub();
    const { exports } = loadSourceModule(serverSrc("cloud/parsefunction/declinedocument.js"), {
      stubs: {
        axios: { post: async () => ({}) },
        "../../Utils.js": {
          appName: "LexySign",
          brandColor: "#d46b0f",
          brandEmailLogo: "<img/>",
          cloudServerUrl: "http://localhost:8080/app",
          serverAppId: "opensign"
        }
      },
      globals: { Parse, process }
    });
    await assert.rejects(
      () => exports.default({ params: {}, headers: {} }),
      (err) => {
        assert.equal(err.code, Parse.Error.SCRIPT_FAILED);
        assert.match(String(err.message), /missing parameter docId/);
        return true;
      }
    );
  });

  it("declines without OTP even when request.user is missing", async () => {
    const Parse = createParseStub();
    const doc = new Parse.Object("contracts_Document", {
      IsEnableOTP: false,
      Name: "synthetic",
      Placeholders: [],
      ExtUserPtr: { Name: "Sender", Email: "sender@example.test", objectId: "ext1" }
    });
    doc.id = "doc-decline";
    Parse.records.contracts_Document = [doc];
    const mail = [];
    const { exports } = loadSourceModule(serverSrc("cloud/parsefunction/declinedocument.js"), {
      stubs: {
        axios: { post: async (_url, params) => mail.push(params) },
        "../../Utils.js": {
          appName: "LexySign",
          brandColor: "#d46b0f",
          brandEmailLogo: "<img/>",
          cloudServerUrl: "http://localhost:8080/app",
          serverAppId: "opensign"
        }
      },
      globals: { Parse, process }
    });
    const result = await exports.default({
      params: { docId: "doc-decline", reason: "not signing", userId: "user-1" },
      headers: { public_url: "https://sign.lexyalgo.com" }
    });
    assert.equal(result, "document declined");
    assert.equal(doc.get("IsDeclined"), true);
    assert.equal(doc.get("DeclineReason"), "not signing");
    assert.equal(doc.get("DeclineBy").objectId, "user-1");
  });

  it("OTP-enabled decline rejects an unauthenticated caller", async () => {
    const Parse = createParseStub();
    const doc = new Parse.Object("contracts_Document", { IsEnableOTP: true });
    doc.id = "doc-otp";
    Parse.records.contracts_Document = [doc];
    const { exports } = loadSourceModule(serverSrc("cloud/parsefunction/declinedocument.js"), {
      stubs: {
        axios: { post: async () => ({}) },
        "../../Utils.js": {
          appName: "LexySign",
          brandColor: "#d46b0f",
          brandEmailLogo: "<img/>",
          cloudServerUrl: "http://localhost:8080/app",
          serverAppId: "opensign"
        }
      },
      globals: { Parse, process }
    });
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

  it("signer UI still receives the PDF URL after decline (viewing is not revoked)", () => {
    const state = signerViewState([
      {
        URL: "https://files.example.test/original.pdf",
        SignedUrl: "https://files.example.test/partial.pdf",
        IsDeclined: true,
        IsCompleted: false,
        ExpiryDate: { iso: "2026-10-01T00:00:00.000Z" }
      }
    ]);
    assert.equal(state.canSign, false);
    assert.equal(state.reason, "declined");
    assert.equal(state.pdfUrl, "https://files.example.test/partial.pdf");
  });

  it("PdfRequestFiles declineDoc posts declinedoc with docId, reason, and userId", () => {
    const src = readRepoFile(openSignSrc("pages/PdfRequestFiles.jsx"));
    const fn = src.slice(src.indexOf("const declineDoc"), src.indexOf("const addDefaultSignature"));
    assert.match(fn, /functions\/declinedoc/);
    assert.match(fn, /docId:\s*pdfDetails\?\.\[0\]\.objectId/);
    assert.match(fn, /reason:\s*reason/);
    assert.match(fn, /userId:\s*userId/);
  });

  it("RED: declinedocument should refuse an already completed envelope", async () => {
    const Parse = createParseStub();
    const doc = new Parse.Object("contracts_Document", {
      IsEnableOTP: false,
      IsCompleted: true,
      Name: "done",
      Placeholders: [],
      ExtUserPtr: { Name: "Sender", Email: "sender@example.test", objectId: "ext1" }
    });
    doc.id = "doc-complete";
    Parse.records.contracts_Document = [doc];
    const { exports } = loadSourceModule(serverSrc("cloud/parsefunction/declinedocument.js"), {
      stubs: {
        axios: { post: async () => ({}) },
        "../../Utils.js": {
          appName: "LexySign",
          brandColor: "#d46b0f",
          brandEmailLogo: "<img/>",
          cloudServerUrl: "http://localhost:8080/app",
          serverAppId: "opensign"
        }
      },
      globals: { Parse, process }
    });
    await assert.rejects(
      () =>
        exports.default({
          params: { docId: "doc-complete", reason: "too late", userId: "user-1" },
          headers: { public_url: "https://sign.lexyalgo.com" }
        }),
      /completed|already/i
    );
  });
});
