import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadSourceModule, readRepoFile } from "./helpers/load-source-module.mjs";
import { sliceBetween } from "./helpers/extract-source.mjs";
import { createParseStub } from "./helpers/parse-stub.mjs";
import { openSignSrc, serverSrc } from "./helpers/paths.mjs";
import {
  isDispatchedLock,
  runCustomizeMailClose,
  runInterruptedSendSequence
} from "./helpers/send-state-harness.mjs";

describe("sender cancel-dialog / send-state recovery", () => {
  const placeholderSrc = readRepoFile(openSignSrc("pages/PlaceHolderSign.jsx"));
  const customizeMailSrc = readRepoFile(openSignSrc("components/pdf/CustomizeMail.jsx"));

  it("static: saveDocumentDetails PUT text includes SentToOthers before mail helpers", () => {
    const saveFn = sliceBetween(
      placeholderSrc,
      "const saveDocumentDetails = utils.withSessionValidation(async () => {",
      "\n  const copytoclipboard"
    );
    assert.match(saveFn, /SentToOthers:\s*true/);
    assert.match(saveFn, /SignedUrl:\s*pdfUrl/);
    assert.equal(saveFn.includes("sendmailv3"), false);
    assert.match(saveFn, /setIsMailModal\(true\)/);
  });

  it("extracted saveDocumentDetails commits SignedUrl and SentToOthers and opens the mail modal without sendmailv3", async () => {
    const observed = await runInterruptedSendSequence();
    assert.equal(observed.put.data.SentToOthers, true);
    assert.equal(observed.put.data.SignedUrl, "https://files.example.test/doc.pdf");
    assert.equal(observed.mailModalAfterSave, true);
    assert.match(observed.put.url, /contracts_Document\/doc1/);
  });

  it("extracted CustomizeMail close navigates away without sending mail", () => {
    const close = runCustomizeMailClose(customizeMailSrc);
    assert.equal(close.state.isMailModal, false);
    assert.equal(close.nav[0], "/report/1MwEuxLEkF");
  });

  it("extracted reopen after unsigned close is executable (baseline observation, not a lock gate)", async () => {
    const observed = await runInterruptedSendSequence();
    assert.ok(observed.put, "save PUT ran from extracted PlaceHolderSign source");
    assert.equal(observed.close.nav[0], "/report/1MwEuxLEkF");
    assert.ok(Array.isArray(observed.placed));
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

  it("RED: extracted close-without-send then reopen must not lock the sender out of first invitation", async () => {
    const observed = await runInterruptedSendSequence();
    assert.equal(
      isDispatchedLock(observed.placed),
      false,
      "PlaceHolderSign reopen treats SignedUrl as dispatched before sendmailv3"
    );
  });
});
