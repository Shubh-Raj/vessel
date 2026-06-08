const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const CHROMIUM_PATH = '/usr/bin/chromium';

const TARGET_URL = 'https://example.com';

const SCREENSHOT_PATH = '/tmp/screenshot.png';

async function main() {
  console.log('[browser.js] Starting Chromium via Puppeteer...');


  const browser = await puppeteer.launch({
    executablePath: CHROMIUM_PATH,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
    ],
  });

  console.log('[browser.js] Browser launched. Opening new page...');
  const page = await browser.newPage();

  await page.setViewport({ width: 1280, height: 720 });

  console.log(`[browser.js] Navigating to: ${TARGET_URL}`);
  await page.goto(TARGET_URL, { waitUntil: 'networkidle2' });

  const title = await page.title();
  console.log(`[browser.js] Page loaded! Title: "${title}"`);

  console.log(`[browser.js] Taking screenshot → ${SCREENSHOT_PATH}`);
  await page.screenshot({ path: SCREENSHOT_PATH, fullPage: false });

  console.log('[browser.js] Screenshot saved.');
  console.log('[browser.js] Phase 1 complete — container is working!');

  await browser.close();
  console.log('[browser.js] Browser closed. Exiting.');
}

main().catch((err) => {
  console.error('[browser.js] FATAL ERROR:', err);
  process.exit(1);
});
