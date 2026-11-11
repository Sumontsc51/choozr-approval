import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import Animated, { FadeIn, SlideInDown, SlideInUp, SlideOutDown, SlideOutUp } from 'react-native-reanimated';
import type { AiResult, Marks, Order, Shape } from './types';
import { DrawTool, ZoomableHandle, ZoomableViewer } from './ZoomableViewer';
import { fmt } from './util';
import { loadImage } from './api';

interface Props {
  order: Order;
  position: string;
  direction: 'next' | 'prev' | null;
  canDecide: boolean;
  onNext: () => void;
  onPrev: () => void;
  onApprove: () => void;
  onReject: () => void;
  onRecheck: () => void;
  onArchive?: () => void;      // approved -> archive (approver/admin)
  onRestore?: () => void;      // archive -> approved (admin)
  onDeleteNow?: () => void;    // archive -> deleted now (admin)
  canMark?: boolean;                                  // approver/admin may draw on the photos
  onSaveMarks?: (m: Marks) => Promise<unknown>;
  busy: boolean;
  loadImg?: (orderId: string, imageId: string) => Promise<string>;   // demo mode override
}

const VERDICT = {
  ok: { label: 'AI ✓', color: '#22c55e', text: '#052e16' },
  check: { label: 'AI ?', color: '#f59e0b', text: '#111' },
  wrong: { label: 'AI ✗', color: '#ef4444', text: '#fff' },
} as const;

const COLORS = ['#ff2d2d', '#ffe600', '#22d3ee', '#ffffff'];
const TOOLS: { id: DrawTool; icon: string }[] = [
  { id: null, icon: '✋' }, { id: 'pen', icon: '✎' }, { id: 'line', icon: '╱' }, { id: 'circle', icon: '◯' }, { id: 'text', icon: 'T' },
];

function useImage(orderId: string, imageId: string, load: (o: string, i: string) => Promise<string> = loadImage) {
  const [state, setState] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setState(null);
    load(orderId, imageId).then((u) => alive && setState(u)).catch(() => alive && setState(''));
    return () => { alive = false; };
  }, [orderId, imageId]);
  return state;
}

