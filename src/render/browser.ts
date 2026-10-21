/**
 * Locked Chromium harness for the postcard renderer.
 *
 * The browser is playwright-core's registered Chromium (revision 1234,
 * binary version 151.0.7922.34) resolved exclusively from
 * PLAYWRIGHT_BROWSERS_PATH. A missing cache, a revision mismatch or a
 * browser.version() mismatch is an explicit render failure — the renderer
 * never falls back to a system Chrome/Edge. The page only ever talks to the
 * renderer's own loopback server; every request is recorded and anything
 * off-origin (external network, non-loopback, file:, unexpected paths) is
 * aborted and fails the render.
 */

import { createServer, type Server } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import {
  CHROMIUM_REVISION,
  CHROMIUM_VERSION,
  PAGE_HEIGHT,
  PAGE_WIDTH,
  PLAYWRIGHT_VERSION,
} from '../version.js';
import { RenderError } from './errors.js';
import type { LoadedFontAssets } from './fonts.js';

const require_ = createRequire(import.meta.url);

export interface RecordedRequest {
  url: string;
  method: string;
  status: number | null;
  failed: boolean;
  /** true when the harness aborted the request as out-of-policy */
  blocked: boolean;
}

export interface FontLoadEvidence {
  face: string;
  check: boolean;
}

export interface PageMeasurement {
  viewport: { width: number; height: number };
  document: { scrollWidth: number; scrollHeight: number };
  boxes: Record<string, { x: number; y: number; width: number; height: number }>;
  bodyText: {
    fontSizePx: number;
    scrollHeight: number;
    clientHeight: number;
    scrollWidth: number;
    clientWidth: number;
    lineRects: { x: number; y: number; width: number; height: number }[];
    textContent: string;
    textLengthScalars: number;
  };
  fontsReady: boolean;
  fontsCheck: FontLoadEvidence[];
}

function playwrightModule(): typeof import('playwright-core') {
  let mod: typeof import('playwright-core');
  try {
    mod = require_('playwright-core') as typeof import('playwright-core');
  } catch {
    throw new RenderError('render_failed', 'playwright-core is not installed');
  }
  const declared = require_('playwright-core/package.json') as { version: string };
  if (declared.version !== PLAYWRIGHT_VERSION) {
    throw new RenderError('render_failed', 'installed playwright-core does not match the locked version');
  }
  return mod;
}

/** The registry revisions this build pins (from playwright-core's browsers.json). */
async function expectedRevisions(): Promise<{ chromium: string; chromiumHeadlessShell: string }> {
  const packageJsonPath = require_.resolve('playwright-core/package.json');
  const registryPath = join(dirname(packageJsonPath), 'browsers.json');
  const registry = JSON.parse(await readFile(registryPath, 'utf8')) as {
    browsers: { name: string; revision: string }[];
  };
  const find = (name: string): string | undefined =>
    registry.browsers.find((browser) => browser.name === name)?.revision;
  const chromium = find('chromium');
  const headless = find('chromium-headless-shell');
  if (chromium !== CHROMIUM_REVISION || headless !== CHROMIUM_REVISION) {
    throw new RenderError('render_failed', 'playwright-core expects a different Chromium revision than the locked cache');
  }
  return { chromium: chromium!, chromiumHeadlessShell: headless! };
}

export interface RenderPageOptions {
  pageHtml: string;
  assets: LoadedFontAssets;
}

/**
 * Cheap, launch-free environment check: can the locked Chromium be resolved
 * from PLAYWRIGHT_BROWSERS_PATH at all (registry revisions match, both
 * browser directories present)? Used by the service start path to decide the
 * `publish` capability; the render itself still fails loudly on drift.
 */
export function browserEnvironmentStatus(): { ok: true; browsersPath: string } | { ok: false; reason: string } {
  const browsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (browsersPath === undefined || browsersPath.length === 0) {
    return { ok: false, reason: 'PLAYWRIGHT_BROWSERS_PATH is not configured' };
  }
  if (!existsSync(browsersPath)) {
    return { ok: false, reason: 'PLAYWRIGHT_BROWSERS_PATH does not point at an existing browser cache' };
  }
  try {
    playwrightModule();
  } catch {
    return { ok: false, reason: 'playwright-core is not installed' };
  }
  try {
    const packageJsonPath = require_.resolve('playwright-core/package.json');
    const registry = JSON.parse(readFileSync(join(dirname(packageJsonPath), 'browsers.json'), 'utf8')) as {
      browsers: { name: string; revision: string }[];
    };
    for (const name of ['chromium', 'chromium-headless-shell']) {
      const revision = registry.browsers.find((browser) => browser.name === name)?.revision;
      if (revision !== CHROMIUM_REVISION) {
        return { ok: false, reason: 'the locked Chromium revision is not the one this build expects' };
      }
      if (!existsSync(join(browsersPath, `${name.replace(/-/g, '_')}-${revision}`))) {
        return { ok: false, reason: `the browser cache does not contain ${name}` };
      }
    }
  } catch {
    return { ok: false, reason: 'playwright-core browser registry is unreadable' };
  }
  return { ok: true, browsersPath };
}

