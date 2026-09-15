# Local browser follow-up for interrupted send (parent-owned)

This is not a Node RED and not a live login. It exists because PlaceHolderSign.jsx
is a React page: the Node suite executes the extracted saveDocumentDetails /
CustomizeMail close / reopen blocks with closure mocks. Full UI still needs a
local browser against a private stack.

Do not open public sign.lexyalgo.com. Do not send or sign client documents.

1. Start only a local/dev LexySign with synthetic users.
2. As sender, place fields on the synthetic packet and press Next.
3. Close CustomizeMail without pressing Send.
4. Reopen the same draft.
5. Record whether document-signed-alert-8 appears and whether a first invitation
   can still be sent from UI (not via a raw sendmailv3 recovery).

Node extraction already shows Next PUTs SignedUrl + SentToOthers before mail.
