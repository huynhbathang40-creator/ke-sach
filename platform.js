/* Kệ Sách platform layer: Supabase-backed stand-ins for the db / assets / user / sample
   capabilities the reader was written against, plus sign-in and the offline audio cache. */
(() => {
'use strict';
const SUPABASE_URL = 'https://hixiuqluncpjxlxiwkxa.supabase.co';
const SUPABASE_KEY = 'sb_publishable_w25PgjBB8VOhAXsz81N9Yg_ipWqPcdI';
const SB = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: true, autoRefreshToken: true, storageKey: 'kesach-auth' } });
window.SB = SB;
let UID = null;

const err = (code, message) => Object.assign(new Error(message || code), { code });
const clone = v => v === undefined ? undefined : JSON.parse(JSON.stringify(v));
const deepMerge = (a, b) => {
  const out = { ...(a || {}) };
  for (const k of Object.keys(b)) {
    const v = b[k];
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out;
};
const rid = () => (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '') : Math.random().toString(36).slice(2) + Date.now().toString(36));
const colOf = path => path.split('/').slice(0, -1).join('/');

/* ---------------- db ---------------- */
const listeners = new Set();
function snapDoc(path, data, pending) {
  const frozen = data === undefined ? undefined : Object.freeze(data);
  return { id: path.split('/').pop(), exists: data !== undefined, data: () => frozen, metadata: { fromCache: false, hasPendingWrites: !!pending } };
}
async function readDoc(path) {
  const { data, error } = await SB.from('docs').select('data').eq('path', path).maybeSingle();
  if (error) throw err('unavailable', error.message);
  return data ? data.data : undefined;
}
async function writeDoc(path, data) {
  const { error } = await SB.from('docs').upsert({ user_id: UID, path, col: colOf(path), data, updated_at: new Date().toISOString() }, { onConflict: 'user_id,path' });
  if (error) throw err(/size|too large|payload/i.test(error.message) ? 'quota_exceeded' : 'unavailable', error.message);
}
function notify(path) {
  const col = colOf(path);
  for (const l of listeners) if ((l.kind === 'doc' && l.path === path) || (l.kind === 'col' && l.path === col)) l.refresh();
}
function docRef(path) {
  const ref = {
    id: path.split('/').pop(), path,
    async get() { return snapDoc(path, await readDoc(path)); },
    async set(data) { await writeDoc(path, clone(data)); notify(path); },
    async update(data) {
      const cur = await readDoc(path);
      if (cur === undefined) throw err('invalid_argument', 'document does not exist');
      await writeDoc(path, deepMerge(cur, clone(data))); notify(path);
    },
    async delete() { const { error } = await SB.from('docs').delete().eq('path', path); if (error) throw err('unavailable', error.message); notify(path); },
    async acquire() { return { acquired: true }; },
    onSnapshot(next, onError) {
      let last = null, dead = false, timer = null;
      const l = { kind: 'doc', path, refresh() { clearTimeout(timer); timer = setTimeout(run, 120); } };
      async function run() {
        if (dead) return;
        try { const d = await readDoc(path); const s = JSON.stringify(d ?? null); if (s !== last) { last = s; next(snapDoc(path, d)); } }
        catch (e) { console.warn('snapshot', e); }
      }
      listeners.add(l); run();
      return () => { dead = true; listeners.delete(l); };
    },
    collection(sub) { return colRef(path + '/' + sub); },
  };
  return ref;
}
function colRef(path, filters = [], order = null, lim = 0) {
  const apply = rows => {
    let out = rows.filter(r => filters.every(([f, op, v]) => {
      const x = r.data[f];
      switch (op) {
        case '==': return x === v; case '!=': return x !== v; case '<': return x < v; case '<=': return x <= v;
        case '>': return x > v; case '>=': return x >= v; case 'in': return v.includes(x); case 'not-in': return !v.includes(x);
        case 'array-contains': return Array.isArray(x) && x.includes(v); default: return true;
      }
    }));
    if (order) out.sort((a, b) => { const x = a.data[order[0]], y = b.data[order[0]]; const c = x === y ? 0 : x === undefined ? 1 : y === undefined ? -1 : x < y ? -1 : 1; return order[1] === 'desc' ? -c : c; });
    else out.sort((a, b) => a.path < b.path ? -1 : 1);
    return lim ? out.slice(0, lim) : out;
  };
  async function fetchRows() {
    const rows = []; const page = 500;
    for (let from = 0; ; from += page) {
      let q = SB.from('docs').select('path,data').eq('col', path);
      for (const [f, op, v] of filters) if (op === '==' && (typeof v === 'string' || typeof v === 'number')) q = q.eq(`data->>${f}`, String(v));
      const { data, error } = await q.range(from, from + page - 1);
      if (error) throw err('unavailable', error.message);
      rows.push(...data); if (data.length < page) break;
    }
    return apply(rows);
  }
  const toSnap = (rows, prev) => {
    const docs = rows.map(r => snapDoc(r.path, r.data));
    return { docs, size: docs.length, empty: !docs.length, metadata: { fromCache: false, hasPendingWrites: false },
      docChanges: () => prev ? [] : docs.map((d, i) => ({ type: 'added', doc: d, oldIndex: -1, newIndex: i })) };
  };
  return {
    path,
    where(f, op, v) { return colRef(path, [...filters, [f, op, v]], order, lim); },
    orderBy(f, dir = 'asc') { return colRef(path, filters, [f, dir], lim); },
    limit(n) { return colRef(path, filters, order, n); },
    async get() { return toSnap(await fetchRows()); },
    doc(id) { return docRef(path + '/' + (id || rid())); },
    async add(data) { const r = docRef(path + '/' + rid()); await r.set(data); return r; },
    onSnapshot(next, onError) {
      let last = null, dead = false, timer = null, first = true;
      const l = { kind: 'col', path, refresh() { clearTimeout(timer); timer = setTimeout(run, 150); } };
      async function run() {
        if (dead) return;
        try {
          const rows = await fetchRows(); const s = JSON.stringify(rows);
          if (s !== last) { last = s; next(toSnap(rows, !first)); first = false; }
        } catch (e) { console.warn('snapshot', e); if (first && onError) onError(e); }
      }
      listeners.add(l); run();
      return () => { dead = true; listeners.delete(l); };
    },
  };
}
const DB = { doc: docRef, collection: p => colRef(p) };

