/**
 * Demo visitors are short-lived accounts on a reserved domain: `.invalid` can never receive mail,
 * so no real sign-in (email code or OAuth) can ever reach one of these accounts.
 */
export const GUEST_EMAIL_DOMAIN = 'demo.invalid'

/** Demo visitors (and their private chats) are removed this long after they arrive. */
export const GUEST_LIFETIME_HOURS = 24

export function isGuestEmail(email: string): boolean {
  return email.trim().toLowerCase().endsWith(`@${GUEST_EMAIL_DOMAIN}`)
}

export function newGuestEmail(): string {
  return `guest-${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}@${GUEST_EMAIL_DOMAIN}`
}
