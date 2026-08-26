import { getApps, initializeApp, cert, type App } from 'firebase-admin/app';
import { getAuth, type DecodedIdToken } from 'firebase-admin/auth';
import { getDatabaseWithUrl, type Database as RealtimeDatabase } from 'firebase-admin/database';
import { config } from './config.js';
import { AppError } from './errors.js';

let adminApp: App | undefined;
let initAttempted = false;
let chatDatabase: RealtimeDatabase | undefined;
let chatDatabaseAttempted = false;

function serverCredentials(): { projectId: string; clientEmail: string; privateKey: string } | undefined {
  return config.firebaseProjectId && config.firebaseClientEmail && config.firebasePrivateKey
    ? { projectId: config.firebaseProjectId, clientEmail: config.firebaseClientEmail, privateKey: config.firebasePrivateKey }
    : undefined;
}

/** Whether the server can verify Firebase ID tokens (needs the service account). */
export function isFirebaseConfigured(): boolean {
  return Boolean(serverCredentials());
}

function app(): App {
  if (adminApp) return adminApp;
  if (initAttempted) throw new AppError(503, 'FIREBASE_NOT_CONFIGURED', 'Firebase authentication is not configured');
  initAttempted = true;
  const credentials = serverCredentials();
  if (!credentials) throw new AppError(503, 'FIREBASE_NOT_CONFIGURED', 'Firebase authentication is not configured');
  const existing = getApps()[0] as App | undefined;
  if (existing) {
    adminApp = existing;
    return adminApp;
  }
  adminApp = initializeApp({ credential: cert(credentials) });
  return adminApp;
}

/** Verifies a Firebase ID token produced by the browser-side Firebase Auth SDK. */
export async function verifyFirebaseIdToken(idToken: string): Promise<DecodedIdToken> {
  try {
    return await getAuth(app()).verifyIdToken(idToken);
  } catch (error) {
    if (error instanceof AppError && error.code === 'FIREBASE_NOT_CONFIGURED') throw error;
    throw new AppError(401, 'FIREBASE_TOKEN_INVALID', 'Invalid or expired Google sign-in token');
  }
}

/**
 * Realtime Database URL used for live chat: the explicit env override, or the
 * default instance of the Firebase project when a project ID is known.
 */
export function firebaseDatabaseUrl(): string | undefined {
  const explicit = config.firebaseDatabaseUrl?.trim();
  if (explicit) return explicit;
  if (config.firebaseProjectId) return `https://${config.firebaseProjectId}-default-rtdb.firebaseio.com`;
  return undefined;
}

/** Whether the server can read and write the Firebase Realtime Database used for live chat. */
export function isFirebaseDatabaseConfigured(): boolean {
  return Boolean(serverCredentials() && firebaseDatabaseUrl());
}

/**
 * Admin-SDK handle to the live chat Realtime Database. The Admin SDK writes
 * bypass security rules; browsers never talk to this database directly.
 */
export function firebaseRealtimeDatabase(): RealtimeDatabase {
  if (chatDatabase) return chatDatabase;
  if (chatDatabaseAttempted) throw new AppError(503, 'CHAT_STORAGE_NOT_CONFIGURED', 'Live chat storage is not configured');
  const url = firebaseDatabaseUrl();
  if (!url) throw new AppError(503, 'CHAT_STORAGE_NOT_CONFIGURED', 'Live chat storage is not configured');
  try {
    chatDatabase = getDatabaseWithUrl(url, app());
    chatDatabaseAttempted = true;
    return chatDatabase;
  } catch (error) {
    // Keep the app alive with a clean 503 on chat endpoints instead of an
    // unhandled credential error; a later request may retry initialization.
    if (error instanceof AppError) throw new AppError(503, 'CHAT_STORAGE_NOT_CONFIGURED', 'Live chat storage is not configured');
    console.error('Firebase Realtime Database initialization failed', error);
    throw new AppError(503, 'CHAT_STORAGE_UNAVAILABLE', 'Live chat storage is temporarily unavailable');
  }
}

/**
 * Public, browser-safe Firebase web config. Only non-secret values are exposed;
 * the private key and service-account email never leave the server.
 */
export function firebasePublicConfig(): Record<string, string> | undefined {
  if (!config.firebaseApiKey || !config.firebaseAuthDomain) return undefined;
  const value: Record<string, string> = { apiKey: config.firebaseApiKey, authDomain: config.firebaseAuthDomain };
  if (config.firebaseProjectId) value.projectId = config.firebaseProjectId;
  if (config.firebaseAppId) value.appId = config.firebaseAppId;
  if (config.firebaseMeasurementId) value.measurementId = config.firebaseMeasurementId;
  return value;
}

/**
 * Live chat realtime bridge for the browser: the public web config (including
 * the Realtime Database URL) plus the ability to mint per-user custom tokens.
 * The browser signs into Firebase Auth with the custom token and then reads
 * and writes the chat nodes directly — Realtime Database is the real-time
 * source of truth, gated by database.rules.json.
 */
export function firebaseChatBridge(): { webConfig: Record<string, string>; databaseUrl: string; mintToken(uid: string, claims: Record<string, string | boolean>): Promise<string> } | undefined {
  const webConfig = firebasePublicConfig();
  const databaseUrl = firebaseDatabaseUrl();
  if (!webConfig || !databaseUrl || !isFirebaseDatabaseConfigured()) return undefined;
  return {
    webConfig: { ...webConfig, databaseURL: databaseUrl },
    databaseUrl,
    async mintToken(uid, claims) {
      try {
        return await getAuth(app()).createCustomToken(uid, claims);
      } catch (error) {
        console.error('Firebase custom token minting failed', error);
        throw new AppError(503, 'CHAT_TOKEN_UNAVAILABLE', 'Realtime chat is temporarily unavailable');
      }
    }
  };
}
