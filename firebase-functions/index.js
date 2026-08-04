const crypto = require('node:crypto');
const admin = require('firebase-admin');

admin.initializeApp();
const db = admin.firestore();
const trelloKey = process.env.TRELLO_API_KEY || '';
const installationSecret = process.env.LEDGERFLOW_INSTALLATION_SECRET || '';
const encryptionKey = Buffer.from(process.env.LEDGERFLOW_TOKEN_ENCRYPTION_KEY || '', 'hex');
const configuredWorkspaceId = process.env.TRELLO_WORKSPACE_ID || '';
const allowedOrigins = new Set((process.env.LEDGERFLOW_ALLOWED_ORIGINS || '').split(',').map((origin) => origin.trim()).filter(Boolean));
const rateBuckets = new Map();
const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;
const MAX_BODY_BYTES = 32 * 1024;
const MAX_PATH_LENGTH = 256;
const CONNECTION_ID = 'singleton';
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const TRELLO_PATHS = [
  /^\/organizations\/[A-Za-z0-9_-]{1,128}\/boards$/,
  /^\/boards\/[A-Za-z0-9_-]{1,128}\/lists$/,
  /^\/list\/[A-Za-z0-9_-]{1,128}\/cards$/,
];

function headers(origin) {
  const permitted = origin && allowedOrigins.has(origin) ? origin : '';
  return {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    ...(permitted ? { 'access-control-allow-origin': permitted, vary: 'Origin' } : {}),
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-allow-methods': 'POST, OPTIONS'
  };
}

function audit(event, details = {}) {
  console.info(JSON.stringify({ severity: 'INFO', component: 'trello-function', event, ...details }));
}

function requestId(req) {
  return req.get('x-cloud-trace-context')?.split('/')[0] || crypto.randomUUID();
}

function enforceRateLimit(bucketId) {
  const now = Date.now();
  const bucket = rateBuckets.get(bucketId) || { startedAt: now, count: 0 };
  if (now - bucket.startedAt >= RATE_WINDOW_MS) { bucket.startedAt = now; bucket.count = 0; }
  bucket.count += 1;
  rateBuckets.set(bucketId, bucket);
  if (rateBuckets.size > 10_000) rateBuckets.delete(rateBuckets.keys().next().value);
  if (bucket.count > RATE_LIMIT) throw Object.assign(new Error('Too many requests. Try again shortly.'), { status: 429 });
}

function sameSecret(provided, expected) {
  const left = Buffer.from(provided || '');
  const right = Buffer.from(expected || '');
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

function authorizeInstallation(req) {
  const origin = req.get('origin');
  if (!origin || !allowedOrigins.has(origin)) {
    throw Object.assign(new Error('This installation is not an allowed origin.'), { status: 403 });
  }
  const provided = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!sameSecret(provided, installationSecret)) {
    throw Object.assign(new Error('Invalid local installation credential.'), { status: 401 });
  }
}

function validateWorkspaceId(organizationId) {
  if (configuredWorkspaceId && organizationId !== configuredWorkspaceId) {
    throw Object.assign(new Error('This installation is configured for a different Trello workspace.'), { status: 422 });
  }
}

function validateBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw Object.assign(new Error('Invalid JSON request.'), { status: 422 });
  if (!['connect', 'profile', 'fetch', 'disconnect'].includes(body.action)) throw Object.assign(new Error('Unsupported action.'), { status: 422 });
  if (body.action === 'connect') {
    if (typeof body.organizationId !== 'string' || !ID_PATTERN.test(body.organizationId)) throw Object.assign(new Error('Invalid Trello workspace.'), { status: 422 });
    if (typeof body.token !== 'string' || body.token.length < 10 || body.token.length > 512) throw Object.assign(new Error('Invalid Trello authorization.'), { status: 422 });
  }
  if (body.action === 'profile' && body.organizationId !== undefined) {
    if (typeof body.organizationId !== 'string' || !ID_PATTERN.test(body.organizationId)) throw Object.assign(new Error('Invalid Trello workspace.'), { status: 422 });
  }
  if (body.action === 'fetch') {
    if (body.connectionId !== CONNECTION_ID) throw Object.assign(new Error('Invalid Trello connection.'), { status: 422 });
    if (typeof body.path !== 'string' || body.path.length > MAX_PATH_LENGTH || !TRELLO_PATHS.some((pattern) => pattern.test(body.path))) throw Object.assign(new Error('Unsupported Trello request.'), { status: 422 });
  }
}

function seal(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${encrypted.toString('base64')}`;
}

function open(value) {
  const [ivText, tagText, dataText] = value.split('.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey, Buffer.from(ivText, 'base64'));
  decipher.setAuthTag(Buffer.from(tagText, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataText, 'base64')), decipher.final()]).toString('utf8');
}

function connectionRef() {
  return db.collection('trelloConnections').doc(CONNECTION_ID);
}

function organizationFromPath(path) {
  return path.match(/^\/organizations\/([^/]+)\/boards$/)?.[1] || '';
}

function validatePathWorkspace(path, organizationId) {
  const pathOrganizationId = organizationFromPath(path);
  if (pathOrganizationId && pathOrganizationId !== organizationId) {
    throw Object.assign(new Error('The requested board list is outside the configured Trello workspace.'), { status: 422 });
  }
}

async function trelloRequest(path, token) {
  const url = new URL(`https://api.trello.com/1${path}`);
  url.search = new URLSearchParams({ key: trelloKey, token }).toString();
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  const body = await response.text();
  let data = {};
  try { data = body ? JSON.parse(body) : {}; } catch (_error) { data = {}; }
  if (!response.ok) {
    if (response.status === 401) {
      throw Object.assign(new Error('The Trello token expired or was revoked. Reconnect Trello.'), { status: 409, code: 'TRELLO_REAUTH_REQUIRED' });
    }
    throw Object.assign(new Error(`Trello request failed (${response.status}).`), { status: 502, code: 'TRELLO_REQUEST_FAILED' });
  }
  return data;
}

