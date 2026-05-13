// Probe: open one EA player profile page and dump candidate images so we can see
// what fetchPhoto in scrape.js will pick.
import { chromium } from 'playwright';

const URL = 'https://www.ea.com/en/games/ea-sports-fc/ratings/player-ratings/mohamed-salah/209331';

const browser = await chromium.launch({
  headless: true,
  channel: undefined,
});
const ctx = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  viewport: { width: 1440, height: 900 },
});
const page = await ctx.newPage();

console.log('Opening:', URL);
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
await page.waitForTimeout(3000);

// Dismiss cookie banner if present
for (const sel of ['button:has-text("Accept")', 'button:has-text("I accept")', 'button:has-text("Agree")']) {
  const btn = await page.$(sel);
  if (btn) { try { await btn.click(); await page.waitForTimeout(500); } catch {} }
}
await page.waitForTimeout(1500);

const result = await page.evaluate(() => {
  const imgs = Array.from(document.querySelectorAll('img'));
  const all = imgs.map(img => ({
    src: img.currentSrc || img.src || img.getAttribute('data-src') || '',
    alt: img.getAttribute('alt') || '',
    w: img.naturalWidth || img.width || 0,
    h: img.naturalHeight || img.height || 0,
  })).filter(x => x.src && !x.src.startsWith('data:'));

  // Replicate fetchPhoto picker
  let best = '', bestScore = -Infinity;
  for (const x of all) {
    const lower = x.src.toLowerCase();
    if (/flag|crest|badge|logo|nation|country|sprite|icon|placeholder/.test(lower)) continue;
    let score = (x.w * x.h) || 1;
    if (/player|card|portrait|headshot/.test(lower)) score += 1e8;
    if (/drop-assets\.ea\.com/.test(lower)) score += 1e6;
    if (score > bestScore) { bestScore = score; best = x.src; }
  }

  return { all, best, bestScore, title: document.title };
});

console.log('\nPage title:', result.title);
console.log(`\nFound ${result.all.length} <img> tags. Listing all:`);
for (const x of result.all) {
  console.log(`  [${x.w}x${x.h}] alt="${x.alt}" src=${x.src}`);
}

console.log('\nfetchPhoto would pick:');
console.log('  ', result.best || '(none)');
console.log('  score=', result.bestScore);

await browser.close();
