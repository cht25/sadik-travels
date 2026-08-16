import { config } from './config.js';
import { hashPassword, normalizeIdentity } from './security.js';
import type { Store } from './store.js';

/**
 * Optional first-run bootstrap for deployments where an interactive shell is unavailable.
 * The password is read from the deployment secret store and is never written to source code.
 * Existing super-admin passwords are never overwritten automatically.
 */
export async function bootstrapSuperAdmin(store: Store): Promise<boolean> {
  const email = config.superAdminEmail.trim();
  const password = config.superAdminPassword;
  if (!email && !password) return false;
  if (!email || !password) throw new Error('SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD must be provided together');
  if (password.length < 12) throw new Error('SUPER_ADMIN_PASSWORD must be at least 12 characters');

  const normalized = normalizeIdentity(email);
  if (normalized.channel !== 'email') throw new Error('SUPER_ADMIN_EMAIL must be a valid email address');
  const existing = await store.findUserByIdentity(normalized.identity);
  if (existing) {
    const passwordHash = await store.getPasswordHash(normalized.identity);
    if (existing.role !== 'super_admin') throw new Error('SUPER_ADMIN_EMAIL already belongs to a non-super-admin account; use the admin console to manage it');
    if (!passwordHash) await store.setPasswordHash(existing.id, await hashPassword(password));
    return !passwordHash;
  }

  const user = await store.createUser({ identity: normalized.identity, channel: 'email', role: 'super_admin' });
  await store.setPasswordHash(user.id, await hashPassword(password));
  return true;
}
