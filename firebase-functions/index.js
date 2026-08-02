const crypto = require('node:crypto');
const admin = require('firebase-admin');

admin.initializeApp();
const db = admin.firestore();
const auth = admin.auth();
const trelloKey = process.env.TRELLO_API_KEY;
const encryptionKey = Buffer.from(process.env.LEDGERFLOW_TOKEN_ENCRYPTION_KEY || '', 'hex');
const allowedOrigins = new Set((process.env.LEDGERFLOW_ALLOWED_ORIGINS || '').split(',').map((origin) => origin.trim()).filter(Boolean));
const rateBuckets = new Map();
const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;
const MAX_BODY_BYTES = 32 * 1024;
const MAX_PATH_LENGTH = 256;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const TRELLO_PATHS = [
  /^\/organizations\/[A-Za-z0-9_-]{1,128}\/boards$/,
  /^\/boards\/[A-Za-z0-9_-]{1,128}\/lists$/,
  /^\/list\/[A-Za-z0-9_-]{1,128}\/cards$/,
];

function headers(origin) {
  const permitted = origin && allowedOrigins.has(origin) ? origin : '';
  return { 'content-type': 'application/json', ...(permitted ? { 'access-control-allow-origin': permitted, 'vary': 'Origin' } : {}), 'access-control-allow-headers': 'authorization, content-type', 'access-control-allow-methods': 'POST, OPTIONS' };
}

function json(data, status = 200, origin) {
  return { status, headers: headers(origin), body: JSON.stringify(data) };
}

function audit(event, details = {}) {
  console.info(JSON.stringify({ severity: 'INFO', component: 'trello-function', event, ...details }));
}

function requestId(req) {
  return req.get('x-cloud-trace-context')?.split('/')[0] || crypto.randomUUID();
}

function enforceRateLimit(userId) {
  const now = Date.now();
  const bucket = rateBuckets.get(userId) || { startedAt: now, count: 0 };
  if (now - bucket.startedAt >= RATE_WINDOW_MS) { bucket.startedAt = now; bucket.count = 0; }
  bucket.count += 1;
  rateBuckets.set(userId, bucket);
  if (rateBuckets.size > 10_000) rateBuckets.delete(rateBuckets.keys().next().value);
  if (bucket.count > RATE_LIMIT) throw Object.assign(new Error('Too many requests. Try again shortly.'), { status: 429 });
}

function validateBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw Object.assign(new Error('Invalid JSON request.'), { status: 422 });
  if (!['connect', 'profile', 'fetch'].includes(body.action)) throw Object.assign(new Error('Unsupported action.'), { status: 422 });
  if (body.action === 'connect') {
    if (typeof body.organizationId !== 'string' || !ID_PATTERN.test(body.organizationId)) throw Object.assign(new Error('Invalid Trello workspace.'), { status: 422 });
    if (typeof body.token !== 'string' || body.token.length < 10 || body.token.length > 512) throw Object.assign(new Error('Invalid Trello authorization.'), { status: 422 });
  }
  if (body.action === 'profile' && body.organizationId !== undefined) {
    if (typeof body.organizationId !== 'string' || !ID_PATTERN.test(body.organizationId)) throw Object.assign(new Error('Invalid Trello workspace.'), { status: 422 });
  }
  if (body.action === 'fetch') {
    if (typeof body.connectionId !== 'string' || !ID_PATTERN.test(body.connectionId)) throw Object.assign(new Error('Invalid Trello connection.'), { status: 422 });
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

async function currentUser(req) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!token) throw new Error('Missing login session.');
  try { return await auth.verifyIdToken(token); }
  catch (_error) { throw Object.assign(new Error('Invalid login session.'), { status: 401 }); }
}

async function trello(path, token) {
  const url = new URL(`https://api.trello.com/1${path}`);
  url.search = new URLSearchParams({ key: trelloKey, token }).toString();
  const response = await fetch(url);
  const body = await response.text();
  if (!response.ok) throw new Error(`Trello request failed (${response.status}).`);
  return JSON.parse(body);
}

exports.trello = async (req, res) => {
  const origin = req.get('origin');
  const id = requestId(req);
  if (req.method === 'OPTIONS') return res.status(allowedOrigins.has(origin) ? 204 : 403).set(headers(origin)).send('');
  if (req.method !== 'POST') return res.status(405).set(headers(origin)).send(JSON.stringify({ error: 'Method not allowed.' }));
  try {
    if (!trelloKey || encryptionKey.length !== 32) throw new Error('Backend secrets are not configured.');
    const user = await currentUser(req);
    enforceRateLimit(user.uid);
    const body = req.body || {};
    const bodySize = Buffer.byteLength(JSON.stringify(body), 'utf8');
    if (bodySize > MAX_BODY_BYTES) throw Object.assign(new Error('Request is too large.'), { status: 413 });
    validateBody(body);
    audit('request_started', { requestId: id, userId: user.uid, action: body.action });
    await db.collection('users').doc(user.uid).set({
      uid: user.uid,
      email: user.email || null,
      displayName: user.name || null,
      lastSeenAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    if (body.action === 'connect') {
      if (!body.organizationId || !body.token) throw new Error('Missing Trello workspace or authorization.');
      const ref = db.collection('trelloConnections').doc(`${user.uid}_${body.organizationId}`);
      await ref.set({ userId: user.uid, userEmail: user.email || null, organizationId: body.organizationId, encryptedApiKey: seal(trelloKey), encryptedToken: seal(body.token), updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      audit('connection_saved', { requestId: id, userId: user.uid, organizationId: body.organizationId });
      return res.status(200).set(headers(origin)).send(JSON.stringify({ id: ref.id, organization_id: body.organizationId }));
    }
    if (body.action === 'profile') {
      const connection = body.organizationId
        ? await db.collection('trelloConnections').doc(`${user.uid}_${body.organizationId}`).get()
        : (await db.collection('trelloConnections').where('userId', '==', user.uid).limit(1).get()).docs[0];
      if (!connection?.exists) return res.status(200).set(headers(origin)).send(JSON.stringify({ organization_id: '' }));
      return res.status(200).set(headers(origin)).send(JSON.stringify({ id: connection.id, organization_id: connection.data().organizationId || '' }));
    }
    const snapshot = await db.collection('trelloConnections').doc(body.connectionId).get();
    if (!snapshot.exists || snapshot.data().userId !== user.uid) throw new Error('Trello connection not found.');
    const result = await trello(body.path, open(snapshot.data().encryptedToken));
    audit('trello_fetch_succeeded', { requestId: id, userId: user.uid, path: body.path });
    return res.status(200).set(headers(origin)).send(JSON.stringify(result));
  } catch (error) {
    const status = Number.isInteger(error.status) ? error.status : error.message === 'Missing login session.' ? 401 : 500;
    audit('request_failed', { requestId: id, status, error: error.message || 'Request failed' });
    return res.status(status).set(headers(origin)).send(JSON.stringify({ error: status >= 500 ? 'Request failed.' : error.message || 'Request failed' }));
  }
};
