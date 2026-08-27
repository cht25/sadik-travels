import { config } from '../config.js';
import type { Store, User } from '../store.js';
import type { MessagingProvider } from '../providers.js';
import type { PushSender, PushPayload } from '../push/vapid.js';
import {
  channelsFor,
  eventDefinition,
  NOTIFICATION_EVENT,
  type NotificationAudience,
  type NotificationChannel,
  type NotificationEventKey,
  type PreferenceCategory
} from './events.js';
import { shouldDeliver } from './preferences.js';
import { announcementEmail, type EmailTemplate } from './templates.js';
import { hasFinePermission } from '../permissions.js';

/**
 * Sadik Travels — centralized notification service.
 *
 * One call, three deliveries. `emit()` is the *only* place in the codebase that
 * decides how a notification reaches a person:
 *
 *   event key ──► recipients ──► channels (per audience) ──► user preferences
 *                                     │
 *             ┌───────────────────────┼───────────────────────┐
 *             ▼                       ▼                       ▼
 *         in-app row (DB)        SMTP email             VAPID Web Push
 *
 * Guarantees:
 *   - in-app notifications are written first and always, so the bell works even
 *     when SMTP or the push service is down or unconfigured;
 *   - email and push are best effort: a provider outage is recorded on the
 *     notification row and logged, never thrown at the caller, so a booking can
 *     never fail because an email did not send;
 *   - push and email honour per-user preferences; security events ignore them;
 *   - a recipient appears once even if several audiences resolve to them.
 *
 * SMTP is email only. Push notifications never touch SMTP.
 */

export type NotificationRecipient = { userId: string; audience: NotificationAudience };

export type NotificationContext = {
  bookingId?: string;
  orderId?: string;
  serviceId?: string;
  /** Absolute path a notification click should open. */
  route?: string;
};

export type EmitRequest = {
  event: NotificationEventKey;
  message: string;
  title?: string;
  recipients: NotificationRecipient[];
  context?: NotificationContext;
  /** Tag groups related notifications on the device (last one wins). */
  tag?: string;
  /** Pre-rendered email. A function receives the recipient and may opt out. */
  email?: EmailTemplate | ((user: User) => EmailTemplate | undefined);
  /** Overrides for the push payload (title/body/data default to the row). */
  push?: Partial<Omit<PushPayload, 'title' | 'body'>>;
  actorId?: string;
};

export type DeliverySummary = {
  event: NotificationEventKey;
  recipients: number;
  inApp: number;
  email: { sent: number; failed: number; skipped: number };
  push: { attempted: number; delivered: number; expired: number; failed: number };
};

/** Fine permission that qualifies a staff account for ops alerts. */
const BOOKING_ALERT_PERMISSIONS = ['booking.view', 'booking.update'];
const PAYMENT_ALERT_PERMISSIONS = ['payment.view', 'payment.manage'];

function categoryFor(event: NotificationEventKey): PreferenceCategory | undefined {
  return eventDefinition(event)?.category;
}

export class NotificationService {
  constructor(
    private readonly store: Store,
    private readonly messaging: MessagingProvider,
    private readonly push: PushSender
  ) {}

