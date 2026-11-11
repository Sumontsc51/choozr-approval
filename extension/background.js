// Service worker: screenshot capture, export to Firestore, AI check, and a small background
// "worker" (every 5 min) that runs queued AI re-checks, Claude learning jobs and the 7-day
// image cleanup. Everything runs on the free Firebase plan — no Cloud Functions.
importScripts('firebase-client.js', 'ai-core.js', 'ai-claude.js');

const MIN_SAMPLES = 15;
const IMAGE_MAX_B64 = 900_000;       // Firestore doc limit is 1 MiB

chrome.runtime.onInstalled.addListener(() => chrome.alarms.create('worker', { periodInMinutes: 5 }));
chrome.runtime.onStartup.addListener(() => chrome.alarms.create('worker', { periodInMinutes: 5 }));
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'worker') runWorker(); });
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      let data;
      switch (msg.type) {
        case 'capture': data = await capture(sender.tab.windowId, msg.rect, msg.dpr); break;
        case 'export': data = await exportOrder(msg.payload); break;
        case 'status': data = await status(msg.id); break;
        case 'recheck': data = await recheckOrder(msg.id); break;
        case 'whoami': data = await FB.currentUser(); break;
        case 'openOptions': chrome.runtime.openOptionsPage(); data = true; break;
        default: throw new Error('unknown message');
      }
      sendResponse({ ok: true, data });
    } catch (e) {
      sendResponse({ ok: false, error: String((e && e.message) || e) });
    }
  })();
  return true;
});

// ---------------------------------------------------------------- capture
async function capture(windowId, rect, dpr) {
  const shot = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
  const bmp = await createImageBitmap(await (await fetch(shot)).blob());
  const sx = Math.max(0, Math.round(rect.x * dpr)), sy = Math.max(0, Math.round(rect.y * dpr));
  const sw = Math.min(bmp.width - sx, Math.round(rect.w * dpr)), sh = Math.min(bmp.height - sy, Math.round(rect.h * dpr));
  if (sw <= 0 || sh <= 0) throw new Error('Editor is not visible in the window');
  // keep it small enough for one Firestore document (free plan has no file storage)
  let scale = Math.min(1, 1400 / Math.max(sw, sh));
  for (let attempt = 0; attempt < 6; attempt++) {
    const w = Math.round(sw * scale), h = Math.round(sh * scale);
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, w, h);
    const quality = [0.85, 0.78, 0.7, 0.7, 0.65, 0.6][attempt];
    const b64 = await blobToB64(await canvas.convertToBlob({ type: 'image/jpeg', quality }));
    if (b64.length <= IMAGE_MAX_B64) return b64;
    scale *= 0.85;
  }
  throw new Error('Image too large even after compression');
}
async function blobToB64(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return btoa(bin);
}

