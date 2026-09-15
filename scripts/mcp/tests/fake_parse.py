from __future__ import annotations

import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, urlparse


def pointer(class_name: str, object_id: str) -> dict:
    return {"__type": "Pointer", "className": class_name, "objectId": object_id}


def pid(value: Any) -> str:
    if not value:
        return ""
    if isinstance(value, str):
        return value
    return str(value.get("objectId") or "")


PRINCIPAL = {
    "user": "userPrincipal",
    "ext": "extPrincipal",
    "tenant": "tenantPrincipal",
    "email": "attorney@peacock.example",
    "token": "r:valid-session",
}
FOREIGN = {
    "user": "userForeign",
    "ext": "extForeign",
    "tenant": "tenantForeign",
    "email": "other@example.com",
    "token": "r:foreign-session",
}

LETTER_PDF = (
    b"%PDF-1.4\n"
    b"1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n"
    b"2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n"
    b"3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >> endobj\n"
    b"xref\n0 4\n0000000000 65535 f \ntrailer << /Size 4 /Root 1 0 R >>\nstartxref\n0\n%%EOF\n"
)


class FakeParse:
    def __init__(self) -> None:
        self.files: dict[str, bytes] = {"seed.pdf": LETTER_PDF, "signed.pdf": LETTER_PDF, "cert.pdf": LETTER_PDF}
        self.users = {
            PRINCIPAL["token"]: {
                "objectId": PRINCIPAL["user"],
                "email": PRINCIPAL["email"],
                "sessionToken": PRINCIPAL["token"],
            },
            FOREIGN["token"]: {
                "objectId": FOREIGN["user"],
                "email": FOREIGN["email"],
                "sessionToken": FOREIGN["token"],
            },
        }
        self.ext_users = [
            {
                "objectId": PRINCIPAL["ext"],
                "Email": PRINCIPAL["email"],
                "Name": "Firm Attorney",
                "UserId": pointer("_User", PRINCIPAL["user"]),
                "TenantId": {"objectId": PRINCIPAL["tenant"], "__type": "Pointer", "className": "partners_Tenant"},
            },
            {
                "objectId": FOREIGN["ext"],
                "Email": FOREIGN["email"],
                "Name": "Other Tenant",
                "UserId": pointer("_User", FOREIGN["user"]),
                "TenantId": {"objectId": FOREIGN["tenant"], "__type": "Pointer", "className": "partners_Tenant"},
            },
        ]
        self.contacts: list[dict] = [
            {
                "objectId": "contact-1",
                "Name": "Client One",
                "Email": "client@example.com",
                "CreatedBy": pointer("_User", PRINCIPAL["user"]),
                "TenantId": pointer("partners_Tenant", PRINCIPAL["tenant"]),
                "IsDeleted": False,
                "className": "contracts_Contactbook",
            }
        ]
        now = "2026-09-15T12:00:00.000Z"
        future = "2026-12-01T00:00:00.000Z"
        past = "2020-01-01T00:00:00.000Z"
        self.documents: dict[str, dict] = {
            "doc-owned-draft": self._doc(
                "doc-owned-draft",
                PRINCIPAL,
                name="Draft Retainer",
                signed=False,
                expiry=future,
                updated=now,
            ),
            "doc-owned-sent": self._doc(
                "doc-owned-sent",
                PRINCIPAL,
                name="Sent Packet",
                signed=True,
                expiry=future,
                updated=now,
            ),
            "doc-completed": self._doc(
                "doc-completed",
                PRINCIPAL,
                name="Completed Packet",
                signed=True,
                completed=True,
                expiry=future,
                updated=now,
                certificate=True,
            ),
            "doc-declined": self._doc(
                "doc-declined",
                PRINCIPAL,
                name="Declined Packet",
                declined=True,
                expiry=future,
                updated=now,
            ),
            "doc-expired": self._doc(
                "doc-expired",
                PRINCIPAL,
                name="Expired Packet",
                expiry=past,
                updated=now,
            ),
            "doc-foreign": self._doc(
                "doc-foreign",
                FOREIGN,
                name="Other Tenant Doc",
                expiry=future,
                updated=now,
            ),
            "doc-signer-only": self._doc(
                "doc-signer-only",
                FOREIGN,
                name="Signer Only",
                expiry=future,
                updated=now,
                extra_signers=[pointer("contracts_Users", PRINCIPAL["ext"])],
            ),
            "doc-hang": self._doc(
                "doc-hang",
                PRINCIPAL,
                name="Hang Packet",
                expiry=future,
                updated=now,
            ),
        }
        self.hang = False
        self.send_mode_force: str | None = None
        self.created = 0
        self.reservations: dict[str, str] = {}
        self.approval_ids: set[str] = set()

    def _doc(
        self,
        object_id: str,
        owner: dict,
        *,
        name: str,
        expiry: str,
        updated: str,
        signed: bool = False,
        completed: bool = False,
        declined: bool = False,
        certificate: bool = False,
        extra_signers: list | None = None,
    ) -> dict:
        signers = [
            {
                "objectId": "contact-1",
                "Email": "client@example.com",
                "Name": "Client One",
                "UserId": pointer("_User", "userSigner"),
                "CreatedBy": pointer("_User", owner["user"]),
                "TenantId": pointer("partners_Tenant", owner["tenant"]),
                "IsDeleted": False,
                "className": "contracts_Contactbook",
            }
        ]
        if extra_signers:
            signers.extend(extra_signers)
        url = f"__BASE__/files/seed.pdf"
        placeholders = [
            {
                "Id": "s1",
                "Role": "client",
                "signerObjId": "contact-1",
                "signerPtr": pointer("contracts_Contactbook", "contact-1"),
                "placeHolder": [
                    {
                        "pageNumber": 1,
                        "pos": [
                            {
                                "type": "signature",
                                "key": 1,
                                "xPosition": 72,
                                "yPosition": 100,
                                "Width": 180,
                                "Height": 38,
                            }
                        ],
                    }
                ],
            }
        ]
        return {
            "objectId": object_id,
            "Name": name,
            "URL": url,
            "SignedUrl": url if signed or completed else None,
            "CertificateUrl": f"__BASE__/files/cert.pdf" if certificate else None,
            "CreatedBy": pointer("_User", owner["user"]),
            "ExtUserPtr": {
                "objectId": owner["ext"],
                "__type": "Pointer",
                "className": "contracts_Users",
                "TenantId": {"objectId": owner["tenant"], "__type": "Pointer", "className": "partners_Tenant"},
            },
            "Signers": signers,
            "Placeholders": placeholders,
            "IsCompleted": completed,
            "IsDeclined": declined,
            "IsArchive": False,
            "SendinOrder": False,
            "TimeToCompleteDays": 15,
            "ExpiryDate": {"__type": "Date", "iso": expiry},
            "updatedAt": updated,
            "AuditTrail": (
                [{"Activity": "Signed", "UserPtr": {"Email": "client@example.com"}, "SignedOn": updated}]
                if completed
                else []
            ),
        }

    def rewrite_base(self, base: str) -> None:
        for doc in self.documents.values():
            for key in ("URL", "SignedUrl", "CertificateUrl"):
                if isinstance(doc.get(key), str) and doc[key].startswith("__BASE__"):
                    doc[key] = doc[key].replace("__BASE__", base)

    def user_for(self, token: str) -> dict | None:
        return self.users.get(token)


