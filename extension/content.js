// Content script for dash.choozr.ai — adds the "Export to approver" panel on measurement
// pages, captures front + side editor views, collects validated measurements, uploads to
// Firebase, and shows the AI check result, approval status and the REJECTED tag.

(() => {
  const PANEL_ID = 'cae-panel';
  let currentId = null;
  let busy = false;
  let last = null;            // last status object for this page
  let pollTimer = null;

  // ---------- helpers ----------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const send = (msg) => new Promise((res, rej) => {
    chrome.runtime.sendMessage(msg, (r) => {
      if (chrome.runtime.lastError) return rej(new Error(chrome.runtime.lastError.message));
      if (!r) return rej(new Error('No response from extension'));
      r.ok ? res(r.data ?? r) : rej(new Error(r.error));
    });
  });
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmt = (d) => { if (!d) return ''; const x = new Date(d); return isNaN(x) ? String(d) : x.toLocaleString(); };

  const measurementId = () => (location.pathname.match(/\/measurement\/([a-zA-Z0-9]+)/) || [])[1] || null;
  const customerId = () => (location.pathname.match(/\/customer\/([a-zA-Z0-9]+)/) || [])[1] || null;

  function orderInfo() {
    const h2 = [...document.querySelectorAll('.measurements-wrapper h2')].find((e) => /Order\s*#/.test(e.textContent));
    const text = h2 ? h2.textContent.replace(/\s+/g, ' ').trim() : '';
    return {
      orderNo: (text.match(/Order\s*#\s*(\d+)/) || [])[1] || '',
      customer: ((text.match(/\(([^)]+)\)/) || [])[1] || '').trim(),
      title: text.replace(/\s*metadata\s*$/i, ''),
    };
  }
  function measurementDate() {
    const el = [...document.querySelectorAll('.measurements-wrapper span, .measurements-wrapper input')]
      .find((e) => /\b\d{4}\b.*\d{1,2}:\d{2}/.test(e.value || e.textContent || ''));
    return el ? (el.value || el.textContent).trim() : '';
  }
  const validatedMeasurements = () => [...document.querySelectorAll('.measurement-card.confirmed')].map((c) => ({
    name: (c.querySelector('span')?.textContent || '').trim(),
    value: (c.querySelector('h3')?.textContent || '').trim(),
  })).filter((m) => m.name);
  const allMeasurementsCount = () => document.querySelectorAll('.measurement-card').length;

  // ---------- Flutter editor control (semantics tree) ----------
  const editorFrame = () => document.querySelector('iframe[src*="measurement-editor"]') || document.querySelector('.measurement-editor-wrapper iframe');
  const glassRoot = () => editorFrame()?.contentDocument?.querySelector('flt-glass-pane')?.shadowRoot || null;

  async function ensureSemantics() {
    const sr = glassRoot();
    if (!sr) throw new Error('Measurement editor not found on this page');
    for (let i = 0; i < 20; i++) {
      if (sr.querySelector('flt-semantics[role="button"]')) return sr;
      sr.querySelector('flt-semantics-placeholder')?.click();
      await sleep(250);
    }
    throw new Error('Could not enable editor controls. Reload the page and try again.');
  }
  function viewToggle(sr) {
    const label = [...sr.querySelectorAll('flt-semantics[aria-label]')]
      .find((n) => /^(side|front) photo$/i.test(n.getAttribute('aria-label') || ''));
    if (!label) return null;
    const lr = label.getBoundingClientRect();
    const cx = lr.x + lr.width / 2;
    const btn = [...sr.querySelectorAll('flt-semantics[role="button"]')]
      .map((b) => ({ b, r: b.getBoundingClientRect() })).filter(({ r }) => r.width > 0)
      .sort((a, b) => Math.abs(a.r.x + a.r.width / 2 - cx) - Math.abs(b.r.x + b.r.width / 2 - cx))[0];
    // Label "Side Photo" = front is showing (the button switches to side), and vice versa.
    return { button: btn?.b || label, showing: /^side/i.test(label.getAttribute('aria-label')) ? 'front' : 'side' };
  }
  async function showView(sr, view) {
    const t = viewToggle(sr);
    if (!t) throw new Error('Front/Side toggle not found in editor');
    if (t.showing === view) return;
    t.button.click();
    await sleep(1400); // let Flutter load and draw the other photo
  }

  async function captureEditor() {
    const f = editorFrame();
    f.scrollIntoView({ block: 'start', behavior: 'instant' });
    await sleep(150);
    let r = f.getBoundingClientRect();
    if (r.height > window.innerHeight - 4) { window.scrollBy(0, r.top); await sleep(150); r = f.getBoundingClientRect(); }
    const x0 = Math.max(0, r.left), y0 = Math.max(0, r.top);
    const x1 = Math.min(window.innerWidth, r.right), y1 = Math.min(window.innerHeight, r.bottom);
    const rect = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    if (rect.w < 100 || rect.h < 100) throw new Error('Editor is not visible — scroll it into view and try again');
    return send({ type: 'capture', rect, dpr: window.devicePixelRatio || 1 });   // base64 JPEG
  }

  // ---------- export ----------
  async function doExport() {
    if (busy) return;
    const id = measurementId();
    if (!id) return toast('Open a measurement page first', 'err');
    const ms = validatedMeasurements();
    if (!ms.length && !confirm('No measurement is validated (green tick) yet. Export anyway?')) return;
    if (last?.status === 'approved' && !confirm('This order is already APPROVED. Export a new version for approval again?')) return;
    busy = true;
    const panel = document.getElementById(PANEL_ID);
    panel.classList.add('cae-busy');
    const hide = async () => { panel.style.visibility = 'hidden'; await sleep(80); };
    try {
      setSub('Preparing editor…');
      const sr = await ensureSemantics();
      await showView(sr, 'front');
      setSub('Capturing front…'); await hide();
      const front = await captureEditor();
      panel.style.visibility = '';
      setSub('Capturing side…');
      await showView(sr, 'side'); await hide();
      const side = await captureEditor();
      panel.style.visibility = '';
      await showView(sr, 'front');

      setSub('Uploading…');
      const info = orderInfo();
      setSub('Uploading + AI check…');
      const s = await send({ type: 'export', payload: {
        id, customerId: customerId(), orderNo: info.orderNo, customer: info.customer, title: info.title,
        measuredAt: measurementDate(), pageUrl: location.href.split('#')[0],
        totalCount: allMeasurementsCount(), measurements: ms, front, side,
      } });
      toast(`Exported v${s.version} to the approver`, 'ok');
      render(s);
      schedulePoll(20000);
    } catch (e) {
      console.error('[Choozr export]', e);
      toast('Export failed: ' + e.message, 'err');
      setSub('');
    } finally {
      panel.style.visibility = '';
      panel.classList.remove('cae-busy');
      busy = false;
    }
  }

  // ---------- UI ----------
  function ensurePanel() {
    let p = document.getElementById(PANEL_ID);
    if (p) return p;
    p = document.createElement('div');
    p.id = PANEL_ID;
    p.innerHTML = `
      <div class="cae-head"><span class="cae-status" id="cae-status">…</span><button class="cae-min" id="cae-min" title="Minimise">–</button></div>
      <div class="cae-body">
        <div class="cae-sub" id="cae-sub"></div>
        <div class="cae-ai" id="cae-ai"></div>
        <div class="cae-row">
          <button class="cae-btn" id="cae-export">Export to approver</button>
          <button class="cae-gear" id="cae-settings" title="Settings">⚙</button>
        </div>
      </div>`;
    document.body.appendChild(p);
    p.querySelector('#cae-export').addEventListener('click', doExport);
    p.querySelector('#cae-settings').addEventListener('click', () => send({ type: 'openOptions' }).catch(() => {}));
    p.querySelector('#cae-min').addEventListener('click', () => p.classList.toggle('cae-collapsed'));
    p.querySelector('#cae-ai').addEventListener('click', async (e) => {
      if (!e.target.closest('[data-recheck]')) return;
      try { renderAi({ status: 'running' }); render(await send({ type: 'recheck', id: currentId })); toast('AI re-checked', 'ok'); } catch (err) { toast(err.message, 'err'); }
    });
    return p;
  }
  const setSub = (t) => { const s = document.getElementById('cae-sub'); if (s) s.textContent = t; };
  function toast(msg, kind) {
    const t = document.createElement('div');
    t.className = 'cae-toast ' + (kind || '');
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.classList.add('show'), 10);
    setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, kind === 'err' ? 6000 : 3000);
  }

  function renderAi(ai, version) {
    const el = document.getElementById('cae-ai');
    if (!el) return;
    if (!ai) { el.innerHTML = ''; return; }
    if (ai.status === 'queued' || ai.status === 'running') { el.innerHTML = `<div class="cae-ai-run"><i class="cae-spin"></i>AI is checking the points…</div>`; return; }
    if (ai.status === 'error') { el.innerHTML = `<div class="cae-ai-bad">AI check failed: ${esc(ai.error)} <a data-recheck>retry</a></div>`; return; }
    if (ai.status !== 'done') { el.innerHTML = ''; return; }
    const cls = ai.verdict === 'ok' ? 'ok' : ai.verdict === 'check' ? 'warn' : 'bad';
    const label = ai.verdict === 'ok' ? '✓ Points look correct' : ai.verdict === 'check' ? '? Needs a look' : '✗ Points look wrong';
    const stale = ai.forVersion !== version ? ' (previous version)' : '';
    el.innerHTML = `
      <div class="cae-ai-v cae-${cls}">AI ${label} · ${ai.score ?? '–'}%${stale}</div>
      ${ai.summary ? `<div class="cae-ai-sum">${esc(ai.summary)}</div>` : ''}
      ${(ai.issues || []).length ? `<ul class="cae-ai-list">${ai.issues.slice(0, 5).map((i) =>
        `<li class="sev-${esc(i.severity)}"><b>${esc(i.measurement)}</b>${i.view && i.view !== 'unknown' ? ` <span>(${esc(i.view)})</span>` : ''}: ${esc(i.problem)}</li>`).join('')}</ul>` : ''}
      <a class="cae-link" data-recheck>Re-run AI</a>`;
    highlightCards(ai);
  }

  // Outline measurement cards the AI flagged so the coordinator can find them fast.
  function highlightCards(ai) {
    document.querySelectorAll('.measurement-card.cae-flag').forEach((c) => { c.classList.remove('cae-flag'); c.removeAttribute('data-cae'); });
    const names = new Map((ai?.issues || []).map((i) => [i.measurement.toLowerCase().trim(), i.problem]));
    if (!names.size) return;
    for (const c of document.querySelectorAll('.measurement-card')) {
      const n = (c.querySelector('span')?.textContent || '').toLowerCase().trim();
      if (names.has(n)) { c.classList.add('cae-flag'); c.setAttribute('data-cae', 'AI: ' + names.get(n)); }
    }
  }

  function render(s) {
    last = s;
    const el = document.getElementById('cae-status');
    if (!el) return;
    el.className = 'cae-status';
    removeTag();
    if (!s || !s.status) { el.textContent = 'Not exported yet'; setSub(''); renderAi(null); return; }
    el.classList.add('cae-' + s.status);
    const v = s.version ? ` · v${s.version}` : '';
    if (s.status === 'pending') { el.textContent = `Waiting for approval${v}`; setSub('Exported ' + fmt(s.exportedAt)); }
    else if (s.status === 'approved') { el.textContent = `APPROVED${v}`; setSub(`by ${s.decidedBy || '—'} · ${fmt(s.decidedAt)}`); }
    else if (s.status === 'archived') { el.textContent = `ARCHIVED${v}`; setSub(`approved by ${s.decidedBy || '—'} · archived, will be deleted`); }
    else if (s.status === 'rejected') { el.textContent = `REJECTED${v}`; setSub(`by ${s.decidedBy || '—'} · ${fmt(s.decidedAt)}`); showRejectedTag(s); }
    renderAi(s.ai, s.version);
  }
  const removeTag = () => document.getElementById('cae-tag')?.remove();
  function showRejectedTag(s) {
    const tag = document.createElement('div');
    tag.id = 'cae-tag';
    tag.innerHTML = `<b>REJECTED</b> by ${esc(s.decidedBy || 'approver')} · ${esc(fmt(s.decidedAt))}` +
      (s.reason ? ` — <i>${esc(s.reason)}</i>` : '') +
      ` <span>Rework the points, then press “Export to approver” again to resend.</span>`;
    (document.querySelector('.measurements-wrapper') || document.body).prepend(tag);
  }

  // ---------- status polling ----------
  function schedulePoll(ms) { clearTimeout(pollTimer); pollTimer = setTimeout(poll, ms); }
  async function poll() {
    const id = measurementId();
    if (!id || id !== currentId) return;
    if (document.hidden) return schedulePoll(5000);
    try {
      const s = await send({ type: 'status', id });
      if (id !== currentId) return;
      render(s);
      const aiBusy = s?.ai && (s.ai.status === 'queued' || s.ai.status === 'running');
      schedulePoll(aiBusy ? 4000 : s?.status === 'pending' ? 20000 : 60000);
    } catch (e) {
      const el = document.getElementById('cae-status');
      if (el) { el.className = 'cae-status cae-warn'; el.textContent = /sign in|Session|role/i.test(e.message) ? 'Sign in (⚙)' : 'Offline'; }
      setSub(e.message);
      schedulePoll(30000);
    }
  }

  function onRoute() {
    const id = measurementId();
    if (!id) { document.getElementById(PANEL_ID)?.remove(); removeTag(); currentId = null; clearTimeout(pollTimer); return; }
    ensurePanel();
    if (id === currentId) return;
    currentId = id;
    last = null;
    removeTag();
    render(null);
    document.getElementById('cae-status').textContent = 'Loading…';
    schedulePoll(0);
  }
  setInterval(onRoute, 1000);   // SPA navigation
  onRoute();
})();
