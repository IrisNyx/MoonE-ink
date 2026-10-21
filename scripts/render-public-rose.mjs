#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = fileURLToPath(new URL('../assets/public/', import.meta.url));
const svg = readFileSync(join(root, 'rose-placeholder.svg'));
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 512, height: 512 }, deviceScaleFactor: 1 });
  await page.setContent(`<html><body style="margin:0;background:transparent"><img width="512" height="512" src="data:image/svg+xml;base64,${svg.toString('base64')}"></body></html>`);
  await page.locator('img').screenshot({ path: join(root, 'rose-placeholder.png'), omitBackground: true });
  await page.close();
} finally {
  await browser.close();
}
