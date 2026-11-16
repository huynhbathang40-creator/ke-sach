/* Kệ Sách · "Bản gốc" for PDF and plain text / Markdown.
   PDF: every page is drawn exactly as in the file (pdf.js canvas) with an invisible text layer on top,
   rendered lazily as you scroll. Sentences of the clean view are matched to the text layer so Listen
   can highlight them on the page; translations appear in a box under each page.
   TXT/MD: the file's own text, line breaks kept, with the same highlighting and translation.
   Uses orig.js internals through O._ and the main script's globals through window.KS. */
(() => {
'use strict';
const { S, $, esc, toast, markPos, goTo, headerBottom, loadScript, ls, sentencesOf, activeLang, play, primeAudio } = window.KS;
const O = window.O, _ = O._;
const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';
const clamp = _.clamp, key4 = _.key4;
const P = window.OP = { book: null, pages: [], items: [], tok: 0, io: null, lastI: -1 };
const box = () => $('#oDoc');

/* ---------- loading ---------- */
async function getBlob(key) {
  let blob = await _.idb.get(key);
  if (!blob) {
    _.msg('Đang tải bản gốc của sách…');
    const A = await _.assets(); if (!A || !A.download) throw new Error('Không tải được file gốc.');
    blob = await A.download(key); _.idb.set(key, blob);
  }
  return blob;
}
const isHeader = t => /[|│]\s*\d{1,4}\s*$|^\s*\d{1,4}\s*[|│]/.test(t) || /^\s*(page\s*)?\d{1,4}\s*$/i.test(t);
async function loadPdf(bk) {
  const key = _.epubOf(bk);
  if (P.book && P.book.key === key) return P.book;
  const blob = await getBlob(key);
  await loadScript(PDFJS + 'pdf.min.js');
  const lib = window.pdfjsLib; lib.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.js';
  const pdf = await lib.getDocument({ data: new Uint8Array(await blob.arrayBuffer()), isEvalSupported: false }).promise;
  const n = pdf.numPages;
  // page sizes, text length and first line of every page: computed once, then kept on this device
  let meta = await _.idb.get('meta:' + key);
  if (!meta || meta.v !== 1 || meta.n !== n) {
    meta = { v: 1, n, sizes: [], weights: [], firsts: [] };
    for (let p = 1; p <= n; p++) {
      const page = await pdf.getPage(p), vp = page.getViewport({ scale: 1 });
      meta.sizes.push([vp.width, vp.height]);
      const tc = await page.getTextContent(); const lines = []; let cur = '';
      for (const it of tc.items) { if (!('str' in it)) continue; cur += it.str; if (it.hasEOL) { lines.push(cur); cur = ''; } }
      if (cur) lines.push(cur);
      meta.weights.push(lines.reduce((s, l) => s + key4(l).length, 0));
      let first = ''; const li = lines.findIndex(l => key4(l).length >= 16 && !isHeader(l));
      if (li >= 0) for (let k = li; k < lines.length && first.length < 60; k++) if (!isHeader(lines[k])) first += key4(lines[k]);
      meta.firsts.push(first);
      page.cleanup();
      if (p % 10 === 0 || p === n) _.msg(`Đang chuẩn bị bản gốc lần đầu: trang ${p}/${n}`);
    }
    _.idb.set('meta:' + key, meta);
  }
  const weights = meta.weights.map(w => Math.max(1, w)), cumW = [0];
  weights.forEach((w, k) => cumW.push(cumW[k] + w));
  const toc = [];
  try {
    const walk = async (items, depth) => {
      for (const it of items || []) {
        let i;
        try { let d = it.dest; if (typeof d === 'string') d = await pdf.getDestination(d); if (d && d[0] != null) i = typeof d[0] === 'number' ? d[0] : await pdf.getPageIndex(d[0]); } catch {}
        if (i !== undefined && (it.title || '').trim()) toc.push({ t: it.title.trim(), i, depth, f: 0 });
        if (it.items && it.items.length && depth < 2) await walk(it.items, depth + 1);
      }
    };
    await walk(await pdf.getOutline(), 0);
  } catch (e) { console.warn('outline', e); }
  const titles = []; let last = ''; const firstFor = new Map();
  for (const t of toc) if (!firstFor.has(t.i)) firstFor.set(t.i, t.t);
  for (let i = 0; i < n; i++) { if (firstFor.has(i)) last = firstFor.get(i); titles.push(last); }
  return P.book = { key, kind: 'pdf', pdf, lib, n, sizes: meta.sizes, spine: Array.from({ length: n }, (x, i) => i), weights, cumW, totalW: cumW[n], firsts: meta.firsts, sub: true, toc, titles };
}
async function loadText(bk) {
  const key = _.epubOf(bk);
  if (P.book && P.book.key === key) return P.book;
  const text = await (await getBlob(key)).text();
  const w = Math.max(1, key4(text).length);
  return P.book = { key, kind: 'text', md: bk.format === 'md', text, n: 1, spine: [0], weights: [w], cumW: [0, w], totalW: w, firsts: [''], toc: [], titles: [''] };
}

/* ---------- layout ---------- */
P.zoom = () => clamp((S.dev.fontSize || 19) / 19, 0.6, 2.4);
const baseW = () => Math.min(Math.max(280, (box().clientWidth || $('#orig').clientWidth || 700) - 0), 980);
const pageW = () => Math.round(baseW() * P.zoom());
function build(B) {
  const el = box(); el.innerHTML = ''; P.pages = []; P.items = []; P.lastI = -1;
  if (P.io) { P.io.disconnect(); P.io = null; }
  if (B.kind === 'pdf') {
    const w = pageW(), frag = document.createDocumentFragment();
    for (let i = 0; i < B.n; i++) {
      const [vw, vh] = B.sizes[i];
      const pg = document.createElement('div'); pg.className = 'opg'; pg.dataset.i = i;
      pg.style.width = w + 'px'; pg.style.height = Math.round(w * vh / vw) + 'px';
      const vi = document.createElement('div'); vi.className = 'opg-vi'; vi.hidden = true; vi.style.maxWidth = w + 'px';
      frag.append(pg, vi); P.pages.push({ el: pg, vi, state: 0, items: [] });
    }
    el.appendChild(frag);
    P.io = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) renderPage(+e.target.dataset.i); }), { rootMargin: '1500px 0px' });
    P.pages.forEach(p => P.io.observe(p.el));
  } else buildText(B);
}
async function renderPage(i) {
  const pg = P.pages[i], B = P.book; if (!pg || pg.state || !B || B.kind !== 'pdf') return;
  pg.state = 1; const tok = P.tok;
  try {
    const page = await B.pdf.getPage(i + 1); if (tok !== P.tok) return;
    const base = page.getViewport({ scale: 1 }), vp = page.getViewport({ scale: pageW() / base.width });
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cv = document.createElement('canvas'); cv.width = Math.floor(vp.width * dpr); cv.height = Math.floor(vp.height * dpr);
    await page.render({ canvasContext: cv.getContext('2d'), viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null }).promise;
    if (tok !== P.tok || pg.state !== 1) return;
    const tl = document.createElement('div'); tl.className = 'textLayer'; tl.style.setProperty('--scale-factor', vp.scale);
    const tc = await page.getTextContent(), divs = [];
    await B.lib.renderTextLayer({ textContentSource: tc, container: tl, viewport: vp, textDivs: divs }).promise;
    if (tok !== P.tok || pg.state !== 1) return;
    pg.el.replaceChildren(cv, tl); pg.state = 2; pg.divs = divs;
    page.cleanup();
    try { pg.items = wrapEls(divs.filter(d => d.textContent.trim()), i, i); } catch (e) { console.warn('wrap page', e); }
    if (S.settings.lang !== 'en') fillVi(i);
    if (S.mode === 'listen' && (P.pendingHL === i || pageOf(S.pos.b) === i)) { const sc = P.pendingHL === i ? P.hlScroll : false; P.pendingHL = null; P.highlight(sc); }
  } catch (e) { console.warn('page', i, e); if (pg.state === 1) pg.state = 0; }
}
function unrenderFar() {
  for (let k = 0; k < P.pages.length; k++) {
    const pg = P.pages[k];
    if (pg.state === 2 && Math.abs(k - O.i) > 8) { pg.el.replaceChildren(); pg.state = 0; pg.divs = null; pg.items = []; }
  }
}
function buildText(B) {
  const wrap = document.createElement('div'); wrap.className = 'otext';
  wrap.style.fontSize = (S.dev.fontSize || 19) + 'px';
  const paras = B.text.replace(/\r\n?/g, '\n').split(/\n[ \t]*\n/);
  const frag = document.createDocumentFragment(), els = [];
  for (const t of paras) { if (!t.trim()) continue; const d = document.createElement('div'); d.className = 'otp'; d.textContent = t.replace(/^\n+|\n+$/g, ''); frag.appendChild(d); els.push(d); }
  wrap.appendChild(frag); box().appendChild(wrap);
  try { P.items = wrapEls(els, 0, 0); } catch (e) { console.warn('wrap text', e); }
}

