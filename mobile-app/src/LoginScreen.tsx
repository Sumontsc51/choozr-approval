import React, { useEffect, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { signInWithEmailAndPassword, sendPasswordResetEmail, signOut } from 'firebase/auth';
import { auth } from './firebase';
import { claimAdmin, ensureUserDoc, signUp } from './api';
import type { Profile } from './types';

export function LoginScreen() {
  const [mode, setMode] = useState<'in' | 'up'>('in');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [info, setInfo] = useState('');

  const submit = async () => {
    setErr(''); setInfo(''); setBusy(true);
    try {
      if (mode === 'in') await signInWithEmailAndPassword(auth, email.trim(), password);
      else {
        if (!name.trim()) throw new Error('Enter your name.');
        await signUp(email.trim(), password, name.trim());
      }
    } catch (e: any) {
      const c = String(e?.code ?? '');
      setErr(/invalid-credential|wrong-password|user-not-found/.test(c) ? 'Wrong email or password.'
        : /email-already-in-use/.test(c) ? 'This email already has an account — sign in instead.'
        : /weak-password/.test(c) ? 'Password must be at least 6 characters.'
        : /too-many/.test(c) ? 'Too many attempts. Try again later.' : e.message);
    } finally { setBusy(false); }
  };
  const reset = async () => {
    if (!email.trim()) { setErr('Enter your email first.'); return; }
    try { await sendPasswordResetEmail(auth, email.trim()); setInfo('Password reset email sent.'); } catch (e: any) { setErr(e.message); }
  };

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={s.wrap}>
      <ScrollView contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
        <Text style={s.h1}>Measurement Approver</Text>
        <Text style={s.p}>{mode === 'in' ? 'Sign in to review measurement orders.' : 'Create your account. The admin will then give you access.'}</Text>
        {mode === 'up' && (<>
          <Text style={s.label}>Your name</Text>
          <TextInput style={s.input} value={name} onChangeText={setName} autoCapitalize="words" />
        </>)}
        <Text style={s.label}>Email</Text>
        <TextInput style={s.input} value={email} onChangeText={setEmail} autoCapitalize="none" autoCorrect={false} keyboardType="email-address" textContentType="username" />
        <Text style={s.label}>Password</Text>
        <TextInput style={s.input} value={password} onChangeText={setPassword} secureTextEntry textContentType={mode === 'in' ? 'password' : 'newPassword'} onSubmitEditing={submit} />
        {!!err && <Text style={s.err}>{err}</Text>}
        {!!info && <Text style={s.ok}>{info}</Text>}
        <Pressable style={[s.btn, busy && { opacity: 0.6 }]} disabled={busy} onPress={submit}>
          {busy ? <ActivityIndicator color="#fff" /> : <Text style={s.btnText}>{mode === 'in' ? 'Sign in' : 'Create account'}</Text>}
        </Pressable>
        <Pressable style={s.link} onPress={() => { setMode(mode === 'in' ? 'up' : 'in'); setErr(''); }}>
          <Text style={s.linkText}>{mode === 'in' ? 'New here? Create an account' : 'Have an account? Sign in'}</Text>
        </Pressable>
        {mode === 'in' && <Pressable style={s.link} onPress={reset}><Text style={s.linkText}>Forgot password?</Text></Pressable>}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

/** Signed in, but no role assigned yet. Offers first-time admin setup. */
export function NoRoleScreen({ profile }: { profile: Profile }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { if (!profile.exists) ensureUserDoc(profile.uid, profile.email).catch(() => {}); }, [profile.exists]);
  return (
    <View style={[s.wrap, s.content]}>
      <Text style={s.h1}>Waiting for access</Text>
      <Text style={s.p}>{profile.email} is signed in but has no role yet. Ask the admin to add you in ⚙ Settings → Team.</Text>
      <Text style={[s.p, { marginTop: 24 }]}>First-time setup? If nobody is admin yet, you can become the admin:</Text>
      {!!err && <Text style={s.err}>{err}</Text>}
      <Pressable style={[s.btn, busy && { opacity: 0.6 }]} disabled={busy}
        onPress={async () => {
          setBusy(true); setErr('');
          try { await claimAdmin(profile.uid, profile.email, profile.name || profile.email.split('@')[0]); }
          catch (e: any) { setErr(/permission/i.test(e.message) ? 'An admin already exists — ask them to add you.' : e.message); }
          finally { setBusy(false); }
        }}>
        <Text style={s.btnText}>Become admin (first setup only)</Text>
      </Pressable>
      <Pressable style={s.link} onPress={() => signOut(auth)}><Text style={s.linkText}>Sign out</Text></Pressable>
    </View>
  );
}

export const s = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: '#0b0d12' },
  content: { padding: 24, paddingTop: 80, maxWidth: 520, width: '100%', alignSelf: 'center' },
  h1: { color: '#f3f4f6', fontSize: 24, fontWeight: '800' },
  h2: { color: '#f3f4f6', fontSize: 17, fontWeight: '700', marginTop: 28, marginBottom: 8 },
  p: { color: '#9aa3b5', marginTop: 8, lineHeight: 20 },
  label: { color: '#f3f4f6', fontWeight: '600', marginTop: 18, marginBottom: 6 },
  input: { backgroundColor: '#161a24', color: '#f3f4f6', borderWidth: 1, borderColor: '#2a3040', borderRadius: 10, padding: 12, fontSize: 15 },
  err: { color: '#fca5a5', marginTop: 12 },
  ok: { color: '#86efac', marginTop: 12 },
  btn: { backgroundColor: '#3b82f6', borderRadius: 12, paddingVertical: 14, alignItems: 'center', marginTop: 22 },
  btnText: { color: '#fff', fontWeight: '800', fontSize: 16 },
  link: { alignItems: 'center', marginTop: 16 },
  linkText: { color: '#9aa3b5' },
});
