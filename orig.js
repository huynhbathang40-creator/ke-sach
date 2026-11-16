/* Kệ Sách · "Bản gốc" (original layout)
   Shows an EPUB the way Apple Books does: the publisher's own XHTML, CSS, fonts and images.
   Each chapter (spine item) is rebuilt with blob URLs and shown in a same-origin iframe that
   grows to its content height, so the page scrolls like the rest of the reader.
   Position is kept as (chapter, fraction) on this device and mapped to the block index used by
   the clean view, so Listen mode and other devices stay in sync. Loaded after the main script:
   it uses its globals (S, $, esc, toast, markPos, goTo, headerBottom, loadScript, resolvePath…). */
(() => {
'use strict';
const { S, $, esc, toast, markPos, goTo, headerBottom, loadScript, resolvePath, openSheet, closeSheets, saveSettings, ls } = window.KS;
const JSZIP = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
const XHTML = 'http://www.w3.org/1999/xhtml', XLINK = 'http://www.w3.org/1999/xlink', OPS = 'http://www.idpf.org/2007/ops';
const MIME = { css: 'text/css', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2', mp3: 'audio/mpeg', mp4: 'video/mp4', xhtml: 'application/xhtml+xml', html: 'text/html', htm: 'text/html' };
const dirOf = p => p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '';
const isExt = u => /^(data:|blob:|https?:|mailto:|tel:|javascript:|#)/i.test(u);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

const key4 = t => String(t || '').replace(/\s+/g, '').toLowerCase();
const O = window.O = { on: false, book: null, i: 0, f: 0, tok: 0, local: new Map(), restoreUntil: 0, target: null, jumpFrom: null, bc: null };

/* ---------- this device's copy of the EPUB (IndexedDB) ---------- */
const idb = (() => {
  let p = null;
  const open = () => p || (p = new Promise((res, rej) => {
    const r = indexedDB.open('kesach-epub', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('f');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  }));
  const run = async (mode, fn) => { try { const db = await open(); return await new Promise(res => { const q = fn(db.transaction('f', mode).objectStore('f')); q.onsuccess = () => res(q.result ?? null); q.onerror = () => res(null); }); } catch { return null; } };
  return { get: k => run('readonly', s => s.get(k)), set: (k, v) => run('readwrite', s => s.put(v, k)), del: k => run('readwrite', s => s.delete(k)) };
})();
const assets = async () => (window.claude?.use ? await window.claude.use('assets') : null);
const epubOf = bk => bk && (bk.epub || O.local.get(bk.id)) || null;
const isEpub = bk => bk && bk.format === 'epub';

/* save the original file with a book (called on import, or later for books added before this feature) */
O.attach = async (bookId, file) => {
  const A = await assets(); if (!A) throw new Error('Chưa kết nối được tài khoản.');
  const blob = new Blob([file], { type: 'application/epub+zip' });
  const up = await A.upload(blob);
  await S.booksCol.doc(bookId).update({ epub: up.id });
  O.local.set(bookId, up.id); idb.set(up.id, blob);
  return up.id;
};
O.forget = id => { if (id) idb.del(id); };

/* ---------- open the zip ---------- */
async function loadBook(bk) {
  const key = epubOf(bk);
  if (O.book && O.book.key === key) return O.book;
  if (O.book) closeBook();
  let blob = await idb.get(key);
  if (!blob) {
    msg('Đang tải bản gốc của sách…');
    const A = await assets(); if (!A || !A.download) throw new Error('Không tải được file gốc.');
    blob = await A.download(key); idb.set(key, blob);
  }
  await loadScript(JSZIP);
  const zip = await window.JSZip.loadAsync(blob);
  const xml = s => new DOMParser().parseFromString(s, 'application/xml');
  const cx = zip.file('META-INF/container.xml'); if (!cx) throw new Error('File EPUB không hợp lệ.');
  const opfPath = xml(await cx.async('string')).getElementsByTagNameNS('*', 'rootfile')[0]?.getAttribute('full-path');
  if (!opfPath || !zip.file(opfPath)) throw new Error('Không tìm thấy mục lục trong EPUB.');
  const opf = xml(await zip.file(opfPath).async('string')), base = dirOf(opfPath);
  const byId = new Map(), types = new Map(); let navPath = null, ncxPath = null;
  for (const it of Array.from(opf.getElementsByTagNameNS('*', 'item'))) {
    const path = resolvePath(base, it.getAttribute('href') || ''), type = it.getAttribute('media-type') || '';
    byId.set(it.getAttribute('id'), path); types.set(path, type);
    if (/\bnav\b/.test(it.getAttribute('properties') || '')) navPath = path;
    if (type === 'application/x-dtbncx+xml') ncxPath = path;
  }
  const sp = opf.getElementsByTagNameNS('*', 'spine')[0];
  if (!ncxPath && sp?.getAttribute('toc')) ncxPath = byId.get(sp.getAttribute('toc'));
  const spine = Array.from(opf.getElementsByTagNameNS('*', 'itemref')).map(r => byId.get(r.getAttribute('idref'))).filter(p => p && zip.file(p));
  if (!spine.length) throw new Error('EPUB không có chương nào.');
  const B = { key, zip, spine, types, urls: new Map(), chUrls: new Map(), docs: new Map(), toc: [] };
  // per chapter: text length (for the % shown) and its first line of text (to find where it starts in the clean blocks)
  B.weights = []; B.firsts = [];
  for (const p of spine) {
    const doc = await docAt(B, p), body = doc && (doc.getElementsByTagNameNS('*', 'body')[0] || doc.documentElement);
    B.weights.push(Math.max(1, body ? (body.textContent || '').replace(/\s+/g, ' ').length : 1));
    let first = '';
    if (body) for (const el of Array.from(body.getElementsByTagName('*'))) {
      if (!/^(h[1-6]|p|li|pre|dt|dd|td|blockquote|figcaption)$/i.test(el.localName || '')) continue;
      const k = key4(el.textContent); if (k.length >= 3) { first = k; break; }
    }
    B.firsts.push(first);
  }
  B.cumW = [0]; B.weights.forEach((w, k) => B.cumW.push(B.cumW[k] + w)); B.totalW = B.cumW[B.cumW.length - 1];
  B.spineIdx = new Map(spine.map((p, k) => [p, k]));
  try { B.toc = await readToc(B, navPath, ncxPath); } catch (e) { console.warn('toc', e); }
  B.titles = spine.map(() => '');
  let last = '';
  const firstFor = new Map(); for (const t of B.toc) if (t.i !== undefined && !firstFor.has(t.i)) firstFor.set(t.i, t.t);
  spine.forEach((p, k) => { if (firstFor.has(k)) last = firstFor.get(k); B.titles[k] = last; });
  O.book = B; return B;
}
async function readToc(B, navPath, ncxPath) {
  const out = [];
  const push = (t, href, dir, depth) => {
    t = (t || '').replace(/\s+/g, ' ').trim(); if (!t || !href) return;
    const [file, id] = href.split('#'); const path = file ? resolvePath(dir, file) : null;
    out.push({ t, path, id: id || '', depth, i: B.spineIdx.get(path) });
  };
  if (navPath && B.zip.file(navPath)) {
    const doc = await docAt(B, navPath);
    const navs = Array.from(doc.getElementsByTagNameNS('*', 'nav'));
    const nav = navs.find(n => /\btoc\b/.test(n.getAttributeNS(OPS, 'type') || n.getAttribute('epub:type') || '')) || navs[0];
    if (nav) for (const a of Array.from(nav.getElementsByTagNameNS('*', 'a'))) {
      let d = 0; for (let e = a.parentNode; e && e !== nav; e = e.parentNode) if ((e.localName || '').toLowerCase() === 'ol') d++;
      push(a.textContent, a.getAttribute('href'), dirOf(navPath), Math.max(0, d - 1));
    }
  }
  if (!out.length && ncxPath && B.zip.file(ncxPath)) {
    const ncx = new DOMParser().parseFromString(await B.zip.file(ncxPath).async('string'), 'application/xml');
    for (const np of Array.from(ncx.getElementsByTagNameNS('*', 'navPoint'))) {
      let d = 0; for (let e = np.parentNode; e; e = e.parentNode) if (e.localName === 'navPoint') d++;
      const label = np.getElementsByTagNameNS('*', 'text')[0]?.textContent, src = np.getElementsByTagNameNS('*', 'content')[0]?.getAttribute('src');
      push(label, src, dirOf(ncxPath), d);
    }
  }
  return out;
}
async function docAt(B, path) {
  if (B.docs.has(path)) return B.docs.get(path);
  const f = B.zip.file(path); if (!f) return null;
  const s = await f.async('string');
  let doc = new DOMParser().parseFromString(s, 'application/xhtml+xml');
  if (doc.getElementsByTagName('parsererror').length) doc = new DOMParser().parseFromString(s, 'text/html');
  B.docs.set(path, doc); return doc;
}
function closeBook() {
  const B = O.book; if (!B) return;
  for (const p of [...B.urls.values(), ...B.chUrls.values()]) Promise.resolve(p).then(u => u && URL.revokeObjectURL(u));
  O.book = null;
}

/* ---------- resources -> blob URLs ---------- */
function resUrl(B, path) {
  if (B.urls.has(path)) return B.urls.get(path);
  const p = (async () => {
    const f = B.zip.file(path); if (!f) return '';
    const ext = (path.split('.').pop() || '').toLowerCase(), type = B.types.get(path) || MIME[ext] || 'application/octet-stream';
    if (type === 'text/css' || ext === 'css') return URL.createObjectURL(new Blob([await fixCss(B, await f.async('string'), dirOf(path))], { type: 'text/css' }));
    return URL.createObjectURL(new Blob([await f.async('arraybuffer')], { type }));
  })();
  B.urls.set(path, p); return p;
}
async function fixCss(B, css, dir) {
  const refs = new Set(), RX_URL = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g, RX_IMP = /@import\s+(['"])([^'"]+)\1/g;
  css.replace(RX_URL, (m, q, u) => { if (!isExt(u.trim())) refs.add(u.trim()); });
  css.replace(RX_IMP, (m, q, u) => { if (!isExt(u)) refs.add(u); });
  const map = new Map(); for (const u of refs) map.set(u, await resUrl(B, resolvePath(dir, u)));
  return css.replace(RX_URL, (m, q, u) => map.get(u.trim()) ? `url("${map.get(u.trim())}")` : m)
            .replace(RX_IMP, (m, q, u) => map.get(u) ? `@import url("${map.get(u)}")` : m);
}
/* one chapter as a standalone document: scripts removed, resources pointed at blob URLs */
function chapterUrl(B, i) {
  if (B.chUrls.has(i)) return B.chUrls.get(i);
  const p = (async () => {
    const path = B.spine[i], dir = dirOf(path);
    const s = await B.zip.file(path).async('string');
    let doc = new DOMParser().parseFromString(s, 'application/xhtml+xml'), xmlDoc = true;
    if (doc.getElementsByTagName('parsererror').length) { doc = new DOMParser().parseFromString(s, 'text/html'); xmlDoc = false; }
    const jobs = [];
    const set = (el, attr, u, ns) => { if (u) ns ? el.setAttributeNS(ns, attr, u) : el.setAttribute(attr, u); };
    const fix = (el, attr) => { const v = el.getAttribute(attr); if (v && !isExt(v.trim())) jobs.push(resUrl(B, resolvePath(dir, v.trim())).then(u => set(el, attr, u))); };
    for (const el of Array.from(doc.getElementsByTagName('*'))) {
      const tag = (el.localName || '').toLowerCase();
      if (tag === 'script') { el.remove(); continue; }
      for (const a of Array.from(el.attributes)) if (/^on/i.test(a.name)) el.removeAttribute(a.name);
      if (['img', 'source', 'audio', 'video', 'track', 'embed'].includes(tag)) { el.removeAttribute('srcset'); fix(el, 'src'); }
      if (tag === 'video') fix(el, 'poster');
      if (tag === 'object') fix(el, 'data');
      if (tag === 'link' && /stylesheet/i.test(el.getAttribute('rel') || '')) fix(el, 'href');
      if (tag === 'image' || tag === 'use') {
        const xv = el.getAttributeNS(XLINK, 'href');
        if (xv && !isExt(xv)) jobs.push(resUrl(B, resolvePath(dir, xv)).then(u => set(el, 'xlink:href', u, XLINK)));
        else fix(el, 'href');
      }
      if (tag === 'style') jobs.push(fixCss(B, el.textContent, dir).then(c => { el.textContent = c; }));
      const st = el.getAttribute('style'); if (st && /url\(/i.test(st)) jobs.push(fixCss(B, st, dir).then(c => el.setAttribute('style', c)));
    }
    await Promise.all(jobs);
    let head = doc.getElementsByTagNameNS('*', 'head')[0];
    if (!head) { head = doc.createElementNS(XHTML, 'head'); doc.documentElement.insertBefore(head, doc.documentElement.firstChild); }
    const mk = id => { const e = doc.createElementNS(XHTML, 'style'); e.setAttribute('id', id); return e; };
    head.insertBefore(mk('ks-base'), head.firstChild); head.appendChild(mk('ks-over'));
    const out = xmlDoc ? new XMLSerializer().serializeToString(doc) : '<!DOCTYPE html>' + doc.documentElement.outerHTML;
    return URL.createObjectURL(new Blob([out], { type: xmlDoc ? 'application/xhtml+xml' : 'text/html' }));
  })();
  B.chUrls.set(i, p); return p;
}

/* ---------- theme ---------- */
const rgb = c => { const m = String(c).match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?/); if (!m) return null; let a = m[4] === undefined ? 1 : parseFloat(m[4]) / (String(m[4]).endsWith('%') ? 100 : 1); return [+m[1], +m[2], +m[3], a]; };
const lum = c => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
function theme() {
  const cs = getComputedStyle(document.documentElement), v = n => cs.getPropertyValue(n).trim();
  const probe = document.createElement('i'); probe.style.display = 'none'; document.body.appendChild(probe);
  const toRgb = c => { probe.style.color = ''; probe.style.color = c; return rgb(getComputedStyle(probe).color); };
  const t = { ink: v('--ink'), bg: v('--bg'), link: v('--link'), hl: v('--hl'), scheme: cs.colorScheme || 'light', inkRgb: toRgb(v('--ink')), bgRgb: toRgb(v('--bg')) };
  probe.remove(); t.dark = t.bgRgb ? lum(t.bgRgb) < 0.2 : false; return t;
}
const zoom = () => clamp((S.dev.fontSize || 19) / 18, 0.7, 1.6);
function styleFrame() {
  const d = frameDoc(); if (!d) return; const t = theme();
  const base = d.getElementById('ks-base'), over = d.getElementById('ks-over'); if (!base || !over) return;
  base.textContent = `html{-webkit-text-size-adjust:100%}
body{margin:0;padding:6px 2px 32px;font-family:Charter,"Iowan Old Style","Palatino Linotype",Palatino,Georgia,serif;line-height:1.55;color:${t.ink};overflow-wrap:break-word}
a{color:${t.link}}`;
  over.textContent = `:root{color-scheme:${t.scheme}}
html,body{background:transparent!important;overflow:hidden!important;height:auto!important;min-height:0!important}
body{zoom:${zoom()}}
img,video,svg{max-width:100%!important;box-sizing:border-box}
img{height:auto!important}
pre{white-space:pre-wrap!important;overflow-wrap:anywhere}
table{max-width:100%}
::selection{background:${t.hl}}`;
  fixContrast(d, t);
}
/* keep text readable on the chosen page colour (Apple Books does the same in dark/sepia themes) */
function fixContrast(d, t) {
  const win = d.defaultView; if (!win || !d.body || !t.bgRgb) return;
  for (const el of Array.from(d.querySelectorAll('[data-ks-c]'))) { el.style.removeProperty('color'); el.removeAttribute('data-ks-c'); }
  const bgCache = new Map();
  const bgOf = el => {
    if (!el || el.nodeType !== 1 || el === d.documentElement) return t.bgRgb;
    if (bgCache.has(el)) return bgCache.get(el);
    const c = el === d.body ? null : rgb(win.getComputedStyle(el).backgroundColor);
    const r = c && c[3] > 0.5 ? c : bgOf(el.parentElement); bgCache.set(el, r); return r;
  };
  for (const el of Array.from(d.body.getElementsByTagName('*')).concat(d.body)) {
    let has = false; for (const n of el.childNodes) if (n.nodeType === 3 && n.nodeValue.trim()) { has = true; break; }
    if (!has) continue;
    const fg = rgb(win.getComputedStyle(el).color), bg = bgOf(el); if (!fg || !bg) continue;
    if (contrast(fg, bg) < 3) { el.style.setProperty('color', lum(bg) < 0.25 ? '#E7E3DA' : '#24221E', 'important'); el.setAttribute('data-ks-c', ''); }
  }
}

/* ---------- view ---------- */
const frame = () => $('#oFrame');
const frameDoc = () => { try { return frame()?.contentDocument || null; } catch { return null; } };
function msg(html, actions) {
  $('#oMsg').hidden = false; $('#oMsg').innerHTML = `<p>${html}</p>${actions ? `<div class="orig-acts">${actions}</div>` : ''}`;
  if (actions) { $('#oFrameWrap').hidden = true; $('#oNav').hidden = true; }
}
function hideMsg() { $('#oMsg').hidden = true; $('#oFrameWrap').hidden = false; $('#oNav').hidden = false; }
const want = () => S.view === 'reader' && S.mode === 'read' && isEpub(S.book) && S.settings.view !== 'clean';

function updateSeg() {
  const ep = isEpub(S.book);
  $('#viewSeg').hidden = !ep;
  const orig = ep && S.settings.view !== 'clean';
  $('#viewSeg [data-view="orig"]').setAttribute('aria-pressed', orig);
  $('#viewSeg [data-view="clean"]').setAttribute('aria-pressed', !orig);
}
O.onOpen = () => { O.bc = null; O.jumpFrom = null; updateSeg(); O.sync(true); };
O.sync = (fresh) => {
  if (S.view !== 'reader' || !S.blocks) return;
  updateSeg();
  if (want()) { if (!O.on || fresh) enter(); }
  else if (O.on) leave();
};
O.close = () => { O.on = false; O.tok++; document.body.classList.remove('orig'); const f = frame(); if (f) f.removeAttribute('src'); };

async function enter() {
  O.on = true; document.body.classList.add('orig'); const bk = S.book, tok = ++O.tok;
  $('#fnPop').hidden = true;
  if (!epubOf(bk)) {
    msg(`Để xem cuốn này đúng như trên MacBook (font, hình, khung code của nhà xuất bản), hãy chọn lại file EPUB của nó. Chỉ cần làm một lần, sau đó iPhone cũng xem được.`,
      `<button class="btn primary" type="button" id="oPick">Chọn file EPUB</button><button class="btn" type="button" id="oClean">Dùng bản gọn</button>`);
    $('#oPick').onclick = () => $('#oFile').click();
    $('#oClean').onclick = () => setView('clean');
    updateBar(); return;
  }
  msg('Đang mở bản gốc…');
  try {
    const B = await loadBook(bk); if (tok !== O.tok) return;
    const saved = (() => { try { return JSON.parse(ls.get('opos:' + bk.id) || 'null'); } catch { return null; } })();
    const p = saved && saved.b === S.pos.b && saved.i < B.spine.length ? saved : fromBlock(S.pos.b);
    await render(p.i, { f: p.f });
  } catch (e) {
    console.error(e); if (tok !== O.tok) return;
    msg(esc(e.message || 'Không mở được bản gốc.'), `<button class="btn" type="button" id="oClean">Dùng bản gọn</button>`);
    $('#oClean').onclick = () => setView('clean');
  }
}
function leave() {
  O.on = false; O.tok++; document.body.classList.remove('orig'); $('#jumpBack').hidden = true;
  if (S.blocks) goTo(S.pos.b, 0);
}
function setView(v) { S.settings.view = v; saveSettings(); O.sync(); }

async function render(i, target = {}) {
  const B = O.book; if (!B) return; i = clamp(i, 0, B.spine.length - 1);
  const tok = ++O.tok, f = frame();
  O.i = i; O.target = target; O.restoreUntil = Date.now() + 4000;
  const url = await chapterUrl(B, i); if (tok !== O.tok) return;
  hideMsg(); $('#oMsg').hidden = true;
  f.onload = () => { if (tok !== O.tok) return; setupFrame(); };
  f.style.height = '400px'; f.src = url;
  updateNav(); updateBar();
}
function setupFrame() {
  const d = frameDoc(); if (!d) return;
  styleFrame();
  const win = d.defaultView;
  const refit = () => fit();
  try { new win.ResizeObserver(refit).observe(d.documentElement); } catch {}
  d.addEventListener('load', refit, true);
  d.fonts?.ready?.then(refit);
  d.addEventListener('click', onFrameClick);
  d.addEventListener('keydown', e => { if (['ArrowLeft', 'ArrowRight', 'Escape'].includes(e.key)) document.dispatchEvent(new KeyboardEvent('keydown', { key: e.key })); });
  for (const ev of ['wheel', 'touchstart', 'mousedown', 'keydown']) d.addEventListener(ev, userMoved, { passive: true });
  fit(); place();
}
function userMoved() { O.restoreUntil = 0; }
['wheel', 'touchstart', 'keydown'].forEach(ev => window.addEventListener(ev, userMoved, { passive: true }));
function fit() {
  const d = frameDoc(), f = frame(); if (!d || !d.documentElement || !f) return;
  const h = Math.max(60, Math.ceil(d.documentElement.getBoundingClientRect().height));
  if (Math.abs(f.offsetHeight - h) > 2) { f.style.height = h + 'px'; if (Date.now() < O.restoreUntil) place(); }
}
/* scroll the page to the target inside the current chapter */
function place() {
  const t = O.target || {}, f = frame(), d = frameDoc(); if (!f) return;
  const fr = f.getBoundingClientRect(), H = Math.max(1, fr.height);
  let ratio = clamp(t.f || 0, 0, 1);
  if (t.id && d) {
    const el = d.getElementById(t.id) || d.getElementsByName?.(t.id)?.[0];
    if (el) { const full = Math.max(1, d.documentElement.getBoundingClientRect().height); ratio = clamp((el.getBoundingClientRect().top + (d.scrollingElement?.scrollTop || 0)) / full, 0, 1); }
  }
  O.ignore = true;
  const top = window.scrollY + fr.top + ratio * H - headerBottom() - (ratio === 0 ? 30 : 12);
  window.scrollTo({ top: Math.max(0, top), behavior: 'auto' });
  O.f = ratio; setTimeout(() => { O.ignore = false; }, 120);
}

/* ---------- position ---------- */
function blockCum() {
  if (O.bc && O.bc.n === S.blocks.length) return O.bc;
  const c = new Float64Array(S.blocks.length + 1);
  S.blocks.forEach((b, k) => { c[k + 1] = c[k] + (b.t === 'img' ? 120 : b.t === 'pg' ? 0 : (b.x || '').length); });
  return O.bc = { c, n: S.blocks.length, total: Math.max(1, c[S.blocks.length]) };
}
/* first block of each chapter, found by matching the chapter's first line of text */
function starts() {
  const B = O.book, n = S.blocks.length;
  if (O.st && O.st.B === B && O.st.n === n) return O.st.s;
  const keys = S.blocks.map(b => (b.t === 'p' || b.t === 'h' || b.t === 'c') ? key4(b.x) : '');
  const st = new Array(B.spine.length).fill(-1); let from = 0;
  B.firsts.forEach((f, i) => {
    if (!f) return; const probe = f.slice(0, 40);
    for (let b = from; b < n; b++) { const k = keys[b]; if (k && (k.startsWith(probe) || (k.length >= 12 && probe.startsWith(k)))) { st[i] = b; from = b; break; } }
  });
  // chapters with no text (cover, images) or no match: interpolate by chapter length
  const bc = blockCum();
  for (let i = 0; i < st.length; i++) if (st[i] < 0) {
    let a = i - 1; while (a >= 0 && st[a] < 0) a--; let z = i + 1; while (z < st.length && st[z] < 0) z++;
    const lb = a >= 0 ? st[a] : 0, ub = z < st.length ? st[z] : n, wa = a >= 0 ? B.cumW[a] : 0, wz = z < st.length ? B.cumW[z] : B.totalW;
    const want = bc.c[lb] + (bc.c[ub] - bc.c[lb]) * (B.cumW[i] - wa) / Math.max(1, wz - wa);
    let b = lb; while (b < ub && bc.c[b + 1] <= want) b++; st[i] = Math.max(st[i - 1] ?? 0, b);
  }
  for (let i = 1; i < st.length; i++) if (st[i] < st[i - 1]) st[i] = st[i - 1];
  O.st = { B, n, s: st }; return st;
}
function toBlock(i, f) {
  if (!O.book || !S.blocks.length) return 0;
  const st = starts(), bc = blockCum(), s = st[i], e = i + 1 < st.length ? st[i + 1] : S.blocks.length;
  if (e <= s) return Math.min(s, S.blocks.length - 1);
  const want = bc.c[s] + f * (bc.c[e] - bc.c[s]);
  let b = s; while (b < e - 1 && bc.c[b + 1] <= want) b++;
  return b;
}
function fromBlock(b) {
  const st = starts(), bc = blockCum(); b = clamp(b, 0, S.blocks.length - 1);
  let i = 0;
  // prefer the last chapter that starts at or before b and still contains it
  for (let k = st.length - 1; k >= 0; k--) { const e = k + 1 < st.length ? st[k + 1] : S.blocks.length; if (st[k] <= b && b < e) { i = k; break; } }
  const s = st[i], e = i + 1 < st.length ? st[i + 1] : S.blocks.length;
  return { i, f: e > s ? clamp((bc.c[b] - bc.c[s]) / Math.max(1, bc.c[e] - bc.c[s]), 0, 1) : 0 };
}
const globalPct = () => O.book ? (O.book.cumW[O.i] + O.f * O.book.weights[O.i]) / O.book.totalW : 0;
let raf = false;
window.addEventListener('scroll', () => { if (!O.on || !O.book || O.ignore || raf) return; raf = true; requestAnimationFrame(() => { raf = false; track(); }); }, { passive: true });
function track() {
  const f = frame(); if (!f || $('#oFrameWrap').hidden) return;
  const r = f.getBoundingClientRect(); if (r.height < 10) return;
  O.f = clamp((headerBottom() + 8 - r.top) / r.height, 0, 1);
  const b = toBlock(O.i, O.f);
  try { ls.set('opos:' + S.book.id, JSON.stringify({ i: O.i, f: +O.f.toFixed(4), b })); } catch {}
  if (b !== S.pos.b) { S.pos = { b, s: 0 }; markPos(); }
  updateBar();
}
function updateBar() {
  const B = O.book;
  if (!B) { $('#rSub').textContent = ''; $('#dLabel').textContent = 'Bản gốc'; $('#dPct').textContent = ''; $('#dPrev').disabled = true; $('#dNext').disabled = true; return; }
  const pct = Math.round(globalPct() * 100), title = B.titles[O.i] || '';
  $('#rSub').textContent = `${pct}% · ${title}`;
  $('#progFill').style.width = pct + '%';
  $('#dLabel').textContent = `Chương ${O.i + 1}/${B.spine.length}`;
  $('#dPct').textContent = `${pct}% · ${title}`;
  $('#dPrev').disabled = O.i === 0; $('#dNext').disabled = O.i >= B.spine.length - 1;
}
function updateNav() {
  const B = O.book, last = O.i >= B.spine.length - 1;
  $('#oPrev').hidden = O.i === 0; $('#oNext').disabled = last;
  $('#oNext small').textContent = last ? 'Hết sách' : 'Tiếp theo';
  $('#oNext strong').textContent = last ? 'Bạn đã tới phần cuối cùng.' : (B.titles[O.i + 1] && B.titles[O.i + 1] !== B.titles[O.i] ? B.titles[O.i + 1] : `Chương ${O.i + 2}`);
}
O.next = () => { if (O.book && O.i < O.book.spine.length - 1) render(O.i + 1, { f: 0 }); };
O.prev = () => { if (O.book && O.i > 0) render(O.i - 1, { f: 0 }); };
O.goBlock = b => { if (!O.book) return; const p = fromBlock(b); render(p.i, { f: p.f }); };
function goHref(path, id) {
  const B = O.book; const i = B.spineIdx.get(path); if (i === undefined) return false;
  if (i === O.i && frameDoc()) { O.target = { id }; O.restoreUntil = 0; place(); setTimeout(track, 150); }
  else render(i, { id, f: 0 });
  return true;
}
O.back = () => { const p = O.jumpFrom; O.jumpFrom = null; $('#jumpBack').hidden = true; if (p) render(p.i, { f: p.f }); };

/* links, footnotes */
function isNoteref(a) {
  const ty = (a.getAttributeNS(OPS, 'type') || a.getAttribute('epub:type') || '') + ' ' + (a.getAttribute('role') || '');
  if (/noteref/.test(ty)) return true;
  const txt = (a.textContent || '').trim();
  return /#/.test(a.getAttribute('href') || '') && /^\[?[0-9*†‡§]{1,3}\]?$/.test(txt) && !!a.closest('sup');
}
async function onFrameClick(e) {
  const a = e.target.closest && e.target.closest('a[href]'); if (!a) return;
  e.preventDefault();
  const href = a.getAttribute('href').trim();
  if (/^(https?:|mailto:)/i.test(href)) { window.open(href, '_blank', 'noopener'); return; }
  const B = O.book, cur = B.spine[O.i];
  const [file, id] = href.split('#'); const path = file ? resolvePath(dirOf(cur), file) : cur;
  if (isNoteref(a) && id) {
    const doc = path === cur ? frameDoc() : await docAt(B, path);
    let el = doc && (doc.getElementById(id));
    if (el && !(el.textContent || '').trim().replace(/^\[?\d{1,3}\]?$/, '')) el = el.closest('p,li,aside,div') || el;
    if (el) {
      const clone = el.cloneNode(true);
      for (const x of Array.from(clone.querySelectorAll('a'))) if (/backlink/.test(x.getAttribute('epub:type') || x.getAttribute('role') || '') || /^\[?\d{1,3}\]?$/.test((x.textContent || '').trim())) x.remove();
      $('#fnPopN').textContent = 'Chú thích ' + (a.textContent || '').trim().replace(/[\[\]]/g, '');
      $('#fnPopText').textContent = (clone.textContent || '').replace(/\s+/g, ' ').trim() || 'Không tìm thấy nội dung chú thích.';
      $('#fnPop').hidden = false; return;
    }
  }
  O.jumpFrom = { i: O.i, f: O.f };
  if (goHref(path, id)) { $('#jumpBack').hidden = false; clearTimeout(O.jt); O.jt = setTimeout(() => { $('#jumpBack').hidden = true; }, 30000); }
}

/* table of contents */
O.toc = () => {
  const B = O.book; if (!B) { toast('Chưa mở được bản gốc.'); return; }
  const list = B.toc.length ? B.toc.filter(t => t.i !== undefined) : B.spine.map((p, k) => ({ t: 'Chương ' + (k + 1), i: k, id: '', depth: 0, path: p }));
  let curIdx = -1; list.forEach((t, k) => { if (t.i <= O.i) curIdx = k; });
  O.tocList = list;
  $('#toc').innerHTML = list.map((t, k) => `<li style="${t.depth ? `padding-left:${Math.min(t.depth, 3) * 16}px` : ''}"><button type="button" data-oi="${k}" aria-current="${k === curIdx}"><span class="n">${t.depth ? '·' : k + 1}</span><span>${esc(t.t)}</span></button></li>`).join('');
  document.querySelector('#tocSheet .hint').hidden = true;
  openSheet('#tocSheet');
  const c = $('#toc [aria-current="true"]'); if (c) c.scrollIntoView({ block: 'center' });
};
$('#toc').addEventListener('click', e => {
  const b = e.target.closest('[data-oi]'); if (!b || !O.tocList) return;
  e.stopImmediatePropagation(); closeSheets();
  const t = O.tocList[+b.dataset.oi]; render(t.i, { id: t.id, f: 0 });
}, true);

/* theme / font changes */
O.restyle = () => {
  if (!O.on || !frameDoc()) return;
  const keep = O.f; styleFrame(); O.target = { f: keep }; O.restoreUntil = Date.now() + 1500;
  requestAnimationFrame(() => { fit(); place(); });
};
let rsT = null; window.addEventListener('resize', () => { if (!O.on) return; clearTimeout(rsT); const keep = O.f; rsT = setTimeout(() => { O.target = { f: keep }; O.restoreUntil = Date.now() + 1500; fit(); place(); }, 150); });
try { matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => O.restyle()); } catch {}

/* ---------- controls ---------- */
document.querySelectorAll('#viewSeg [data-view]').forEach(b => b.onclick = () => setView(b.dataset.view));
$('#oNext').onclick = () => O.next();
$('#oPrev').onclick = () => O.prev();
$('#oFile').addEventListener('change', async e => {
  const file = e.target.files[0]; e.target.value = ''; if (!file || !S.book) return;
  if (!/\.epub$/i.test(file.name)) { toast('Hãy chọn file .epub'); return; }
  const bk = S.book;
  msg('Đang lưu file gốc vào tài khoản…');
  try { await O.attach(bk.id, file); if (S.book === bk) { toast('Đã lưu bản gốc'); enter(); } }
  catch (err) { console.error(err); msg(esc(err.message || 'Không lưu được file.'), `<button class="btn primary" type="button" id="oPick">Thử lại</button><button class="btn" type="button" id="oClean">Dùng bản gọn</button>`); $('#oPick').onclick = () => $('#oFile').click(); $('#oClean').onclick = () => setView('clean'); }
});
})();