/* match elements to the clean blocks of pages/chapters i..j and wrap every sentence in a span */
function wrapEls(els, i, j) {
  const st = _.starts(), s = st[i], e = j + 1 < st.length ? st[j + 1] : S.blocks.length;
  const cum = new Map();
  const sentCum = b => { if (cum.has(b)) return cum.get(b); const c = [0]; for (const x of sentencesOf(b, 'en')) c.push(c[c.length - 1] + key4(x).length); cum.set(b, c); return c; };
  const items = _.alignChapter(els, Math.max(0, s - 3), Math.min(S.blocks.length, e + 3));
  for (const { el, parts } of items) {
    el.setAttribute('data-ksb', [...new Set(parts.map(p => p.b))].join(' '));
    const segs = [];
    for (const p of parts) {
      if (S.blocks[p.b].t === 'c') continue;
      const c = sentCum(p.b);
      for (let k = 0; k + 1 < c.length; k++) {
        const a = Math.max(c[k], p.bFrom), z = Math.min(c[k + 1], p.bFrom + p.len);
        if (z > a) segs.push({ from: p.elFrom + a - p.bFrom, to: p.elFrom + z - p.bFrom, b: p.b, s: k });
      }
    }
    if (segs.length) _.wrapText(el, segs);
  }
  return items.map(x => ({ ...x, orig: null }));
}

