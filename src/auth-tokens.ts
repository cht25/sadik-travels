import mongoose, { Schema, model, type Model } from 'mongoose';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { config } from './config.js';

/**
 * Sadik Travels — password reset tokens.
 *
 * Security properties (Part 16 of the production requirements):
 *
 *   - **Unpredictable.** 32 bytes from `crypto.randomBytes`, base64url encoded.
 *     Not a 4/6-digit code, not a timestamp, not derived from the address.
 *   - **Hashed at rest.** Only SHA-256 of the token is stored. A database read
 *     does not yield usable reset links.
 *   - **Single use.** Consumption is an atomic conditional update, so two
 *     concurrent redemptions cannot both succeed.
 *   - **Expiring.** TTL from `PASSWORD_RESET_TTL_MINUTES` (default 30).
 *   - **Rate limited.** One active token per account, and a per-account issue
 *     cap, so the flow cannot be used to mail-bomb an address.
 *   - **No enumeration.** The request endpoint always answers identically
 *     whether or not the address exists, and the email itself never says
 *     "your new password is …" — passwords are never emailed.
 */

const models = mongoose.models as Record<string, Model<any>>;
const makeModel = (name: string, collection: string, schema: Schema) => (models[name] as Model<any>) || model(name, schema, collection);

export type PasswordResetToken = {
  id: string;
  userId: string;
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
  consumedAt?: string;
  /** Set once the password has actually been changed with this token. */
  completedAt?: string;
  requestIp?: string;
  userAgent?: string;
};

/** Maximum reset links issued for one account inside the throttle window. */
export const RESET_ISSUE_LIMIT = 5;
export const RESET_THROTTLE_WINDOW_MS = 60 * 60 * 1000;

const PasswordResetSchema = new Schema(
  {
    id: { type: String, required: true, unique: true, index: true },
    userId: { type: String, required: true, index: true },
    tokenHash: { type: String, required: true, unique: true, index: true },
    createdAt: { type: String, required: true },
    // Indexed once below via the TTL definition; a second `index: true` here
    // would make Mongoose warn about a duplicate index.
    expiresAt: { type: String, required: true },
    consumedAt: String,
    completedAt: String,
    requestIp: String,
    userAgent: String
  },
  { versionKey: false, collection: 'password_resets' }
);
PasswordResetSchema.index({ userId: 1, createdAt: -1 });
// MongoDB removes expired rows even if the application never reads them again.
PasswordResetSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const PasswordResetModel = makeModel('SadikPasswordReset', 'password_resets', PasswordResetSchema);

const now = () => new Date().toISOString();
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const strip = <T>(doc: any): T | undefined => { if (!doc) return undefined; const { _id, __v, ...rest } = doc as any; return clone(rest) as T; };

/** SHA-256 of the token. The raw token never touches the database. */
export function hashResetToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** 256-bit URL-safe token. */
export function generateResetToken(): string {
  return randomBytes(32).toString('base64url');
}

export function resetTokenTtlMinutes(): number {
  const value = Number(config.passwordResetTtlMinutes);
  return Number.isFinite(value) && value >= 5 ? value : 30;
}

export class PasswordResetService {
  async ensureIndexes() { await PasswordResetModel.createIndexes(); }

  /**
   * Issue a reset token for an account.
   *
   * Returns `undefined` when the account has hit the issue limit; the caller
   * must still answer the request identically to a successful issue so the
   * endpoint cannot be used to enumerate accounts.
   */
  async issue(userId: string, meta: { ip?: string; userAgent?: string } = {}): Promise<{ token: string; record: PasswordResetToken; expiresAt: string } | { throttled: true }> {
    const since = new Date(Date.now() - RESET_THROTTLE_WINDOW_MS).toISOString();
    const recent = await PasswordResetModel.countDocuments({ userId, createdAt: { $gte: since } });
    if (recent >= RESET_ISSUE_LIMIT) return { throttled: true };

    const token = generateResetToken();
    const createdAt = now();
    const expiresAt = new Date(Date.now() + resetTokenTtlMinutes() * 60_000).toISOString();

    // One live token per account: a newer link invalidates the previous one so
    // an old email sitting in an inbox cannot be replayed.
    await PasswordResetModel.updateMany({ userId, consumedAt: { $in: [null, ''] } }, { $set: { consumedAt: createdAt } });

    const record = await PasswordResetModel.create({
      id: randomUUID(),
      userId,
      tokenHash: hashResetToken(token),
      createdAt,
      expiresAt,
      requestIp: meta.ip,
      userAgent: meta.userAgent
    });
    return { token, record: strip<PasswordResetToken>(record) as PasswordResetToken, expiresAt };
  }

  /**
   * Validate a token without consuming it, so the reset form can be rendered
   * before the user types a new password.
   */
  async peek(token: string): Promise<{ userId: string; expiresAt: string } | undefined> {
    if (!token || token.length > 200) return undefined;
    const doc = await PasswordResetModel.findOne({ tokenHash: hashResetToken(token) }).lean() as unknown as PasswordResetToken | null;
    if (!doc) return undefined;
    if (doc.consumedAt) return undefined;
    if (new Date(doc.expiresAt).getTime() <= Date.now()) return undefined;
    return { userId: doc.userId, expiresAt: doc.expiresAt };
  }

  /**
   * Atomically consume a token.
   *
   * The conditional update (`consumedAt` empty AND not expired) is what makes
   * the token single-use under concurrency: the second caller's filter matches
   * nothing and it gets `undefined`.
   */
  async consume(token: string): Promise<{ userId: string; id: string } | undefined> {
    if (!token || token.length > 200) return undefined;
    const stamp = now();
    const doc = await PasswordResetModel.findOneAndUpdate(
      { tokenHash: hashResetToken(token), consumedAt: { $in: [null, ''] }, expiresAt: { $gt: stamp } },
      { $set: { consumedAt: stamp } },
      { new: false }
    ).lean() as unknown as PasswordResetToken | null;
    if (!doc) return undefined;
    return { userId: doc.userId, id: doc.id };
  }

  /** Mark the reset as finished after the password was actually changed. */
  async markCompleted(id: string): Promise<void> {
    await PasswordResetModel.updateOne({ id }, { $set: { completedAt: now() } });
  }

  /** Invalidate every outstanding token for an account (e.g. after a change). */
  async invalidateAll(userId: string): Promise<number> {
    const result = await PasswordResetModel.updateMany({ userId, consumedAt: { $in: [null, ''] } }, { $set: { consumedAt: now() } });
    return result.modifiedCount;
  }

  /** Housekeeping: drop expired rows the TTL index has not swept yet. */
  async pruneExpired(): Promise<number> {
    const result = await PasswordResetModel.deleteMany({ expiresAt: { $lte: now() } });
    return result.deletedCount;
  }
}

export function createPasswordResetService(): PasswordResetService {
  return new PasswordResetService();
}
