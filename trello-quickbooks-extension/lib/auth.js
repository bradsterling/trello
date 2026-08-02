import { AUTH_CONFIG, assertAuthConfig } from './auth-config.js';

const GOOGLE_SCOPE = 'openid email profile';

function decodeJwt(token) {
  try {
    const encoded = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(decodeURIComponent(atob(encoded).split('').map((character) => `%${(`00${character.charCodeAt(0).toString(16)}`).slice(-2)}`).join('')));
  } catch (_error) { return {}; }
}

async function firebaseRequest(path, body) {
  const response = await fetch(`https://identitytoolkit.googleapis.com/v1/${path}?key=${encodeURIComponent(AUTH_CONFIG.firebaseApiKey)}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error?.message?.replaceAll('_', ' ').toLowerCase() || 'Firebase authentication failed.');
  return data;
}

export async function getAuthSession() {
  const stored = await chrome.storage.local.get({ auth: null });
  if (!stored.auth?.idToken) return null;
  if (stored.auth.expiresAt && stored.auth.expiresAt <= Date.now()) {
    if (!stored.auth.refreshToken) { await signOut(); return null; }
    try {
      const response = await fetch(`https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(AUTH_CONFIG.firebaseApiKey)}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(stored.auth.refreshToken)}` });
      const refreshed = await response.json();
      if (!response.ok) throw new Error('refresh failed');
      const auth = { ...stored.auth, idToken: refreshed.id_token, refreshToken: refreshed.refresh_token || stored.auth.refreshToken, localId: refreshed.user_id || stored.auth.localId, expiresAt: Date.now() + Number(refreshed.expires_in || 3600) * 1000 - 60_000 };
      await chrome.storage.local.set({ auth });
      return auth;
    } catch (_error) { await signOut(); return null; }
  }
  return stored.auth;
}

export async function signInWithGoogle() {
  assertAuthConfig();
  const redirectUri = chrome.identity.getRedirectURL('firebase-auth');
  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.search = new URLSearchParams({ client_id: AUTH_CONFIG.googleClientId, response_type: 'id_token', redirect_uri: redirectUri, scope: GOOGLE_SCOPE, nonce: crypto.randomUUID(), prompt: 'select_account' });
  const redirected = await chrome.identity.launchWebAuthFlow({ url: authUrl.toString(), interactive: true });
  const googleIdToken = new URL(redirected).hash.match(/(?:^#|&)id_token=([^&]+)/)?.[1];
  if (!googleIdToken) throw new Error('Google sign-in was cancelled or did not return an identity token.');
  const data = await firebaseRequest('accounts:signInWithIdp', { postBody: `id_token=${encodeURIComponent(decodeURIComponent(googleIdToken))}&providerId=google.com`, requestUri: redirectUri, returnSecureToken: true, returnIdpCredential: false });
  const auth = { idToken: data.idToken, refreshToken: data.refreshToken, localId: data.localId, email: data.email || decodeJwt(data.idToken).email || '', displayName: data.displayName || decodeJwt(data.idToken).name || '', expiresAt: Date.now() + Number(data.expiresIn || 3600) * 1000 - 60_000 };
  await chrome.storage.local.set({ auth });
  return auth;
}

export async function signOut() {
  await chrome.storage.local.remove(['auth', 'organizationId', 'selectedBoardId']);
}

export async function authenticatedFetch(path, options = {}) {
  assertAuthConfig();
  const auth = await getAuthSession();
  if (!auth) throw new Error('Sign in to continue.');
  const headers = new Headers(options.headers || {});
  headers.set('authorization', `Bearer ${auth.idToken}`);
  headers.set('content-type', 'application/json');
  const response = await fetch(`${AUTH_CONFIG.backendUrl}${path}`, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) { await signOut(); throw new Error('Your session expired. Sign in again.'); }
  if (!response.ok) throw new Error(data?.error || 'Ledgerflow could not complete that request.');
  return data;
}