/* ---------- open / close ---------- */
P.enter = async (bk, tok) => {
  try {
    const B = bk.format === 'pdf' ? await loadPdf(bk) : await loadText(bk);
    if (tok !== O.tok) return;
    if (O.book && O.book !== B) _.closeBook();
    O.book = B; O.st = null; O.bc = null; P.tok++;
    _.hideMsg(); $('#oMsg').hidden = true;
    build(B);
    const saved = (() => { try { return JSON.parse(ls.get('opos:' + bk.id) || 'null'); } catch { return null; } })();
    const p = saved && saved.b === S.pos.b && saved.i < B.spine.length ? saved : _.fromBlock(S.pos.b);
    P.go(p.i, p.f);
    if (S.settings.lang !== 'en') P.applyLang();
    if (S.mode === 'listen') setTimeout(() => P.highlight(false), 300);
  } catch (e) {
    console.error(e); if (tok !== O.tok) return;
    _.msg(esc(e.message || 'Không mở được bản gốc.'), `<button class="btn" type="button" id="oClean">Dùng bản gọn</button>`);
    $('#oClean').onclick = () => _.setView('clean');
  }
};
P.close = () => { P.tok++; if (P.io) { P.io.disconnect(); P.io = null; } const el = box(); if (el) el.innerHTML = ''; P.pages = []; P.items = []; document.body.classList.remove('orig-paged'); };

