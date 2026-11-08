import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { signOut } from 'firebase/auth';
import { auth } from './firebase';
import { listUsers, removeUser, setRole, subscribeAi, type AiStats, type PlaybookRule } from './api';
import type { Profile, Role } from './types';
import { s as base } from './LoginScreen';

const ROLES: (Role | null)[] = ['approver', 'coordinator', 'admin', null];

function confirm(title: string, msg: string, onYes: () => void) {
  if (Platform.OS === 'web') { if (window.confirm(`${title}\n\n${msg}`)) onYes(); return; }
  Alert.alert(title, msg, [{ text: 'Cancel', style: 'cancel' }, { text: 'Yes', style: 'destructive', onPress: onYes }]);
}

export function AccountScreen({ profile, onClose }: { profile: Profile; onClose: () => void }) {
  const [ai, setAi] = useState<{ accuracy: AiStats; rules: PlaybookRule[]; approvedSeen: number; claude: boolean } | null>(null);
  const [showRules, setShowRules] = useState(false);
  useEffect(() => subscribeAi(setAi), []);

  const a = ai?.accuracy ?? {};
  const total = (a.tp ?? 0) + (a.tn ?? 0) + (a.fp ?? 0) + (a.fn ?? 0);
  const agree = total ? Math.round(((a.tp ?? 0) + (a.tn ?? 0)) / total * 100) : null;

  return (
    <ScrollView style={base.wrap} contentContainerStyle={[base.content, { paddingTop: 24 }]}>
      <View style={st.top}>
        <Text style={base.h1}>Settings</Text>
        <Pressable onPress={onClose} style={st.close}><Text style={st.closeText}>Done</Text></Pressable>
      </View>
      <Text style={base.p}>{profile.name || profile.email} · <Text style={{ color: '#f3f4f6' }}>{profile.role}</Text></Text>

      <Text style={base.h2}>AI quality check</Text>
      <View style={st.card}>
        <Row k="Engines" v={ai?.claude ? 'Built-in model + Claude' : 'Built-in model (free)'} />
        <Row k="Agreement with approvers" v={agree === null ? 'no decisions yet' : `${agree}% (${total} orders)`} />
        <Row k="Caught real problems" v={`${a.tp ?? 0}`} />
        <Row k="Missed problems" v={`${a.fn ?? 0}`} />
        <Row k="False alarms" v={`${a.fp ?? 0}`} />
        <Row k="Approved orders learned" v={`${ai?.approvedSeen ?? 0}`} />
        {ai?.claude && <>
          <Row k="Learned rules (playbook)" v={`${ai.rules.length}`} />
          <Pressable onPress={() => setShowRules((x) => !x)}><Text style={st.link}>{showRules ? 'Hide' : 'Show'} learned rules</Text></Pressable>
          {showRules && (ai.rules.length ? ai.rules.map((r) => (
            <Text key={r.id} style={st.rule}>• <Text style={{ color: '#f3f4f6' }}>{r.measurement} ({r.view})</Text> {r.rule} <Text style={{ color: '#6b7280' }}>×{r.evidence}</Text></Text>
          )) : <Text style={st.rule}>No rules yet — they appear after rejections and reworks.</Text>)}
        </>}
        <Text style={[st.rule, { marginTop: 10 }]}>Screenshots of approved orders are deleted automatically 7 days after approval.</Text>
      </View>

      {profile.role === 'admin' && <Team me={profile.uid} />}

      <Pressable style={[base.btn, { backgroundColor: '#2a3040' }]} onPress={() => signOut(auth)}>
        <Text style={base.btnText}>Sign out</Text>
      </Pressable>
    </ScrollView>
  );
}

const Row = ({ k, v }: { k: string; v: string }) => (
  <View style={st.row}><Text style={st.k}>{k}</Text><Text style={st.v}>{v}</Text></View>
);

function Team({ me }: { me: string }) {
  const [users, setUsers] = useState<{ uid: string; name: string; email: string; role: Role | null }[] | null>(null);
  const [msg, setMsg] = useState('');
  const load = () => listUsers().then((u) => setUsers(u.sort((a, b) => (a.role ? 1 : 0) - (b.role ? 1 : 0)))).catch((e) => setMsg(e.message));
  useEffect(() => { load(); }, []);

  return (
    <>
      <Text style={base.h2}>Team</Text>
      <Text style={[base.p, { marginTop: 0, marginBottom: 8 }]}>People create their own account in the app (or web link), then appear here. Tap the role to change it.</Text>
      <View style={st.card}>
        {!users ? <ActivityIndicator color="#9aa3b5" /> : users.map((u) => (
          <View key={u.uid} style={st.row}>
            <View style={{ flex: 1 }}>
              <Text style={st.v}>{u.name || u.email}</Text>
              <Text style={st.k}>{u.email}</Text>
            </View>
            <Pressable disabled={u.uid === me} onPress={() => {
              const next = ROLES[(ROLES.indexOf(u.role) + 1) % ROLES.length];
              setRole(u.uid, next).then(load).catch((e) => setMsg(e.message));
            }}><Text style={[st.pill, st[`pill_${u.role ?? 'none'}` as 'pill_none']]}>{u.role ?? 'no access'}</Text></Pressable>
            {u.uid !== me && (
              <Pressable onPress={() => confirm('Remove person', `Remove ${u.email}? They lose access immediately.`,
                () => removeUser(u.uid).then(load).catch((e) => setMsg(e.message)))}>
                <Text style={st.del}>✕</Text>
              </Pressable>
            )}
          </View>
        ))}
        {!!msg && <Text style={base.err}>{msg}</Text>}
      </View>
    </>
  );
}

const st = StyleSheet.create({
  top: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  close: { paddingHorizontal: 14, paddingVertical: 8, backgroundColor: '#3b82f6', borderRadius: 10 },
  closeText: { color: '#fff', fontWeight: '700' },
  card: { backgroundColor: '#161a24', borderRadius: 12, padding: 14, gap: 4 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 6, gap: 10 },
  k: { color: '#9aa3b5', fontSize: 13 },
  v: { color: '#f3f4f6', fontSize: 14, fontWeight: '600' },
  link: { color: '#60a5fa', marginTop: 8 },
  rule: { color: '#9aa3b5', fontSize: 13, marginTop: 6, lineHeight: 18 },
  pill: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, overflow: 'hidden', fontSize: 12, fontWeight: '700', color: '#fff' },
  pill_approver: { backgroundColor: '#15803d' },
  pill_coordinator: { backgroundColor: '#1d4ed8' },
  pill_admin: { backgroundColor: '#7c3aed' },
  pill_none: { backgroundColor: '#4b5563' },
  del: { color: '#fca5a5', fontSize: 16, paddingHorizontal: 6 },
});
