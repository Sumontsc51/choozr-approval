import React, { useEffect, useImperativeHandle, useRef, forwardRef } from 'react';
import { Image, Platform, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

export interface ZoomableHandle { reset: () => void; }

interface Props {
  frontUri: string | null;   // data: URI, '' when none, null while loading
  sideUri: string | null;
  view: 'front' | 'side';
  onSwipe: (dir: 'left' | 'right' | 'up' | 'down') => void;
  onDoubleTap: () => void;
  onSingleTap: () => void;
  onZoomChange: (zoomed: boolean) => void;
}

const MAX = 6;

export const ZoomableViewer = forwardRef<ZoomableHandle, Props>(function ZoomableViewer(
  { frontUri, sideUri, view, onSwipe, onDoubleTap, onSingleTap, onZoomChange }, ref) {
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

  const reset = () => {
    scale.value = withTiming(1); tx.value = withTiming(0); ty.value = withTiming(0);
    savedScale.value = 1; savedTx.value = 0; savedTy.value = 0;
    onZoomChange(false);
  };
  useImperativeHandle(ref, () => ({ reset }));

  /** Button / mouse-wheel zoom around the centre (works on phones, tablets and desktop browsers). */
  const zoomBy = (factor: number) => {
    const cur = savedScale.value;
    const next = Math.min(MAX, Math.max(1, cur * factor));
    if (next <= 1.02) { reset(); return; }
    const k = next / cur;
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

  const pinch = Gesture.Pinch()
    .onStart(() => { pinching.value = true; })
    .onUpdate((e) => {
      const next = Math.min(MAX, Math.max(1, savedScale.value * e.scale));
      // zoom around the focal point
      const fx = e.focalX - width / 2, fy = e.focalY - height.value / 2;
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
  const taps = Gesture.Exclusive(doubleTap, singleTap);
  const gesture = Gesture.Simultaneous(pinch, pan, taps);

  const trackStyle = useAnimatedStyle(() => ({ transform: [{ translateX: -slide.value * width }] }));
  const zoomStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: tx.value }, { translateY: ty.value }, { scale: scale.value }],
  }));

  const pane = (uri: string | null, label: string) => (
    <View style={[styles.pane, { width }]}>
      {uri === null ? <Text style={styles.ph}>Loading {label}…</Text>
        : uri === '' ? <Text style={styles.ph}>No {label} image</Text>
        : (
          // plain Image inside an Animated.View: Animated.Image drops `source` on the web build
          <Animated.View style={[styles.img, zoomStyle]} pointerEvents="none">
            <Image source={{ uri }} resizeMode="contain" style={styles.img} />
          </Animated.View>
        )}
    </View>
  );

  return (
    <View style={styles.viewport}>
      <GestureDetector gesture={gesture}>
        <View ref={viewportRef} style={[styles.viewport, Platform.OS === 'web' && ({ touchAction: 'none' } as any)]} collapsable={false}
          onLayout={(e) => { height.value = e.nativeEvent.layout.height; }}>
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
