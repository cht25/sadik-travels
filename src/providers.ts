import { createHmac, timingSafeEqual } from 'node:crypto';
import nodemailer from 'nodemailer';
import { config } from './config.js';
import { AppError } from './errors.js';

async function requestJson(baseUrl: string, apiKey: string, path: string, payload: unknown, timeoutMs = 12_000) {
  if (!baseUrl || !apiKey) throw new AppError(503, 'PROVIDER_NOT_CONFIGURED', 'The requested live provider is not configured');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(new URL(path, baseUrl).toString(), { method: 'POST', signal: controller.signal, headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${apiKey}`, 'x-api-key': apiKey }, body: JSON.stringify(payload) });
    const body = await response.text();
    let parsed: unknown;
    try { parsed = body ? JSON.parse(body) : {}; } catch { parsed = { raw: body }; }
    if (!response.ok) throw new AppError(502, 'PROVIDER_ERROR', `Provider returned HTTP ${response.status}`, config.isProduction ? undefined : parsed);
    return parsed;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(502, 'PROVIDER_UNAVAILABLE', 'The external provider is unavailable');
  } finally { clearTimeout(timeout); }
}

export type Vertical = 'flight' | 'hotel' | 'home' | 'visa' | 'esim' | 'tour';

export class TravelProvider {
  async search(vertical: Vertical, payload: unknown) {
    if (config.providerMode !== 'live') throw new AppError(503, 'PROVIDER_NOT_CONFIGURED', 'Live travel search is required; no static results are available');
    return requestJson(config.providerBaseUrl, config.providerApiKey, `/v1/${vertical}/search`, payload, config.providerTimeoutMs);
  }
  async reserve(vertical: Vertical, payload: unknown) { return requestJson(config.providerBaseUrl, config.providerApiKey, `/v1/${vertical}/bookings`, payload, config.providerTimeoutMs); }
  async cancel(vertical: Vertical, payload: unknown) { return requestJson(config.providerBaseUrl, config.providerApiKey, `/v1/${vertical}/bookings/cancel`, payload, config.providerTimeoutMs); }
}

function normalizeBangladeshNumber(value: string) {
  const raw = value.trim().replace(/[\s()-]/g, '');
  if (raw.startsWith('+880')) return raw.slice(1);
  if (raw.startsWith('880')) return raw;
  if (raw.startsWith('01')) return `880${raw.slice(1)}`;
  return raw;
}

export class MessagingProvider {
  private transporter() {
    if (!config.smtpHost || !config.smtpUser || !config.smtpPassword || !config.smtpFrom) throw new AppError(503, 'EMAIL_NOT_CONFIGURED', 'SMTP email delivery is not configured');
    return nodemailer.createTransport({ host: config.smtpHost, port: config.smtpPort, secure: config.smtpPort === 465, auth: { user: config.smtpUser, pass: config.smtpPassword } });
  }
  async sendSms(destination: string, message: string) {
    if (!config.bulkSmsApiKey || !config.bulkSmsSenderId) throw new AppError(503, 'SMS_NOT_CONFIGURED', 'BulkSMSBD credentials are not configured');
    const body = new URLSearchParams({ api_key: config.bulkSmsApiKey, senderid: config.bulkSmsSenderId, number: normalizeBangladeshNumber(destination), message });
    const response = await fetch(config.bulkSmsApiUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json,text/plain' }, body });
    const raw = await response.text();
    if (!response.ok || /(^|\b)(error|failed|invalid|insufficient)(\b|:)/i.test(raw)) throw new AppError(502, 'SMS_PROVIDER_ERROR', 'BulkSMSBD rejected the message');
    return { delivered: true, providerResponse: raw.slice(0, 500) };
  }
  async sendEmail(destination: string, subject: string, message: string) {
    await this.transporter().sendMail({ from: config.smtpFrom, to: destination, subject, text: message });
    return { delivered: true };
  }
  async sendOtp(channel: 'sms' | 'email', destination: string, code: string): Promise<{ delivered: boolean; devCode?: string; providerResponse?: string }> {
    try {
      if (channel === 'sms') return await this.sendSms(destination, `Your Sadik Travels login code is ${code}. It expires in 5 minutes.`);
      return await this.sendEmail(destination, 'Your Sadik Travels login code', `Your Sadik Travels login code is ${code}. It expires in 5 minutes.`);
    } catch (error) {
      if (!config.isProduction && config.devOtpEcho) return { delivered: false, devCode: code };
      throw error;
    }
  }
  async sendNotification(channel: 'sms' | 'email', destination: string, title: string, message: string) {
    return channel === 'sms' ? this.sendSms(destination, `${title}: ${message}`) : this.sendEmail(destination, title, message);
  }
}

export class PaymentProvider {
  async createIntent(payload: unknown) { return requestJson(config.paymentBaseUrl, config.paymentApiKey, '/v1/payments/intents', payload, config.providerTimeoutMs); }
  verifyWebhook(rawBody: Buffer, signature: string | undefined) {
    if (!signature || !config.paymentWebhookSecret) return false;
    const expected = createHmac('sha256', config.paymentWebhookSecret).update(rawBody).digest('hex');
    const a = Buffer.from(expected); const b = Buffer.from(signature);
    return a.length === b.length && timingSafeEqual(a, b);
  }
}
