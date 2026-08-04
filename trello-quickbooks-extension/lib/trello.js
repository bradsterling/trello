import { formatCard, parseListName } from './parser.js';
import { authenticatedFetch } from './auth.js';
import { AUTH_CONFIG, assertAuthConfig } from './auth-config.js';

export async function getSettings() {
  const local = await chrome.storage.local.get({ organizationId: '', selectedBoardId: '' });
  // Never infer a workspace from an arbitrary server-side connection. A user
  // can have more than one Trello workspace, and the backend's no-ID lookup
  // is intentionally not a workspace selection mechanism.
  if (!local.organizationId) return { ...local, session: true };
  try {
    const profile = await authenticatedFetch('/trello', { method: 'POST', body: JSON.stringify({ action: 'profile', organizationId: local.organizationId }) });
    if (profile.organization_id && profile.organization_id !== local.organizationId) {
      await chrome.storage.local.set({ organizationId: profile.organization_id });
      return { ...local, organizationId: profile.organization_id, session: true };
    }
  } catch (_error) {
    // Startup can still render local state while the network is unavailable.
  }
  return { ...local, session: true };
}

export async function authorizeWithTrello() {
  assertAuthConfig();
  // Chrome's WebAuthFlow callback is an HTTPS chromiumapp.org origin.
  // Use the base callback URL so Trello's allowed-origin check matches it.
  const returnUrl = chrome.identity.getRedirectURL();
  const url = new URL('https://trello.com/1/authorize');
  url.search = new URLSearchParams({
    expiration: 'never',
    name: 'LedgerFlow',
    scope: 'read',
    response_type: 'token',
    key: AUTH_CONFIG.trelloApiKey,
    callback_method: 'fragment',
    return_url: returnUrl
  });
  const redirected = await chrome.identity.launchWebAuthFlow({ url: url.toString(), interactive: true });
  const token = new URL(redirected).hash.match(/(?:^#|&)token=([^&]+)/)?.[1];
  const error = new URL(redirected).hash.match(/(?:^#|&)error=([^&]+)/)?.[1];
  if (!token) throw new Error(error ? `Trello authorization failed: ${decodeURIComponent(error)}` : 'Trello did not return an access token.');
  return decodeURIComponent(token);
}

export async function disconnectTrello() {
  try {
    await authenticatedFetch('/trello', { method: 'POST', body: JSON.stringify({ action: 'disconnect' }) });
  } finally {
    await chrome.storage.local.remove(['organizationId', 'selectedBoardId']);
  }
}

function requireSettings(settings, required = ['organizationId']) {
  const missing = required.filter((key) => !settings[key]?.trim());
  if (missing.length) throw new Error(`Set ${missing.join(', ')} in Settings first.`);
}

async function trelloFetch(path, settings) {
  const connection = await authenticatedFetch('/trello', { method: 'POST', body: JSON.stringify({ action: 'profile', organizationId: settings.organizationId }) });
  if (!connection.id) throw new Error('Connect Trello to continue.');
  return authenticatedFetch('/trello', { method: 'POST', body: JSON.stringify({ action: 'fetch', connectionId: connection.id, path }) });
}

export async function loadBoards(settings) {
  settings ??= await getSettings();
  requireSettings(settings, ['organizationId']);
  const boards = await trelloFetch(`/organizations/${encodeURIComponent(settings.organizationId)}/boards`, settings);
  return boards
    .filter((board) => !board.closed)
    .map((board) => ({ id: board.shortLink || board.id, trelloId: board.id, name: board.name, shortLink: board.shortLink }));
}

export async function loadLists(boardId, settings) {
  settings ??= await getSettings();
  requireSettings(settings, ['organizationId']);
  if (!boardId?.trim()) throw new Error('Choose a Trello board first.');
  const lists = await trelloFetch(`/boards/${encodeURIComponent(boardId)}/lists`, settings);
  return lists.map((list) => ({ ...list, parsed: parseListName(list.name) }));
}

export async function loadCards(listId, settings) {
  settings ??= await getSettings();
  requireSettings(settings, ['organizationId']);
  const cards = await trelloFetch(`/list/${encodeURIComponent(listId)}/cards`, settings);
  return cards.map(formatCard);
}
