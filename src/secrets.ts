import crypto from 'node:crypto';
import { config } from './config.js';

const key = () => crypto.createHash('sha256').update(config.settingsMasterKey).digest();
export const SECRET_MASK = '••••••••';

export function encryptSecret(value: string) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `v1:${iv.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}:${encrypted.toString('base64url')}`;
}
export function decryptSecret(value: string) {
  if (!value.startsWith('v1:')) return value;
  const [, ivText, tagText, dataText] = value.split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(ivText, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(dataText, 'base64url')), decipher.final()]).toString('utf8');
}
export function maskSecret(value: string | undefined) { return value ? SECRET_MASK : ''; }
