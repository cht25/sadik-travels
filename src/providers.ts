import { createHmac, timingSafeEqual } from 'node:crypto';
import nodemailer from 'nodemailer';
import { config } from './config.js';
import { AppError } from './errors.js';
import type { Store } from './store.js';

async function fetchWithTimeout(input: string | URL, init: RequestInit, timeoutMs = config.providerTimeoutMs): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(502, 'PROVIDER_TIMEOUT', 'The external provider did not respond in time');
  } finally {
    clearTimeout(timer);
  }
}

async function runtime(store: Store, key: string, fallback = ''): Promise<string> {
  return (await store.getSetting(key)) ?? fallback;
}

function normalizeBangladeshNumber(value: string): string {
  const raw = value.trim().replace(/[\s()-]/g, '');
  if (raw.startsWith('+880')) return raw.slice(1);
  if (raw.startsWith('880')) return raw;
  if (raw.startsWith('01')) return `880${raw.slice(1)}`;
  return raw;
}

function asString(value: unknown): string {
  return value === undefined || value === null ? '' : String(value);
}

function appendPath(base: string, path: string): string {
  return base.endsWith('/') ? `${base.slice(0, -1)}${path}` : `${base}${path}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJsonObject(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function responseJsonObject(response: Response): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await response.json();
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

type SmsConfig = {
  provider: string;
  url: string;
  username: string;
  password: string;
  apiKey: string;
  senderId: string;
};

type EmailConfig = {
  host: string;
  port: number;
  user: string;
  password: string;
  from: string;
  fromName: string;
  secure: boolean;
  rejectUnauthorized: boolean;
};

type PaymentSettings = {
  provider: string;
  sslStoreId: string;
  sslStorePassword: string;
  sslApiUrl: string;
  sslValidationUrl: string;
  sslIpnUrl: string;
  bkashBaseUrl: string;
  bkashAppKey: string;
  bkashAppSecret: string;
  bkashUsername: string;
  bkashPassword: string;
};

export type PaymentIntentPayload = {
  paymentId: string;
  bookingId: string;
  amount: number;
  currency: string;
  customerId: string;
  returnUrl: string;
};

export type PaymentIntentResult = {
  provider: 'sslcommerz' | 'bkash';
  status: 'pending';
  transactionRef: string;
  checkoutUrl: string;
  raw: Record<string, unknown>;
};

export class MessagingProvider {
  constructor(private readonly store: Store) {}

  private async smsConfig(): Promise<SmsConfig> {
    return {
      provider: await runtime(this.store, 'sms_provider', config.smsProvider),
      url: await runtime(this.store, 'sms_gateway_url', config.smsGatewayUrl),
      username: await runtime(this.store, 'sms_gateway_username', config.smsGatewayUsername),
      password: await runtime(this.store, 'sms_gateway_password', config.smsGatewayPassword),
      apiKey: await runtime(this.store, 'sms_api_key', config.bulkSmsApiKey),
      senderId: await runtime(this.store, 'sms_sender_id', config.bulkSmsSenderId)
    };
  }

  private async emailConfig(): Promise<EmailConfig> {
    const port = Number(await runtime(this.store, 'smtp_port', String(config.smtpPort)));
    return {
      host: await runtime(this.store, 'smtp_host', config.smtpHost),
      port,
      user: await runtime(this.store, 'smtp_user', config.smtpUser),
      password: await runtime(this.store, 'smtp_password', config.smtpPassword),
      from: await runtime(this.store, 'smtp_from', config.smtpFrom),
      fromName: (await runtime(this.store, 'smtp_from_name', config.smtpFromName)) || 'Sadik Travels',
      // Implicit TLS only on 465; 587 upgrades with STARTTLS automatically.
      secure: port === 465 ? true : config.smtpSecure,
      rejectUnauthorized: config.smtpRejectUnauthorized
    };
  }

  private buildTransport(c: EmailConfig) {
    return nodemailer.createTransport({
      host: c.host,
      port: c.port,
      secure: c.secure,
      connectionTimeout: config.providerTimeoutMs,
      greetingTimeout: config.providerTimeoutMs,
      socketTimeout: config.providerTimeoutMs,
      auth: c.user && c.password ? { user: c.user, pass: c.password } : undefined,
      tls: { rejectUnauthorized: c.rejectUnauthorized }
    });
  }

  /** RFC-5322 `From:` header. The address is quoted so a name with a comma is safe. */
  private formatFrom(c: EmailConfig): string {
    const name = c.fromName.replace(/["\\]/g, '').trim();
    return name ? `"${name}" <${c.from}>` : c.from;
  }

  /**
   * Deployment check used by Admin → System Status and by the smoke test.
   * Never exposes the password: only whether credentials exist and whether the
   * relay completed a handshake.
   */
  async verifyEmailConfig(): Promise<{ configured: boolean; host: string; port: number; secure: boolean; authPresent: boolean; reachable: boolean; error?: string }> {
    const c = await this.emailConfig();
    const base = { configured: Boolean(c.host && c.from && c.user && c.password), host: c.host, port: c.port, secure: c.secure, authPresent: Boolean(c.user && c.password) };
    if (!base.configured) return { ...base, reachable: false, error: 'SMTP_HOST, SMTP_USER, SMTP_PASSWORD and SMTP_FROM must all be set' };
    try {
      await this.buildTransport(c).verify();
      return { ...base, reachable: true };
    } catch (error) {
      return { ...base, reachable: false, error: error instanceof Error ? error.message : 'SMTP verification failed' };
    }
  }

  async sendSms(destination: string, message: string): Promise<{ delivered: boolean; providerResponse: string }> {
    const c = await this.smsConfig();
    const number = normalizeBangladeshNumber(destination);
    if (c.provider === 'custom_gateway') {
      if (!c.url || !c.username || !c.password) throw new AppError(503, 'SMS_NOT_CONFIGURED', 'Custom SMS gateway credentials are not configured');
      const body = new URLSearchParams({ username: c.username, password: c.password, to: number, number, phone: number, mobile: number, message });
      const response = await fetchWithTimeout(c.url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json,text/plain' }, body });
      const raw = await response.text();
      const parsed = parseJsonObject(raw);
      if (!response.ok || parsed.success === false || Boolean(parsed.error)) throw new AppError(502, 'SMS_PROVIDER_ERROR', 'Custom SMS gateway rejected the message');
      return { delivered: true, providerResponse: raw.slice(0, 500) };
    }

    if (!c.url || !c.apiKey || !c.senderId) throw new AppError(503, 'SMS_NOT_CONFIGURED', 'BulkSMSBD credentials are not configured');
    const body = new URLSearchParams({ api_key: c.apiKey, senderid: c.senderId, number, message });
    const response = await fetchWithTimeout(c.url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json,text/plain' }, body });
    const raw = await response.text();
    if (!response.ok || /(^|\b)(error|failed|invalid|insufficient)(\b|:)/i.test(raw)) throw new AppError(502, 'SMS_PROVIDER_ERROR', 'SMS gateway rejected the message');
    return { delivered: true, providerResponse: raw.slice(0, 500) };
  }

  async sendEmail(destination: string, subject: string, message: string, html?: string): Promise<{ delivered: boolean }> {
    const c = await this.emailConfig();
    if (!c.host || !c.user || !c.password || !c.from) throw new AppError(503, 'EMAIL_NOT_CONFIGURED', 'SMTP email delivery is not configured');
    await this.buildTransport(c).sendMail({ from: this.formatFrom(c), to: destination, subject, text: message, ...(html ? { html } : {}) });
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

  async sendNotification(channel: 'sms' | 'email', destination: string, title: string, message: string): Promise<{ delivered: boolean; providerResponse?: string }> {
    return channel === 'sms' ? this.sendSms(destination, `${title}: ${message}`) : this.sendEmail(destination, title, message);
  }
}

export class PaymentProvider {
  constructor(private readonly store: Store) {}

  private async paymentSettings(): Promise<PaymentSettings> {
    return {
      provider: await runtime(this.store, 'payment_provider', 'sslcommerz'),
      sslStoreId: await runtime(this.store, 'sslcommerz_store_id'),
      sslStorePassword: await runtime(this.store, 'sslcommerz_store_password'),
      sslApiUrl: await runtime(this.store, 'sslcommerz_api_url'),
      sslValidationUrl: await runtime(this.store, 'sslcommerz_validation_url'),
      sslIpnUrl: await runtime(this.store, 'sslcommerz_ipn_url'),
      bkashBaseUrl: await runtime(this.store, 'bkash_base_url'),
      bkashAppKey: await runtime(this.store, 'bkash_app_key'),
      bkashAppSecret: await runtime(this.store, 'bkash_app_secret'),
      bkashUsername: await runtime(this.store, 'bkash_username'),
      bkashPassword: await runtime(this.store, 'bkash_password')
    };
  }

  async createIntent(payload: PaymentIntentPayload): Promise<PaymentIntentResult> {
    const s = await this.paymentSettings();
    if (s.provider === 'bkash') return this.createBkash(payload, s);
    return this.createSslCommerz(payload, s);
  }

  private async createSslCommerz(payload: PaymentIntentPayload, s: PaymentSettings): Promise<PaymentIntentResult> {
    if (!s.sslStoreId || !s.sslStorePassword || !s.sslApiUrl) throw new AppError(503, 'SSLCOMMERZ_NOT_CONFIGURED', 'SSLCommerz merchant settings are not configured');
    const params = new URLSearchParams({
      store_id: s.sslStoreId,
      store_passwd: s.sslStorePassword,
      total_amount: asString(payload.amount),
      currency: asString(payload.currency || 'BDT'),
      tran_id: asString(payload.paymentId),
      success_url: `${payload.returnUrl}?payment=success`,
      fail_url: `${payload.returnUrl}?payment=failed`,
      cancel_url: `${payload.returnUrl}?payment=cancelled`,
      ipn_url: s.sslIpnUrl || `${config.appOrigin}/api/v1/payments/webhook`,
      shipping_method: 'NO',
      product_name: 'Sadik Travels booking',
      product_category: 'Travel',
      cus_name: 'Sadik Travels customer',
      cus_email: 'customer@sadiktravels.com',
      cus_add1: 'Bangladesh',
      cus_phone: '01700000000',
      value_a: asString(payload.bookingId)
    });
    const response = await fetchWithTimeout(s.sslApiUrl.includes('gwprocess') ? s.sslApiUrl : appendPath(s.sslApiUrl, '/gwprocess/v4/api.php'), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: params
    });
    const result = await responseJsonObject(response);
    const checkoutUrl = asString(result.GatewayPageURL);
    if (!response.ok || result.status !== 'SUCCESS' || !checkoutUrl) throw new AppError(502, 'SSLCOMMERZ_ERROR', 'SSLCommerz rejected the payment request');
    return {
      provider: 'sslcommerz',
      status: 'pending',
      transactionRef: asString(result.tran_id) || payload.paymentId,
      checkoutUrl,
      raw: result
    };
  }

  private async createBkash(payload: PaymentIntentPayload, s: PaymentSettings): Promise<PaymentIntentResult> {
    if (!s.bkashBaseUrl || !s.bkashAppKey || !s.bkashAppSecret || !s.bkashUsername || !s.bkashPassword) throw new AppError(503, 'BKASH_NOT_CONFIGURED', 'bKash merchant settings are not configured');
    const base = s.bkashBaseUrl.replace(/\/$/, '');
    const authResponse = await fetchWithTimeout(`${base}/tokenized/checkout/token/grant`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', username: s.bkashUsername, password: s.bkashPassword },
      body: JSON.stringify({ app_key: s.bkashAppKey, app_secret: s.bkashAppSecret })
    });
    const auth = await responseJsonObject(authResponse);
    const idToken = asString(auth.id_token);
    if (!authResponse.ok || !idToken) throw new AppError(502, 'BKASH_AUTH_ERROR', 'bKash authentication failed');

    const createResponse = await fetchWithTimeout(`${base}/tokenized/checkout/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', authorization: idToken, 'x-app-key': s.bkashAppKey },
      body: JSON.stringify({ mode: '0011', payerReference: asString(payload.customerId), callbackURL: asString(payload.returnUrl), amount: asString(payload.amount), currency: 'BDT', intent: 'sale', merchantInvoiceNumber: asString(payload.paymentId) })
    });
    const result = await responseJsonObject(createResponse);
    const checkoutUrl = asString(result.bkashURL);
    if (!createResponse.ok || !checkoutUrl) throw new AppError(502, 'BKASH_ERROR', 'bKash rejected the payment request');
    return {
      provider: 'bkash',
      status: 'pending',
      transactionRef: asString(result.paymentID) || payload.paymentId,
      checkoutUrl,
      raw: result
    };
  }

  /**
   * Ask the gateway directly whether a transaction really settled.
   *
   * A browser landing on the success URL is *not* proof of payment: the URL is
   * guessable and the customer controls their own browser. This method is the
   * server-side confirmation step. It returns a verdict; only `verified`
   * callers are allowed to mark a payment paid.
   *
   *   - `verified`   the gateway says the transaction is VALID / EXECUTED
   *   - `failed`     the gateway explicitly rejected it
   *   - `unknown`    no verification path is configured, or the gateway did not
   *                  answer. The caller must leave the payment pending and wait
   *                  for the signed webhook/IPN.
   */
  async validateTransaction(refs: { paymentId: string; valId?: string; gatewayTransactionId?: string; amount?: number; currency?: string }): Promise<{ verdict: 'verified' | 'failed' | 'unknown'; gatewayStatus?: string; detail?: string; payload?: Record<string, unknown> }> {
    const s = await this.paymentSettings();

    if (s.provider === 'bkash') {
      if (!s.bkashBaseUrl || !s.bkashAppKey || !s.bkashAppSecret || !s.bkashUsername || !s.bkashPassword) return { verdict: 'unknown', detail: 'bKash credentials are not configured' };
      const paymentId = refs.gatewayTransactionId || refs.valId;
      if (!paymentId) return { verdict: 'unknown', detail: 'No bKash payment id to verify' };
      try {
        const base = s.bkashBaseUrl.replace(/\/$/, '');
        const authResponse = await fetchWithTimeout(`${base}/tokenized/checkout/token/grant`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json', username: s.bkashUsername, password: s.bkashPassword },
          body: JSON.stringify({ app_key: s.bkashAppKey, app_secret: s.bkashAppSecret })
        });
        const auth = await responseJsonObject(authResponse);
        const idToken = asString(auth.id_token);
        if (!authResponse.ok || !idToken) return { verdict: 'unknown', detail: 'bKash authentication failed' };
        const response = await fetchWithTimeout(`${base}/tokenized/checkout/execute`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json', authorization: idToken, 'x-app-key': s.bkashAppKey },
          body: JSON.stringify({ paymentID: paymentId })
        });
        const result = await responseJsonObject(response);
        const status = asString(result.transactionStatus).toUpperCase();
        if (response.ok && (status === 'COMPLETED' || status === 'SUCCESS')) return { verdict: 'verified', gatewayStatus: status, payload: result };
        if (response.ok && status) return { verdict: 'failed', gatewayStatus: status, detail: asString(result.statusMessage), payload: result };
        return { verdict: 'unknown', detail: 'bKash returned no verdict', payload: result };
      } catch (error) {
        return { verdict: 'unknown', detail: error instanceof Error ? error.message : 'bKash verification failed' };
      }
    }

    // SSLCommerz order_validate.
    if (!s.sslStoreId || !s.sslStorePassword || !s.sslValidationUrl) return { verdict: 'unknown', detail: 'SSLCommerz validation is not configured' };
    const params = new URLSearchParams({
      store_id: s.sslStoreId,
      store_passwd: s.sslStorePassword,
      ...(refs.valId ? { val_id: refs.valId } : {}),
      ...(refs.gatewayTransactionId && !refs.valId ? { tran_id: refs.gatewayTransactionId } : {}),
      format: 'json'
    });
    if (!refs.valId && !refs.gatewayTransactionId) return { verdict: 'unknown', detail: 'No gateway transaction reference to verify' };
    try {
      const response = await fetchWithTimeout(s.sslValidationUrl, { method: 'GET', headers: { accept: 'application/json' }, ...(params.toString() ? { body: undefined } : {}) } as RequestInit & { body?: undefined }).catch(() => undefined);
      // order_validate is a GET with a query string in the live API.
      const queryUrl = s.sslValidationUrl.includes('?') ? `${s.sslValidationUrl}&${params}` : `${s.sslValidationUrl}?${params}`;
      const validated = response && response.ok ? await responseJsonObject(response) : await responseJsonObject(await fetchWithTimeout(queryUrl, { method: 'GET', headers: { accept: 'application/json' } }));
      const status = asString(validated.status).toUpperCase();
      if (['VALID', 'VALIDATED', 'SUCCESS', 'GWVERSION_3'].includes(status)) {
        // Cross-check the amount when the gateway returned one, so a tampered
        // success URL pointing at a cheaper transaction cannot settle a pricier one.
        const gatewayAmount = Number(validated.amount ?? validated.currency_amount);
        const expectedAmount = Number(refs.amount);
        if (Number.isFinite(gatewayAmount) && Number.isFinite(expectedAmount) && expectedAmount > 0 && Math.abs(gatewayAmount - expectedAmount) > 1) {
          return { verdict: 'failed', gatewayStatus: status, detail: `Gateway amount ${gatewayAmount} does not match the booking amount ${expectedAmount}`, payload: validated };
        }
        return { verdict: 'verified', gatewayStatus: status, payload: validated };
      }
      if (status) return { verdict: 'failed', gatewayStatus: status, detail: asString(validated.error ?? validated.failedreason), payload: validated };
      return { verdict: 'unknown', detail: 'SSLCommerz returned no verdict', payload: validated };
    } catch (error) {
      return { verdict: 'unknown', detail: error instanceof Error ? error.message : 'SSLCommerz verification failed' };
    }
  }

  async verifyWebhook(rawBody: Buffer, signature: string | undefined): Promise<boolean> {
    const secret = await runtime(this.store, 'payment_webhook_secret', config.paymentWebhookSecret);
    if (!signature || !secret) return false;
    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    return a.length === b.length && timingSafeEqual(a, b);
  }
}