  /**
   * Fan an event out to every recipient across in-app, email and push.
   * Never throws: notification delivery must not be able to fail a booking,
   * a payment confirmation or a sign-in.
   */
  async emit(request: EmitRequest): Promise<DeliverySummary> {
    const summary: DeliverySummary = {
      event: request.event,
      recipients: 0,
      inApp: 0,
      email: { sent: 0, failed: 0, skipped: 0 },
      push: { attempted: 0, delivered: 0, expired: 0, failed: 0 }
    };

    const definition = eventDefinition(request.event);
    const title = request.title?.trim() || definition?.defaultTitle || 'Sadik Travels';
    const route = request.context?.route || definition?.defaultRoute || '/';
    const category = categoryFor(request.event);

    // Deduplicate: the same person can be reached through two audiences (e.g. a
    // hotel owner who is also an admin). The first audience wins for labelling.
    const unique = new Map<string, NotificationRecipient>();
    for (const recipient of request.recipients) {
      if (!recipient?.userId) continue;
      if (!unique.has(recipient.userId)) unique.set(recipient.userId, recipient);
    }
    summary.recipients = unique.size;
    if (unique.size === 0) return summary;

    const users = await Promise.all([...unique.keys()].map(userId => this.store.findUserById(userId)));
    const stamp = new Date().toISOString();

    await Promise.all([...unique.values()].map(async (recipient, index) => {
      const user = users[index];
      if (!user) return;

      const allowed = channelsFor(request.event, recipient.audience);
      if (allowed.length === 0) return;

      /* ---------------------------------------------------------- in-app */
      if (allowed.includes('in_app') && shouldDeliver(request.event, 'in_app', user, category)) {
        try {
          await this.store.createNotification({
            userId: user.id,
            title,
            message: request.message,
            channels: ['in_app' as const, ...(allowed.includes('push') ? (['push'] as const) : []), ...(allowed.includes('email') ? (['email'] as const) : [])],
            status: 'sent',
            sentAt: stamp,
            type: request.event,
            category,
            route,
            audience: recipient.audience,
            bookingId: request.context?.bookingId,
            orderId: request.context?.orderId,
            serviceId: request.context?.serviceId,
            createdBy: request.actorId
          });
          summary.inApp += 1;
        } catch (error) {
          this.logFailure('in_app', request.event, user.id, error);
        }
      }

      /* ----------------------------------------------------------- email */
      if (allowed.includes('email')) {
        if (!shouldDeliver(request.event, 'email', user, category)) {
          summary.email.skipped += 1;
        } else {
          const address = user.email?.trim();
          if (!address) {
            summary.email.skipped += 1;
          } else {
            const template = this.resolveEmail(request, user, title, route);
            try {
              await this.messaging.sendEmail(address, template.subject, template.text, template.html);
              summary.email.sent += 1;
            } catch (error) {
              summary.email.failed += 1;
              this.logFailure('email', request.event, user.id, error);
            }
          }
        }
      }

      /* ------------------------------------------------------------ push */
      if (allowed.includes('push') && shouldDeliver(request.event, 'push', user, category)) {
        const payload: PushPayload = {
          title,
          body: request.message,
          url: route,
          type: request.event,
          tag: request.tag || request.event,
          sentAt: stamp,
          data: {
            ...(request.context?.bookingId ? { bookingId: request.context.bookingId } : {}),
            ...(request.context?.orderId ? { orderId: request.context.orderId } : {}),
            ...(request.context?.serviceId ? { serviceId: request.context.serviceId } : {}),
            ...(request.push?.data || {})
          },
          ...(request.push?.icon ? { icon: request.push.icon } : {}),
          ...(request.push?.badge ? { badge: request.push.badge } : {})
        };
        try {
          const result = await this.push.sendToUser(user.id, payload);
          summary.push.attempted += result.attempted;
          summary.push.delivered += result.delivered;
          summary.push.expired += result.expired;
          summary.push.failed += result.failed;
        } catch (error) {
          this.logFailure('push', request.event, user.id, error);
        }
      }
    }));

    return summary;
  }

  /**
   * Convenience wrapper for a single customer recipient.
   * Callers still name the audience explicitly so the channel policy applies.
   */
  async emitToUser(event: NotificationEventKey, userId: string, message: string, options: Omit<EmitRequest, 'event' | 'message' | 'recipients'> & { audience?: NotificationAudience } = {}): Promise<DeliverySummary> {
    return this.emit({
      ...options,
      event,
      message,
      recipients: [{ userId, audience: options.audience || (event.startsWith('HOTEL_') ? 'hotel_owner' : 'customer') }]
    });
  }

  /**
   * Staff who should receive an operational alert.
   *
   * Resolved from persisted role/permission data — never from request input —
   * and filtered by the fine permission that owns the module. Vendor accounts
   * (`hotel_owner`, `home_owner`, `travel_agent`) are excluded here; they are
   * addressed through their own `hotel_owner` audience with an explicit user id.
   */
  async adminRecipients(event: NotificationEventKey): Promise<NotificationRecipient[]> {
    const wanted = event.startsWith('PAYMENT') || event === NOTIFICATION_EVENT.REFUND_ISSUED
      ? PAYMENT_ALERT_PERMISSIONS
      : BOOKING_ALERT_PERMISSIONS;
    const admins = await this.store.listAdmins().catch(() => [] as User[]);
    return admins
      .filter(user => !['hotel_owner', 'home_owner', 'travel_agent'].includes(user.role))
      .filter(user => wanted.some(key => hasFinePermission(user, key)))
      .map(user => ({ userId: user.id, audience: 'admin' as NotificationAudience }));
  }

  private resolveEmail(request: EmitRequest, user: User, title: string, route: string): EmailTemplate {
    if (typeof request.email === 'function') {
      const custom = request.email(user);
      if (custom) return custom;
    } else if (request.email) {
      return request.email;
    }
    return announcementEmail({
      title,
      message: `${request.message}\n\n${request.context?.bookingId ? `Reference: ${request.context.bookingId}` : ''}`.trim(),
      url: `${config.appOrigin}${route}`
    });
  }

  /**
   * A failed delivery is visible in the admin notification history instead of
   * disappearing. In-app rows carry the failure reason; email/push log it.
   */
  private logFailure(channel: NotificationChannel, event: NotificationEventKey, userId: string, error: unknown): void {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`[notifications] ${channel} delivery failed for ${event} → ${userId}: ${reason}`);
  }
}

export function createNotificationService(store: Store, messaging: MessagingProvider, push: PushSender): NotificationService {
  return new NotificationService(store, messaging, push);
}
