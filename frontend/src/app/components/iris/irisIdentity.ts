/**
 * Which signed-in identity an Iris controller belongs to. Iris state is
 * account-scoped and sensitive, so it must not outlive the identity it was
 * created for. One account can hold more than one role (a landlord who also
 * rents), and another tab can sign in as someone else, so the account id alone
 * is not enough: any change to account, role or sign-in email starts over.
 * Only fields the session already carries are used; nothing new is requested.
 */
export function irisIdentityKey(user: unknown): string | null {
  if (!user || typeof user !== 'object') return null;
  const u = user as { id?: unknown; _id?: unknown; role?: unknown; email?: unknown };
  const id = typeof u.id === 'string' && u.id ? u.id : typeof u._id === 'string' ? u._id : '';
  const role = typeof u.role === 'string' ? u.role : '';
  if (!id || !role) return null;
  const email = typeof u.email === 'string' ? u.email.toLowerCase() : '';
  return JSON.stringify([id, role, email]);
}

/** True while the stored session is still exactly the identity Iris was made for. */
export function sameIdentity(key: string, stored: unknown): boolean {
  return irisIdentityKey(stored) === key;
}
