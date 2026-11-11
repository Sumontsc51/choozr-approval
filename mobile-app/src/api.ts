import {
  collection, doc, getDoc, getDocs, onSnapshot, orderBy, query, where, limit, runTransaction, writeBatch,
  updateDoc, deleteDoc, setDoc, increment, serverTimestamp, Timestamp,
} from 'firebase/firestore';
import { createUserWithEmailAndPassword } from 'firebase/auth';
import { auth, db } from './firebase';
import * as AI from './aiCore';
import type { Marks, Order, Profile, Role, Status } from './types';

const DAY = 24 * 3600 * 1000;
const iso = (t: any) => (t && typeof t.toDate === 'function' ? t.toDate().toISOString() : typeof t === 'string' ? t : '');

function toOrder(id: string, d: any): Order {
  return {
    id, orderNo: String(d.orderNo ?? ''), customer: d.customer ?? '', title: d.title ?? '', measuredAt: d.measuredAt ?? '',
    pageUrl: d.pageUrl ?? '', coordinator: d.coordinator ?? '', status: d.status, version: Number(d.version ?? 1),
    rejectCount: Number(d.rejectCount ?? 0), exportedAt: iso(d.exportedAt), decidedAt: iso(d.decidedAt),
    decidedBy: d.decidedBy ?? '', reason: d.reason ?? '', validatedCount: Number(d.validatedCount ?? 0),
    totalCount: Number(d.totalCount ?? 0), measurements: d.measurements ?? [],
    images: d.images ?? { front: `v${d.version}_front`, side: `v${d.version}_side` }, ai: d.ai ?? null,
    archivedAt: iso(d.archivedAt), archivedBy: d.archivedBy ?? '', deleteAt: iso(d.deleteAt),
    rise: Array.isArray(d.rise) ? d.rise : [], riseSpecific: d.riseSpecific ?? '', note: d.note ?? '',
    marks: { front: d.marks?.front ?? [], side: d.marks?.side ?? [] },
  };
}

// ---------------------------------------------------------------- live data
/** Pending: oldest first (work queue). Approved / rejected / archived: newest first. */
export function subscribeOrders(status: Status, cb: (orders: Order[]) => void, onError: (e: Error) => void) {
  const q = query(collection(db, 'orders'), where('status', '==', status), orderBy('sortAt', 'desc'), limit(200));
  return onSnapshot(q, (snap) => {
    const list = snap.docs.map((d) => toOrder(d.id, d.data()));
    cb(status === 'pending' ? list.reverse() : list);
  }, onError);
}

export function subscribeProfile(uid: string, cb: (p: Profile) => void) {
  return onSnapshot(doc(db, 'users', uid), (s) => {
    const d = s.data() ?? {};
    cb({ uid, exists: s.exists(), email: d.email ?? auth.currentUser?.email ?? '', name: d.name ?? '', role: (d.role as Role) ?? null });
  }, () => cb({ uid, exists: false, email: auth.currentUser?.email ?? '', name: '', role: null }));
}

const imageCache = new Map<string, Promise<string>>();
/** Screenshots are stored as base64 in Firestore (free plan has no file storage). */
export function loadImage(orderId: string, imageId: string): Promise<string> {
  const k = `${orderId}/${imageId}`;
  let p = imageCache.get(k);
  if (!p) {
    p = getDoc(doc(db, 'orders', orderId, 'images', imageId)).then((s) => {
      const b64 = s.get('data');
      return b64 ? `data:image/jpeg;base64,${b64}` : '';
    });
    p.catch(() => imageCache.delete(k));
    imageCache.set(k, p);
    if (imageCache.size > 40) imageCache.delete(imageCache.keys().next().value as string);
  }
  return p;
}

// ---------------------------------------------------------------- accounts
export async function signUp(email: string, password: string, name: string) {
  const cred = await createUserWithEmailAndPassword(auth, email, password);
  await setDoc(doc(db, 'users', cred.user.uid), { email, name, role: null, createdAt: serverTimestamp() });
}
/** Creates the users doc for an account that signed in without one (e.g. created in the console). */
export async function ensureUserDoc(uid: string, email: string) {
  await setDoc(doc(db, 'users', uid), { email, name: email.split('@')[0], role: null, createdAt: serverTimestamp() });
}
/** First-time setup: the first person becomes admin (only works while no admin exists). */
export async function claimAdmin(uid: string, email: string, name: string) {
  const b = writeBatch(db);
  b.set(doc(db, 'users', uid), { email, name, role: 'admin', createdAt: serverTimestamp() });
  b.set(doc(db, 'config', 'bootstrap'), { adminUid: uid, at: serverTimestamp() });
  await b.commit();
}
export async function listUsers() {
  const s = await getDocs(collection(db, 'users'));
  return s.docs.map((d) => ({ uid: d.id, name: (d.get('name') as string) ?? '', email: (d.get('email') as string) ?? '', role: (d.get('role') as Role | null) ?? null }));
}
export const setRole = (uid: string, role: Role | null) => updateDoc(doc(db, 'users', uid), { role });
export const removeUser = (uid: string) => deleteDoc(doc(db, 'users', uid));

