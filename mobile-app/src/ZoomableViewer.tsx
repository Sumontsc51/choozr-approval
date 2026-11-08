import React, { useEffect, useImperativeHandle, forwardRef } from 'react';
import { StyleSheet, Text, View, useWindowDimensions } from 'react-native';
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

  const reset = () => {
    scale.value = withTiming(1); tx.value = withTiming(0); ty.value = withTiming(0);
    savedScale.value = 1; savedTx.value = 0; savedTy.value = 0;
    onZoomChange(false);
  };
  useImperativeHandle(ref, () => ({ reset }));

  useEffect(() => { slide.value = withTiming(view === 'side' ? 1 : 0, { duration: 220 }); reset(); }, [view]);

  const pinch = Gesture.Pinch()
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
    });

  const pan = Gesture.Pan()
    .minDistance(8)
    .onUpdate((e) => {
      if (savedScale.value > 1.02) { tx.value = savedTx.value + e.translationX; ty.value = savedTy.value + e.translationY; }
    })
    .onEnd((e) => {
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
        : <Animated.Image source={{ uri }} resizeMode="contain" style={[styles.img, zoomStyle]} />}
    </View>
  );

  return (
    <GestureDetector gesture={gesture}>
      <View style={styles.viewport} collapsable={false} onLayout={(e) => { height.value = e.nativeEvent.layout.height; }}>
        <Animated.View style={[styles.track, { width: width * 2 }, trackStyle]}>
          {pane(frontUri, 'front')}
          {pane(sideUri, 'side')}
        </Animated.View>
      </View>
    </GestureDetector>
  );
});

const styles = StyleSheet.create({
  viewport: { flex: 1, overflow: 'hidden', backgroundColor: '#000' },
  track: { flex: 1, flexDirection: 'row' },
  pane: { height: '100%', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  img: { width: '100%', height: '100%' },
  ph: { color: '#9aa3b5', fontSize: 13 },
});