// ---------------------------------------------------------------- export
async function exportOrder(p) {
  const me = await FB.currentUser();
  if (!me) throw new Error('Not signed in. Click the extension icon and sign in.');
  const profile = await FB.get(`users/${me.uid}`);
  if (!profile || !['coordinator', 'admin'].includes(profile.data.role)) throw new Error('This account needs the coordinator role (admin sets it in the app → Team).');

  const id = p.id;
  const prev = await FB.get(`orders/${id}`);
  const version = (prev?.data.version || 0) + 1;
  const now = new Date();
  const measurements = (p.measurements || []).map((m) => ({ name: m.name, value: m.value, cm: AICore.toCm(m.value) }));
  const imgFront = `v${version}_front`, imgSide = `v${version}_side`;
  const order = {
    id, orderNo: p.orderNo || '', customer: p.customer || '', title: p.title || '', customerId: p.customerId || '',
    measuredAt: p.measuredAt || '', pageUrl: p.pageUrl || '',
    coordinator: profile.data.name || me.email, coordinatorUid: me.uid,
    status: 'pending', version, rejectCount: prev?.data.rejectCount || 0,
    exportedAt: now, sortAt: now, decidedBy: '', decidedByUid: '', decidedAt: null, reason: '',
    validatedCount: measurements.length, totalCount: p.totalCount || 0, measurements,
    rise: (Array.isArray(p.rise) ? p.rise : []).slice(0, 4).map((r) => String(r).slice(0, 40)),
    riseSpecific: String(p.riseSpecific || '').slice(0, 60), note: String(p.note || '').slice(0, 1000),
    images: { front: imgFront, side: imgSide },
    ai: { status: 'running', forVersion: version },
  };
  await FB.commit([
    { set: { path: `orders/${id}/images/${imgFront}`, data: { data: p.front, view: 'front', version, createdAt: now }, exists: false } },
    { set: { path: `orders/${id}/images/${imgSide}`, data: { data: p.side, view: 'side', version, createdAt: now }, exists: false } },
    { set: { path: `orders/${id}`, data: order, ...(prev ? { updateTime: prev.updateTime } : { exists: false }) } },
    { set: { path: `orders/${id}/versions/v${version}`, data: { version, status: 'pending', measurements, images: order.images, exportedAt: now, coordinator: order.coordinator, reason: '', ai: null } } },
    { set: { path: `log/${FB.newId()}`, data: { event: prev ? 're-exported' : 'exported', orderId: id, orderNo: order.orderNo, version, by: order.coordinator, afterRejection: prev?.data.status === 'rejected', at: now } } },
  ]);

  // AI check right away (coordinator sees the result before the approver does)
  let ai;
  try { ai = await aiCheck(order, p.front, p.side); }
  catch (e) { ai = { status: 'error', forVersion: version, error: String(e.message || e).slice(0, 300) }; }
  await FB.commit([
    { patch: { path: `orders/${id}`, data: { ai } } },
    { patch: { path: `orders/${id}/versions/v${version}`, data: { ai } } },
  ]);
  order.ai = ai;
  return publicStatus(order);
}

async function aiCheck(order, frontB64, sideB64) {
  const [statsDoc, playbookDoc, cfg] = await Promise.all([FB.get('ai/stats'), FB.get('ai/playbook'), claudeConfig()]);
  const st = AICore.check(statsDoc?.data || AICore.emptyStats(), order.measurements, MIN_SAMPLES);
  let claude = null;
  if (cfg) {
    claude = await ClaudeAI.review(cfg, {
      front: frontB64, side: sideB64, orderNo: order.orderNo, measurements: order.measurements,
      statsFindings: [st.note, ...st.issues.map((i) => `${i.measurement}: ${i.problem}`)].join('\n'),
      playbook: playbookDoc?.data || { rules: [] },
    });
  }
  return AICore.combine(st, claude, order.version, cfg?.model || '');
}

async function claudeConfig() {
  const { claudeKey, claudeModel } = await chrome.storage.local.get(['claudeKey', 'claudeModel']);
  return claudeKey ? { apiKey: claudeKey, model: claudeModel || 'claude-sonnet-5-5' } : null;
}

function publicStatus(o) {
  if (!o) return { status: null };
  return {
    id: o.id, orderNo: o.orderNo, status: o.status, version: o.version, exportedAt: o.exportedAt,
    decidedBy: o.decidedBy, decidedAt: o.decidedAt, reason: o.reason, rejectCount: o.rejectCount, ai: o.ai || null,
    rise: o.rise || [], riseSpecific: o.riseSpecific || '', note: o.note || '',
  };
}
async function status(id) {
  const d = await FB.get(`orders/${id}`);
  return d ? publicStatus(d.data) : { status: null };
}
async function recheckOrder(id) {
  const d = await FB.get(`orders/${id}`);
  if (!d) throw new Error('Order not found');
  const imgs = await loadImages(id, d.data.images);
  const ai = await aiCheck(d.data, imgs.front, imgs.side).catch((e) => ({ status: 'error', forVersion: d.data.version, error: String(e.message || e) }));
  await FB.commit([{ patch: { path: `orders/${id}`, data: { ai } } }]);
  return publicStatus({ ...d.data, ai });
}
async function loadImages(orderId, images) {
  const [f, s] = await Promise.all([FB.get(`orders/${orderId}/images/${images.front}`), FB.get(`orders/${orderId}/images/${images.side}`)]);
  if (!f || !s) throw new Error('Images no longer available');
  return { front: f.data.data, side: s.data.data };
}

