import { getApps, initializeApp, cert, type App } from 'firebase-admin/app';
import { getAuth, type DecodedIdToken } from 'firebase-admin/auth';
import { config } from './config.js';
import { AppError } from './errors.js';

let adminApp: App | undefined;
let initAttempted = false;

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
