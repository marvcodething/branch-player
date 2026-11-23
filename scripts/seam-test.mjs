#!/usr/bin/env node
// Automated seam check: plays the compiled story in headless Chrome, lets it run through
// several transitions, and fails if any seam is not exactly one frame or any stall occurs.
//
//   npm i -D playwright && npx playwright install chromium   (once)
//   npm run dev   (in another terminal)
//   node scripts/seam-test.mjs [seconds=60] [url=http://localhost:8080/] [--pick]
//
// Note: open-source Chromium can't decode H.264/AAC. Use output.codec "vp9" for CI with
// Playwright's bundled Chromium, or pass CHROME_PATH pointing at Google Chrome.
import { chromium } from 'playwright';

const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const seconds = Number(args[0] || 60);
const url = args[1] || 'http://localhost:8080/';
const pick = process.argv.includes('--pick');

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || undefined,
  args: ['--autoplay-policy=no-user-gesture-required']
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
await page.goto(url);
await page.waitForSelector('#startBtn:not([disabled])', { timeout: 15000 });
await page.click('#startBtn');

const until = Date.now() + seconds * 1000;
while (Date.now() < until) {
  if (await page.isVisible('#endCard')) break;
  if (pick && await page.isVisible('#choices') && await page.isEnabled('#choice-1')) {
    await page.keyboard.press(String(1 + Math.floor(Math.random() * 2)));
    await page.waitForTimeout(1500);
  }
  await page.waitForTimeout(200);
}

const log = await page.evaluate(() => window.__branch.log.slice().reverse());
await browser.close();

let bad = 0;
for (const h of log) {
  const frames = h.gapMs / h.frameMs;
  const ok = h.stalls === 0 && Math.abs(frames - 1) < 0.5;
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${h.from} → ${h.to}  gap ${h.gapMs.toFixed(1)} ms (${frames.toFixed(2)} frames)  stalls ${h.stalls}`);
}
if (errors.length) console.log('\nPage errors:\n' + errors.join('\n'));
if (!log.length) { console.log('No transitions happened. Is the dev server running?'); process.exit(1); }
console.log(`\n${log.length - bad}/${log.length} seamless`);
process.exit(bad || errors.length ? 1 : 0);
