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

Authentication uses Google through Firebase Auth. The Firebase ID token is sent to the backend, while the Trello token is stored encrypted server-side and scoped to the signed-in Firebase user. Copy `lib/auth-config.js` values from the Firebase Web app and deployed `trello` function before loading the unpacked extension. Add the deployed backend origin to `manifest.json` under `host_permissions`, register the exact `chrome.identity.getRedirectURL('firebase-auth')` URL in the Google OAuth client, enable Google as a Firebase sign-in provider, and set `LEDGERFLOW_ALLOWED_ORIGINS` to the extension origin/backend request origin used by your deployment.

The backend requires `TRELLO_API_KEY` and a 32-byte hex `LEDGERFLOW_TOKEN_ENCRYPTION_KEY`. Deploy `firebase-functions/index.js` as the `trello` HTTP function, then use its URL as `backendUrl`. The current workspace does not contain these Firebase project values, so the extension intentionally shows a configuration error until they are supplied.

Before paste, the extension requires the Trello card sum, Trello list total, and QuickBooks transaction total to match exactly. It also detects an already-populated identical split and refuses to paste duplicates. Matching recommendations rank exact amount first, then use date and source/account text as tie-breakers.

## QuickBooks adapter

QuickBooks markup can vary by account and workflow. The content script searches labels, names, IDs, and common `data-*` attributes, and reports which fields it could not find. Update `content/quickbooks-adapter.js` when the live form uses different selectors.

## Tests

```bash
npm test
```
