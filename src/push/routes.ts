import type { Express, RequestHandler } from 'express';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { requireAuth } from '../middleware.js';
import { rateLimit } from '../rate-limit.js';
import type { Store } from '../store.js';
import type { PushSender } from './vapid.js';
import { isWebPushEnabled } from './vapid.js';
import type { PushSubscriptionStore } from './store.js';
import { describeDevice } from './store.js';

/**
 * Sadik Travels — Web Push subscription endpoints.
 *
 * Permission is *never* assumed. The browser flow is:
 *
 *   1. `GET  /api/v1/push/config`  — is push available, and what is the VAPID
 *      public key? (public, no secrets)
 *   2. the UI explains what notifications are for and asks the user
 *   3. `Notification.requestPermission()` runs in the browser
 *   4. only on `granted` does the browser call
 *      `POST /api/v1/push/subscribe` with the PushSubscription
 *
 * The private key, stored endpoints and `p256dh`/`auth` keys are never
 * returned by any route. `GET /api/v1/push/subscriptions` returns device
 * labels only, so the account owner can revoke a device without the API ever
 * exposing another device's push credentials.
 */

const subscribeSchema = z.object({
  subscription: z.object({
    endpoint: z.string().min(20).max(2048),
    keys: z.object({ p256dh: z.string().min(20).max(200), auth: z.string().min(10).max(64) })
  })
});

export function registerPushRoutes(app: Express, deps: { store: Store; subscriptions: PushSubscriptionStore; sender: PushSender }) {
  const { store, subscriptions, sender } = deps;

  /** Public: advertises whether push works here, and the VAPID public key. */
  app.get('/api/v1/push/config', async (_req, res, next) => {
    try {
      if (!isWebPushEnabled()) {
        // Still resolve keys lazily: the first request on a deployment without
        // environment keys generates and persists a pair.
        const publicKey = await sender.publicKey().catch(() => '');
        if (!publicKey) return res.json({ enabled: false, publicKey: '' });
      }
      const publicKey = await sender.publicKey();
      res.json({ enabled: true, publicKey });
    } catch (error) { next(error); }
  });

  const subscribeHandler: RequestHandler = async (req, res, next) => {
    try {
      const input = subscribeSchema.parse(req.body || {});
      const userId = req.user!.id;
      const saved = await subscriptions.upsert(userId, input.subscription, {
        userAgent: req.get('user-agent')?.slice(0, 400),
        locale: req.get('accept-language')?.slice(0, 40)
      });
      await store.audit('push.subscribed', { ip: req.ip, userAgent: req.get('user-agent')?.slice(0, 500), userId, metadata: { subscriptionId: saved.id, deviceType: saved.deviceType } });
      // Return metadata only — never the endpoint or the keys.
      res.status(201).json({ success: true, subscription: { id: saved.id, deviceType: saved.deviceType, platform: saved.platform, label: describeDevice(saved.userAgent).label, createdAt: saved.createdAt } });
    } catch (error) {
      if (error instanceof TypeError) {
        const messages: Record<string, string> = {
          PUSH_ENDPOINT_REQUIRED: 'A push subscription endpoint is required',
          PUSH_ENDPOINT_TOO_LONG: 'The push subscription endpoint is too long',
          PUSH_ENDPOINT_INVALID: 'The push subscription endpoint is not a valid URL',
          PUSH_ENDPOINT_NOT_SECURE: 'Push subscriptions must use an HTTPS endpoint',
          PUSH_KEY_INVALID: 'The push subscription keys are invalid'
        };
        return next(new AppError(400, 'PUSH_SUBSCRIPTION_INVALID', messages[error.message] || 'The push subscription is invalid'));
      }
      next(error);
    }
  };

  app.post('/api/v1/push/subscribe', requireAuth(store), rateLimit('push-subscribe', 15, 300), subscribeHandler);

  /** The signed-in user's own devices. Labels only, no credentials. */
  app.get('/api/v1/push/subscriptions', requireAuth(store), async (req, res, next) => {
    try {
      res.json({ subscriptions: await subscriptions.listForUser(req.user!.id) });
    } catch (error) { next(error); }
  });

  app.delete('/api/v1/push/subscriptions/:id', requireAuth(store), async (req, res, next) => {
    try {
      const removed = await subscriptions.remove(req.user!.id, String(req.params.id));
      if (!removed) throw new AppError(404, 'PUSH_SUBSCRIPTION_NOT_FOUND', 'That device is no longer registered');
      await store.audit('push.unsubscribed', { ip: req.ip, userAgent: req.get('user-agent')?.slice(0, 500), userId: req.user!.id, metadata: { subscriptionId: String(req.params.id) } });
      res.json({ removed: true });
    } catch (error) { next(error); }
  });

  app.delete('/api/v1/push/subscriptions', requireAuth(store), async (req, res, next) => {
    try {
      const removed = await subscriptions.removeAll(req.user!.id);
      await store.audit('push.unsubscribed_all', { ip: req.ip, userAgent: req.get('user-agent')?.slice(0, 500), userId: req.user!.id, metadata: { removed } });
      res.json({ removed });
    } catch (error) { next(error); }
  });

  /**
   * Round-trip check the account owner can trigger from the notification
   * settings panel. Delivers to *this user only*; there is no way to address
   * another account through it.
   */
  app.post('/api/v1/push/test', requireAuth(store), rateLimit('push-test', 5, 300), async (req, res, next) => {
    try {
      const result = await sender.sendToUser(req.user!.id, {
        title: 'Sadik Travels notifications are on',
        body: 'This is a test notification. Booking, payment and message updates will appear here.',
        url: '/account',
        type: 'push.test',
        tag: 'sadik-push-test'
      });
      if (result.attempted === 0) {
        return res.status(409).json({ success: false, delivered: false, reason: 'No registered device found. Enable notifications on this browser first.' });
      }
      res.json({ success: result.delivered > 0, ...result });
    } catch (error) { next(error); }
  });
}