export function OrderSlide(p: Props) {
  const { order } = p;
  const [view, setView] = useState<'front' | 'side'>('front');
  const [sheet, setSheet] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const viewer = useRef<ZoomableHandle>(null);
  const front = useImage(order.id, order.images.front, p.loadImg);
  const side = useImage(order.id, order.images.side, p.loadImg);

  useEffect(() => { setView('front'); setSheet(false); }, [order.id, order.version]);

  // ---- approver's drawings (pen / line / circle / text) ----
  const [marking, setMarking] = useState(false);
  const [tool, setTool] = useState<DrawTool>(null);
  const [color, setColor] = useState(COLORS[0]);
  const [marks, setMarks] = useState<Marks>(order.marks);
  const [dirty, setDirty] = useState(false);
  const [textAt, setTextAt] = useState<{ view: 'front' | 'side'; pt: number[] } | null>(null);
  const [textVal, setTextVal] = useState('');
  const serverKey = JSON.stringify(order.marks);
  useEffect(() => { if (!dirty) setMarks(order.marks); }, [serverKey]);
  const change = (m: Marks) => { setMarks(m); setDirty(true); };
  const addShape = (v: 'front' | 'side', sh: Shape) => change({ ...marks, [v]: [...marks[v], sh] });
  const saveMarks = async () => {
    if (!dirty) return;
    await p.onSaveMarks?.(marks);
    setDirty(false);
  };
  const doneMarking = () => { setMarking(false); setTool(null); saveMarks().catch(() => {}); };
  const markCount = marks.front.length + marks.side.length;

  const onSwipe = (dir: 'left' | 'right' | 'up' | 'down') => {
    if (sheet) { if (dir === 'down') setSheet(false); return; }
    if (dir === 'left') setView('side');
    else if (dir === 'right') setView('front');
    else if (dir === 'up') p.onNext();
    else p.onPrev();
  };

  const ai = order.ai && order.ai.forVersion === order.version ? order.ai : null;
  const flags = ai?.status === 'done' ? (ai.flags ?? {}) : {};
  const ms = order.measurements ?? [];
  const pending = order.status === 'pending';

  return (
    <Animated.View
      style={st.slide}
      entering={p.direction === 'next' ? SlideInDown.duration(260) : p.direction === 'prev' ? SlideInUp.duration(260) : FadeIn.duration(150)}
      exiting={p.direction === 'next' ? SlideOutUp.duration(260) : SlideOutDown.duration(260)}>
      <View style={st.viewport}>
        <ZoomableViewer ref={viewer} frontUri={front} sideUri={side} view={view} onSwipe={onSwipe}
          onDoubleTap={() => setSheet((x) => !x)} onSingleTap={() => sheet && setSheet(false)} onZoomChange={setZoomed}
          marks={marks} drawTool={marking ? tool : null} drawColor={color} onAddShape={addShape}
          onTextAt={(v, pt) => { setTextVal(''); setTextAt({ view: v, pt }); }} />

        {p.canMark && !marking && (
          <Pressable style={st.markBtn} onPress={() => { setMarking(true); setTool('pen'); setSheet(false); }}>
            <Text style={st.markBtnText}>✎{markCount ? ` ${markCount}` : ''}</Text>
          </Pressable>
        )}
        {!p.canMark && markCount > 0 && (
          <View pointerEvents="none" style={st.markInfo}><Text style={st.markInfoText}>✎ {markCount} approver mark{markCount > 1 ? 's' : ''}</Text></View>
        )}
        {marking && (
          <View style={st.tools}>
            {TOOLS.map((t) => (
              <Pressable key={t.id ?? 'move'} onPress={() => setTool(t.id)} style={[st.toolBtn, tool === t.id && st.toolOn]}>
                <Text style={st.toolTxt}>{t.icon}</Text>
              </Pressable>
            ))}
            <Pressable onPress={() => setColor(COLORS[(COLORS.indexOf(color) + 1) % COLORS.length])} style={st.toolBtn}>
              <View style={[st.colorDot, { backgroundColor: color }]} />
            </Pressable>
            <Pressable onPress={() => marks[view].length && change({ ...marks, [view]: marks[view].slice(0, -1) })} style={st.toolBtn}><Text style={st.toolTxt}>↶</Text></Pressable>
            <Pressable onPress={() => markCount && change({ front: [], side: [] })} style={st.toolBtn}><Text style={st.toolTxt}>🗑</Text></Pressable>
            <Pressable onPress={doneMarking} style={[st.toolBtn, st.toolDone]}><Text style={[st.toolTxt, { color: '#052e16' }]}>✓</Text></Pressable>
          </View>
        )}
        <Modal visible={!!textAt} transparent animationType="fade" onRequestClose={() => setTextAt(null)}>
          <View style={st.textModal}>
            <View style={st.textBox}>
              <Text style={st.sheetTitle}>Text to put on the photo</Text>
              <TextInput style={st.textInput} value={textVal} onChangeText={setTextVal} autoFocus maxLength={60}
                placeholder="e.g. line too low" placeholderTextColor="#6b7280"
                onSubmitEditing={() => { if (textAt && textVal.trim()) addShape(textAt.view, { type: 'text', color, a: textAt.pt, text: textVal.trim() }); setTextAt(null); }} />
              <View style={st.btns}>
                <Pressable style={[st.btn, st.neutral, st.small]} onPress={() => setTextAt(null)}><Text style={st.btnText}>Cancel</Text></Pressable>
                <Pressable style={[st.btn, st.approve, st.small]} onPress={() => { if (textAt && textVal.trim()) addShape(textAt.view, { type: 'text', color, a: textAt.pt, text: textVal.trim() }); setTextAt(null); }}>
                  <Text style={[st.btnText, { color: '#052e16' }]}>Add</Text></Pressable>
              </View>
            </View>
          </View>
        </Modal>

        <View pointerEvents="none" style={st.viewTag}><Text style={st.viewTagText}>{view.toUpperCase()} VIEW</Text></View>
        <View pointerEvents="none" style={[st.badge, st[`badge_${order.status}` as 'badge_pending']]}>
          <Text style={[st.badgeText, order.status === 'approved' && { color: '#052e16' }, order.status === 'pending' && { color: '#111' }]}>
            {pending ? `v${order.version}${order.rejectCount ? ' · REWORK' : ''}` : order.status.toUpperCase()}
          </Text>
        </View>
        <AiBadge ai={ai} onPress={() => setSheet(true)} />
        <View pointerEvents="none" style={st.dots}>
          <View style={[st.dot, view === 'front' && st.dotOn]} /><View style={[st.dot, view === 'side' && st.dotOn]} />
        </View>
        {zoomed && (
          <Pressable style={st.zoomReset} onPress={() => viewer.current?.reset()}><Text style={st.zoomResetText}>Reset zoom</Text></Pressable>
        )}

        {sheet && (
          <Animated.View entering={SlideInDown.duration(220)} exiting={SlideOutDown.duration(180)} style={st.sheet}>
            <ScrollView style={{ maxHeight: 460 }} contentContainerStyle={{ paddingBottom: 10 }}>
              <AiSection ai={ai} onRecheck={p.onRecheck} />
              <View style={st.sheetHead}>
                <Text style={st.sheetTitle}>Validated measurements</Text>
                <Text style={st.sheetCount}>{ms.length}{order.totalCount ? ` / ${order.totalCount}` : ''}</Text>
              </View>
              {ms.length === 0 && <Text style={st.empty}>No validated measurements in this export</Text>}
              {ms.map((m, i) => {
                const f = flags[m.name];
                return (
                  <View key={i} style={[st.row, f ? st.rowFlag : null]}>
                    <Text style={[st.rowName, f ? { color: '#fcd34d' } : null]}>{f ? '⚠ ' : ''}{m.name}</Text>
                    <Text style={[st.rowVal, f ? { color: '#fcd34d' } : null]}>{m.value}</Text>
                  </View>
                );
              })}
            </ScrollView>
          </Animated.View>
        )}
      </View>

      <View style={st.info}>
        <View style={st.titleRow}>
          <Text style={st.title} numberOfLines={1}>Order #{order.orderNo} · {order.customer}</Text>
          <Text style={st.pos}>{p.position}</Text>
        </View>
        <Text style={st.meta}>
          v{order.version} by <Text style={st.metaB}>{order.coordinator || '—'}</Text> · {fmt(order.exportedAt)}
          {order.rejectCount ? ` · rejected ${order.rejectCount}× before` : ''}
        </Text>
        {(order.rise.length > 0 || !!order.riseSpecific) && (
          <View style={st.riseRow}>
            <Text style={st.riseLabel}>Rise</Text>
            {order.rise.map((r) => <View key={r} style={st.chip}><Text style={st.chipText}>{r}</Text></View>)}
            {!!order.riseSpecific && <View style={[st.chip, st.chipAlt]}><Text style={st.chipText}>Specific: {order.riseSpecific}</Text></View>}
          </View>
        )}
        {!!order.note && (
          <ScrollView style={st.noteBox} nestedScrollEnabled>
            <Text style={st.noteText}><Text style={st.noteLabel}>Note  </Text>{order.note}</Text>
          </ScrollView>
        )}
        {pending && p.canDecide ? (
          <View style={st.btns}>
            <Pressable disabled={p.busy} onPress={() => { setMarking(false); setTool(null); saveMarks().catch(() => {}).then(p.onReject); }} style={({ pressed }) => [st.btn, st.reject, (pressed || p.busy) && st.pressed]}>
              <Text style={st.btnText}>✕  Reject</Text>
            </Pressable>
            <Pressable disabled={p.busy} onPress={() => { setMarking(false); setTool(null); saveMarks().catch(() => {}).then(p.onApprove); }} style={({ pressed }) => [st.btn, st.approve, (pressed || p.busy) && st.pressed]}>
              <Text style={[st.btnText, { color: '#052e16' }]}>✓  Approve</Text>
            </Pressable>
          </View>
        ) : pending ? (
          <View style={[st.decided, { borderLeftColor: '#f59e0b' }]}><Text style={st.decidedText}>Waiting for approver</Text></View>
        ) : order.status === 'archived' ? (
          <>
            <View style={[st.decided, { borderLeftColor: '#6b7280' }]}>
              <Text style={st.decidedText}><Text style={{ fontWeight: '800' }}>ARCHIVED</Text> by {order.archivedBy || '—'} · {fmt(order.archivedAt)}</Text>
              <Text style={st.reason}>Approved by {order.decidedBy || '—'} · deleted automatically {fmt(order.deleteAt)}</Text>
            </View>
            {(p.onRestore || p.onDeleteNow) && (
              <View style={st.btns}>
                {p.onDeleteNow && <Pressable disabled={p.busy} onPress={p.onDeleteNow} style={({ pressed }) => [st.btn, st.reject, st.small, (pressed || p.busy) && st.pressed]}>
                  <Text style={st.btnText}>Delete now</Text></Pressable>}
                {p.onRestore && <Pressable disabled={p.busy} onPress={p.onRestore} style={({ pressed }) => [st.btn, st.neutral, st.small, (pressed || p.busy) && st.pressed]}>
                  <Text style={st.btnText}>↩  Restore</Text></Pressable>}
              </View>
            )}
          </>
        ) : (
          <>
            <View style={[st.decided, order.status === 'approved' ? st.decidedOk : st.decidedBad]}>
              <Text style={st.decidedText}><Text style={{ fontWeight: '800' }}>{order.status.toUpperCase()}</Text> by {order.decidedBy || '—'} · {fmt(order.decidedAt)}</Text>
              {!!order.reason && <Text style={st.reason}>“{order.reason}”</Text>}
            </View>
            {order.status === 'approved' && p.onArchive && (
              <View style={st.btns}>
                <Pressable disabled={p.busy} onPress={p.onArchive} style={({ pressed }) => [st.btn, st.neutral, st.small, (pressed || p.busy) && st.pressed]}>
                  <Text style={st.btnText}>🗄  Archive</Text>
                </Pressable>
              </View>
            )}
          </>
        )}
      </View>
    </Animated.View>
  );
}

