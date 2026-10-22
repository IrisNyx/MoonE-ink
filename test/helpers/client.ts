import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

/**
 * Official SDK v2 clients over real loopback HTTP with a static bearer token.
 * Both eras use stock SDK machinery — no transport subclassing, no request
 * rewriting:
 *
 *  - modern: `versionNegotiation: { mode: { pin: '2026-07-28' } }` makes
 *    `connect()` run the official `server/discover` negotiation and fail
 *    loudly unless the server offers exactly the pinned modern revision.
 *    After connect the client attaches the 2026-07-28 per-request `_meta`
 *    envelope to every call automatically.
 *  - legacy: `supportedProtocolVersions: [version]` makes the plain 2025
 *    `initialize` handshake offer exactly that revision; the server must echo
 *    it or the client aborts.
 */
export interface ConnectedClient {
  client: Client;
  /** Protocol era the SDK recorded for this connection ('modern' | 'legacy'). */
  era(): 'modern' | 'legacy' | undefined;
  /** Protocol revision the SDK negotiated for this connection. */
  negotiatedVersion(): string | undefined;
  /** The server/discover result, when the connection negotiated the modern era. */
  discoverResult(): { supportedVersions?: string[] } | undefined;
  close(): Promise<void>;
}

function connectedClient(client: Client, transport: StreamableHTTPClientTransport): ConnectedClient {
  return {
    client,
    era: () => client.getProtocolEra(),
    negotiatedVersion: () => client.getNegotiatedProtocolVersion(),
    discoverResult: () => client.getDiscoverResult() as { supportedVersions?: string[] } | undefined,
    close: async () => {
      await client.close();
      try {
        await transport.close();
      } catch {
        // transport may already be closed by the server
      }
    },
  };
}

/** Connect an official client pinned to the modern 2026-07-28 revision. */
export async function connectModernClient(opts: {
  port: number;
  token: string;
  pin?: string;
  clientName?: string;
}): Promise<ConnectedClient> {
  const url = new URL(`http://127.0.0.1:${opts.port}/mcp`);
  const transport = new StreamableHTTPClientTransport(url, {
    authProvider: { token: async () => opts.token },
  });
  const client = new Client(
    { name: opts.clientName ?? 'ephemera-modern-test-client', version: '1.0.0' },
    { versionNegotiation: { mode: { pin: opts.pin ?? '2026-07-28' } } },
  );
  await client.connect(transport);
  return connectedClient(client, transport);
}

/** Connect an official client running the plain 2025 initialize handshake. */
export async function connectLegacyClient(opts: {
  port: number;
  token: string;
  version: string;
  clientName?: string;
}): Promise<ConnectedClient> {
  const url = new URL(`http://127.0.0.1:${opts.port}/mcp`);
  const transport = new StreamableHTTPClientTransport(url, {
    authProvider: { token: async () => opts.token },
  });
  const client = new Client(
    { name: opts.clientName ?? 'ephemera-legacy-test-client', version: '1.0.0' },
    { supportedProtocolVersions: [opts.version] },
  );
  await client.connect(transport);
  return connectedClient(client, transport);
}
