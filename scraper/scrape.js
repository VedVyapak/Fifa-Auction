// One-off scraper: grab top 150 player ratings from EA Sports FC's ratings page.
//
// EA's site is JS-rendered. Strategy:
//   1) Open the ratings page with Playwright.
//   2) Intercept JSON network responses to find the players payload.
//   3) Fall back to DOM scraping if the API call shape isn't recognized.
//
// Output: ../data/players.json
//
// Run:
//   cd scraper && npm install && npm run scrape
//
// If EA's site has changed and this script fails, you can also paste data
// from another source into ../data/players.json — the website only needs:
//   [{ id, name, overall, position, club, nation, photo }]

import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATH = path.resolve(__dirname, '../data/players.json');
const TARGET = 150;
const URL = 'https://www.ea.com/en/games/ea-sports-fc/ratings';

async function main() {
  console.log('Launching Chromium...');
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 },
  });
  const page = await ctx.newPage();

  const apiPayloads = [];
  page.on('response', async (res) => {
    const ct = res.headers()['content-type'] || '';
    if (!ct.includes('application/json')) return;
    const url = res.url();
    // EA ratings JSON tends to live under /content/ea-com/ or a search/index endpoint
    if (!/rating|player|search|content/i.test(url)) return;
    try {
      const data = await res.json();
      apiPayloads.push({ url, data });
    } catch {}
  });

  console.log(`Opening ${URL}`);
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  // Let JS finish rendering and trigger initial data calls
  await page.waitForTimeout(6000);

  // Try to detect "load more" or pagination and scroll a few times
  for (let i = 0; i < 8; i++) {
    await page.mouse.wheel(0, 2000);
    await page.waitForTimeout(800);
    // try clicking any "load more" button if present
    const more = await page.$('button:has-text("Load more"), button:has-text("Show more")');
    if (more) { try { await more.click(); await page.waitForTimeout(1500); } catch {} }
  }

  let players = extractFromPayloads(apiPayloads);
  if (players.length < 30) {
    console.log(`Only ${players.length} from JSON, falling back to DOM scrape...`);
    players = await scrapeDOM(page);
  }

  await browser.close();

  if (!players.length) {
    console.error('Scraping failed — no players found.');
    console.error('You can manually edit data/players.json instead. Required schema:');
    console.error('  [{ id, name, overall, position, club, nation, photo }]');
    process.exit(1);
  }

  // Sort by overall desc, dedupe by name, take top N
  const seen = new Set();
  const top = players
    .filter(p => p && p.name && Number.isFinite(p.overall))
    .sort((a, b) => b.overall - a.overall)
    .filter(p => {
      const k = p.name.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, TARGET)
    .map((p, i) => ({
      id: `p_${i + 1}`,
      name: p.name,
      overall: Number(p.overall) || 0,
      position: p.position || '',
      club: p.club || '',
      nation: p.nation || '',
      photo: p.photo || '',
    }));

  await fs.writeFile(OUT_PATH, JSON.stringify(top, null, 2), 'utf8');
  console.log(`Wrote ${top.length} players → ${OUT_PATH}`);
}

function extractFromPayloads(payloads) {
  const collected = [];
  for (const { data } of payloads) {
    walk(data, collected);
  }
  return collected;
}

// Recursively look for objects that look like a player.
function walk(node, out, depth = 0) {
  if (!node || depth > 8) return;
  if (Array.isArray(node)) {
    for (const item of node) walk(item, out, depth + 1);
    return;
  }
  if (typeof node === 'object') {
    // Detect player-like shape
    const rating = pickFirst(node, ['overallRating', 'rating', 'overall', 'ovr']);
    const name = pickFirst(node, ['commonName', 'fullName', 'firstName', 'name', 'playerName']);
    if (rating && name && Number(rating) >= 50 && Number(rating) <= 99) {
      out.push({
        name: typeof name === 'string' ? name : combineNames(node),
        overall: Number(rating),
        position: pickFirst(node, ['position', 'preferredPosition', 'pos']) || '',
        club: extractName(pickFirst(node, ['club', 'team', 'teamName', 'clubName'])),
        nation: extractName(pickFirst(node, ['nationality', 'nation', 'country'])),
        photo: pickFirst(node, ['avatarUrl', 'imageUrl', 'image', 'photoUrl', 'playerImage']) || '',
      });
    }
    for (const k of Object.keys(node)) walk(node[k], out, depth + 1);
  }
}

function pickFirst(obj, keys) {
  for (const k of keys) {
    if (obj[k] != null && obj[k] !== '') return obj[k];
  }
  return null;
}

function combineNames(node) {
  return [node.firstName, node.lastName].filter(Boolean).join(' ') || 'Unknown';
}

function extractName(val) {
  if (!val) return '';
  if (typeof val === 'string') return val;
  if (typeof val === 'object') return val.name || val.label || '';
  return String(val);
}

async function scrapeDOM(page) {
  // Best-effort DOM scrape if JSON intercept fails.
  return await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('[class*="player"], [class*="Player"]'));
    const out = [];
    for (const row of rows) {
      const txt = row.textContent || '';
      const ratingMatch = txt.match(/\b([5-9]\d)\b/);
      const nameEl = row.querySelector('[class*="name" i], h2, h3, [class*="title" i]');
      if (!ratingMatch || !nameEl) continue;
      out.push({
        name: (nameEl.textContent || '').trim().slice(0, 60),
        overall: Number(ratingMatch[1]),
        position: '',
        club: '',
        nation: '',
        photo: row.querySelector('img')?.src || '',
      });
    }
    return out;
  });
}

main().catch((e) => {
  console.error('Scrape failed:', e);
  process.exit(1);
});