export interface RenderedPage {
  png: Buffer;
  measurement: PageMeasurement;
  requests: RecordedRequest[];
  fontFilesServed: string[];
  chromiumVersion: string;
  playwrightVersion: string;
  browsersPath: string;
}

/** Start the loopback asset server; resolves with its origin and closer. */
async function startLoopbackServer(
  pageHtml: string | (() => string),
  assets: LoadedFontAssets,
): Promise<{ origin: string; server: Server; served: string[]; hits: { url: string; status: number }[] }> {
  const server = createServer((req, res) => {
    const url = req.url ?? '/';
    const send = (status: number, headers: Record<string, string>, body: Buffer | string) => {
      hits.push({ url, status });
      res.writeHead(status, headers);
      res.end(body);
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      send(405, { 'content-type': 'text/plain', 'cache-control': 'no-store' }, 'method not allowed');
      return;
    }
    if (url === '/' || url === '/index.html') {
      send(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
        typeof pageHtml === 'function' ? pageHtml() : pageHtml);
      return;
    }
    if (url === '/fonts/fonts.css') {
      send(200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-store' }, assets.cssText);
      return;
    }
    const fontMatch = /^\/fonts\/([A-Za-z0-9._-]+\.woff2)$/.exec(url);
    if (fontMatch) {
      const file = fontMatch[1]!;
      if (!assets.files.some((entry) => entry.file === file)) {
        send(404, { 'content-type': 'text/plain', 'cache-control': 'no-store' }, 'not found');
        return;
      }
      readFile(join(assets.fontsRoot, file))
        .then((buffer) => {
          served.push(file);
          send(200, { 'content-type': 'font/woff2', 'cache-control': 'no-store' }, buffer);
        })
        .catch(() => send(404, { 'content-type': 'text/plain' }, 'not found'));
      return;
    }
    send(404, { 'content-type': 'text/plain', 'cache-control': 'no-store' }, 'not found');
  });
  const served: string[] = [];
  const hits: { url: string; status: number }[] = [];
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => resolveListen());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new RenderError('render_failed', 'loopback server could not bind');
  }
  return { origin: `http://127.0.0.1:${address.port}`, server, served, hits };
}

export interface LockedPageLoad {
  requests: RecordedRequest[];
  fontFilesServed: string[];
}

export interface LockedPageSession {
  page: import('playwright-core').Page;
  chromiumVersion: string;
  playwrightVersion: string;
  browsersPath: string;
  /** Replace the root HTML, load it through the guarded loopback origin and wait for the locked fonts. */
  loadHtml(html: string): Promise<LockedPageLoad>;
}

/**
 * Reusable locked-browser session for measured multi-page renderers.  It has
 * the same version, loopback-only and font-load gates as the postcard helper,
 * while allowing the note paginator to evaluate many candidate pages without
 * launching a new browser for every binary-search step.
 */
