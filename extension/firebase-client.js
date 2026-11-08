// Minimal Firebase client for the extension (no SDK): Auth via Identity Toolkit REST,
// data via the Firestore REST API with the user's ID token (security rules apply).

const FB_CONFIG = {
  apiKey: 'AIzaSyBKsafbaWP7zYQxxrC-O-gCENwiXLetc5o',
  projectId: 'choozr-approval',
};
const FS_ROOT = `projects/${FB_CONFIG.projectId}/databases/(default)/documents`;
const FS_URL = `https://firestore.googleapis.com/v1/${FS_ROOT}`;

const FB = {
  // ---------------- auth ----------------
  async signIn(email, password) {
    const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FB_CONFIG.apiKey}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    });
    const j = await res.json();
    if (!res.ok) throw new Error(friendly(j?.error?.message) || 'Sign-in failed');
    await chrome.storage.local.set({ auth: { email: j.email, uid: j.localId, idToken: j.idToken, refreshToken: j.refreshToken, exp: Date.now() + Number(j.expiresIn) * 1000 } });
    return { email: j.email, uid: j.localId };
  },
  async signOut() { await chrome.storage.local.remove('auth'); },
  async currentUser() { const { auth } = await chrome.storage.local.get('auth'); return auth ? { email: auth.email, uid: auth.uid } : null; },
  async idToken() {
    const { auth } = await chrome.storage.local.get('auth');
    if (!auth) throw new Error('Not signed in. Click the extension icon and sign in.');
    if (auth.exp - Date.now() > 60_000) return auth.idToken;
    const res = await fetch(`https://securetoken.googleapis.com/v1/token?key=${FB_CONFIG.apiKey}`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: auth.refreshToken }),
    });
    const j = await res.json();
    if (!res.ok) { await FB.signOut(); throw new Error('Session expired. Sign in again (extension icon).'); }
    const next = { ...auth, idToken: j.id_token, refreshToken: j.refresh_token, exp: Date.now() + Number(j.expires_in) * 1000 };
    await chrome.storage.local.set({ auth: next });
    return next.idToken;
  },

  // ---------------- firestore ----------------
  async req(method, url, body) {
    const token = await FB.idToken();
    const res = await fetch(url, {
      method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const j = text ? JSON.parse(text) : {};
    if (!res.ok) {
      if (res.status === 404 && method === 'GET') return null;
      const msg = j?.error?.message || res.statusText;
      throw new Error(/PERMISSION_DENIED|insufficient permissions/i.test(msg) ? 'Permission denied — does this account have the coordinator role?' : msg);
    }
    return j;
  },
  /** Returns { id, data, updateTime } or null. */
  async get(path) {
    const d = await FB.req('GET', `${FS_URL}/${path}`);
    return d ? { id: d.name.split('/').pop(), data: decodeFields(d.fields || {}), updateTime: d.updateTime } : null;
  },
  /** Atomic multi-document write. ops: {set:{path,data,exists?,updateTime?}} | {patch:{path,data}} | {del:path} */
  async commit(ops) {
    const writes = ops.map((op) => {
      if (op.del) return { delete: `${FS_ROOT}/${op.del}` };
      if (op.patch) return { update: { name: `${FS_ROOT}/${op.patch.path}`, fields: encodeFields(op.patch.data) }, updateMask: { fieldPaths: Object.keys(op.patch.data).map(quotePath) } };
      const w = { update: { name: `${FS_ROOT}/${op.set.path}`, fields: encodeFields(op.set.data) } };
      if (op.set.exists === false) w.currentDocument = { exists: false };
      else if (op.set.updateTime) w.currentDocument = { updateTime: op.set.updateTime };
      return w;
    });
    return FB.req('POST', `${FS_URL}:commit`, { writes });
  },
  /** Simple query: collection, [field, op, value], orderBy?, limit */
  async query(collection, where, limit = 20, orderBy) {
    const sq = { from: [{ collectionId: collection }], limit };
    if (where) sq.where = { fieldFilter: { field: { fieldPath: where[0] }, op: where[1], value: encodeValue(where[2]) } };
    if (orderBy) sq.orderBy = [{ field: { fieldPath: orderBy[0] }, direction: orderBy[1] || 'ASCENDING' }];
    const rows = await FB.req('POST', `${FS_URL}:runQuery`, { structuredQuery: sq });
    return (rows || []).filter((r) => r.document).map((r) => ({
      id: r.document.name.split('/').pop(), path: r.document.name.slice(FS_ROOT.length + 1),
      data: decodeFields(r.document.fields || {}), updateTime: r.document.updateTime,
    }));
  },
  newId() { const a = new Uint8Array(15); crypto.getRandomValues(a); return Array.from(a, (b) => 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[b % 62]).join('').slice(0, 20); },
};

const quotePath = (p) => (/^[a-zA-Z_][a-zA-Z_0-9]*$/.test(p) ? p : '`' + p.replace(/`/g, '\\`') + '`');

function encodeValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(encodeValue) } };
  if (typeof v === 'object') return { mapValue: { fields: encodeFields(v) } };
  return { stringValue: String(v) };
}
function encodeFields(o) { const f = {}; for (const [k, v] of Object.entries(o)) if (v !== undefined) f[k] = encodeValue(v); return f; }
function decodeValue(v) {
  if ('nullValue' in v) return null;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('stringValue' in v) return v.stringValue;
  if ('timestampValue' in v) return v.timestampValue;   // ISO string
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(decodeValue);
  if ('mapValue' in v) return decodeFields(v.mapValue.fields || {});
  return null;
}
function decodeFields(f) { const o = {}; for (const [k, v] of Object.entries(f)) o[k] = decodeValue(v); return o; }

function friendly(code) {
  if (!code) return '';
  if (/INVALID_LOGIN_CREDENTIALS|INVALID_PASSWORD|EMAIL_NOT_FOUND/.test(code)) return 'Wrong email or password';
  if (/USER_DISABLED/.test(code)) return 'This account is disabled';
  if (/TOO_MANY_ATTEMPTS/.test(code)) return 'Too many attempts, try later';
  return code;
}

if (typeof self !== 'undefined') { self.FB = FB; self.FB_CONFIG = FB_CONFIG; }