function AiBadge({ ai, onPress }: { ai: AiResult | null; onPress: () => void }) {
  if (!ai) return null;
  if (ai.status === 'queued' || ai.status === 'running') {
    return <View style={[st.aiBadge, { backgroundColor: 'rgba(0,0,0,.6)' }]}><ActivityIndicator size="small" color="#fff" /><Text style={st.aiText}> AI…</Text></View>;
  }
  if (ai.status !== 'done' || !ai.verdict) return null;
  const v = VERDICT[ai.verdict];
  return (
    <Pressable onPress={onPress} style={[st.aiBadge, { backgroundColor: v.color }]}>
      <Text style={[st.aiText, { color: v.text }]}>{v.label} {ai.score}%{ai.issues?.length ? ` · ${ai.issues.length}` : ''}</Text>
    </Pressable>
  );
}

function AiSection({ ai, onRecheck }: { ai: AiResult | null; onRecheck: () => void }) {
  if (!ai) return null;
  const busy = ai.status === 'queued' || ai.status === 'running';
  const v = ai.verdict ? VERDICT[ai.verdict] : null;
  return (
    <View style={st.aiBox}>
      <View style={st.sheetHead}>
        <Text style={st.sheetTitle}>AI check{ai.engines?.length ? ` (${ai.engines.join(' + ')})` : ''}</Text>
        {!busy && <Pressable onPress={onRecheck}><Text style={st.recheck}>Re-run</Text></Pressable>}
      </View>
      {busy && <Text style={st.aiSummary}>Checking the points…</Text>}
      {ai.status === 'error' && <Text style={[st.aiSummary, { color: '#fca5a5' }]}>Failed: {ai.error}</Text>}
      {ai.status === 'done' && v && (
        <>
          <Text style={[st.aiVerdict, { color: v.color }]}>
            {ai.verdict === 'ok' ? 'Points look correct' : ai.verdict === 'check' ? 'Needs a closer look' : 'Points look wrong'} · {ai.score}%
          </Text>
          {!!ai.summary && <Text style={st.aiSummary}>{ai.summary}</Text>}
          {(ai.issues ?? []).map((i, k) => (
            <Text key={k} style={st.aiIssue}>
              <Text style={{ color: i.severity === 'high' ? '#f87171' : i.severity === 'medium' ? '#fbbf24' : '#9aa3b5', fontWeight: '700' }}>{i.measurement}</Text>
              {i.view !== 'unknown' ? <Text style={{ color: '#6b7280' }}> ({i.view})</Text> : null}: {i.problem}
            </Text>
          ))}
        </>
      )}
    </View>
  );
}