export async function withLockedPageSession<T>(
  assets: LoadedFontAssets,
  callback: (session: LockedPageSession) => Promise<T>,
  viewport: { width: number; height: number } = { width: PAGE_WIDTH, height: PAGE_HEIGHT },
): Promise<T> {
  const browsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (browsersPath === undefined || browsersPath.length === 0) {
    throw new RenderError('render_failed', 'PLAYWRIGHT_BROWSERS_PATH is not configured');
  }
  try {
    await expectedRevisions();
  } catch (error) {
    throw error instanceof RenderError ? error : new RenderError('render_failed', 'playwright-core browser registry is unreadable');
  }
  const playwright = playwrightModule();
  let currentHtml = '<!doctype html><html><body></body></html>';
  const loopback = await startLoopbackServer(() => currentHtml, assets);
  const requests: RecordedRequest[] = [];
  let browser: import('playwright-core').Browser | undefined;
  try {
    try {
      browser = await playwright.chromium.launch({ headless: true });
    } catch (error) {
      throw new RenderError('render_failed',
        `locked Chromium could not be launched from the browser cache (${error instanceof Error ? error.name : 'unknown error'})`);
    }
    const version = browser.version();
    if (version !== CHROMIUM_VERSION) {
      throw new RenderError('render_failed', 'launched Chromium version does not match the locked browser build');
    }
    const context = await browser.newContext({
      viewport,
      deviceScaleFactor: 1,
      reducedMotion: 'reduce',
      colorScheme: 'light',
      offline: false,
    });
    const page = await context.newPage();
    page.on('request', (request) => {
      requests.push({ url: request.url(), method: request.method(), status: null, failed: false, blocked: false });
    });
    page.on('requestfailed', (request) => {
      const entry = requests.find((item) => item.url === request.url() && item.status === null && !item.failed);
      const failure: RecordedRequest = {
        url: request.url(), method: request.method(), status: null, failed: true,
        blocked: request.failure()?.errorText === 'net::ERR_FAILED',
      };
      if (entry === undefined) requests.push(failure);
      else Object.assign(entry, failure);
    });
    page.on('response', (response) => {
      const entry = requests.find((item) => item.url === response.url() && item.status === null);
      if (entry !== undefined) entry.status = response.status();
    });
    await page.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.origin === loopback.origin && (url.protocol === 'http:' || url.protocol === 'https:')) {
        void route.continue();
      } else {
        void route.abort();
      }
    });
    const loadHtml = async (html: string): Promise<LockedPageLoad> => {
      currentHtml = html;
      requests.length = 0;
      loopback.served.length = 0;
      const response = await page.goto(loopback.origin + '/', { waitUntil: 'load' });
      if (response === null || response.status() !== 200) {
        throw new RenderError('render_failed', 'paper page did not load successfully');
      }
      await page.evaluate(async () => {
        await document.fonts.ready;
        await Promise.all([
          document.fonts.load('500 22px "Noto Serif SC"', '便签正文'),
          document.fonts.load('700 22px "Noto Serif SC"', '便签正文'),
          document.fonts.load('500 16px "Cormorant Garamond"', 'note 2026'),
          document.fonts.load('italic 500 16px "Cormorant Garamond"', 'a little note'),
        ]);
        await document.fonts.ready;
      });
      await page.evaluate(() => new Promise<void>((resolveFrame) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolveFrame()))));
      for (const request of requests) {
        if (request.failed) {
          throw new RenderError('render_failed', `a page resource request failed (${new URL(request.url).pathname})`);
        }
        if (request.status !== 200) {
          throw new RenderError('render_failed', `a page resource request returned an unexpected status (${new URL(request.url).pathname})`);
        }
      }
      return { requests: requests.map((item) => ({ ...item })), fontFilesServed: [...loopback.served] };
    };
    return await callback({ page, chromiumVersion: version, playwrightVersion: PLAYWRIGHT_VERSION, browsersPath, loadHtml });
  } finally {
    try {
      await browser?.close();
    } finally {
      await new Promise<void>((resolveClose) => loopback.server.close(() => resolveClose()));
    }
  }
}

/** The in-page measurement payload (serialized into the page context). */
async function measurePage(page: import('playwright-core').Page): Promise<PageMeasurement> {
  return page.evaluate((): PageMeasurement => {
    const rect = (el: Element | null) => {
      if (el === null) return { x: -1, y: -1, width: -1, height: -1 };
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    };
    const doc = document.scrollingElement ?? document.documentElement;
    const bodyEl = document.getElementById('eph-body-text');
    let lineRects: { x: number; y: number; width: number; height: number }[] = [];
    let textContent = '';
    if (bodyEl !== null) {
      textContent = bodyEl.textContent ?? '';
      const range = document.createRange();
      range.selectNodeContents(bodyEl);
      lineRects = Array.from(range.getClientRects()).map((r) => ({
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height,
      }));
    }
    let textLengthScalars = 0;
    for (const _ of textContent) textLengthScalars += 1;
    const fontsCheck: FontLoadEvidence[] = [];
    const faces: [string, string][] = [
      ['500 16px "Noto Serif SC"', 'noto-500'],
      ['700 16px "Noto Serif SC"', 'noto-700'],
      ['500 16px "Cormorant Garamond"', 'cormorant-500'],
      ['italic 500 16px "Cormorant Garamond"', 'cormorant-italic-500'],
    ];
    for (const [spec, label] of faces) {
      let ok = false;
      try {
        ok = document.fonts.check(spec);
      } catch {
        ok = false;
      }
      fontsCheck.push({ face: label, check: ok });
    }
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      document: { scrollWidth: doc.scrollWidth, scrollHeight: doc.scrollHeight },
      boxes: {
        sheet: rect(document.getElementById('eph-sheet')),
        head: rect(document.getElementById('eph-head')),
        bodyText: rect(bodyEl),
        stamp: rect(document.getElementById('eph-stamp')),
        postmark: rect(document.getElementById('eph-postmark')),
        divider: rect(document.getElementById('eph-divider')),
      },
      bodyText:
        bodyEl === null
          ? { fontSizePx:0, scrollHeight: -1, clientHeight: -1, scrollWidth: -1, clientWidth: -1, lineRects: [], textContent: '', textLengthScalars: 0 }
          : {
              fontSizePx: parseFloat(getComputedStyle(bodyEl).fontSize),
              scrollHeight: bodyEl.scrollHeight,
              clientHeight: bodyEl.clientHeight,
              scrollWidth: bodyEl.scrollWidth,
              clientWidth: bodyEl.clientWidth,
              lineRects,
              textContent,
              textLengthScalars,
            },
      fontsReady: document.fonts.status === 'loaded',
      fontsCheck,
    };
  });
}

