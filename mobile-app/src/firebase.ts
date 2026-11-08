import { Platform } from 'react-native';
import { initializeApp, getApps, getApp } from 'firebase/app';
import * as FirebaseAuth from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { firebaseConfig } from './firebaseConfig';

export const app = getApps().length ? getApp() : initializeApp(firebaseConfig);

function makeAuth() {
  if (Platform.OS === 'web') return FirebaseAuth.getAuth(app);   // browser keeps the session in IndexedDB
  // React Native persistence (exists in Firebase's RN build, missing from the web typings)
  const rnPersistence = (FirebaseAuth as any).getReactNativePersistence;
  try { return FirebaseAuth.initializeAuth(app, { persistence: rnPersistence(AsyncStorage) }); }
  catch { return FirebaseAuth.getAuth(app); }
}
export const auth = makeAuth();
export const db = getFirestore(app);