class FakeParseHandler(BaseHTTPRequestHandler):
    server_version = "FakeParse/1.0"

    def log_message(self, format: str, *args: Any) -> None:
        return

    @property
    def store(self) -> FakeParse:
        return self.server.store  # type: ignore[attr-defined]

    def _token(self) -> str:
        return self.headers.get("X-Parse-Session-Token") or ""

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return {}
        return json.loads(self.rfile.read(length).decode("utf-8") or "{}")

    def _send(self, code: int, payload: Any, headers: dict | None = None) -> None:
        body = json.dumps(payload).encode("utf-8") if not isinstance(payload, (bytes, bytearray)) else payload
        self.send_response(code)
        if isinstance(payload, (bytes, bytearray)):
            self.send_header("Content-Type", "application/pdf")
        else:
            self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def _auth(self) -> dict | None:
        user = self.store.user_for(self._token())
        if not user:
            self._send(209, {"code": 209, "error": "Invalid session token"})
            return None
        return user

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path
        if path.startswith("/files/"):
            query = parse_qs(parsed.query)
            if not query.get("token"):
                self._send(400, {"message": "unauthorized"})
                return
            name = path.rsplit("/", 1)[-1]
            data = self.store.files.get(name)
            if data is None:
                self._send(404, {"error": "not found"})
                return
            self._send(200, data)
            return
        user = self._auth()
        if user is None:
            return
        if path == "/users/me":
            self._send(200, user)
            return
        if path.startswith("/classes/"):
            self._handle_get_class(path, parse_qs(parsed.query), user)
            return
        self._send(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path
        user = self._auth()
        if user is None:
            return
        if path.startswith("/files/"):
            name = path.rsplit("/", 1)[-1]
            length = int(self.headers.get("Content-Length") or 0)
            data = self.rfile.read(length)
            self.store.files[name] = data
            host = self.headers.get("Host")
            url = f"http://{host}/files/{name}"
            self._send(201, {"url": url, "name": name})
            return
        if path.startswith("/functions/"):
            self._handle_function(path.rsplit("/", 1)[-1], self._read_json(), user)
            return
        self._send(404, {"error": "not found"})

    def do_PUT(self) -> None:  # noqa: N802
        user = self._auth()
        if user is None:
            return
        parsed = urlparse(self.path)
        parts = parsed.path.strip("/").split("/")
        if len(parts) == 3 and parts[0] == "classes" and parts[1] == "contracts_Document":
            body = self._read_json()
            doc = self.store.documents.get(parts[2])
            if not doc:
                self._send(404, {"error": "not found"})
                return
            doc.update(body)
            self._send(200, {"updatedAt": "2026-09-15T12:00:00.000Z"})
            return
        self._send(404, {"error": "not found"})

    def _handle_get_class(self, path: str, query: dict, user: dict) -> None:
        parts = path.strip("/").split("/")
        where = json.loads((query.get("where") or ["{}"])[0])
        include = (query.get("include") or [""])[0]
        if parts[1] == "contracts_Users":
            results = []
            for item in self.store.ext_users:
                if where.get("objectId") and item["objectId"] != where["objectId"]:
                    continue
                if where.get("UserId") and pid(item.get("UserId")) != pid(where.get("UserId")):
                    continue
                results.append(item)
            self._send(200, {"results": results})
            return
        if parts[1] == "contracts_Contactbook":
            if len(parts) == 3:
                for item in self.store.contacts:
                    if item["objectId"] == parts[2]:
                        self._send(200, item)
                        return
                self._send(404, {"error": "not found"})
                return
            results = []
            for item in self.store.contacts:
                if where.get("Email") and item.get("Email") != where["Email"]:
                    continue
                if where.get("CreatedBy") and pid(item.get("CreatedBy")) != pid(where.get("CreatedBy")):
                    continue
                if where.get("TenantId") and pid(item.get("TenantId")) != pid(where.get("TenantId")):
                    continue
                if item.get("IsDeleted") is True:
                    continue
                results.append(item)
            self._send(200, {"results": results})
            return
        if parts[1] == "contracts_Document":
            if len(parts) == 3:
                doc = self.store.documents.get(parts[2])
                if not doc:
                    self._send(404, {"error": "not found"})
                    return
                self._send(200, doc)
                return
            results = []
            skip = int((query.get("skip") or ["0"])[0])
            limit = int((query.get("limit") or ["100"])[0])
            matched = []
            for doc in self.store.documents.values():
                if not _where_match(doc, where):
                    continue
                matched.append(doc)
            self._send(200, {"results": matched[skip : skip + limit]})
            return
        self._send(404, {"error": "not found"})

    def _handle_function(self, name: str, params: dict, user: dict) -> None:
        if name == "createdocumentfromapp":
            self.store.created += 1
            object_id = f"doc-created-{self.store.created}"
            doc = params.get("document") or {}
            stored = {
                "objectId": object_id,
                **doc,
                "ExtUserPtr": {
                    **(doc.get("ExtUserPtr") or {}),
                    "TenantId": {"objectId": PRINCIPAL["tenant"], "__type": "Pointer", "className": "partners_Tenant"},
                },
                "Signers": [
                    {
                        "objectId": pid(item) or "contact-1",
                        "Email": "client@example.com",
                        "Name": "Client One",
                        "CreatedBy": pointer("_User", PRINCIPAL["user"]),
                        "TenantId": pointer("partners_Tenant", PRINCIPAL["tenant"]),
                        "IsDeleted": False,
                        "className": "contracts_Contactbook",
                    }
                    for item in (doc.get("Signers") or [pointer("contracts_Contactbook", "contact-1")])
                ],
                "Placeholders": doc.get("Placeholders") or [],
                "SendinOrder": bool(doc.get("SendinOrder")),
                "TimeToCompleteDays": int(doc.get("TimeToCompleteDays") or 15),
                "IsCompleted": False,
                "IsDeclined": False,
                "IsArchive": False,
                "updatedAt": "2026-09-15T12:00:00.000Z",
                "ExpiryDate": {"__type": "Date", "iso": "2026-12-01T00:00:00.000Z"},
            }
            if pid(stored.get("CreatedBy")) == PRINCIPAL["user"]:
                stored["ExtUserPtr"]["objectId"] = PRINCIPAL["ext"]
            self.store.documents[object_id] = stored
            self._send(200, {"result": stored})
            return
        if name == "savecontact":
            email = str(params.get("email") or "").lower()
            object_id = f"contact-{len(self.store.contacts) + 1}"
            item = {
                "objectId": object_id,
                "Name": params.get("name"),
                "Email": email,
                "CreatedBy": pointer("_User", user["objectId"]),
                "TenantId": pointer("partners_Tenant", params.get("tenantId") or PRINCIPAL["tenant"]),
                "IsDeleted": False,
                "className": "contracts_Contactbook",
            }
            self.store.contacts.append(item)
            self._send(200, {"result": item})
            return
        if name == "generatecertificate":
            doc = self.store.documents.get(params.get("docId"))
            if not doc or not doc.get("IsCompleted"):
                self._send(400, {"code": 400, "error": "not completed"})
                return
            host = self.headers.get("Host")
            url = f"http://{host}/files/cert.pdf"
            doc["CertificateUrl"] = url
            self._send(200, {"result": {"CertificateUrl": url}})
            return
        if name == "lexysignFirmAcquireFile":
            self._acquire_file(params, user)
            return
        if name == "lexysignFirmSendInvitations":
            self._send_invitations(params, user)
            return
        self._send(404, {"code": 141, "error": f"Invalid function: {name}"})

    def _capability(self, url: str) -> str:
        clean = str(url or "").split("?")[0]
        return f"{clean}?token=firm-file-token"

    def _acquire_file(self, params: dict, user: dict) -> None:
        document_id = params.get("documentId")
        kind = params.get("kind")
        doc = self.store.documents.get(document_id)
        if user["objectId"] != PRINCIPAL["user"]:
            self._send(403, {"code": 119, "error": "foreign_document: not owned"})
            return
        if not doc:
            self._send(400, {"code": 102, "error": "missing: not found"})
            return
        if pid(doc.get("CreatedBy")) != PRINCIPAL["user"] or pid(doc.get("ExtUserPtr")) != PRINCIPAL["ext"]:
            self._send(403, {"code": 119, "error": "foreign_document: not owned"})
            return
        stored = ""
        if kind == "source":
            stored = doc.get("URL") or ""
        elif kind == "signed":
            stored = doc.get("SignedUrl") or (doc.get("URL") if doc.get("IsCompleted") else "")
        elif kind == "certificate":
            stored = doc.get("CertificateUrl") or ""
        else:
            self._send(400, {"code": 102, "error": "invalid_parameter: kind"})
            return
        if not stored:
            self._send(400, {"code": 102, "error": "missing_url: requested document file is missing."})
            return
        self._send(200, {"result": {"url": self._capability(stored), "kind": kind, "source": "document"}})

    def _send_invitations(self, params: dict, user: dict) -> None:
        import hashlib
        import hmac
        import json
        import os

        document_id = params.get("documentId")
        if document_id == "doc-hang" or self.store.hang:
            time.sleep(2.5)
        doc = self.store.documents.get(document_id)
        principal_ok = user["objectId"] == PRINCIPAL["user"]
        if not principal_ok:
            self._send(403, {"code": 119, "error": "foreign_document: not owned"})
            return
        if not doc:
            self._send(400, {"code": 102, "error": "missing: not found"})
            return
        if pid(doc.get("CreatedBy")) != PRINCIPAL["user"] or pid(doc.get("ExtUserPtr")) != PRINCIPAL["ext"]:
            self._send(403, {"code": 119, "error": "foreign_document: not owned"})
            return
        if doc.get("IsCompleted") or doc.get("IsDeclined") or doc.get("IsArchive"):
            self._send(400, {"code": 102, "error": "document_terminal: locked"})
            return
        iso = (doc.get("ExpiryDate") or {}).get("iso")
        if iso and iso.startswith("2020"):
            self._send(400, {"code": 102, "error": "document_expired: expired"})
            return
        expected = params.get("expected")
        approval = params.get("approval") or {}
        required = [
            "title",
            "fileUrl",
            "fileHash",
            "recipients",
            "order",
            "expiry",
            "timeToCompleteDays",
            "subject",
            "sendMode",
            "placeholders",
        ]
        if not isinstance(expected, dict) or any(expected.get(key) in (None, "") for key in required):
            self._send(400, {"code": 102, "error": "approval_missing: Canonical expected binding is required."})
            return
        secret = os.environ.get("LEXYSIGN_FIRM_APPROVAL_SECRET", "")
        if not secret:
            self._send(403, {"code": 119, "error": "approval_unconfigured: Native firm approval secret is not configured."})
            return
        if not approval.get("approval_id") or not approval.get("hmac"):
            self._send(400, {"code": 102, "error": "approval_missing: Server-verifiable approval is required."})
            return
        payload = {
            "approval_id": approval.get("approval_id"),
            "document_id": document_id,
            "expires_at": int(approval.get("expires_at") or 0),
            "issued_at": int(approval.get("issued_at") or 0),
            "manifest_hash": approval.get("manifest_hash") or "",
            "operator": approval.get("operator") or "",
            "expected": expected,
        }
        body = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False).encode("utf-8")
        want = hmac.new(secret.encode("utf-8"), body, hashlib.sha256).hexdigest()
        if not hmac.compare_digest(str(approval.get("hmac")), want):
            self._send(400, {"code": 102, "error": "approval_mismatch: Approval signature is invalid."})
            return
        if int(approval.get("expires_at") or 0) < int(time.time()):
            self._send(400, {"code": 102, "error": "approval_expired: Operator approval has expired."})
            return
        if expected.get("title") != doc.get("Name") or expected.get("fileUrl") != doc.get("URL"):
            self._send(400, {"code": 102, "error": "payload_modified: title"})
            return
        order = "sequential" if doc.get("SendinOrder") else "parallel"
        if expected.get("order") != order:
            self._send(400, {"code": 102, "error": "payload_modified: order"})
            return
        if int(expected.get("timeToCompleteDays") or 0) != int(doc.get("TimeToCompleteDays") or 15):
            self._send(400, {"code": 102, "error": "payload_modified: days"})
            return
        if str(expected.get("expiry") or "") != str(iso or ""):
            self._send(400, {"code": 102, "error": "payload_modified: expiry"})
            return
        want_emails = [str(item.get("email") or "").lower() for item in (expected.get("recipients") or [])]
        actual_emails = [str(item.get("Email") or "").lower() for item in (doc.get("Signers") or [])]
        want_ids = [str(item.get("contact_id") or "") for item in (expected.get("recipients") or [])]
        actual_ids = [str(item.get("objectId") or "") for item in (doc.get("Signers") or [])]
        if want_emails != actual_emails or want_ids != actual_ids:
            self._send(400, {"code": 102, "error": "payload_modified: recipients"})
            return
        if not (doc.get("Placeholders") or []):
            self._send(400, {"code": 102, "error": "payload_modified: empty fields"})
            return
        for signer in doc.get("Signers") or []:
            if pid(signer.get("CreatedBy")) and pid(signer.get("CreatedBy")) != PRINCIPAL["user"]:
                self._send(403, {"code": 119, "error": "foreign_contact: Signer contact is not owned by the configured principal."})
                return
            if pid(signer.get("TenantId")) and pid(signer.get("TenantId")) != PRINCIPAL["tenant"]:
                self._send(403, {"code": 119, "error": "foreign_contact: Signer contact tenant does not match the configured tenant."})
                return
        if doc.get("SignedUrl") or doc.get("SentToOthers") is True:
            self._send(400, {"code": 137, "error": "duplicate_send: already sent"})
            return
        if document_id in self.store.reservations or approval.get("approval_id") in self.store.approval_ids:
            self._send(400, {"code": 137, "error": "duplicate_send: document send is already reserved."})
            return
        self.store.reservations[document_id] = "in_flight"
        self.store.approval_ids.add(str(approval.get("approval_id")))
        if self.store.send_mode_force == "uncertain":
            self.store.reservations[document_id] = "uncertain"
            self._send(200, {"result": {"status": "uncertain", "smtp_accepted": False, "delivered": False, "recipients": []}})
            return
        send_mode = expected.get("sendMode") or "email"
        if not doc.get("SignedUrl"):
            doc["SignedUrl"] = doc.get("URL")
            doc["SentToOthers"] = True
        recipients = [
            {
                "email": "client@example.com",
                "smtp_accepted": send_mode != "manual",
                "delivery": "accepted_not_delivered" if send_mode != "manual" else "not_attempted_manual",
            }
        ]
        status = "activated_manual" if send_mode == "manual" else "sent_smtp_accepted"
        result = {
            "status": status,
            "smtp_accepted": send_mode != "manual",
            "delivered": False,
            "recipients": recipients,
        }
        if send_mode == "manual":
            host = self.headers.get("Host")
            result["manual_artifacts"] = [
                {
                    "email": "client@example.com",
                    "contact_id": "contact-1",
                    "signing_url": f"https://sign.lexyalgo.com/login/c3ludGhldGlj",
                }
            ]
        self.store.reservations[document_id] = status
        self._send(200, {"result": result})


def _where_match(doc: dict, where: dict) -> bool:
    if not where:
        return True
    if "CreatedBy" in where and pid(doc.get("CreatedBy")) != pid(where.get("CreatedBy")):
        return False
    if "ExtUserPtr" in where and pid(doc.get("ExtUserPtr")) != pid(where.get("ExtUserPtr")):
        return False
    return True


class FakeParseServer(ThreadingHTTPServer):
    def __init__(self, store: FakeParse) -> None:
        super().__init__(("127.0.0.1", 0), FakeParseHandler)
        self.store = store


def start_fake_parse() -> tuple[FakeParseServer, str, FakeParse]:
    store = FakeParse()
    server = FakeParseServer(store)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    host, port = server.server_address[:2]
    base = f"http://{host}:{port}"
    store.rewrite_base(base)
    return server, base, store