// ---------------------------------------------------------------- background worker
let workerBusy = false;
async function runWorker() {
  if (workerBusy) return;
  workerBusy = true;
  try {
    const me = await FB.currentUser();
    if (!me) return;
    await cleanupImages().catch((e) => console.warn('cleanup', e));
    await processQueuedChecks().catch((e) => console.warn('queued checks', e));
    await processLearningQueue().catch((e) => console.warn('learning', e));
  } finally { workerBusy = false; }
}

/** Deletes screenshots of approved orders 7 days after approval. */
async function cleanupImages() {
  const due = await FB.query('cleanup', ['deleteAt', 'LESS_THAN_OR_EQUAL', new Date()], 20);
  for (const c of due) {
    const ops = (c.data.imageIds || []).map((img) => ({ del: `orders/${c.data.orderId}/images/${img}` }));
    ops.push({ del: c.path });
    await FB.commit(ops);
  }
}

/** Orders whose AI check was requested from the app ("Re-run AI"). */
async function processQueuedChecks() {
  const q = await FB.query('orders', ['ai.status', 'EQUAL', 'queued'], 5);
  for (const o of q) {
    try { await recheckOrder(o.id); } catch (e) {
      await FB.commit([{ patch: { path: `orders/${o.id}`, data: { ai: { status: 'error', forVersion: o.data.version, error: String(e.message || e) } } } }]);
    }
  }
}

/** Claude playbook learning jobs queued by the app after approve/reject decisions. */
async function processLearningQueue() {
  const cfg = await claudeConfig();
  if (!cfg) return;
  const jobs = await FB.query('aiQueue', null, 3, ['createdAt', 'ASCENDING']);
  for (const job of jobs) {
    const j = job.data;
    try {
      const images = [];
      if (j.kind === 'fixed' && j.prevVersion) {
        const pv = await FB.get(`orders/${j.orderId}/versions/v${j.prevVersion}`);
        const pi = await loadImages(j.orderId, pv?.data.images || { front: `v${j.prevVersion}_front`, side: `v${j.prevVersion}_side` });
        images.push({ label: `REJECTED v${j.prevVersion} FRONT`, b64: pi.front }, { label: `REJECTED v${j.prevVersion} SIDE`, b64: pi.side });
      }
      const ci = await loadImages(j.orderId, { front: `v${j.version}_front`, side: `v${j.version}_side` });
      const tag = j.kind === 'missed' ? 'REJECTED' : 'APPROVED';
      images.push({ label: `${tag} v${j.version} FRONT`, b64: ci.front }, { label: `${tag} v${j.version} SIDE`, b64: ci.side });

      const pb = await FB.get('ai/playbook');
      const playbook = pb?.data || { rules: [], version: 0 };
      const { lesson, rules } = await ClaudeAI.learn(cfg, {
        kind: j.kind, playbook, reason: j.reason || '', aiSummary: j.aiSummary || '', aiIssues: j.aiIssues || [],
        changes: j.changes || [], images,
      });
      const now = new Date();
      await FB.commit([
        { set: { path: 'ai/playbook', data: { rules, version: (playbook.version || 0) + 1, updatedAt: now }, ...(pb ? { updateTime: pb.updateTime } : { exists: false }) } },
        { set: { path: `aiLessons/${FB.newId()}`, data: { kind: j.kind, lesson, orderId: j.orderId, orderNo: j.orderNo || '', version: j.version, reason: j.reason || '', at: now } } },
        { del: job.path },
      ]);
    } catch (e) {
      console.warn('learning job failed', job.id, e);
      if (/no longer available|not found/i.test(String(e.message))) await FB.commit([{ del: job.path }]);
    }
  }
}
