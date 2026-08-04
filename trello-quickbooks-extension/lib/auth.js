import { AUTH_CONFIG, assertAuthConfig } from './auth-config.js';

// This private build uses one locally configured installation credential.
// Google/Firebase user authentication is intentionally disabled until the
// extension needs to support multiple Trello accounts or multiple users.
export async function getAuthSession() {
  assertAuthConfig();
  return { authenticated: true, mode: 'local-installation' };
}

export async function signOut() {
  await chrome.storage.local.remove(['organizationId', 'selectedBoardId']);
}

export async function authenticatedFetch(path, options = {}) {
  assertAuthConfig();
  const headers = new Headers(options.headers || {});
  headers.set('authorization', `Bearer ${AUTH_CONFIG.installationSecret}`);
  headers.set('content-type', 'application/json');
  const response = await fetch(`${AUTH_CONFIG.backendUrl}${path}`, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) {
    const error = new Error(data?.error || 'The local installation is not authorized.');
    error.code = data?.code || 'INSTALLATION_UNAUTHORIZED';
    throw error;
  }
  if (!response.ok) {
    const error = new Error(data?.error || 'Ledgerflow could not complete that request.');
    if (data?.code) error.code = data.code;
    throw error;
  }
  return data;
}

// Future multi-user migration point:
// restore Google/Firebase sign-in here, persist a Firebase ID/refresh token,
// and send the Firebase ID token instead of the local installation secret.
