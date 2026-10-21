/**
 * Host and Origin validation executed before any MCP handling.
 *
 * Defaults bind to loopback and reject every browser Origin, so a machine
 * client without an Origin header works while websites cannot reach the
 * service (DNS rebinding / drive-by protection).
 */

/** Extract the hostname part of a Host header, port-insensitive. */
export function hostHostname(hostHeader: string): string {
  const trimmed = hostHeader.trim().toLowerCase();
  if (trimmed.startsWith('[')) {
    // IPv6 literal: [::1]:8765 -> [::1]
    const close = trimmed.indexOf(']');
    return close === -1 ? trimmed : trimmed.slice(0, close + 1);
  }
  const colon = trimmed.lastIndexOf(':');
  return colon === -1 ? trimmed : trimmed.slice(0, colon);
}

export function isHostAllowed(hostHeader: string | undefined, allowedHosts: readonly string[]): boolean {
  if (hostHeader === undefined || hostHeader.length === 0) {
    return false;
  }
  return allowedHosts.includes(hostHostname(hostHeader));
}

/**
 * Origin policy: absent Origin (machine client) is allowed; any present
 * Origin must match the configured allowlist exactly (case-insensitive).
 * An empty allowlist rejects all browser origins.
 */
export function isOriginAllowed(originHeader: string | undefined, allowedOrigins: readonly string[]): boolean {
  if (originHeader === undefined || originHeader.length === 0) {
    return true;
  }
  return allowedOrigins.some((allowed) => allowed.toLowerCase() === originHeader.trim().toLowerCase());
}
