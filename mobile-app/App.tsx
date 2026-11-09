import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import * as Haptics from 'expo-haptics';
import { onAuthStateChanged, type User } from 'firebase/auth';
import { auth } from './src/firebase';
import { archiveOrder, cleanupExpired, decide, purgeExpired, purgeOrder, recheck, restoreOrder, subscribeOrders, subscribeProfile, ARCHIVE_DAYS } from './src/api';
import type { Order, Profile, Status } from './src/types';
import { OrderSlide } from './src/OrderSlide';
import { RejectModal } from './src/RejectModal';
import { LoginScreen, NoRoleScreen } from './src/LoginScreen';
import { AccountScreen } from './src/AccountScreen';

const TABS: Status[] = ['pending', 'approved', 'rejected', 'archived'];
type Lists = Record<Status, Order[]>;

export default function App() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <StatusBar style="light" />
        <Root />
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

function Root() {
  if (Platform.OS === 'web' && typeof location !== 'undefined' && /[?&]demo=1/.test(location.search)) return <Demo />;
  return <AuthedRoot />;
}

/** ?demo=1 on the web link: try the gestures with sample photos, no login, nothing saved. */
function Demo() {
  // sample photo drawn on a canvas (JPEG data URI, same format as real exports)
  const svg = (bg: string, label: string) => {
    const c = document.createElement('canvas'); c.width = 600; c.height = 900;
    const x = c.getContext('2d')!;
    x.fillStyle = bg; x.fillRect(0, 0, 600, 900);
    x.strokeStyle = '#ff0'; x.lineWidth = 4; x.setLineDash([10, 8]);
    [220, 330, 420, 520, 600].forEach((y) => { x.beginPath(); x.moveTo(170, y); x.lineTo(430, y); x.stroke(); });
    x.fillStyle = '#fff'; x.font = '64px sans-serif'; x.textAlign = 'center'; x.fillText(label, 300, 120);
    x.fillStyle = '#ccc'; x.font = '22px sans-serif'; x.fillText('zoom in to read this small text', 300, 860);
    return c.toDataURL('image/jpeg', 0.85);
  };
  const mk = (i: number): Order => ({
    id: 'demo' + i, orderNo: String(10000 + i), customer: 'Demo customer ' + i, title: '', measuredAt: '', pageUrl: '', coordinator: 'Demo',
    status: 'pending', version: 1, rejectCount: 0, exportedAt: new Date().toISOString(), decidedAt: '', decidedBy: '', reason: '',
    validatedCount: 2, totalCount: 27, measurements: [{ name: 'Height', value: '170.00 cm', cm: 170 }, { name: 'Seat', value: '101.20 cm', cm: 101.2 }],
    images: { front: 'front', side: 'side' }, archivedAt: '', archivedBy: '', deleteAt: '',
    ai: { status: 'done', forVersion: 1, verdict: i % 2 ? 'ok' : 'check', score: i % 2 ? 91 : 48, summary: 'Demo AI result.',
      issues: i % 2 ? [] : [{ measurement: 'Seat', view: 'side', severity: 'medium', problem: 'Demo issue', source: 'stats' }], flags: i % 2 ? {} : { Seat: 'medium' } },
  });
  const orders = [1, 2, 3].map(mk);
  const [idx, setIdx] = useState(0);
  const [dir, setDir] = useState<'next' | 'prev' | null>(null);
  const o = orders[idx];
  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.header}><Text style={[styles.tabText, { color: '#fff' }]}>Demo — gestures only, nothing is saved</Text></View>
      <View style={styles.stage}>
        <OrderSlide key={o.id} order={o} position={`${idx + 1} / 3`} direction={dir} canDecide busy={false}
          loadImg={async (_id, img) => svg(img === 'front' ? '#334' : '#433', `${img.toUpperCase()} ${o.orderNo}`)}
          onNext={() => { if (idx < 2) { setDir('next'); setIdx(idx + 1); } }} onPrev={() => { if (idx > 0) { setDir('prev'); setIdx(idx - 1); } }}
          onApprove={() => {}} onReject={() => {}} onRecheck={() => {}} />
      </View>
    </SafeAreaView>
  );
}

