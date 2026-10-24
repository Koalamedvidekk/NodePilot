import { timingSafeEqual } from 'node:crypto';

/**
 * API routes that are deliberately available before a panel PIN is verified.
 * Network configuration is intentionally not listed: if a PIN exists, changing
 * it or exposing LAN mode must require that existing credential.
 */
export function requiresPanelPin(requestUrl: string): boolean {
  const urlPath = requestUrl.split('?')[0];
  return urlPath.startsWith('/api/')
    && !urlPath.startsWith('/api/auth/')
    && urlPath !== '/api/bridge/connect';
}

/** Constant-time comparison for the panel PIN once the lengths match. */
export function pinMatches(providedPin: string | undefined, expectedPin: string | null): boolean {
  if (!providedPin || !expectedPin) return false;
  const provided = Buffer.from(providedPin.trim(), 'utf8');
  const expected = Buffer.from(expectedPin, 'utf8');
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}
