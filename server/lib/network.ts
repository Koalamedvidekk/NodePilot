import os from 'node:os';

/**
 * Returns all active, non-internal IPv4 addresses assigned to this machine.
 * Examples: ['192.168.1.150', '10.0.0.42']
 */
export function getLocalNetworkAddresses(): string[] {
  const interfaces = os.networkInterfaces();
  const addresses: string[] = [];

  for (const name of Object.keys(interfaces)) {
    const list = interfaces[name];
    if (!list) continue;

    for (const info of list) {
      // Collect non-internal IPv4 addresses
      if (info.family === 'IPv4' && !info.internal) {
        addresses.push(info.address);
      }
    }
  }

  // Remove duplicates and sort
  return Array.from(new Set(addresses)).sort();
}

/**
 * Check whether an IP string is within a standard private IPv4 range
 * (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16) or loopback.
 */
export function isPrivateOrLoopbackIp(ip: string): boolean {
  if (['127.0.0.1', 'localhost', '::1', '[::1]'].includes(ip)) {
    return true;
  }

  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
    return false;
  }

  // 10.0.0.0/8
  if (parts[0] === 10) return true;
  // 172.16.0.0/12 (172.16.0.0 - 172.31.255.255)
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  // 192.168.0.0/16
  if (parts[0] === 192 && parts[1] === 168) return true;
  // 169.254.0.0/16 (link-local)
  if (parts[0] === 169 && parts[1] === 254) return true;

  return false;
}

/**
 * Checks if an incoming HTTP Origin or WebSocket Origin header is permitted.
 * If host is 0.0.0.0 (LAN mode), allows localhost and private network origins.
 */
export function isAllowedOrigin(
  origin: string | undefined,
  configuredHost: string,
  localAddresses = getLocalNetworkAddresses(),
): boolean {
  if (!origin) return true;

  try {
    const url = new URL(origin);
    const hostname = url.hostname.toLowerCase();

    // Loopback is always permitted
    if (['localhost', '127.0.0.1', '[::1]'].includes(hostname)) {
      return true;
    }

    // If server is only listening on loopback, reject non-loopback origins
    if (configuredHost === '127.0.0.1' || configuredHost === 'localhost') {
      return false;
    }

    // In LAN mode (e.g. 0.0.0.0): allow known host addresses or private subnets
    if (localAddresses.includes(hostname) || isPrivateOrLoopbackIp(hostname) || hostname.endsWith('.local')) {
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Format URLs for display in the console or API.
 */
export function formatAccessUrls(
  host: string,
  port: number,
  addresses = getLocalNetworkAddresses(),
): { local: string; network: string[] } {
  const local = `http://localhost:${port}`;
  const network = host === '0.0.0.0'
    ? addresses.map((addr) => `http://${addr}:${port}`)
    : [];

  return { local, network };
}