function AuthedRoot() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [profile, setProfile] = useState<Profile | null>(null);

  useEffect(() => onAuthStateChanged(auth, (u) => { setUser(u); if (!u) setProfile(null); }), []);
  useEffect(() => (user ? subscribeProfile(user.uid, setProfile) : undefined), [user?.uid]);
  // 7-day screenshot cleanup runs whenever a team member has the app open (free plan has no server jobs)
  useEffect(() => {
    if (!profile?.role) return;
    const run = () => { cleanupExpired().catch(() => {}); purgeExpired().catch(() => {}); };
    run();
    const t = setInterval(run, 3600 * 1000);
    return () => clearInterval(t);
  }, [profile?.role]);

  if (user === undefined || (user && !profile)) return <View style={styles.center}><ActivityIndicator color="#9aa3b5" /></View>;
  if (!user) return <LoginScreen />;
  if (!profile!.role) return <NoRoleScreen profile={profile!} />;
  return <Main profile={profile!} />;
}

function Main({ profile }: { profile: Profile }) {
  const canDecide = profile.role === 'approver' || profile.role === 'admin';
  const [tab, setTab] = useState<Status>(canDecide ? 'pending' : 'rejected');
  const isAdmin = profile.role === 'admin';
  const tabs = TABS.filter((t) => t !== 'archived' || isAdmin);   // archive page: admins only
  const [lists, setLists] = useState<Lists>({ pending: [], approved: [], rejected: [], archived: [] });
  const [loaded, setLoaded] = useState(false);
  const [idx, setIdx] = useState(0);
  const [dir, setDir] = useState<'next' | 'prev' | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ msg: string; kind: 'ok' | 'err' | '' } | null>(null);
  const [rejecting, setRejecting] = useState<Order | null>(null);
  const [account, setAccount] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentId = useRef<string | undefined>(undefined);
  const wantedId = useRef<string | undefined>(undefined);   // from a tapped notification

  const say = (msg: string, kind: 'ok' | 'err' | '' = '') => {
    setToast({ msg, kind });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), kind === 'err' ? 5000 : 2200);
  };

  // Live lists (Firestore listeners) — new exports, AI results and decisions appear instantly.
  useEffect(() => {
    const unsubs = tabs.map((s) => subscribeOrders(s, (orders) => {
      setLists((l) => ({ ...l, [s]: orders }));
      setLoaded(true);
    }, (e) => say('Sync error: ' + e.message, 'err')));
    return () => unsubs.forEach((u) => u());
  }, []);


  const current = lists[tab];
  // Keep the same order on screen when the list changes; jump to a notified order if requested.
  useEffect(() => {
    const target = wantedId.current ?? currentId.current;
    const i = target ? current.findIndex((o) => o.id === target) : -1;
    if (wantedId.current && i >= 0) wantedId.current = undefined;
    setIdx((old) => (i >= 0 ? i : Math.min(old, Math.max(0, current.length - 1))));
  }, [current]);
  const order: Order | undefined = current[idx];
  useEffect(() => { currentId.current = order?.id; }, [order?.id]);

  const go = (d: 'next' | 'prev') => {
    const n = idx + (d === 'next' ? 1 : -1);
    if (n < 0) return say('First order');
    if (n >= current.length) return say('Last order');
    setDir(d); setIdx(n);
    Haptics.selectionAsync().catch(() => {});
  };
  const switchTab = (t: Status) => { setTab(t); setIdx(0); setDir(null); currentId.current = undefined; };

  const doDecide = async (decision: 'approved' | 'rejected', reason = '') => {
    if (!order || order.status !== 'pending') return;
    setBusy(true);
    try {
      await decide(order, decision, reason, profile);
      setDir('next');
      currentId.current = current[idx + 1]?.id;   // move on to the next order in the queue
      Haptics.notificationAsync(decision === 'approved' ? Haptics.NotificationFeedbackType.Success : Haptics.NotificationFeedbackType.Warning).catch(() => {});
      say(`${decision === 'approved' ? 'Approved' : 'Rejected'} #${order.orderNo}`, decision === 'approved' ? 'ok' : 'err');
    } catch (e: any) {
      say(e.message, 'err');
    } finally { setBusy(false); }
  };

  const ask = (title: string, msg: string, yes: () => void) => {
    if (Platform.OS === 'web') { if (window.confirm(`${title}\n\n${msg}`)) yes(); return; }
    Alert.alert(title, msg, [{ text: 'Cancel', style: 'cancel' }, { text: 'Yes', style: 'destructive', onPress: yes }]);
  };
  const act = async (fn: () => Promise<unknown>, okMsg: string) => {
    setBusy(true);
    try { currentId.current = current[idx + 1]?.id; setDir('next'); await fn(); say(okMsg, 'ok'); }
    catch (e: any) { say(e.message, 'err'); } finally { setBusy(false); }
  };

  if (account) return <AccountScreen profile={profile} onClose={() => setAccount(false)} />;

  return (
    <SafeAreaView style={styles.root} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <View style={styles.tabs}>
          {tabs.map((t) => (
            <Pressable key={t} onPress={() => switchTab(t)} style={[styles.tab, tab === t && styles.tabOn]}>
              <Text style={[styles.tabText, tab === t && styles.tabTextOn]} numberOfLines={1}>
                {t === 'archived' ? 'Archive' : t[0].toUpperCase() + t.slice(1)}{lists[t].length ? ` ${lists[t].length}` : ''}
              </Text>
            </Pressable>
          ))}
        </View>
        <Pressable style={styles.iconBtn} onPress={() => setAccount(true)}><Text style={styles.icon}>⚙</Text></Pressable>
      </View>

      <View style={styles.stage}>
        {!loaded ? (
          <View style={styles.center}><ActivityIndicator color="#9aa3b5" /></View>
        ) : order ? (
          <OrderSlide
            key={`${order.id}:${order.version}`}
            order={order} position={`${idx + 1} / ${current.length}`} direction={dir} canDecide={canDecide}
            onNext={() => go('next')} onPrev={() => go('prev')}
            onApprove={() => doDecide('approved')} onReject={() => setRejecting(order)}
            onRecheck={() => recheck(order).then(() => say('AI re-check requested — runs on the coordinator PC')).catch((e) => say(e.message, 'err'))}
            onArchive={() => act(() => archiveOrder(order, profile), `Archived #${order.orderNo} — deleted in ${ARCHIVE_DAYS} days`)}
            onRestore={isAdmin ? () => act(() => restoreOrder(order, profile), `Restored #${order.orderNo} to Approved`) : undefined}
            onDeleteNow={isAdmin ? () => ask('Delete order', `Permanently delete order #${order.orderNo} with its photos? This cannot be undone.`,
              () => act(() => purgeOrder(order.id, order.version), `Deleted #${order.orderNo}`)) : undefined}
            busy={busy} />
        ) : (
          <View style={styles.center}>
            <Text style={styles.bigIcon}>{tab === 'pending' ? '✓' : '—'}</Text>
            <Text style={styles.emptyText}>{tab === 'pending' ? 'No orders waiting for approval' : tab === 'archived' ? 'Archive is empty' : `No ${tab} orders`}</Text>
            <Text style={styles.hint}>{tab === 'archived' ? `Archived orders are deleted ${ARCHIVE_DAYS} days after archiving.` : 'New exports appear here automatically.'}</Text>
          </View>
        )}
        {toast && (
          <View pointerEvents="none" style={[styles.toast, toast.kind === 'ok' && { backgroundColor: '#15803d' }, toast.kind === 'err' && { backgroundColor: '#b91c1c' }]}>
            <Text style={styles.toastText}>{toast.msg}</Text>
          </View>
        )}
      </View>

      <RejectModal order={rejecting} onCancel={() => setRejecting(null)}
        onConfirm={(reason) => { setRejecting(null); doDecide('rejected', reason); }} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#161a24' },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 8, backgroundColor: '#161a24', borderBottomWidth: 1, borderBottomColor: '#2a3040' },
  tabs: { flex: 1, flexDirection: 'row', backgroundColor: '#0f1219', borderRadius: 10, padding: 3 },
  tab: { flex: 1, paddingVertical: 7, borderRadius: 8, alignItems: 'center' },
  tabOn: { backgroundColor: '#3b82f6' },
  tabText: { color: '#9aa3b5', fontSize: 13, fontWeight: '600' },
  tabTextOn: { color: '#fff' },
  iconBtn: { width: 36, height: 36, borderRadius: 8, borderWidth: 1, borderColor: '#2a3040', alignItems: 'center', justifyContent: 'center' },
  icon: { color: '#f3f4f6', fontSize: 18 },
  stage: { flex: 1, backgroundColor: '#000', overflow: 'hidden' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#0b0d12', gap: 8 },
  bigIcon: { color: '#9aa3b5', fontSize: 40 },
  emptyText: { color: '#9aa3b5' },
  hint: { color: '#6b7280', fontSize: 12 },
  toast: { position: 'absolute', top: 16, alignSelf: 'center', backgroundColor: '#111', paddingHorizontal: 16, paddingVertical: 10, borderRadius: 10, maxWidth: '85%' },
  toastText: { color: '#fff', fontSize: 14 },
});
