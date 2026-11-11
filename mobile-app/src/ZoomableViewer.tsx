import React, { useEffect, useImperativeHandle, useRef, useState, forwardRef } from 'react';
import { Image, Platform, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import type { Marks, Shape } from './types';

export interface ZoomableHandle { reset: () => void; }
export type DrawTool = 'pen' | 'line' | 'circle' | 'text' | null;

interface Props {
  frontUri: string | null;   // data: URI, '' when none, null while loading
  sideUri: string | null;
  view: 'front' | 'side';
  onSwipe: (dir: 'left' | 'right' | 'up' | 'down') => void;
  onDoubleTap: () => void;
  onSingleTap: () => void;
  onZoomChange: (zoomed: boolean) => void;
  marks?: Marks;                                   // drawings shown on the photos
  drawTool?: DrawTool;                             // when set, touches draw instead of swiping
  drawColor?: string;
  onAddShape?: (view: 'front' | 'side', s: Shape) => void;
  onTextAt?: (view: 'front' | 'side', pt: number[]) => void;
}

const MAX = 6;
const STROKE = 3;

/** Natural width / height of an image (needed to place drawings exactly on the photo). */
function useAspect(uri: string | null) {
  const [a, setA] = useState(0);
  useEffect(() => {
    let alive = true;
    setA(0);
    if (uri) Image.getSize(uri, (w, h) => { if (alive && w && h) setA(w / h); }, () => {});
    return () => { alive = false; };
  }, [uri]);
  return a;
}

/** Where a "contain" image actually sits inside its pane. */
function fit(aspect: number, pw: number, ph: number) {
  if (!aspect || !pw || !ph) return { x: 0, y: 0, w: pw, h: ph };
  const w = Math.min(pw, ph * aspect), h = w / aspect;
  return { x: (pw - w) / 2, y: (ph - h) / 2, w, h };
}

function Seg({ x1, y1, x2, y2, color }: { x1: number; y1: number; x2: number; y2: number; color: string }) {
  const len = Math.hypot(x2 - x1, y2 - y1);
  return <View style={{
    position: 'absolute', left: (x1 + x2) / 2 - len / 2, top: (y1 + y2) / 2 - STROKE / 2, width: len, height: STROKE,
    backgroundColor: color, borderRadius: STROKE / 2, transform: [{ rotate: `${Math.atan2(y2 - y1, x2 - x1)}rad` }],
  }} />;
}

function ShapeView({ s, W, H }: { s: Shape; W: number; H: number }) {
  if (s.type === 'line') return <Seg x1={s.a[0] * W} y1={s.a[1] * H} x2={s.b[0] * W} y2={s.b[1] * H} color={s.color} />;
  if (s.type === 'circle') {
    const r = Math.max(2, s.r * W);
    return <View style={{ position: 'absolute', left: s.a[0] * W - r, top: s.a[1] * H - r, width: r * 2, height: r * 2, borderRadius: r, borderWidth: STROKE, borderColor: s.color }} />;
  }
  if (s.type === 'text') {
    return <View style={{ position: 'absolute', left: s.a[0] * W, top: s.a[1] * H, backgroundColor: 'rgba(0,0,0,.65)', borderRadius: 4, paddingHorizontal: 5, paddingVertical: 2, maxWidth: W * 0.8 }}>
      <Text style={{ color: s.color, fontSize: 14, fontWeight: '700' }}>{s.text}</Text>
    </View>;
  }
  const segs = [];
  for (let i = 0; i + 3 < s.pts.length; i += 2) {
    segs.push(<Seg key={i} x1={s.pts[i] * W} y1={s.pts[i + 1] * H} x2={s.pts[i + 2] * W} y2={s.pts[i + 3] * H} color={s.color} />);
  }
  return <>{segs}</>;
}

export const ZoomableViewer = forwardRef<ZoomableHandle, Props>(function ZoomableViewer(
  { frontUri, sideUri, view, onSwipe, onDoubleTap, onSingleTap, onZoomChange, marks, drawTool, drawColor = '#ff2d2d', onAddShape, onTextAt }, ref) {
  const { width } = useWindowDimensions();
  const scale = useSharedValue(1);
  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  const savedScale = useSharedValue(1);
  const savedTx = useSharedValue(0);
  const savedTy = useSharedValue(0);
  const slide = useSharedValue(view === 'side' ? 1 : 0);
  const height = useSharedValue(1);
  const pinching = useSharedValue(false);
  const viewportRef = useRef<View>(null);
  const [paneH, setPaneH] = useState(0);
  const [cur, setCur] = useState<Shape | null>(null);      // shape being drawn
  const curRef = useRef<Shape | null>(null);
  const aspects = { front: useAspect(frontUri), side: useAspect(sideUri) };

  const reset = () => {
    scale.value = withTiming(1); tx.value = withTiming(0); ty.value = withTiming(0);
    savedScale.value = 1; savedTx.value = 0; savedTy.value = 0;
    onZoomChange(false);
  };
  useImperativeHandle(ref, () => ({ reset }));

  /** Button / mouse-wheel zoom around the centre (works on phones, tablets and desktop browsers). */
  const zoomBy = (factor: number) => {
    const c = savedScale.value;
    const next = Math.min(MAX, Math.max(1, c * factor));
    if (next <= 1.02) { reset(); return; }
    const k = next / c;
    savedTx.value = savedTx.value * k; savedTy.value = savedTy.value * k; savedScale.value = next;
    tx.value = withTiming(savedTx.value, { duration: 150 });
    ty.value = withTiming(savedTy.value, { duration: 150 });
    scale.value = withTiming(next, { duration: 150 });
    onZoomChange(true);
  };

  // Desktop browsers: mouse wheel / trackpad pinch zooms the photo instead of the page.
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const el = viewportRef.current as unknown as HTMLElement | null;
    if (!el || !el.addEventListener) return;
    const onWheel = (e: WheelEvent) => { e.preventDefault(); zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15); };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  useEffect(() => { slide.value = withTiming(view === 'side' ? 1 : 0, { duration: 220 }); reset(); }, [view]);

  // ---------------------------------------------------------------- normal gestures
  const pinch = Gesture.Pinch()
    .onStart(() => { pinching.value = true; })
    .onUpdate((e) => {
      const next = Math.min(MAX, Math.max(1, savedScale.value * e.scale));
      const fx = e.focalX - width / 2, fy = e.focalY - height.value / 2;   // zoom around the fingers
      tx.value = savedTx.value + (fx - savedTx.value) * (1 - next / savedScale.value);
      ty.value = savedTy.value + (fy - savedTy.value) * (1 - next / savedScale.value);
      scale.value = next;
    })
    .onEnd(() => {
      if (scale.value <= 1.02) { scale.value = withTiming(1); tx.value = withTiming(0); ty.value = withTiming(0); savedScale.value = 1; savedTx.value = 0; savedTy.value = 0; runOnJS(onZoomChange)(false); }
      else { savedScale.value = scale.value; savedTx.value = tx.value; savedTy.value = ty.value; runOnJS(onZoomChange)(true); }
    })
    .onFinalize(() => { pinching.value = false; });

  const pan = Gesture.Pan()
    .minDistance(8)
    .onUpdate((e) => {
      if (pinching.value) return;
      if (savedScale.value > 1.02) { tx.value = savedTx.value + e.translationX; ty.value = savedTy.value + e.translationY; }
    })
    .onEnd((e) => {
      if (pinching.value || e.numberOfPointers > 1) return;   // a pinch is not a swipe
      if (savedScale.value > 1.02) { savedTx.value = tx.value; savedTy.value = ty.value; return; }
      const ax = Math.abs(e.translationX), ay = Math.abs(e.translationY);
      if (ax > 50 && ax > ay * 1.3) runOnJS(onSwipe)(e.translationX < 0 ? 'left' : 'right');
      else if (ay > 60 && ay > ax * 1.3) runOnJS(onSwipe)(e.translationY < 0 ? 'up' : 'down');
    });

  const doubleTap = Gesture.Tap().numberOfTaps(2).maxDelay(300).onEnd((_e, ok) => { if (ok) runOnJS(onDoubleTap)(); });
  const singleTap = Gesture.Tap().numberOfTaps(1).onEnd((_e, ok) => { if (ok) runOnJS(onSingleTap)(); });
  const normal = Gesture.Simultaneous(pinch, pan, Gesture.Exclusive(doubleTap, singleTap));

  // ---------------------------------------------------------------- drawing gestures
  /** Screen point inside the viewport -> 0..1 position on the photo (undoing zoom and pan). */
  const toImage = (x: number, y: number): number[] => {
    const cx = width / 2, cy = paneH / 2, s = scale.value;
    const qx = (x - cx - tx.value) / s + cx, qy = (y - cy - ty.value) / s + cy;
    const r = fit(aspects[view], width, paneH);
    const clamp = (v: number) => Math.max(0, Math.min(1, v));
    return [clamp((qx - r.x) / r.w), clamp((qy - r.y) / r.h)];
  };
  const setShape = (s: Shape | null) => { curRef.current = s; setCur(s); };

  const drawPan = Gesture.Pan().runOnJS(true).minDistance(0).maxPointers(1)
    .onBegin((e) => {
      const p = toImage(e.x, e.y);
      if (drawTool === 'pen') setShape({ type: 'pen', color: drawColor, pts: [p[0], p[1]] });
      else if (drawTool === 'line') setShape({ type: 'line', color: drawColor, a: p, b: p });
      else if (drawTool === 'circle') setShape({ type: 'circle', color: drawColor, a: p, r: 0 });
    })
    .onUpdate((e) => {
      const c = curRef.current;
      if (!c) return;
      const p = toImage(e.x, e.y);
      if (c.type === 'pen') {
        const n = c.pts.length;
        if (Math.hypot(p[0] - c.pts[n - 2], p[1] - c.pts[n - 1]) < 0.012) return;   // keep strokes light
        setShape({ ...c, pts: [...c.pts, p[0], p[1]] });
      } else if (c.type === 'line') setShape({ ...c, b: p });
      else if (c.type === 'circle') {
        const r = fit(aspects[view], width, paneH);
        setShape({ ...c, r: Math.hypot((p[0] - c.a[0]) * r.w, (p[1] - c.a[1]) * r.h) / (r.w || 1) });
      }
    })
    .onFinalize(() => {
      const c = curRef.current;
      setShape(null);
      if (!c) return;
      const ok = c.type === 'pen' ? c.pts.length >= 4
        : c.type === 'line' ? Math.hypot(c.b[0] - c.a[0], c.b[1] - c.a[1]) > 0.015
        : c.type === 'circle' ? c.r > 0.012 : false;
      if (ok) onAddShape?.(view, c);
    });
  const textTap = Gesture.Tap().runOnJS(true).onEnd((e, ok) => { if (ok) onTextAt?.(view, toImage(e.x, e.y)); });
  const gesture = drawTool === 'text' ? textTap : drawTool ? drawPan : normal;

  const trackStyle = useAnimatedStyle(() => ({ transform: [{ translateX: -slide.value * width }] }));
  const zoomStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: tx.value }, { translateY: ty.value }, { scale: scale.value }],
  }));

  const pane = (uri: string | null, v: 'front' | 'side') => {
    const r = fit(aspects[v], width, paneH);
    const list = (marks?.[v] ?? []).concat(cur && v === view ? [cur] : []);
    return (
      <View style={[styles.pane, { width }]}>
        {uri === null ? <Text style={styles.ph}>Loading {v}…</Text>
          : uri === '' ? <Text style={styles.ph}>No {v} image</Text>
          : (
            // plain Image inside an Animated.View: Animated.Image drops `source` on the web build
            <Animated.View style={[styles.img, zoomStyle]} pointerEvents="none">
              <Image source={{ uri }} resizeMode="contain" style={styles.img} />
              {list.length > 0 && aspects[v] > 0 && (
                <View style={{ position: 'absolute', left: r.x, top: r.y, width: r.w, height: r.h }}>
                  {list.map((s, i) => <ShapeView key={i} s={s} W={r.w} H={r.h} />)}
                </View>
              )}
            </Animated.View>
          )}
      </View>
    );
  };

  return (
    <View style={styles.viewport}>
      <GestureDetector gesture={gesture}>
        <View ref={viewportRef} style={[styles.viewport, Platform.OS === 'web' && ({ touchAction: 'none', cursor: drawTool ? 'crosshair' : 'auto' } as any)]} collapsable={false}
          onLayout={(e) => { height.value = e.nativeEvent.layout.height; setPaneH(e.nativeEvent.layout.height); }}>
          <Animated.View style={[styles.track, { width: width * 2 }, trackStyle]}>
            {pane(frontUri, 'front')}
            {pane(sideUri, 'side')}
          </Animated.View>
        </View>
      </GestureDetector>
      <View style={styles.zoomBtns}>
        <Pressable onPress={() => zoomBy(1.5)} style={styles.zoomBtn} hitSlop={6}><Text style={styles.zoomTxt}>＋</Text></Pressable>
        <Pressable onPress={() => zoomBy(1 / 1.5)} style={styles.zoomBtn} hitSlop={6}><Text style={styles.zoomTxt}>－</Text></Pressable>
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  viewport: { flex: 1, overflow: 'hidden', backgroundColor: '#000' },
  track: { flex: 1, flexDirection: 'row' },
  pane: { height: '100%', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  img: { width: '100%', height: '100%' },
  ph: { color: '#9aa3b5', fontSize: 13 },
  zoomBtns: { position: 'absolute', right: 10, bottom: 28, gap: 8 },
  zoomBtn: { width: 42, height: 42, borderRadius: 21, backgroundColor: 'rgba(0,0,0,.6)', alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,.25)' },
  zoomTxt: { color: '#fff', fontSize: 22, lineHeight: 24, fontWeight: '700' },
});