// ---------------------------------------------------------------- decisions + learning
export async function decide(o: Order, decision: 'approved' | 'rejected', reason: string, me: Profile) {
  const ref = doc(db, 'orders', o.id);
  const now = Timestamp.now();
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    const cur = snap.data();
    if (!cur) throw new Error('Order not found');
    if (cur.version !== o.version) throw new Error(`This order was re-exported (now v${cur.version}). It will refresh.`);
    if (cur.status !== 'pending') throw new Error(`Already ${cur.status} by ${cur.decidedBy}.`);
    tx.update(ref, {
      status: decision, decidedBy: me.name || me.email, decidedByUid: me.uid, decidedAt: now, sortAt: now, reason,
      rejectCount: (cur.rejectCount ?? 0) + (decision === 'rejected' ? 1 : 0),
    });
    tx.set(doc(db, 'orders', o.id, 'versions', `v${o.version}`), { status: decision, reason, decidedBy: me.name || me.email, decidedAt: now }, { merge: true });
    if (decision === 'approved') {
      // screenshots of approved orders are deleted 7 days later (keeps the free quota free)
      const imageIds: string[] = [];
      for (let v = 1; v <= o.version; v++) imageIds.push(`v${v}_front`, `v${v}_side`);
      tx.set(doc(db, 'cleanup', o.id), { orderId: o.id, imageIds, deleteAt: Timestamp.fromMillis(now.toMillis() + 7 * DAY) });
    }
    tx.set(doc(collection(db, 'log')), { event: decision, orderId: o.id, orderNo: o.orderNo, version: o.version, by: me.name || me.email, reason, at: now });
  });
  learnFromDecision(o, decision, reason).catch((e) => console.warn('learning failed', e));
}

/** Updates the built-in model and queues a Claude lesson when the decision teaches something. */
async function learnFromDecision(o: Order, decision: 'approved' | 'rejected', reason: string) {
  let prevRejected: any = null;
  if (decision === 'approved' && o.version > 1) {
    const vs = await getDocs(collection(db, 'orders', o.id, 'versions'));
    prevRejected = vs.docs.map((d) => d.data()).filter((v) => v.status === 'rejected' && v.version < o.version)
      .sort((a, b) => b.version - a.version)[0] ?? null;
  }
  let changes: { name: string; fromCm: number; toCm: number; pct: number }[] = [];
  await runTransaction(db, async (tx) => {
    const ref = doc(db, 'ai', 'stats');
    const s = ((await tx.get(ref)).data() as AI.StatsDoc | undefined) ?? AI.emptyStats();
    if (decision === 'approved') {
      AI.learnApproved(s, o.measurements);
      if (prevRejected) changes = AI.learnCorrection(s, prevRejected.measurements ?? [], o.measurements);
    } else {
      AI.learnRejected(s, o.measurements, reason);
    }
    tx.set(ref, s);
  });
  const ai = o.ai && o.ai.status === 'done' && o.ai.forVersion === o.version ? o.ai : null;
  if (ai) {
    const predicted = ai.verdict !== 'ok', actual = decision === 'rejected';
    const k = predicted ? (actual ? 'tp' : 'fp') : (actual ? 'fn' : 'tn');
    await setDoc(doc(db, 'ai', 'accuracy'), { [k]: increment(1) }, { merge: true });
  }
  const cfg = await getDoc(doc(db, 'config', 'ai')).catch(() => null);
  if (!cfg?.get('claudeEnabled')) return;
  const kind = AI.lessonKind(decision, ai, !!prevRejected);
  if (!kind) return;
  const src = kind === 'fixed' ? prevRejected?.ai : ai;
  await setDoc(doc(collection(db, 'aiQueue')), {
    kind, orderId: o.id, orderNo: o.orderNo, version: o.version, prevVersion: prevRejected?.version ?? null,
    reason: kind === 'fixed' ? prevRejected?.reason ?? '' : reason,
    aiSummary: src?.summary ?? '', aiIssues: src?.issues ?? [], changes, createdAt: serverTimestamp(),
  });
}

/** Asks the coordinator's extension to re-run the AI check (it has the optional Claude key). */
export const recheck = (o: Order) => updateDoc(doc(db, 'orders', o.id), { ai: { status: 'queued', forVersion: o.version } });

