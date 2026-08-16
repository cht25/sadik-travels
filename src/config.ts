import 'dotenv/config';
import path from 'node:path';

const isTrue = (value: string | undefined, fallback = false) => value === undefined ? fallback : ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
const env = (key: string, fallback = '') => process.env[key] ?? fallback;
const normalizeAdminIdentity = (value: string) => {
  const raw = value.trim();
  if (raw.includes('@')) return raw.toLowerCase();
  const digits = raw.replace(/[\s()-]/g, '');
  if (digits.startsWith('01') && digits.length === 11) return `+880${digits.slice(1)}`;
  if (digits.startsWith('8801') && digits.length === 13) return `+${digits}`;
  return digits;
};

export const config = {
  nodeEnv: env('NODE_ENV', 'development'),
  isProduction: env('NODE_ENV', 'development') === 'production',
  host: env('HOST', '0.0.0.0'),
  port: Number(env('PORT', '8787')),
  appOrigin: env('APP_ORIGIN', 'http://localhost:8787').replace(/\/$/, ''),
  corsOrigins: env('CORS_ORIGINS', 'http://localhost:8787').split(',').map(value => value.trim().replace(/\/$/, '')).filter(Boolean),
  trustProxy: isTrue(process.env.TRUST_PROXY),
  dataMode: env('DATA_MODE', 'mongodb') as 'memory' | 'mongodb',
  mongoUri: env('MONGODB_URI', 'mongodb://127.0.0.1:27017/sadik_travels'),
  redisUrl: env('REDIS_URL'),
  jwtSecret: env('JWT_SECRET', 'local-only-change-me-local-only-change-me'),
  jwtIssuer: env('JWT_ISSUER', 'sadik-travels-api'),
  jwtAudience: env('JWT_AUDIENCE', 'sadik-travels-web'),
  accessTokenTtl: env('ACCESS_TOKEN_TTL', '15m'),
  refreshTokenTtl: env('REFRESH_TOKEN_TTL', '30d'),
  cookieDomain: env('COOKIE_DOMAIN') || undefined,
  cookieSecure: isTrue(process.env.COOKIE_SECURE, false),
  cookieSameSite: env('COOKIE_SAMESITE', 'lax') as 'lax' | 'strict' | 'none',
  serveStatic: isTrue(process.env.SERVE_STATIC, true),
  adminIdentities: env('ADMIN_IDENTITIES').split(',').map(normalizeAdminIdentity).filter(Boolean),
  bulkSmsApiUrl: env('BULKSMSBD_API_URL', 'https://bulksmsbd.net/api/smsapi'),
  bulkSmsApiKey: env('BULKSMSBD_API_KEY'),
  bulkSmsSenderId: env('BULKSMSBD_SENDER_ID'),
  smtpHost: env('SMTP_HOST'),
  smtpPort: Number(env('SMTP_PORT', '587')),
  smtpUser: env('SMTP_USER'),
  smtpPassword: env('SMTP_PASSWORD'),
  smtpFrom: env('SMTP_FROM'),
  providerMode: env('PROVIDER_MODE', 'live') as 'live',
  providerBaseUrl: env('TRAVEL_PROVIDER_BASE_URL'),
  providerApiKey: env('TRAVEL_PROVIDER_API_KEY'),
  providerTimeoutMs: Number(env('TRAVEL_PROVIDER_TIMEOUT_MS', '12000')),
  paymentBaseUrl: env('PAYMENT_PROVIDER_BASE_URL'),
  paymentApiKey: env('PAYMENT_PROVIDER_API_KEY'),
  paymentWebhookSecret: env('PAYMENT_WEBHOOK_SECRET'),
  cloudinaryCloudName: env('CLOUDINARY_CLOUD_NAME'),
  cloudinaryApiKey: env('CLOUDINARY_API_KEY'),
  cloudinaryApiSecret: env('CLOUDINARY_API_SECRET'),
  cloudinaryFolder: env('CLOUDINARY_FOLDER', 'sadik-travels'),
  maxUploadBytes: Number(env('MAX_UPLOAD_BYTES', String(5 * 1024 * 1024))),
  devOtpEcho: isTrue(process.env.DEV_OTP_ECHO, false),
  logLevel: env('LOG_LEVEL', 'info'),
  publicDir: path.resolve(process.cwd(), env('PUBLIC_DIR', 'public'))
};

export function validateConfig() {
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error('PORT must be a valid TCP port');
  if (!Number.isInteger(config.maxUploadBytes) || config.maxUploadBytes < 1024 || config.maxUploadBytes > 20 * 1024 * 1024) throw new Error('MAX_UPLOAD_BYTES must be between 1 KB and 20 MB');
  if (!['memory', 'mongodb'].includes(config.dataMode)) throw new Error('DATA_MODE must be memory or mongodb');
  if (config.dataMode === 'mongodb' && !config.mongoUri) throw new Error('MONGODB_URI is required when DATA_MODE=mongodb');
  if (!['lax', 'strict', 'none'].includes(config.cookieSameSite)) throw new Error('COOKIE_SAMESITE must be lax, strict, or none');
  if (config.cookieSameSite === 'none' && !config.cookieSecure) throw new Error('COOKIE_SAMESITE=none requires COOKIE_SECURE=true');
  const cloudinaryConfigured = Boolean(config.cloudinaryCloudName && config.cloudinaryApiKey && config.cloudinaryApiSecret);
  if ([config.cloudinaryCloudName, config.cloudinaryApiKey, config.cloudinaryApiSecret].some(Boolean) && !cloudinaryConfigured) throw new Error('Set all Cloudinary credentials or none of them');
  if (config.isProduction) {
    if (config.jwtSecret.length < 32 || config.jwtSecret.includes('local-only')) throw new Error('JWT_SECRET must be a strong production secret');
    if (config.dataMode !== 'mongodb') throw new Error('Production requires DATA_MODE=mongodb');
    if (/mongodb:\/\/(127\.0\.0\.1|localhost)/i.test(config.mongoUri)) throw new Error('Production requires a managed MONGODB_URI, not localhost');
    if (!config.providerBaseUrl || !config.providerApiKey) throw new Error('Production requires a live travel provider adapter and credentials');
    if (!config.paymentBaseUrl || !config.paymentApiKey || !config.paymentWebhookSecret) throw new Error('Production requires a live payment provider adapter and webhook secret');
    if (!config.redisUrl) throw new Error('Production requires REDIS_URL for distributed rate limiting');
    if (config.devOtpEcho) throw new Error('DEV_OTP_ECHO must be false in production');
    if (!config.cookieSecure) throw new Error('COOKIE_SECURE must be true in production');
    if (!config.appOrigin.startsWith('https://')) throw new Error('APP_ORIGIN must use HTTPS in production');
    if (config.corsOrigins.some(origin => origin === '*' || !origin.startsWith('https://'))) throw new Error('CORS_ORIGINS must contain explicit HTTPS origins in production');
    if (!config.bulkSmsApiKey || !config.bulkSmsSenderId) throw new Error('Production requires BULKSMSBD_API_KEY and BULKSMSBD_SENDER_ID');
    if (!config.smtpHost || !config.smtpUser || !config.smtpPassword || !config.smtpFrom) throw new Error('Production requires SMTP email delivery settings');
    if (!cloudinaryConfigured) throw new Error('Production requires Cloudinary credentials for persistent media storage');
  }
}