const st = StyleSheet.create({
  slide: { ...StyleSheet.absoluteFillObject, backgroundColor: '#0b0d12' },
  viewport: { flex: 1 },
  viewTag: { position: 'absolute', top: 10, alignSelf: 'center', backgroundColor: 'rgba(0,0,0,.55)', paddingHorizontal: 12, paddingVertical: 4, borderRadius: 999 },
  viewTagText: { color: '#fff', fontSize: 11, letterSpacing: 1 },
  badge: { position: 'absolute', top: 10, left: 10, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 6 },
  badge_pending: { backgroundColor: '#f59e0b' },
  badge_approved: { backgroundColor: '#22c55e' },
  badge_rejected: { backgroundColor: '#ef4444' },
  badge_archived: { backgroundColor: '#6b7280' },
  badgeText: { color: '#fff', fontSize: 11, fontWeight: '800', letterSpacing: 1 },
  aiBadge: { position: 'absolute', top: 10, right: 10, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999 },
  aiText: { color: '#fff', fontSize: 12, fontWeight: '800' },
  dots: { position: 'absolute', bottom: 10, alignSelf: 'center', flexDirection: 'row', gap: 6 },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: 'rgba(255,255,255,.35)' },
  dotOn: { backgroundColor: '#fff' },
  zoomReset: { position: 'absolute', top: 46, right: 10, backgroundColor: 'rgba(0,0,0,.6)', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8 },
  zoomResetText: { color: '#fff', fontSize: 12 },
  sheet: { position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(22,26,36,.97)', borderTopLeftRadius: 16, borderTopRightRadius: 16, paddingTop: 4 },
  sheetHead: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 16, paddingTop: 10, paddingBottom: 6 },
  sheetTitle: { color: '#9aa3b5', fontSize: 14, fontWeight: '600' },
  sheetCount: { color: '#f3f4f6', fontSize: 14, fontWeight: '600' },
  recheck: { color: '#60a5fa', fontSize: 13 },
  aiBox: { borderBottomWidth: 1, borderBottomColor: '#2a3040', paddingBottom: 10 },
  aiVerdict: { paddingHorizontal: 16, fontSize: 16, fontWeight: '800' },
  aiSummary: { paddingHorizontal: 16, color: '#d1d5db', marginTop: 4, lineHeight: 19 },
  aiIssue: { paddingHorizontal: 16, color: '#d1d5db', marginTop: 6, lineHeight: 19 },
  row: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 9, paddingHorizontal: 18, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#2a3040' },
  rowFlag: { backgroundColor: 'rgba(245,158,11,.12)' },
  rowName: { color: '#f3f4f6', fontSize: 15, flexShrink: 1 },
  rowVal: { color: '#86efac', fontSize: 15, fontWeight: '700', fontVariant: ['tabular-nums'] },
  empty: { color: '#9aa3b5', textAlign: 'center', padding: 20 },
  info: { backgroundColor: '#161a24', borderTopWidth: 1, borderTopColor: '#2a3040', paddingHorizontal: 14, paddingTop: 10, paddingBottom: 10 },
  titleRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  title: { color: '#f3f4f6', fontSize: 16, fontWeight: '700', flex: 1 },
  pos: { color: '#9aa3b5', fontSize: 12 },
  meta: { color: '#9aa3b5', fontSize: 12, marginTop: 2 },
  metaB: { color: '#f3f4f6', fontWeight: '600' },
  markBtn: { position: 'absolute', left: 10, bottom: 28, minWidth: 42, height: 42, borderRadius: 21, paddingHorizontal: 10, backgroundColor: 'rgba(0,0,0,.6)', alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,.25)' },
  markBtnText: { color: '#fff', fontSize: 18, fontWeight: '700' },
  markInfo: { position: 'absolute', left: 10, bottom: 28, backgroundColor: 'rgba(0,0,0,.6)', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5 },
  markInfoText: { color: '#fff', fontSize: 12, fontWeight: '700' },
  tools: { position: 'absolute', left: 8, top: 46, gap: 6, backgroundColor: 'rgba(0,0,0,.55)', borderRadius: 12, padding: 5 },
  toolBtn: { width: 38, height: 38, borderRadius: 9, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,.12)' },
  toolOn: { backgroundColor: '#3b82f6' },
  toolDone: { backgroundColor: '#22c55e' },
  toolTxt: { color: '#fff', fontSize: 18, fontWeight: '700' },
  colorDot: { width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: '#fff' },
  textModal: { flex: 1, backgroundColor: 'rgba(0,0,0,.6)', justifyContent: 'center', padding: 24 },
  textBox: { backgroundColor: '#161a24', borderRadius: 14, padding: 16, maxWidth: 420, width: '100%', alignSelf: 'center' },
  textInput: { marginTop: 10, backgroundColor: '#0f1219', color: '#f3f4f6', borderWidth: 1, borderColor: '#2a3040', borderRadius: 10, padding: 10, fontSize: 15 },
  riseRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginTop: 8 },
  riseLabel: { color: '#9aa3b5', fontSize: 12, fontWeight: '700', marginRight: 2 },
  chip: { backgroundColor: '#1d4ed8', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 },
  chipAlt: { backgroundColor: '#7c3aed' },
  chipText: { color: '#fff', fontSize: 12, fontWeight: '700' },
  noteBox: { marginTop: 8, maxHeight: 70, backgroundColor: '#0f1219', borderRadius: 8, borderLeftWidth: 4, borderLeftColor: '#f59e0b', paddingHorizontal: 10, paddingVertical: 7 },
  noteLabel: { color: '#fbbf24', fontWeight: '800', fontSize: 12 },
  noteText: { color: '#f3f4f6', fontSize: 13, lineHeight: 18 },
  btns: { flexDirection: 'row', gap: 10, marginTop: 10 },
  btn: { flex: 1, borderRadius: 12, paddingVertical: 14, alignItems: 'center' },
  approve: { backgroundColor: '#22c55e' },
  reject: { backgroundColor: '#ef4444' },
  neutral: { backgroundColor: '#374151' },
  small: { paddingVertical: 11 },
  pressed: { opacity: 0.6 },
  btnText: { color: '#fff', fontSize: 16, fontWeight: '800' },
  decided: { marginTop: 8, padding: 10, borderRadius: 8, backgroundColor: '#0f1219', borderLeftWidth: 4 },
  decidedOk: { borderLeftColor: '#22c55e' },
  decidedBad: { borderLeftColor: '#ef4444' },
  decidedText: { color: '#f3f4f6', fontSize: 13 },
  reason: { color: '#9aa3b5', fontStyle: 'italic', marginTop: 2 },
});
