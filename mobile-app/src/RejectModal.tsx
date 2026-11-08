import React, { useState } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { Order } from './types';

const REASONS = ['Lines not on body', 'Side view wrong', 'Waist line off', 'Hip line off', 'Height points off', 'Photo unclear'];

interface Props { order: Order | null; onCancel: () => void; onConfirm: (reason: string) => void; }

export function RejectModal({ order, onCancel, onConfirm }: Props) {
  const [reason, setReason] = useState('');
  const close = () => { setReason(''); onCancel(); };
  return (
    <Modal visible={!!order} transparent animationType="slide" onRequestClose={close}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.backdrop}>
        <Pressable style={{ flex: 1 }} onPress={close} />
        <View style={styles.box}>
          <Text style={styles.title}>Reject order #{order?.orderNo} ({order?.customer})</Text>
          <Text style={styles.sub}>Reason (optional — shown to the measurement coordinator)</Text>
          <TextInput
            style={styles.input} multiline value={reason} onChangeText={setReason}
            placeholder="e.g. Waist line placed too high in side view" placeholderTextColor="#6b7280" />
          <View style={styles.chips}>
            {REASONS.map((r) => (
              <Pressable key={r} style={styles.chip} onPress={() => setReason((v) => (v ? v + '; ' : '') + r)}>
                <Text style={styles.chipText}>{r}</Text>
              </Pressable>
            ))}
          </View>
          <View style={styles.row}>
            <Pressable style={[styles.btn, styles.cancel]} onPress={close}><Text style={styles.btnText}>Cancel</Text></Pressable>
            <Pressable style={[styles.btn, styles.confirm]} onPress={() => { const r = reason.trim(); setReason(''); onConfirm(r); }}>
              <Text style={styles.btnText}>Reject</Text>
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,.7)', justifyContent: 'flex-end' },
  box: { backgroundColor: '#161a24', borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 16, paddingBottom: 28 },
  title: { color: '#f3f4f6', fontWeight: '700', fontSize: 16 },
  sub: { color: '#9aa3b5', fontSize: 13, marginTop: 4, marginBottom: 8 },
  input: { minHeight: 90, backgroundColor: '#0f1219', color: '#f3f4f6', borderWidth: 1, borderColor: '#2a3040', borderRadius: 10, padding: 10, fontSize: 15, textAlignVertical: 'top' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 },
  chip: { backgroundColor: '#0f1219', borderWidth: 1, borderColor: '#2a3040', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5 },
  chipText: { color: '#f3f4f6', fontSize: 12 },
  row: { flexDirection: 'row', gap: 10, marginTop: 12 },
  btn: { flex: 1, borderRadius: 10, paddingVertical: 12, alignItems: 'center' },
  cancel: { backgroundColor: '#2a3040' },
  confirm: { backgroundColor: '#ef4444' },
  btnText: { color: '#fff', fontWeight: '700', fontSize: 15 },
});