let channel = null;
function startRealtime() {
  if (channel) SB.removeChannel(channel);
  channel = SB.channel('docs-' + UID)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'docs', filter: `user_id=eq.${UID}` }, payload => {
      const p = (payload.new && payload.new.path) || (payload.old && payload.old.path);
      if (p) notify(p); else for (const l of listeners) l.refresh();
    })
    .subscribe();
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') for (const l of listeners) l.refresh(); });
  window.addEventListener('online', () => { for (const l of listeners) l.refresh(); });
}

/* ---------------- assets (book images) ---------------- */
const urlCache = new Map();
const ASSETS = {
  async upload(blob) {
    const ext = ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg' })[blob.type] || 'bin';
    const id = rid() + '.' + ext;
    const { error } = await SB.storage.from('assets').upload(`${UID}/${id}`, blob, { contentType: blob.type, upsert: false });
    if (error) throw err(/quota|exceed|size/i.test(error.message) ? 'quota_or_state' : 'unavailable', error.message);
    return { id, url: '', sizeBytes: blob.size, contentType: blob.type };
  },
  async delete(id) { await SB.storage.from('assets').remove([`${UID}/${id}`]); urlCache.delete(id); },
  async list() { return { assets: [], usage: {} }; },
};
/* fill <img data-asset> with signed URLs (valid a day) */
window.hydrateAssets = async root => {
  const imgs = Array.from((root || document).querySelectorAll('img[data-asset]'));
  const need = [...new Set(imgs.map(i => i.dataset.asset).filter(id => !urlCache.has(id)))];
  if (need.length && UID) {
    const { data } = await SB.storage.from('assets').createSignedUrls(need.map(id => `${UID}/${id}`), 86400);
    (data || []).forEach((d, i) => { if (d.signedUrl) urlCache.set(need[i], d.signedUrl); });
  }
  for (const im of imgs) {
    const u = urlCache.get(im.dataset.asset); if (!u) continue;
    if (im.getAttribute('src') !== u) im.src = u;
    const a = im.closest('a'); if (a) a.href = u;
  }
};

