import { config } from './config.js';
import { hashPassword, normalizeIdentity, verifyPassword } from './security.js';
import type { Store } from './store.js';
import { auditAndMigrateVendorPermissions } from './permissions.js';

/**
 * Optional bootstrap for deployments where an interactive shell is unavailable.
 * The password is read from the deployment secret store and is never written to source code.
 *
 * When SUPER_ADMIN_EMAIL / SUPER_ADMIN_PASSWORD are provided, the configured identity is
 * treated as the authoritative super admin: the account is created (or promoted) and its
 * password hash is (re)built to match the configured password. This also repairs accounts
 * whose password was previously inserted in the wrong collection/format, which is the most
 * common cause of the "Invalid admin credentials" error on a manually seeded database.
 */
export async function bootstrapSuperAdmin(store: Store): Promise<boolean> {
  // Always run audit and migration for existing vendor accounts
  await auditAndMigrateVendorPermissions(store).catch(() => undefined);

  const email = config.superAdminEmail.trim();
  const password = config.superAdminPassword;
  if (!email && !password) return false;
  if (!email || !password) throw new Error('SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD must be provided together');
  if (password.length < 12) throw new Error('SUPER_ADMIN_PASSWORD must be at least 12 characters');

  const normalized = normalizeIdentity(email);
  if (normalized.channel !== 'email') throw new Error('SUPER_ADMIN_EMAIL must be a valid email address');

  const existing = await store.findUserByIdentity(normalized.identity);
  if (existing) {
    if (existing.role === 'customer') throw new Error('SUPER_ADMIN_EMAIL already belongs to a customer account; choose a dedicated admin email');
    let changed = false;
    if (existing.role !== 'super_admin') {
      await store.setUserRole(existing.id, 'super_admin');
      changed = true;
    }
    const passwordHash = await store.getPasswordHash(normalized.identity);
    if (!passwordHash || !(await verifyPassword(password, passwordHash))) {
      await store.setPasswordHash(existing.id, await hashPassword(password));
      changed = true;
    }
    return changed;
  }

  const user = await store.createUser({ identity: normalized.identity, channel: 'email', role: 'super_admin' });
  await store.setPasswordHash(user.id, await hashPassword(password));
  return true;
}