async function inspectToken(token) {
  const metadata = await trelloRequest(`/tokens/${encodeURIComponent(token)}`, token);
  return {
    id: typeof metadata.id === 'string' ? metadata.id : null,
    dateCreated: typeof metadata.dateCreated === 'string' ? metadata.dateCreated : null,
    dateExpires: typeof metadata.dateExpires === 'string' ? metadata.dateExpires : null,
    idMember: typeof metadata.idMember === 'string' ? metadata.idMember : null,
    permissions: Array.isArray(metadata.permissions) ? metadata.permissions : []
  };
}

exports.trello = async (req, res) => {
  const origin = req.get('origin');
  const id = requestId(req);
  if (req.method === 'OPTIONS') return res.status(allowedOrigins.has(origin) ? 204 : 403).set(headers(origin)).send('');
  if (req.method !== 'POST') return res.status(405).set(headers(origin)).send(JSON.stringify({ error: 'Method not allowed.' }));
  try {
    if (!trelloKey || !installationSecret || encryptionKey.length !== 32 || !allowedOrigins.size) throw new Error('Backend secrets are not configured.');
    authorizeInstallation(req);
    enforceRateLimit(CONNECTION_ID);
    const body = req.body || {};
    const bodySize = Buffer.byteLength(JSON.stringify(body), 'utf8');
    if (bodySize > MAX_BODY_BYTES) throw Object.assign(new Error('Request is too large.'), { status: 413 });
    validateBody(body);
    audit('request_started', { requestId: id, action: body.action });

    if (body.action === 'connect') {
      validateWorkspaceId(body.organizationId);
      const existing = await connectionRef().get();
      if (existing.exists && existing.data().organizationId && existing.data().organizationId !== body.organizationId) {
        throw Object.assign(new Error('This installation is already connected to a different Trello workspace. Disconnect it before changing workspaces.'), { status: 409 });
      }
      const metadata = await inspectToken(body.token);
      await trelloRequest(`/organizations/${encodeURIComponent(body.organizationId)}/boards`, body.token);
      await connectionRef().set({
        connectionId: CONNECTION_ID,
        organizationId: body.organizationId,
        encryptedToken: seal(body.token),
        tokenId: metadata.id,
        tokenCreatedAt: metadata.dateCreated,
        tokenExpiresAt: metadata.dateExpires,
        tokenMemberId: metadata.idMember,
        tokenPermissions: metadata.permissions,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        encryptedApiKey: admin.firestore.FieldValue.delete()
      }, { merge: true });
      audit('connection_saved', { requestId: id, organizationId: body.organizationId, tokenExpiresAt: metadata.dateExpires });
      return res.status(200).set(headers(origin)).send(JSON.stringify({ id: CONNECTION_ID, organization_id: body.organizationId, token_expires_at: metadata.dateExpires }));
    }

    if (body.action === 'disconnect') {
      await connectionRef().delete();
      audit('connection_deleted', { requestId: id });
      return res.status(200).set(headers(origin)).send(JSON.stringify({ disconnected: true }));
    }

    const snapshot = await connectionRef().get();
    if (body.action === 'profile') {
      if (body.organizationId) validateWorkspaceId(body.organizationId);
      if (!snapshot.exists) return res.status(200).set(headers(origin)).send(JSON.stringify({ organization_id: '' }));
      const connection = snapshot.data();
      if (body.organizationId && connection.organizationId !== body.organizationId) return res.status(200).set(headers(origin)).send(JSON.stringify({ organization_id: '' }));
      return res.status(200).set(headers(origin)).send(JSON.stringify({ id: CONNECTION_ID, organization_id: connection.organizationId || '', token_expires_at: connection.tokenExpiresAt || null }));
    }

    if (!snapshot.exists) throw Object.assign(new Error('Connect Trello to continue.'), { status: 404 });
    const connection = snapshot.data();
    validatePathWorkspace(body.path, connection.organizationId);
    const result = await trelloRequest(body.path, open(connection.encryptedToken));
    audit('trello_fetch_succeeded', { requestId: id, path: body.path });
    return res.status(200).set(headers(origin)).send(JSON.stringify(result));
  } catch (error) {
    const status = Number.isInteger(error.status) ? error.status : 500;
    const payload = { error: status >= 500 ? 'Request failed.' : error.message || 'Request failed' };
    if (error.code && status < 500) payload.code = error.code;
    audit('request_failed', { requestId: id, status, error: error.message || 'Request failed' });
    return res.status(status).set(headers(origin)).send(JSON.stringify(payload));
  }
};