/* ---------------- AI (Gemini via /api/ai) ---------------- */
async function authHeader() {
  const { data } = await SB.auth.getSession();
  return data.session ? { authorization: 'Bearer ' + data.session.access_token } : {};
}
async function callAI(input, asJson, fast) {
  const prompt = typeof input === 'string' ? input : input.map(m => (m.role === 'assistant' ? 'Assistant: ' : '') + m.content).join('\n\n');
  let r;
  try { r = await fetch(SUPABASE_URL + '/functions/v1/ai', { method: 'POST', headers: { 'content-type': 'application/json', apikey: SUPABASE_KEY, ...(await authHeader()) }, body: JSON.stringify({ prompt, json: !!asJson, fast: !!fast }) }); }
  catch { throw err('unavailable', 'offline'); }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    const code = r.status === 429 ? 'rate_limited' : (d.error === 'no_key' || r.status === 403 || r.status === 401) ? 'not_granted' : 'unavailable';
    throw err(code, d.error === 'no_key' ? 'Chưa cài khóa Gemini (GEMINI_API_KEY) trong Supabase.' : (d.detail || d.error || 'AI error'));
  }
  return d.text || '';
}
function parseJSON(text) {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try { return JSON.parse(t); } catch {}
  const i = t.search(/[[{]/), j = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
  if (i >= 0 && j > i) return JSON.parse(t.slice(i, j + 1));
  throw err('invalid_json', 'bad json');
}
const SAMPLE = Object.assign(async (input, opts = {}) => { const text = await callAI(input, false, opts.modelTier === 'quick'); opts.onText?.({ text, delta: text }); return { text, truncated: false }; }, {
  async json(input, opts = {}) { const text = await callAI(input, true, opts.modelTier === 'quick'); opts.onText?.({ text, delta: text }); return parseJSON(text); },
  async limits() { return { maxInputBytes: 600000, images: null }; },
});

/* ---------------- user ---------------- */
const USER = {
  async id() { return UID; }, async me() { return { id: UID, name: '' }; },
  isOwner: () => true, canEdit: () => true, can: () => true, async profiles() { return {}; },
};

window.claude = { use: async name => ({ db: DB, user: USER, assets: ASSETS, sample: SAMPLE })[name] || null };

/* ---------------- Google TTS (/api/tts) ---------------- */
window.ttsSynthesize = async (text, voice, lang) => {
  let r;
  try { r = await fetch(SUPABASE_URL + '/functions/v1/tts', { method: 'POST', headers: { 'content-type': 'application/json', apikey: SUPABASE_KEY, ...(await authHeader()) }, body: JSON.stringify({ text, voice, lang }) }); }
  catch { throw err('offline', 'Không có mạng'); }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw err(d.error || 'tts_error', d.detail || d.error || 'TTS error');
  const bin = atob(d.audio); const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { blob: new Blob([bytes], { type: 'audio/mpeg' }), used: d.used, limit: d.limit, kind: d.kind };
};
window.usageThisMonth = async kind => {
  const m = new Date().toISOString().slice(0, 7);
  const { data } = await SB.from('usage').select('amount').eq('kind', kind).eq('month', m).maybeSingle();
  return data ? Number(data.amount) : 0;
};

/* audio cache: this device (IndexedDB) first, then the account's storage */
const idb = (() => {
  let p = null;
  const open = () => p || (p = new Promise((res, rej) => { const r = indexedDB.open('kesach', 1); r.onupgradeneeded = () => r.result.createObjectStore('audio'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }));
  const tx = async (mode, fn) => { const db = await open(); return new Promise((res, rej) => { const t = db.transaction('audio', mode); const st = t.objectStore('audio'); const out = fn(st); t.oncomplete = () => res(out && out.result); t.onerror = () => rej(t.error); }); };
  return {
    get: k => tx('readonly', st => st.get(k)).catch(() => undefined),
    put: (k, v) => tx('readwrite', st => st.put(v, k)).catch(() => {}),
    del: k => tx('readwrite', st => st.delete(k)).catch(() => {}),
    keys: () => tx('readonly', st => st.getAllKeys()).catch(() => []),
  };
})();
window.audioCache = {
  async get(bookId, key) {
    const local = await idb.get(key); if (local) return local;
    if (!UID || !navigator.onLine) return null;
    const { data, error } = await SB.storage.from('audio').download(`${UID}/${bookId}/${key}.mp3`);
    if (error || !data) return null;
    const blob = new Blob([await data.arrayBuffer()], { type: 'audio/mpeg' });
    idb.put(key, blob); return blob;
  },
  async put(bookId, key, blob) {
    await idb.put(key, blob);
    if (UID) SB.storage.from('audio').upload(`${UID}/${bookId}/${key}.mp3`, blob, { contentType: 'audio/mpeg', upsert: true }).catch(() => {});
  },
  async hasLocal(key) { return !!(await idb.get(key)); },
  async removeBook(bookId) {
    if (!UID) return;
    for (let i = 0; i < 20; i++) {
      const { data } = await SB.storage.from('audio').list(`${UID}/${bookId}`, { limit: 1000 });
      if (!data || !data.length) break;
      await SB.storage.from('audio').remove(data.map(f => `${UID}/${bookId}/${f.name}`));
      for (const f of data) idb.del(f.name.replace(/\.mp3$/, ''));
      if (data.length < 1000) break;
    }
  },
};

/* ---------------- sign-in ---------------- */
function loginUI(show, msg) {
  const el = document.getElementById('login'); if (!el) return;
  el.hidden = !show;
  if (msg !== undefined) { const m = document.getElementById('loginMsg'); m.textContent = msg; }
}
async function startApp(session) {
  UID = session.user.id;
  loginUI(false);
  startRealtime();
  document.getElementById('acctEmail') && (document.getElementById('acctEmail').textContent = session.user.email || '');
  window.__kesachBoot && window.__kesachBoot();
}
document.addEventListener('DOMContentLoaded', () => {});
window.addEventListener('load', async () => {
  const form = document.getElementById('loginForm');
  const email = document.getElementById('loginEmail'), pass = document.getElementById('loginPass');
  let mode = 'in';
  document.getElementById('loginSwitch').onclick = () => {
    mode = mode === 'in' ? 'up' : 'in';
    document.getElementById('loginTitle').textContent = mode === 'in' ? 'Đăng nhập' : 'Tạo tài khoản';
    document.getElementById('loginGo').textContent = mode === 'in' ? 'Đăng nhập' : 'Tạo tài khoản';
    document.getElementById('loginSwitch').textContent = mode === 'in' ? 'Chưa có tài khoản? Tạo tài khoản' : 'Đã có tài khoản? Đăng nhập';
    loginUI(true, '');
  };
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const btn = document.getElementById('loginGo'); btn.disabled = true;
    try {
      if (mode === 'up') {
        const { data, error } = await SB.auth.signUp({ email: email.value.trim(), password: pass.value, options: { emailRedirectTo: location.origin } });
        if (error) throw error;
        if (data.session) return startApp(data.session);
        loginUI(true, 'Đã gửi email xác nhận. Mở email, bấm link xác nhận, rồi quay lại đây đăng nhập.');
        mode = 'up'; document.getElementById('loginSwitch').click();
      } else {
        const { data, error } = await SB.auth.signInWithPassword({ email: email.value.trim(), password: pass.value });
        if (error) throw error;
        startApp(data.session);
      }
    } catch (ex) {
      const m = String(ex.message || ex);
      loginUI(true, /Invalid login/i.test(m) ? 'Sai email hoặc mật khẩu.' : /not confirmed/i.test(m) ? 'Email chưa được xác nhận. Mở email và bấm link xác nhận trước.' : /least 6/i.test(m) ? 'Mật khẩu cần ít nhất 6 ký tự.' : /already registered/i.test(m) ? 'Email này đã có tài khoản, hãy đăng nhập.' : 'Lỗi: ' + m);
    } finally { btn.disabled = false; }
  });
  window.signOut = async () => { await SB.auth.signOut(); location.reload(); };
  const { data } = await SB.auth.getSession();
  if (data.session) startApp(data.session); else loginUI(true);
  SB.auth.onAuthStateChange((ev, session) => { if (ev === 'SIGNED_OUT') loginUI(true); });
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
});
})();
