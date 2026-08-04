# Trello → QuickBooks Chrome Extension Prototype

This is an unpacked Manifest V3 Chrome extension. It loads Trello lists/cards in a side panel and fills the currently open QuickBooks split transaction without submitting it. Each Trello card becomes one split line; the full card title goes into Description and the trailing dollar amount goes into Amount.

## Load it locally

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this directory.
4. Open the extension and authorize Trello. Enter your Trello workspace ID when prompted.
5. Open a QuickBooks Online bank transaction and open its split transaction editor.
6. Choose a board from the side-panel selector, then choose a list.
7. Close Chrome DevTools and use **Paste all cards into split transaction**. The extension briefly attaches Chrome's debugging input API to click/type the amounts and does not submit the transaction.

This private single-installation build does not use Google login. The extension uses a locally configured installation credential to call the backend; keep that credential in `lib/auth-config.js` and in the backend runtime, and do not distribute the configured extension folder. Trello authorization requests a read-only token with `expiration=never`. The backend validates the token, stores only an AES-256-GCM ciphertext in Firestore, and keeps the encryption key outside Firestore. Set `LEDGERFLOW_ALLOWED_ORIGINS`, `LEDGERFLOW_INSTALLATION_SECRET`, `TRELLO_API_KEY`, and `LEDGERFLOW_TOKEN_ENCRYPTION_KEY` in the deployed function. Set `TRELLO_WORKSPACE_ID` as an additional server-side guard when the workspace ID is known.

The Trello API key is an application identifier and must match the key used by the backend. The installation credential is a separate private bearer credential for this one local extension. The singleton Firestore connection locks this installation to its first connected workspace; `TRELLO_WORKSPACE_ID` can enforce the workspace before the first connection. A browser extension cannot make a client-side credential completely undiscoverable, so this access model is intentionally limited to the private single-installation case. Restore user authentication before distributing the extension.

Generate the installation credential with `openssl rand -hex 32`, put the same value in `lib/auth-config.js` and the backend's `LEDGERFLOW_INSTALLATION_SECRET` runtime secret, and never commit or distribute the configured extension folder. Keep the existing token-encryption key stable so previously encrypted Firestore records remain decryptable.

Deploy `firebase-functions/index.js` as the `trello` HTTP function, then use its URL as `backendUrl`. The current workspace does not contain the deployed backend secrets, so the extension intentionally shows a configuration error until the local installation credential is supplied.

Before paste, the extension requires the Trello card sum, Trello list total, and QuickBooks transaction total to match exactly. It also detects an already-populated identical split and refuses to paste duplicates. Matching recommendations rank exact amount first, then use date and source/account text as tie-breakers.

## QuickBooks adapter

QuickBooks markup can vary by account and workflow. The content script searches labels, names, IDs, and common `data-*` attributes, and reports which fields it could not find. Update `content/quickbooks-adapter.js` when the live form uses different selectors.

## Tests

```bash
npm test
```
