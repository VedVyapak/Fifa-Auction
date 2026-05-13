// One-off scraper: grab top player ratings from EA Sports FC's ratings page,
// then visit each player's profile page to pull the full FC card image.
//
// EA's site is JS-rendered. Strategy:
//   1) Open the ratings list page with Playwright, scroll to load enough rows.
//   2) For each row, capture name/overall/position/club/nation + the profile URL.
//   3) For the top N, visit each profile page and extract the card image src.
//
// Output: ../data/players.json — [{ id, name, overall, position, club, nation, photo }]
//
// Run:
//   cd scraper && npm install && npm run scrape

import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATH = path.resolve(__dirname, '../data/players.json');
const TARGET = 150;
const ORIGIN = 'https://www.ea.com';
const LIST_URL = `${ORIGIN}/en/games/ea-sports-fc/ratings`;
const PROFILE_CONCURRENCY = 6;

async function main() {
  console.log('Launching Chromium...');
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 },
  });

  console.log('Scraping ratings list...');
  const list = await scrapeList(ctx);
  console.log(`Collected ${list.length} player rows from the list.`);

  if (!list.length) {
    await browser.close();
    console.error('No players found on list page.');
    process.exit(1);
  }

  // Sort by overall desc, dedupe by profile URL, take top N
  const seen = new Set();
  const top = list
    .filter(p => p.profileUrl && p.name && Number.isFinite(p.overall) && p.overall > 0)
    .sort((a, b) => b.overall - a.overall)
    .filter(p => { if (seen.has(p.profileUrl)) return false; seen.add(p.profileUrl); return true; })
    .slice(0, TARGET);

  console.log(`Fetching photos for top ${top.length} via profile pages (concurrency=${PROFILE_CONCURRENCY})...`);
  await hydratePhotos(ctx, top);

  await browser.close();

  const out = top.map((p, i) => ({
    id: `p_${i + 1}`,
    name: p.name,
    overall: p.overall,
    position: p.position || '',
    club: p.club || '',
    nation: p.nation || '',
    photo: p.photo || '',
  }));

  await fs.writeFile(OUT_PATH, JSON.stringify(out, null, 2), 'utf8');
  const withPhotos = out.filter(p => p.photo).length;
  console.log(`Wrote ${out.length} players (${withPhotos} with photos) → ${OUT_PATH}`);
}

