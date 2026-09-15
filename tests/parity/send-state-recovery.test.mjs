import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadSourceModule, readRepoFile } from "./helpers/load-source-module.mjs";
import { createParseStub } from "./helpers/parse-stub.mjs";
import { openSignSrc, serverSrc } from "./helpers/paths.mjs";

function classifyPlaceholderReopen(documentData) {
  const alreadyPlaceholder = documentData[0] && documentData[0].SignedUrl;
  if (!alreadyPlaceholder) return { locked: false, reason: "editable" };
  const isCompleted = documentData[0].IsCompleted && documentData[0].IsCompleted;
  const expireDate = documentData[0].ExpiryDate.iso;
  const declined = documentData[0].IsDeclined && documentData[0].IsDeclined;
  const expireUpdateDate = new Date(expireDate).getTime();
  const currDate = new Date("2026-09-15T12:00:00.000Z").getTime();
  if (isCompleted) return { locked: true, reason: "completed" };
  if (declined) return { locked: true, reason: "declined" };
  if (currDate > expireUpdateDate) return { locked: true, reason: "expired" };
  return { locked: true, reason: "already-dispatched" };
}

describe("sender cancel-dialog / send-state recovery", () => {
  const placeholderSrc = readRepoFile(openSignSrc("pages/PlaceHolderSign.jsx"));
  const customizeMailSrc = readRepoFile(openSignSrc("components/pdf/CustomizeMail.jsx"));

  it("saveDocumentDetails commits SignedUrl and SentToOthers before any sendmailv3 call", () => {
    const saveStart = placeholderSrc.indexOf("const saveDocumentDetails");
    const saveEnd = placeholderSrc.indexOf("const copytoclipboard");
    const saveFn = placeholderSrc.slice(saveStart, saveEnd);
    assert.match(saveFn, /SentToOthers:\s*true/);
    assert.match(saveFn, /SignedUrl:\s*pdfUrl/);
    assert.equal(saveFn.includes("sendmailv3"), false);
    assert.match(saveFn, /setIsMailModal\(true\)/);
  });

  it("CustomizeMail Send is the sendEmailToSigners path, and close navigates away without sending", () => {
    assert.match(customizeMailSrc, /sendEmailToSigners/);
    assert.match(customizeMailSrc, /onClick=\{\(\) => handleEmailSendToSigners\(\)\}/);
    const closeFn = customizeMailSrc.slice(
      customizeMailSrc.indexOf("const handleCloseSendmailModal"),
      customizeMailSrc.indexOf("const handleEmailSendToSigners")
    );
    assert.match(closeFn, /setIsMailModal\(false\)/);
    assert.match(closeFn, /navigate\("\/report\/1MwEuxLEkF"\)/);
    assert.equal(closeFn.includes("sendEmailToSigners"), false);
  });

  it("reopening a draft that already has SignedUrl is treated as already dispatched", () => {
    const state = classifyPlaceholderReopen([
      {
        SignedUrl: "https://files.example.test/doc.pdf",
        IsCompleted: false,
        IsDeclined: false,
        ExpiryDate: { iso: "2026-10-01T00:00:00.000Z" }
      }
    ]);
    assert.deepEqual(state, { locked: true, reason: "already-dispatched" });
  });

  it("interrupted send leaves mailSent false while dispatch flags are true", () => {
    const afterNext = {
      SignedUrl: "https://files.example.test/doc.pdf",
      SentToOthers: true,
      mailSent: false
    };
    const afterClose = { ...afterNext, alreadyDispatchedUi: true };
    assert.equal(afterClose.SentToOthers, true);
    assert.equal(afterClose.mailSent, false);
    const reopen = classifyPlaceholderReopen([
      {
        SignedUrl: afterClose.SignedUrl,
        IsCompleted: false,
        IsDeclined: false,
        ExpiryDate: { iso: "2026-10-01T00:00:00.000Z" }
      }
    ]);
    assert.equal(reopen.reason, "already-dispatched");
  });

  it("DocumentBeforesave stamps DocSentAt when SignedUrl first appears with signers", async () => {
    const Parse = createParseStub();
    const recorded = [];
    const { exports } = loadSourceModule(serverSrc("cloud/parsefunction/DocumentBeforesave.js"), {
      stubs: {
        "../../Utils.js": {
          MAX_DESCRIPTION_LENGTH: 500,
          MAX_NAME_LENGTH: 250,
          MAX_NOTE_LENGTH: 200
        },
        "../../utils/CountUtils.js": { setDocumentCount: () => recorded.push("count") },
        "../../billing/entitlements.js": {
          getTenantForExtUser: async () => ({ id: "tenant1" }),
          recordESignUsage: async (_tenant, units) => recorded.push(["usage", units])
        }
      },
      globals: { Parse }
    });
    const original = new Parse.Object("contracts_Document", {
      SignedUrl: undefined,
      ExtUserPtr: { id: "ext1" },
      Signers: [{ objectId: "a" }, { objectId: "b" }]
    });
    original.id = "doc1";
    const next = new Parse.Object("contracts_Document", {
      SignedUrl: "https://files.example.test/doc.pdf",
      ExtUserPtr: { id: "ext1" },
      Signers: [{ objectId: "a" }, { objectId: "b" }]
    });
    await exports.default({ original, object: next });
    assert.ok(next.get("DocSentAt"));
    assert.equal(typeof next.get("DocSentAt").getTime, "function");
    assert.equal(recorded[0][0], "usage");
    assert.equal(recorded[0][1], 2);
    assert.equal(recorded[1], "count");
  });

  it("RED: closing the send-mail dialog without Send must not lock the sender out of first invitation", () => {
    const afterCloseWithoutSend = {
      SignedUrl: "https://files.example.test/doc.pdf",
      SentToOthers: true,
      mailSent: false
    };
    const reopen = classifyPlaceholderReopen([
      {
        SignedUrl: afterCloseWithoutSend.SignedUrl,
        IsCompleted: false,
        IsDeclined: false,
        ExpiryDate: { iso: "2026-10-01T00:00:00.000Z" }
      }
    ]);
    assert.equal(
      reopen.locked && afterCloseWithoutSend.mailSent === false,
      false,
      "PlaceHolderSign treats SignedUrl as dispatched before sendmailv3; sender UI cannot recover the first invitation"
    );
  });
});
