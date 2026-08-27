import 'dotenv/config';

const isTrue = (value: string | undefined, fallback = false) => value === undefined ? fallback : ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
const env = (key: string, fallback = '') => process.env[key] ?? fallback;
const normalizeAdminIdentity = (value: string) => { const raw = value.trim(); if (raw.includes('@')) return raw.toLowerCase(); const digits = raw.replace(/[\s()-]/g, ''); if (digits.startsWith('01') && digits.length === 11) return `+880${digits.slice(1)}`; if (digits.startsWith('8801') && digits.length === 13) return `+${digits}`; return digits; };
const normalizeOrigin = (value: string) => { try { return new URL(value.trim()).origin; } catch { return ''; } };
const nodeEnv = env('NODE_ENV', 'development');
const isProduction = nodeEnv === 'production';
const configuredOrigin = env('APP_ORIGIN') || env('RENDER_EXTERNAL_URL') || (env('RENDER_EXTERNAL_HOSTNAME') ? `https://${env('RENDER_EXTERNAL_HOSTNAME')}` : 'http://localhost:8787');
const appOrigin = normalizeOrigin(configuredOrigin) || 'http://localhost:8787';
const configuredCors = env('CORS_ORIGINS', '').split(',').map(normalizeOrigin).filter(Boolean);

export const config = {
  nodeEnv,
  isProduction,
  host: env('HOST', '0.0.0.0'),
  port: Number(env('PORT', '8787')),
  appOrigin,
  corsOrigins: [...new Set([...configuredCors, appOrigin])],
  trustProxy: isTrue(process.env.TRUST_PROXY),
  serveStatic: isTrue(process.env.SERVE_STATIC, true),
  mongoUri: env('MONGODB_URI'),
  jwtSecret: env('JWT_SECRET', 'local-only-change-me-local-only-change-me'),
  jwtIssuer: env('JWT_ISSUER', 'sadik-travels-api'),
  jwtAudience: env('JWT_AUDIENCE', 'sadik-travels-web'),
  accessTokenTtl: env('ACCESS_TOKEN_TTL', '15m'),
  refreshTokenTtl: env('REFRESH_TOKEN_TTL', '30d'),
  cookieDomain: env('COOKIE_DOMAIN') || undefined,
  // Render terminates TLS before forwarding requests to Node. Default cookies
  // to Secure in production so a missing dashboard variable cannot silently
  // create transportable authentication cookies. An explicit false is still
  // rejected by validateConfig() below.
  cookieSecure: isTrue(process.env.COOKIE_SECURE, isProduction),
  cookieSameSite: env('COOKIE_SAMESITE', 'lax') as 'lax' | 'strict' | 'none',
  adminIdentities: env('ADMIN_IDENTITIES').split(',').map(normalizeAdminIdentity).filter(Boolean),
  superAdminEmail: env('SUPER_ADMIN_EMAIL'),
  superAdminPassword: env('SUPER_ADMIN_PASSWORD'),
  settingsMasterKey: env('SETTINGS_MASTER_KEY', 'local-only-settings-master-key-change-me'),
  cloudinaryCloudName: env('CLOUDINARY_CLOUD_NAME'),
  cloudinaryApiKey: env('CLOUDINARY_API_KEY'),
  cloudinaryApiSecret: env('CLOUDINARY_API_SECRET'),
  mediaMaxUploadBytes: Number(env('MEDIA_MAX_UPLOAD_BYTES', String(8 * 1024 * 1024))),
  mediaTimeoutMs: Number(env('MEDIA_TIMEOUT_MS', '15000')),
  smsProvider: env('SMS_PROVIDER', 'custom_gateway') as 'custom_gateway' | 'bulksmsbd',
  // Provider credentials intentionally default to empty. Local OTP can use DEV_OTP_ECHO without sending data anywhere.
  smsGatewayUrl: env('SMS_GATEWAY_URL'),
  smsGatewayUsername: env('SMS_GATEWAY_USERNAME'),
  smsGatewayPassword: env('SMS_GATEWAY_PASSWORD'),
  bulkSmsApiUrl: env('BULKSMSBD_API_URL', 'https://bulksmsbd.net/api/smsapi'),
  bulkSmsApiKey: env('BULKSMSBD_API_KEY'),
  bulkSmsSenderId: env('BULKSMSBD_SENDER_ID'),
  smtpHost: env('SMTP_HOST'),
  smtpPort: Number(env('SMTP_PORT', '587')),
  smtpUser: env('SMTP_USER'),
  smtpPassword: env('SMTP_PASSWORD'),
  smtpFrom: env('SMTP_FROM'),
  providerTimeoutMs: Number(env('OUTBOUND_TIMEOUT_MS', env('TRAVEL_PROVIDER_TIMEOUT_MS', '12000'))),
  paymentMode: env('PAYMENT_MODE', 'live') as 'live',
  paymentBaseUrl: env('PAYMENT_PROVIDER_BASE_URL'),
  paymentApiKey: env('PAYMENT_PROVIDER_API_KEY'),
  paymentWebhookSecret: env('PAYMENT_WEBHOOK_SECRET'),
  // Firebase Authentication (Google "Continue with Google" admin sign-in).
  firebaseProjectId: env('FIREBASE_PROJECT_ID'),
  firebaseClientEmail: env('FIREBASE_CLIENT_EMAIL'),
  firebasePrivateKey: env('FIREBASE_PRIVATE_KEY').replace(/\\n/g, '\n'),
  // Public Firebase web config (safe to expose to the browser).
  firebaseApiKey: env('FIREBASE_API_KEY'),
  firebaseAuthDomain: env('FIREBASE_AUTH_DOMAIN'),
  firebaseAppId: env('FIREBASE_APP_ID'),
  firebaseMeasurementId: env('FIREBASE_MEASUREMENT_ID'),
  // Firebase Realtime Database — live chat conversations and transcripts.
  // When set (together with the service account above), live chat is stored in
  // and served from Realtime Database. Blank falls back to the project default
  // (https://<FIREBASE_PROJECT_ID>-default-rtdb.firebaseio.com) or MongoDB.
  firebaseDatabaseUrl: env('FIREBASE_DATABASE_URL'),
  devOtpEcho: isTrue(process.env.DEV_OTP_ECHO, false),
  logLevel: env('LOG_LEVEL', 'info'),
  publicDir: process.cwd()
};