/**
 * Load the paper in the locked Chromium and capture the 540x960 screenshot.
 * Everything the page fetched is recorded; any failed/blocked/non-200 request
 * fails the render.
 */
export async function renderPageInChromium(options: RenderPageOptions): Promise<RenderedPage> {
  const { pageHtml, assets } = options;
  const browsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (browsersPath === undefined || browsersPath.length === 0) {
    throw new RenderError('render_failed', 'PLAYWRIGHT_BROWSERS_PATH is not configured');
  }
  try {
    await expectedRevisions();
  } catch (error) {
    throw error instanceof RenderError ? error : new RenderError('render_failed', 'playwright-core browser registry is unreadable');
  }
  const playwright = playwrightModule();

  const loopback = await startLoopbackServer(pageHtml, assets);
  const requests: RecordedRequest[] = [];
  let browser: import('playwright-core').Browser | undefined;
  try {
    let context: import('playwright-core').BrowserContext;
    try {
      browser = await playwright.chromium.launch({ headless: true });
    } catch (error) {
      throw new RenderError(
        'render_failed',
        `locked Chromium could not be launched from the browser cache (${error instanceof Error ? error.name : 'unknown error'})`,
      );
    }
    const version = browser.version();
    if (version !== CHROMIUM_VERSION) {
      throw new RenderError('render_failed', 'launched Chromium version does not match the locked browser build');
    }
    context = await browser.newContext({
      viewport: { width: PAGE_WIDTH, height: PAGE_HEIGHT },
      deviceScaleFactor: 1,
      reducedMotion: 'reduce',
      colorScheme: 'light',
      offline: false,
    });
    const page = await context.newPage();
    page.on('request', (request) => {
      requests.push({ url: request.url(), method: request.method(), status: null, failed: false, blocked: false });
    });
    page.on('requestfailed', (request) => {
      const entry = requests.find((r) => r.url === request.url() && r.status === null && !r.failed);
      const failure: RecordedRequest = {
        url: request.url(),
        method: request.method(),
        status: null,
        failed: true,
        blocked: request.failure()?.errorText === 'net::ERR_FAILED',
      };
      if (entry === undefined) requests.push(failure);
      else Object.assign(entry, failure);
    });
    page.on('response', (response) => {
      const entry = requests.find((r) => r.url === response.url() && r.status === null);
      if (entry !== undefined) entry.status = response.status();
    });
    // Guard: only the renderer's own loopback origin may be touched.
    await page.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.origin === loopback.origin && (url.protocol === 'http:' || url.protocol === 'https:')) {
        void route.continue();
        return;
      }
      void route.abort();
    });

    const response = await page.goto(loopback.origin + '/', { waitUntil: 'load' });
    if (response === null || response.status() !== 200) {
      throw new RenderError('render_failed', 'paper page did not load successfully');
    }
    await page.evaluate(async () => {
      await document.fonts.ready;
      const loads: Promise<unknown>[] = [];
      for (const spec of [
        '500 16px "Noto Serif SC"',
        '700 16px "Noto Serif SC"',
        '500 16px "Cormorant Garamond"',
        'italic 500 16px "Cormorant Garamond"',
      ]) {
        loads.push(document.fonts.load(spec).catch(() => undefined));
      }
      await Promise.all(loads);
      await document.fonts.ready;
    });
    // Two animation frames so layout/font application is fully settled.
    await page.evaluate(
      () => new Promise<void>((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(() => resolveFrame()))),
    );

    const measurement = await measurePage(page);
    const png = await page.screenshot({ type: 'png', fullPage: false, animations: 'disabled' });

    for (const request of requests) {
      if (request.failed) {
        throw new RenderError('render_failed', `a page resource request failed (${new URL(request.url).pathname})`);
      }
      if (request.status === null || request.status !== 200) {
        throw new RenderError('render_failed', `a page resource request returned an unexpected status (${new URL(request.url).pathname})`);
      }
    }

    return {
      png,
      measurement,
      requests,
      fontFilesServed: [...loopback.served],
      chromiumVersion: version,
      playwrightVersion: PLAYWRIGHT_VERSION,
      browsersPath,
    };
  } finally {
    try {
      await browser?.close();
    } finally {
      await new Promise<void>((resolveClose) => loopback.server.close(() => resolveClose()));
    }
  }
}