/* ---------- position ---------- */
const pageOf = b => _.fromBlock(b).i;
function scrollToY(y) { O.ignore = true; window.scrollTo({ top: Math.max(0, y), behavior: 'auto' }); setTimeout(() => { O.ignore = false; }, 150); }
P.go = (i, f = 0) => {
  const B = P.book; if (!B) return;
  i = clamp(i, 0, B.n - 1); O.i = i; O.f = f;
  const el = B.kind === 'pdf' ? P.pages[i].el : box().firstElementChild; if (!el) return;
  const r = el.getBoundingClientRect();
  scrollToY(scrollY + r.top + f * r.height - headerBottom() - (f ? 12 : 2));
  if (B.kind === 'pdf') { renderPage(i); if (i + 1 < B.n) renderPage(i + 1); }
  P.updateBar(); setTimeout(P.track, 200);
};
P.goBlock = b => { const p = _.fromBlock(b); P.go(p.i, p.f); };
P.track = () => {
  const B = P.book; if (!B || !O.on) return;
  const lim = headerBottom() + 8;
  if (B.kind === 'pdf') {
    let i = clamp(O.i, 0, B.n - 1), r = P.pages[i].el.getBoundingClientRect();
    while (i + 1 < B.n && r.bottom + 18 < lim) { i++; r = P.pages[i].el.getBoundingClientRect(); }
    while (i > 0 && r.top > lim) { i--; r = P.pages[i].el.getBoundingClientRect(); }
    O.i = i; O.f = clamp((lim - r.top) / Math.max(1, r.height), 0, 1);
    if (i !== P.lastI) { P.lastI = i; unrenderFar(); renderPage(i); if (S.settings.lang !== 'en') O.ensureChapterTr(i, Math.min(B.n - 1, i + 2)); }
  } else {
    const r = box().getBoundingClientRect(); O.i = 0; O.f = clamp((lim - r.top) / Math.max(1, r.height), 0, 1);
  }
  const b = _.toBlock(O.i, O.f);
  try { ls.set('opos:' + S.book.id, JSON.stringify({ i: O.i, f: +O.f.toFixed(4), b })); } catch {}
  if (S.mode !== 'listen' && b !== S.pos.b) { S.pos = { b, s: 0 }; markPos(); }
  P.updateBar();
};
P.updateBar = () => {
  const B = P.book; if (!B) return;
  const pct = Math.round(_.globalPct() * 100), title = B.titles[O.i] || (S.sections && S.blocks ? (S.sections[window.KS.sectionOf(Math.min(S.pos.b, S.blocks.length - 1))] || {}).title || '' : '');
  $('#rSub').textContent = `${pct}% · ${title}`;
  $('#progFill').style.width = pct + '%';
  $('#dLabel').textContent = B.kind === 'pdf' ? `Trang ${O.i + 1}/${B.n}` : 'Bản gốc';
  $('#dPct').textContent = `${pct}% · ${title}`;
  $('#dPrev').disabled = B.kind !== 'pdf' || O.i === 0; $('#dNext').disabled = B.kind !== 'pdf' || O.i >= B.n - 1;
};
P.fallbackToc = () => (S.sections || []).map(sec => { const p = _.fromBlock(sec.b); return { t: sec.title, i: p.i, f: p.f, depth: 0 }; });