export function validateConfig() {
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error('PORT must be a valid TCP port');
  if (!config.mongoUri) throw new Error('MONGODB_URI is required');
  if ((config.superAdminEmail && !config.superAdminPassword) || (!config.superAdminEmail && config.superAdminPassword)) throw new Error('SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD must be provided together');
  if (config.superAdminPassword && config.superAdminPassword.length < 12) throw new Error('SUPER_ADMIN_PASSWORD must be at least 12 characters');
  const firebaseServer = [config.firebaseProjectId, config.firebaseClientEmail, config.firebasePrivateKey];
  if (firebaseServer.some(Boolean) && !firebaseServer.every(Boolean)) throw new Error('FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY must be provided together');
  const firebaseWeb = [config.firebaseApiKey, config.firebaseAuthDomain];
  if (firebaseWeb.some(Boolean) && !firebaseWeb.every(Boolean)) throw new Error('FIREBASE_API_KEY and FIREBASE_AUTH_DOMAIN must be provided together');
  if (config.firebaseDatabaseUrl) {
    let firebaseDbUrl: URL;
    try { firebaseDbUrl = new URL(config.firebaseDatabaseUrl); } catch { throw new Error('FIREBASE_DATABASE_URL must be a valid URL, e.g. https://<project>-default-rtdb.firebaseio.com'); }
    if (firebaseDbUrl.protocol !== 'https:') throw new Error('FIREBASE_DATABASE_URL must use HTTPS');
  }
  if (!Number.isInteger(config.smtpPort) || config.smtpPort < 1 || config.smtpPort > 65535) throw new Error('SMTP_PORT must be a valid TCP port');
  if (!Number.isInteger(config.mediaMaxUploadBytes) || config.mediaMaxUploadBytes < 1_000_000 || config.mediaMaxUploadBytes > 25_000_000) throw new Error('MEDIA_MAX_UPLOAD_BYTES must be between 1MB and 25MB');
  if (!Number.isInteger(config.mediaTimeoutMs) || config.mediaTimeoutMs < 1000 || config.mediaTimeoutMs > 120000) throw new Error('MEDIA_TIMEOUT_MS must be between 1000 and 120000');
  if (config.isProduction) {
    if (/mongodb:\/\/(localhost|127\.0\.0\.1)/i.test(config.mongoUri)) throw new Error('Production requires a managed MONGODB_URI, not localhost');
    if (!config.cloudinaryCloudName || !config.cloudinaryApiKey || !config.cloudinaryApiSecret) throw new Error('CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET are required in production');
    if (config.jwtSecret.length < 32 || config.jwtSecret.includes('local-only')) throw new Error('JWT_SECRET must be a strong production secret');
    if (config.settingsMasterKey.length < 32 || config.settingsMasterKey.includes('local-only')) throw new Error('SETTINGS_MASTER_KEY must be a strong production secret');
    if (!['lax', 'strict', 'none'].includes(config.cookieSameSite)) throw new Error('COOKIE_SAMESITE must be lax, strict, or none');
    if (!config.cookieSecure) throw new Error('COOKIE_SECURE must be true in production');
    if (config.cookieSameSite === 'none' && !config.cookieSecure) throw new Error('COOKIE_SAMESITE=none requires COOKIE_SECURE=true');
    if (!config.appOrigin.startsWith('https://')) throw new Error('APP_ORIGIN or RENDER_EXTERNAL_URL must use HTTPS in production');
    if (config.corsOrigins.some(origin => !origin.startsWith('https://'))) throw new Error('CORS_ORIGINS must use HTTPS in production');
    if (config.devOtpEcho) throw new Error('DEV_OTP_ECHO must be false in production');
    // SMS, SMTP, travel and payment integrations may be configured securely from the admin console.
    // Their adapters return explicit 503/502 errors until a real provider is configured.
  }
}
