/**
 * Service-level identity constants.
 *
 * SERVICE_VERSION is asserted against package.json by the test suite
 * (test/build.test.ts) so it cannot silently drift. The SDK pins below are
 * asserted against the installed packages the same way.
 */
export const SERVICE_NAME = 'ephemera';

export const SERVICE_VERSION = '1.0.3';

/** Business API schema version (independent of MCP protocol versions). */
export const API_SCHEMA_VERSION = 2;

/**
 * Official MCP TypeScript SDK v2, published as split packages (the monolithic
 * `@modelcontextprotocol/sdk` v1 line is replaced by these). The server-side
 * entry is `@modelcontextprotocol/server`; `@modelcontextprotocol/node` adapts
 * its web-standard handler face to plain node:http. The test suite drives the
 * service with the official `@modelcontextprotocol/client`.
 */
export const SDK_SERVER_MODULE = '@modelcontextprotocol/server';
export const SDK_SERVER_VERSION = '2.3.1';
export const SDK_NODE_MODULE = '@modelcontextprotocol/node';
export const SDK_NODE_VERSION = '2.1.1';
export const SDK_CLIENT_MODULE = '@modelcontextprotocol/client';
export const SDK_CLIENT_VERSION = '2.3.1';

/**
 * The protocol revisions this build actually serves.
 *
 * `MODERN_PROTOCOL_VERSION` is negotiated through the SDK's 2026-07-28
 * per-request envelope and `server/discover` path (createMcpHandler's modern
 * leg); the legacy revisions are negotiated through the SDK's 2025-era
 * `initialize` handshake (stateless legacy fallback). The union of both lists
 * is what `ephemera_service_info` advertises, and the F02 tests prove each
 * row with the official client pinned to exactly that revision.
 */
export const MODERN_PROTOCOL_VERSION = '2026-07-28';
export const LEGACY_PROTOCOL_VERSIONS: readonly string[] = ['2025-11-25', '2025-03-26'];

/**
 * MCP-02 renderer identity. The postcard renderer is locked to
 * playwright-core 1.62.0 whose bundled registry expects Chromium revision
 * 1234 (chromium + chromium-headless-shell); the launched browser must report
 * exactly CHROMIUM_VERSION or the render fails — no system Chrome/Edge, no
 * revision drift. The raster profile follows the Device Channel v1 contract.
 */
export const RENDERER_BUILD = 'postcard-renderer/5';
export const RENDER_PROFILE = 'epaper-540x960-gray4-v1';
export const LANDSCAPE_RENDER_PROFILE = 'epaper-960x540-gray4-v1';
export const PLAYWRIGHT_VERSION = '1.62.0';
export const CHROMIUM_REVISION = '1234';
export const CHROMIUM_VERSION = '151.0.7922.34';

/** Fixed RGBA -> gray4 conversion identity (see src/render/gray4.ts). */
export const GRAY4_ALGORITHM = 'rec709-round-gray4-v1';
export const GRAY4_ALGORITHM_VERSION = 1;

/** Raster geometry from the epaper-540x960-gray4-v1 contract. */
export const PAGE_WIDTH = 540;
export const PAGE_HEIGHT = 960;
export const GRAY4_STRIDE_BYTES = 270;
export const GRAY4_BYTE_LENGTH = 259_200;
export const LANDSCAPE_PAGE_WIDTH = 960;
export const LANDSCAPE_PAGE_HEIGHT = 540;
export const LANDSCAPE_GRAY4_STRIDE_BYTES = 480;