async function scrapeList(ctx) {
  const page = await ctx.newPage();
  await page.goto(LIST_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(5000);

  // Try to dismiss cookie banner if present
  for (const sel of ['button:has-text("Accept")', 'button:has-text("I accept")', 'button:has-text("Agree")']) {
    const btn = await page.$(sel);
    if (btn) { try { await btn.click(); await page.waitForTimeout(500); } catch {} }
  }

  // Scroll until we have enough player profile links, or we stop making progress.
  let lastCount = 0;
  let stagnant = 0;
  for (let i = 0; i < 80; i++) {
    const count = await page.evaluate(() =>
      document.querySelectorAll('a[href*="/ratings/player-ratings/"]').length
    );
    if (count >= TARGET + 20) break;
    if (count === lastCount) stagnant++; else stagnant = 0;
    if (stagnant >= 8) break;
    lastCount = count;

    await page.mouse.wheel(0, 4000);
    await page.waitForTimeout(500);

    const more = await page.$('button:has-text("Load more"), button:has-text("Show more")');
    if (more) { try { await more.click(); await page.waitForTimeout(1200); } catch {} }
  }

  return await page.evaluate((origin) => {
    const POSITIONS = new Set([
      'GK','RB','LB','CB','RWB','LWB','CDM','CM','CAM','RM','LM','LW','RW','CF','ST',
    ]);
    const links = Array.from(document.querySelectorAll('a[href*="/ratings/player-ratings/"]'));
    const out = [];
    const seenHref = new Set();

    for (const link of links) {
      let href = link.getAttribute('href') || '';
      if (!href) continue;
      if (href.startsWith('/')) href = origin + href;
      if (seenHref.has(href)) continue;
      seenHref.add(href);

      // Walk up to the row containing this single player link.
      let row = link;
      while (row && row.parentElement) {
        const p = row.parentElement;
        if (p.querySelectorAll('a[href*="/ratings/player-ratings/"]').length > 1) break;
        row = p;
      }

      const text = (row.innerText || row.textContent || '').replace(/\s+/g, ' ').trim();
      const name = ((link.innerText || link.textContent || '').trim()) || extractName(text);

      // Nation + club from img alt attributes inside the row.
      const imgs = Array.from(row.querySelectorAll('img'));
      let nation = '', club = '';
      for (const img of imgs) {
        const alt = (img.getAttribute('alt') || '').trim();
        const src = (img.getAttribute('src') || '').toLowerCase();
        if (!alt) continue;
        if (/avatar|headshot|player|portrait/.test(src)) continue;
        if (/flag|nation|country/.test(src) && !nation) { nation = alt; continue; }
        if (/team|club|crest|badge|logo/.test(src) && !club) { club = alt; continue; }
        // Fallback: first short alt becomes nation, next becomes club.
        if (!nation) nation = alt;
        else if (!club && alt !== nation) club = alt;
      }

      // Position: first cell whose text is a known position token.
      let position = '';
      const tokens = text.split(/\s+/);
      for (const t of tokens) {
        if (POSITIONS.has(t)) { position = t; break; }
      }

      // Overall: the 2-digit number immediately following the position.
      let overall = 0;
      if (position) {
        const idx = text.indexOf(position);
        if (idx >= 0) {
          const m = text.slice(idx + position.length).match(/\b(\d{2})\b/);
          if (m) overall = Number(m[1]);
        }
      }
      if (!overall) {
        // Fallback: pick the first 2-digit number in 50..99 range.
        const m = text.match(/\b([5-9]\d)\b/);
        if (m) overall = Number(m[1]);
      }

      if (!overall || !name) continue;

      out.push({ profileUrl: href, name, overall, position, club, nation });
    }
    return out;

    function extractName(t) {
      const stripped = t.replace(/^\d+\s+/, '');
      return stripped.split(/\s{2,}|\t/)[0] || stripped;
    }
  }, ORIGIN);
}

async function hydratePhotos(ctx, players) {
  let cursor = 0;
  const workers = Array.from({ length: PROFILE_CONCURRENCY }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= players.length) return;
      const p = players[i];
      try {
        p.photo = await fetchPhoto(ctx, p.profileUrl);
        if ((i + 1) % 10 === 0 || i === players.length - 1) {
          console.log(`  ${i + 1}/${players.length} done`);
        }
      } catch (e) {
        console.warn(`  ! ${p.name}: ${e.message}`);
      }
    }
  });
  await Promise.all(workers);
}

async function fetchPhoto(ctx, url) {
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    // Give images a moment to lazy-load.
    await page.waitForTimeout(1500);
    return await page.evaluate(() => {
      const imgs = Array.from(document.querySelectorAll('img'));
      let best = '';
      let bestScore = -Infinity;
      for (const img of imgs) {
        const src = img.currentSrc || img.src || img.getAttribute('data-src') || '';
        if (!src || src.startsWith('data:')) continue;
        const lower = src.toLowerCase();
        if (/flag|crest|badge|logo|nation|country|sprite|icon|placeholder/.test(lower)) continue;
        const w = img.naturalWidth || img.width || 0;
        const h = img.naturalHeight || img.height || 0;
        // Prefer larger images; strongly prefer URLs that look like player cards/portraits.
        let score = (w * h) || 1;
        if (/player|card|portrait|headshot/.test(lower)) score += 1e8;
        if (/drop-assets\.ea\.com/.test(lower)) score += 1e6;
        if (score > bestScore) { bestScore = score; best = src; }
      }
      return best;
    });
  } finally {
    await page.close();
  }
}

main().catch((e) => {
  console.error('Scrape failed:', e);
  process.exit(1);
});