/** Deletes screenshots of orders approved more than 7 days ago. Runs when the app opens. */
export async function cleanupExpired() {
  const due = await getDocs(query(collection(db, 'cleanup'), where('deleteAt', '<=', Timestamp.now()), limit(20)));
  for (const c of due.docs) {
    const b = writeBatch(db);
    for (const img of (c.get('imageIds') as string[]) ?? []) b.delete(doc(db, 'orders', c.get('orderId'), 'images', img));
    b.delete(c.ref);
    await b.commit();
  }
  return due.size;
}

// ---------------------------------------------------------------- AI dashboard
export interface AiStats { tp?: number; fp?: number; tn?: number; fn?: number; }
export interface PlaybookRule { id: string; rule: string; measurement: string; view: string; evidence: number; }
export function subscribeAi(cb: (a: { accuracy: AiStats; rules: PlaybookRule[]; approvedSeen: number; claude: boolean }) => void) {
  let accuracy: AiStats = {}; let rules: PlaybookRule[] = []; let approvedSeen = 0; let claude = false;
  const emit = () => cb({ accuracy, rules, approvedSeen, claude });
  const u = [
    onSnapshot(doc(db, 'ai', 'accuracy'), (s) => { accuracy = (s.data() as AiStats) ?? {}; emit(); }, () => {}),
    onSnapshot(doc(db, 'ai', 'playbook'), (s) => { rules = (s.data()?.rules as PlaybookRule[]) ?? []; emit(); }, () => {}),
    onSnapshot(doc(db, 'ai', 'stats'), (s) => { approvedSeen = Number(s.data()?.approved ?? 0); emit(); }, () => {}),
    onSnapshot(doc(db, 'config', 'ai'), (s) => { claude = !!s.data()?.claudeEnabled; emit(); }, () => {}),
  ];
  return () => u.forEach((f) => f());
}

// ---------------------------------------------------------------- archive (admin)
export const ARCHIVE_DAYS = 5;

/** Approved -> archived. The whole order (photos, history, record) is deleted ARCHIVE_DAYS later. */
export async function archiveOrder(o: Order, me: Profile) {
  const now = Timestamp.now();
  const deleteAt = Timestamp.fromMillis(now.toMillis() + ARCHIVE_DAYS * DAY);
  const b = writeBatch(db);
  b.update(doc(db, 'orders', o.id), { status: 'archived', archivedAt: now, archivedBy: me.name || me.email, sortAt: now, deleteAt });
  b.set(doc(db, 'purge', o.id), { orderId: o.id, version: o.version, deleteAt });
  b.set(doc(collection(db, 'log')), { event: 'archived', orderId: o.id, orderNo: o.orderNo, by: me.name || me.email, at: now });
  await b.commit();
}

/** Admin: archived -> approved again (cancels the deletion). */
export async function restoreOrder(o: Order, me: Profile) {
  const now = Timestamp.now();
  const b = writeBatch(db);
  b.update(doc(db, 'orders', o.id), { status: 'approved', archivedAt: null, archivedBy: '', sortAt: now, deleteAt: null });
  b.delete(doc(db, 'purge', o.id));
  b.set(doc(collection(db, 'log')), { event: 'restored', orderId: o.id, orderNo: o.orderNo, by: me.name || me.email, at: now });
  await b.commit();
}

/** Permanently deletes an archived order: photos, version history, cleanup jobs and the order itself. */
export async function purgeOrder(orderId: string, version: number) {
  const b = writeBatch(db);
  for (let v = 1; v <= version; v++) {
    b.delete(doc(db, 'orders', orderId, 'images', `v${v}_front`));
    b.delete(doc(db, 'orders', orderId, 'images', `v${v}_side`));
    b.delete(doc(db, 'orders', orderId, 'versions', `v${v}`));
  }
  b.delete(doc(db, 'cleanup', orderId));
  b.delete(doc(db, 'purge', orderId));
  b.delete(doc(db, 'orders', orderId));
  await b.commit();
}

/** Deletes archived orders whose 5 days are over. Runs when the app opens (with the 7-day photo cleanup). */
export async function purgeExpired() {
  const due = await getDocs(query(collection(db, 'purge'), where('deleteAt', '<=', Timestamp.now()), limit(20)));
  for (const pdoc of due.docs) {
    const o = await getDoc(doc(db, 'orders', pdoc.get('orderId')));
    if (!o.exists() || o.get('status') !== 'archived') { await deleteDoc(pdoc.ref); continue; }   // restored or gone
    await purgeOrder(o.id, Number(o.get('version') ?? 1));
  }
  return due.size;
}

/** Saves the approver's drawings on the photos (shown to everyone; cleared by the next export). */
export const saveMarks = (o: Order, marks: Marks) => updateDoc(doc(db, 'orders', o.id), { marks });
