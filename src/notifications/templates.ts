/**
 * Sadik Travels — transactional email templates.
 *
 * Plain functions returning `{ subject, text, html }`. They never touch the
 * database or SMTP, which keeps them directly testable and makes it obvious
 * that no credential can reach a template.
 *
 * Every template escapes interpolated values, so a name or hotel title can
 * never break out of the markup. Passwords are never rendered.
 */

const BRAND = 'Sadik Travels';
const BRAND_COLOR = '#1438b8';

export type EmailTemplate = { subject: string; text: string; html: string };

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Bangladeshi taka formatting shared with the storefront. */
export function money(amount: unknown, currency = 'BDT'): string {
  const value = Number(amount);
  const number = Number.isFinite(value) ? value : 0;
  return currency === 'BDT' ? `৳${number.toLocaleString('en-BD')}` : `${currency} ${number.toLocaleString('en-BD')}`;
}

export type Row = { label: string; value: string };

/** Build an email row from a label/value pair. */
export const row = (label: string, value: string): Row => ({ label, value });

function layout(options: { heading: string; intro?: string; rows?: Row[]; body?: string; actionUrl?: string; actionLabel?: string; note?: string; url: string }): string {
  const rowsHtml = (options.rows || [])
    .map(row => `<tr><th scope="row" style="text-align:left;padding:8px 12px;color:#5a6b85;font-weight:600;white-space:nowrap;vertical-align:top;border-bottom:1px solid #eef1f7">${escapeHtml(row.label)}</th><td style="padding:8px 12px;color:#17253b;border-bottom:1px solid #eef1f7">${row.value}</td></tr>`)
    .join('');
  const action = options.actionUrl
    ? `<p style="margin:28px 0"><a href="${escapeHtml(options.actionUrl)}" style="display:inline-block;background:${BRAND_COLOR};color:#ffffff;text-decoration:none;padding:13px 26px;border-radius:10px;font-weight:700">${escapeHtml(options.actionLabel || 'Continue')}</a></p>`
    : '';
  return `<!doctype html><html lang="en"><body style="margin:0;background:#f5f7fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#17253b">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f7fb;padding:28px 12px"><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 1px 3px rgba(23,37,59,.08)">
<tr><td style="background:${BRAND_COLOR};padding:20px 28px"><span style="color:#ffffff;font-size:19px;font-weight:800;letter-spacing:.2px">${BRAND}</span></td></tr>
<tr><td style="padding:30px 28px">
<h1 style="margin:0 0 12px;font-size:21px;line-height:1.35">${escapeHtml(options.heading)}</h1>
${options.intro ? `<p style="margin:0 0 18px;color:#3b4a63;font-size:15px;line-height:1.6">${options.intro}</p>` : ''}
${rowsHtml ? `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin:6px 0 10px;font-size:14px">${rowsHtml}</table>` : ''}
${options.body ? `<div style="color:#3b4a63;font-size:15px;line-height:1.65">${options.body}</div>` : ''}
${action}
${options.note ? `<p style="margin:18px 0 0;padding:12px 14px;background:#f6f8fd;border-left:3px solid ${BRAND_COLOR};color:#5a6b85;font-size:13px;line-height:1.55">${options.note}</p>` : ''}
</td></tr>
<tr><td style="padding:18px 28px;background:#f8fafd;color:#7b8aa3;font-size:12px;line-height:1.6">
${BRAND} · <a href="${escapeHtml(options.url)}" style="color:${BRAND_COLOR};text-decoration:none">${escapeHtml(options.url.replace(/^https?:\/\//, ''))}</a><br/>
You received this email because an account or booking is associated with your address.
</td></tr>
</table></td></tr></table></body></html>`;
}

const rows = (...pairs: Array<[string, string | undefined | null]>): Row[] =>
  pairs.filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== '').map(([label, value]) => ({ label, value: String(value) }));

/* ------------------------------------------------------------------ account */

export function welcomeEmail(input: { name?: string; email: string; url: string }): EmailTemplate {
  const name = input.name?.trim() || 'there';
  const subject = `Welcome to ${BRAND}`;
  const html = layout({
    heading: `Welcome to ${BRAND}, ${escapeHtml(name)}`,
    intro: 'Your account is ready. You can now book hotels, homes &amp; villas, tours and holiday packages, track every reservation and message our support team.',
    rows: rows(['Account holder', escapeHtml(name)], ['Sign-in email', escapeHtml(input.email)]),
    body: '<p style="margin:0 0 10px"><strong>Keep your account safe</strong></p><ul style="margin:0;padding-left:20px;color:#3b4a63;line-height:1.75"><li>We will never ask for your password or a one-time code by email, phone or chat.</li><li>Use a unique password of at least 12 characters.</li><li>Review the sign-in alerts we send when your account is used on a new device.</li></ul>',
    actionUrl: input.url,
    actionLabel: 'Go to Sadik Travels',
    note: 'If you did not create this account, you can safely ignore this email.',
    url: input.url
  });
  const text = [
    `Welcome to ${BRAND}, ${name}`,
    '',
    `Your account (${input.email}) is ready. You can now book hotels, homes & villas, tours and holiday packages, track reservations and message support.`,
    '',
    'Keep your account safe:',
    '- We will never ask for your password or a one-time code by email, phone or chat.',
    '- Use a unique password of at least 12 characters.',
    '- Review the sign-in alerts we send for new devices.',
    '',
    `Visit ${input.url}`,
    '',
    'If you did not create this account, you can safely ignore this email.'
  ].join('\n');
  return { subject, text, html };
}

export function passwordResetEmail(input: { name?: string; resetUrl: string; expiresMinutes: number; url: string }): EmailTemplate {
  const subject = `Reset your ${BRAND} password`;
  const html = layout({
    heading: 'Reset your password',
    intro: `We received a request to reset the password for your ${BRAND} account. This link can be used <strong>once</strong> and expires in ${input.expiresMinutes} minutes.`,
    actionUrl: input.resetUrl,
    actionLabel: 'Choose a new password',
    note: 'If you did not request this, no action is needed — your password stays the same. We never send passwords by email.',
    url: input.url
  });
  const text = [
    `Reset your ${BRAND} password`,
    '',
    `We received a request to reset the password for your ${BRAND} account.`,
    '',
    `Open this link within ${input.expiresMinutes} minutes (it can only be used once):`,
    input.resetUrl,
    '',
    'If you did not request this, no action is needed — your password stays the same.',
    'We never send passwords by email.'
  ].join('\n');
  return { subject, text, html };
}

export function passwordChangedEmail(input: { name?: string; email: string; changedAt: Date; supportEmail?: string; url: string }): EmailTemplate {
  const subject = `Your ${BRAND} password was changed`;
  const html = layout({
    heading: 'Your password was changed',
    intro: `The password for <strong>${escapeHtml(input.email)}</strong> was changed on ${input.changedAt.toUTCString()}. All other active sessions were signed out.`,
    actionUrl: input.supportEmail ? `mailto:${escapeHtml(input.supportEmail)}` : input.url,
    actionLabel: input.supportEmail ? 'This wasn’t me — contact support' : 'Review my account',
    url: input.url
  });
  const text = [
    `Your ${BRAND} password was changed`,
    '',
    `The password for ${input.email} was changed on ${input.changedAt.toUTCString()}. All other active sessions were signed out.`,
    '',
    input.supportEmail ? `If this wasn't you, contact support immediately at ${input.supportEmail}.` : 'If this wasn’t you, contact support immediately.'
  ].join('\n');
  return { subject, text, html };
}

export function newDeviceLoginEmail(input: {
  name?: string;
  loginAt: Date;
  /** Approximate, network-derived. Never presented as exact. */
  approximateLocation?: string;
  ip?: string;
  device?: string;
  url: string;
}): EmailTemplate {
  const subject = `New sign-in to your ${BRAND} account`;
  const html = layout({
    heading: 'New sign-in detected',
    intro: `We noticed a sign-in to your ${BRAND} account from a device we have not seen before.`,
    rows: rows(
      ['Time (UTC)', input.loginAt.toUTCString()],
      ['Approximate location', input.approximateLocation ? `${escapeHtml(input.approximateLocation)} <span style="color:#7b8aa3;font-size:12px">(based on network information)</span>` : undefined],
      ['IP address', input.ip ? escapeHtml(input.ip) : undefined],
      ['Device / browser', input.device ? escapeHtml(input.device) : undefined]
    ),
    body: '<p style="margin:14px 0 0;color:#3b4a63;line-height:1.65">If this was you, no action is needed. If you do not recognise this sign-in, change your password immediately and contact our support team.</p>',
    actionUrl: input.url,
    actionLabel: 'Review my account',
    note: 'Approximate location is derived from network information and may be inaccurate. It is an estimate, not your exact physical location.',
    url: input.url
  });
  const text = [
    `New sign-in to your ${BRAND} account`,
    '',
    `We noticed a sign-in to your ${BRAND} account from a device we have not seen before.`,
    '',
    `Time (UTC): ${input.loginAt.toUTCString()}`,
    input.approximateLocation ? `Approximate location: ${input.approximateLocation} (based on network information — may be inaccurate)` : '',
    input.ip ? `IP address: ${input.ip}` : '',
    input.device ? `Device / browser: ${input.device}` : '',
    '',
    'If this was you, no action is needed. If you do not recognise this sign-in, change your password immediately and contact support.'
  ].filter(Boolean).join('\n');
  return { subject, text, html };
}

/* ------------------------------------------------------------------ booking */

export type BookingEmailFacts = {
  reference: string;
  serviceName: string;
  serviceKind: string;
  dates?: string;
  guests?: string;
  total?: number;
  currency?: string;
  paymentStatus: string;
  bookingStatus: string;
  paymentMethod?: string;
  breakdown?: Row[];
  customerName?: string;
  url: string;
};

const paymentStatusSentence = (paymentStatus: string, paymentMethod?: string) => {
  const normalized = String(paymentStatus || '').toLowerCase();
  if (normalized === 'paid') return 'Payment received — thank you.';
  if (normalized === 'refunded') return 'This booking has been refunded.';
  if (['pay_at_property', 'pay_on_arrival', 'pay_at_hotel'].includes(normalized)) return 'Payment method: pay at the property. Nothing has been charged yet.';
  if (normalized === 'cod' || paymentMethod === 'cod') return 'Payment method: cash / pay later. Your booking is confirmed as unpaid until payment is received.';
  return 'Payment is still pending. Nothing has been charged yet.';
};

export function bookingReceivedEmail(input: BookingEmailFacts): EmailTemplate {
  const subject = `Booking received — ${input.reference}`;
  const html = layout({
    heading: `Thank you, ${escapeHtml(input.customerName?.trim() || 'traveller')}`,
    intro: `We have received your ${escapeHtml(input.serviceKind.toLowerCase())} booking and our team is preparing it.`,
    rows: rows(
      ['Booking reference', escapeHtml(input.reference)],
      ['Service', escapeHtml(input.serviceName)],
      ['Dates', input.dates ? escapeHtml(input.dates) : undefined],
      ['Travellers / guests', input.guests ? escapeHtml(input.guests) : undefined],
      ['Total payable', input.total !== undefined ? `<strong>${money(input.total, input.currency)}</strong>` : undefined],
      ['Payment method', input.paymentMethod ? escapeHtml(input.paymentMethod) : undefined],
      ['Payment status', escapeHtml(String(input.paymentStatus).toUpperCase())],
      ['Booking status', escapeHtml(String(input.bookingStatus).toUpperCase())]
    ).concat(input.breakdown || []),
    body: `<p style="margin:14px 0 0;color:#3b4a63;line-height:1.65">${escapeHtml(paymentStatusSentence(input.paymentStatus, input.paymentMethod))}</p>`,
    actionUrl: input.url,
    actionLabel: 'Track this booking',
    url: input.url
  });
  const text = [
    `Booking received — ${input.reference}`,
    '',
    `Thank you. We have received your ${input.serviceKind.toLowerCase()} booking.`,
    '',
    `Service: ${input.serviceName}`,
    input.dates ? `Dates: ${input.dates}` : '',
    input.guests ? `Travellers: ${input.guests}` : '',
    input.total !== undefined ? `Total payable: ${money(input.total, input.currency)}` : '',
    input.paymentMethod ? `Payment method: ${input.paymentMethod}` : '',
    `Payment status: ${String(input.paymentStatus).toUpperCase()}`,
    `Booking status: ${String(input.bookingStatus).toUpperCase()}`,
    '',
    paymentStatusSentence(input.paymentStatus, input.paymentMethod),
    '',
    `Track it here: ${input.url}`
  ].filter(Boolean).join('\n');
  return { subject, text, html };
}

export function bookingStatusEmail(input: BookingEmailFacts & { heading: string; message?: string }): EmailTemplate {
  const subject = `${input.heading} — ${input.reference}`;
  const html = layout({
    heading: input.heading,
    intro: input.message || `Your booking ${escapeHtml(input.reference)} has been updated.`,
    rows: rows(
      ['Booking reference', escapeHtml(input.reference)],
      ['Service', escapeHtml(input.serviceName)],
      ['Dates', input.dates ? escapeHtml(input.dates) : undefined],
      ['Total', input.total !== undefined ? money(input.total, input.currency) : undefined],
      ['Payment status', escapeHtml(String(input.paymentStatus).toUpperCase())],
      ['Booking status', escapeHtml(String(input.bookingStatus).toUpperCase())]
    ),
    actionUrl: input.url,
    actionLabel: 'View booking',
    url: input.url
  });
  const text = [
    `${input.heading} — ${input.reference}`,
    '',
    input.message || `Your booking ${input.reference} has been updated.`,
    '',
    `Service: ${input.serviceName}`,
    input.dates ? `Dates: ${input.dates}` : '',
    input.total !== undefined ? `Total: ${money(input.total, input.currency)}` : '',
    `Payment status: ${String(input.paymentStatus).toUpperCase()}`,
    `Booking status: ${String(input.bookingStatus).toUpperCase()}`,
    '',
    input.url
  ].filter(Boolean).join('\n');
  return { subject, text, html };
}

/* -------------------------------------------------------------------- staff */

export function staffBookingEmail(input: BookingEmailFacts & { audience: 'Operations team' | string; ownerName?: string; customerEmail?: string; customerPhone?: string }): EmailTemplate {
  const subject = `New booking — ${input.reference}`;
  const html = layout({
    heading: `New ${escapeHtml(input.serviceKind.toLowerCase())} booking`,
    intro: `${escapeHtml(input.audience)}: a booking requires your attention.`,
    rows: rows(
      ['Booking reference', escapeHtml(input.reference)],
      ['Customer', escapeHtml(input.customerName || 'Guest')],
      ['Customer email', input.customerEmail ? escapeHtml(input.customerEmail) : undefined],
      ['Customer phone', input.customerPhone ? escapeHtml(input.customerPhone) : undefined],
      ['Service', escapeHtml(input.serviceName)],
      ['Dates', input.dates ? escapeHtml(input.dates) : undefined],
      ['Travellers / guests', input.guests ? escapeHtml(input.guests) : undefined],
      ['Amount', input.total !== undefined ? money(input.total, input.currency) : undefined],
      ['Payment method', input.paymentMethod ? escapeHtml(input.paymentMethod) : undefined],
      ['Payment status', escapeHtml(String(input.paymentStatus).toUpperCase())],
      ['Booking status', escapeHtml(String(input.bookingStatus).toUpperCase())]
    ),
    actionUrl: input.url,
    actionLabel: 'Open in admin console',
    url: input.url
  });
  const text = [
    `New booking — ${input.reference}`,
    '',
    `${input.audience}: a booking requires your attention.`,
    '',
    `Customer: ${input.customerName || 'Guest'}${input.customerEmail ? ` <${input.customerEmail}>` : ''}`,
    `Service: ${input.serviceName}`,
    input.dates ? `Dates: ${input.dates}` : '',
    input.guests ? `Travellers: ${input.guests}` : '',
    input.total !== undefined ? `Amount: ${money(input.total, input.currency)}` : '',
    `Payment method: ${input.paymentMethod || 'n/a'}`,
    `Payment status: ${String(input.paymentStatus).toUpperCase()}`,
    `Booking status: ${String(input.bookingStatus).toUpperCase()}`,
    '',
    input.url
  ].filter(Boolean).join('\n');
  return { subject, text, html };
}

/* ----------------------------------------------------------------- payments */

export function paymentResultEmail(input: BookingEmailFacts & { succeeded: boolean; transactionRef?: string; paidAt?: Date; failureReason?: string }): EmailTemplate {
  const subject = input.succeeded ? `Payment received — ${input.reference}` : `Payment failed — ${input.reference}`;
  const html = layout({
    heading: input.succeeded ? 'Payment received' : 'Payment could not be completed',
    intro: input.succeeded
      ? `We have received your payment for booking ${escapeHtml(input.reference)}. Your confirmation is on its way.`
      : `We could not complete the payment for booking ${escapeHtml(input.reference)}. Your reservation is held while you retry.`,
    rows: rows(
      ['Booking reference', escapeHtml(input.reference)],
      ['Amount', input.total !== undefined ? money(input.total, input.currency) : undefined],
      ['Payment method', input.paymentMethod ? escapeHtml(input.paymentMethod) : undefined],
      ['Transaction reference', input.transactionRef ? escapeHtml(input.transactionRef) : undefined],
      ['Confirmed at', input.paidAt ? input.paidAt.toUTCString() : undefined],
      ['Reason', input.failureReason ? escapeHtml(input.failureReason) : undefined]
    ),
    actionUrl: input.url,
    actionLabel: input.succeeded ? 'View receipt' : 'Retry payment',
    url: input.url
  });
  const text = [
    subject,
    '',
    input.succeeded
      ? `We have received your payment for booking ${input.reference}.`
      : `We could not complete the payment for booking ${input.reference}.`,
    '',
    input.total !== undefined ? `Amount: ${money(input.total, input.currency)}` : '',
    input.paymentMethod ? `Payment method: ${input.paymentMethod}` : '',
    input.transactionRef ? `Transaction: ${input.transactionRef}` : '',
    input.failureReason ? `Reason: ${input.failureReason}` : '',
    '',
    input.url
  ].filter(Boolean).join('\n');
  return { subject, text, html };
}

export function codPaymentConfirmedEmail(input: BookingEmailFacts & { confirmedAt: Date; methodLabel?: string }): EmailTemplate {
  const subject = `Payment confirmed — ${input.reference}`;
  const html = layout({
    heading: 'Payment confirmed',
    intro: `Our team has recorded your ${escapeHtml(input.methodLabel || 'cash / offline')} payment for booking ${escapeHtml(input.reference)}.`,
    rows: rows(
      ['Booking reference', escapeHtml(input.reference)],
      ['Amount', input.total !== undefined ? money(input.total, input.currency) : undefined],
      ['Confirmed at', input.confirmedAt.toUTCString()],
      ['Booking status', escapeHtml(String(input.bookingStatus).toUpperCase())]
    ),
    actionUrl: input.url,
    actionLabel: 'View booking',
    url: input.url
  });
  const text = [
    subject,
    '',
    `Our team has recorded your ${input.methodLabel || 'cash / offline'} payment for booking ${input.reference}.`,
    '',
    input.total !== undefined ? `Amount: ${money(input.total, input.currency)}` : '',
    `Confirmed at: ${input.confirmedAt.toUTCString()}`,
    '',
    input.url
  ].filter(Boolean).join('\n');
  return { subject, text, html };
}

/**
 * Generic fallback used by the admin "send notification" console so staff
 * announcements are branded HTML rather than bare text.
 */
export function announcementEmail(input: { title: string; message: string; url: string }): EmailTemplate {
  const html = layout({
    heading: input.title,
    body: `<p style="margin:0;color:#3b4a63;line-height:1.7;white-space:pre-line">${escapeHtml(input.message)}</p>`,
    actionUrl: input.url,
    actionLabel: 'Open Sadik Travels',
    url: input.url
  });
  return { subject: `${input.title} — ${BRAND}`, text: `${input.title}\n\n${input.message}\n\n${input.url}`, html };
}