/* ---------- listening ---------- */
P.clearHL = () => { const el = box(); if (el) for (const x of Array.from(el.querySelectorAll('.ks-on'))) x.classList.remove('ks-on'); };
P.highlight = (scroll = true) => {
  const B = P.book; if (!B || !S.blocks) return;
  const b = S.pos.b, bl = S.blocks[b]; if (!bl) return;
  P.clearHL();
  const root = box(), vi = activeLang() === 'vi' && S.tr.has(b);
  let els = bl.t === 'c' ? [] : Array.from(root.querySelectorAll(`.ks-sn[data-b="${b}"][data-s="${S.pos.s}"]${vi ? '[data-l="vi"]' : ':not([data-l])'}`));
  if (!els.length) els = Array.from(root.querySelectorAll('[data-ksb]')).filter(x => x.getAttribute('data-ksb').split(' ').includes(String(b)));
  if (!els.length) {
    if (B.kind === 'pdf') {
      const i = pageOf(b), pg = P.pages[i];
      if (pg && pg.state !== 2) { P.pendingHL = i; P.hlScroll = scroll; if (scroll) P.go(i, _.fromBlock(b).f); renderPage(i); }
    }
    return;
  }
  els.forEach(x => x.classList.add('ks-on'));
  const r0 = els[0].getBoundingClientRect(), bot = els[els.length - 1].getBoundingClientRect().bottom;
  if (B.kind === 'pdf') { const pgEl = els[0].closest('.opg'); if (pgEl) { const i = +pgEl.dataset.i, pr = pgEl.getBoundingClientRect(); O.i = i; O.f = clamp((r0.top - pr.top) / Math.max(1, pr.height), 0, 1); } }
  P.updateBar();
  if (scroll) {
    const topLim = headerBottom() + 16, botLim = innerHeight - ($('#player').offsetHeight || 0) - 24;
    if (r0.top < topLim || bot > botLim) {
      O.ignore = true;
      window.scrollTo({ top: Math.max(0, scrollY + r0.top - topLim - (botLim - topLim) * 0.25), behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      setTimeout(() => { O.ignore = false; }, 700);
    }
  }
};
box().addEventListener('click', e => {
  if (S.mode !== 'listen' || !O.on) return;
  if (getSelection && String(getSelection()).trim()) return;
  const sn = e.target.closest('.ks-sn'), blk = e.target.closest('[data-ksb]');
  const b = sn ? +sn.getAttribute('data-b') : blk ? +blk.getAttribute('data-ksb').split(' ')[0] : NaN;
  if (!Number.isFinite(b)) return;
  primeAudio(); goTo(b, sn ? +sn.getAttribute('data-s') : 0, { scroll: false }); if (!S.playing) play();
});

/* ---------- Vietnamese ---------- */
function viSpans(bs) {
  const frag = document.createDocumentFragment();
  bs.forEach((b, k) => {
    if (k) frag.appendChild(document.createTextNode(' '));
    sentencesOf(b, 'vi').forEach((x, j) => {
      if (j) frag.appendChild(document.createTextNode(' '));
      const sp = document.createElement('span'); sp.className = 'ks-sn'; sp.dataset.b = b; sp.dataset.s = j; sp.dataset.l = 'vi'; sp.textContent = x; frag.appendChild(sp);
    });
  });
  return frag;
}
/* PDF: the translation of the paragraphs that start on a page, in a box under that page */
function fillVi(i) {
  const pg = P.pages[i]; if (!pg) return;
  if (S.settings.lang === 'en') { pg.vi.hidden = true; pg.vi.replaceChildren(); return; }
  const st = _.starts(), s = st[i], e = i + 1 < st.length ? st[i + 1] : S.blocks.length;
  const frag = document.createDocumentFragment(); let n = 0;
  for (let b = s; b < e; b++) {
    const bl = S.blocks[b]; if (!bl || (bl.t !== 'p' && bl.t !== 'h') || !S.tr.has(b)) continue;
    const p = document.createElement('p'); if (bl.t === 'h') p.className = 'h'; p.appendChild(viSpans([b])); frag.appendChild(p); n++;
  }
  pg.vi.replaceChildren(frag); pg.vi.hidden = !n; pg.vi.style.maxWidth = pageW() + 'px';
}
/* text files: like the EPUB view, replace (Tiếng Việt) or add under (Anh–Việt) each paragraph */
function textLang() {
  const L = S.settings.lang, root = box();
  for (const x of Array.from(root.querySelectorAll('.ks-vi'))) x.remove();
  for (const it of P.items) {
    const el = it.el;
    if (it.orig) { el.replaceChildren(...it.orig); it.orig = null; }
    if (L === 'en') continue;
    const bs = [...new Set(it.parts.map(p => p.b))];
    if (bs.some(b => S.blocks[b].t !== 'p' && S.blocks[b].t !== 'h')) continue;
    const covered = bs.every(b => it.parts.filter(p => p.b === b).reduce((n, p) => n + p.len, 0) >= key4(S.blocks[b].x).length);
    if (!covered || !bs.every(b => S.tr.has(b))) continue;
    if (L === 'vi') { it.orig = Array.from(el.childNodes); el.replaceChildren(viSpans(bs)); }
    else { const d = document.createElement('div'); d.className = 'otp ks-vi'; d.appendChild(viSpans(bs)); el.after(d); }
  }
}
P.applyLang = () => {
  const B = P.book; if (!B) return;
  const keep = { i: O.i, f: O.f };
  if (B.kind === 'pdf') { P.pages.forEach((pg, i) => { if (pg.state === 2 || !pg.vi.hidden) fillVi(i); }); O.ensureChapterTr(O.i, Math.min(B.n - 1, O.i + 2)); }
  else { textLang(); O.ensureChapterTr(0, 0); }
  if (B.kind === 'text') P.go(keep.i, keep.f);
};
let trT = null;
P.onTr = () => {
  if (!P.book || S.settings.lang === 'en') return;
  clearTimeout(trT);
  trT = setTimeout(() => {
    const B = P.book; if (!B) return;
    if (B.kind === 'pdf') { const anchor = P.pages[O.i]?.el, before = anchor ? anchor.getBoundingClientRect().top : 0; P.pages.forEach((pg, i) => { if (pg.state === 2) fillVi(i); }); if (anchor) { const d = anchor.getBoundingClientRect().top - before; if (Math.abs(d) > 1) { O.ignore = true; scrollBy(0, d); setTimeout(() => { O.ignore = false; }, 150); } } }
    else { const keep = { i: O.i, f: O.f }; textLang(); P.go(keep.i, keep.f); }
    if (S.mode === 'listen') P.highlight(false);
  }, 150);
};

/* ---------- zoom / resize ---------- */
let rsT = null;
P.restyle = () => { clearTimeout(rsT); rsT = setTimeout(restyleNow, 200); };
function restyleNow() {
  const B = P.book; if (!B || !O.on) return;
  const keep = { i: O.i, f: O.f };
  if (B.kind === 'pdf') { P.tok++; build(B); if (S.settings.lang !== 'en') P.pages.forEach((pg, i) => fillVi(i)); }
  else { const w = box().querySelector('.otext'); if (w) w.style.fontSize = (S.dev.fontSize || 19) + 'px'; }
  requestAnimationFrame(() => P.go(keep.i, keep.f));
}
})();
