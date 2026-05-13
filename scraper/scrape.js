// One-off scraper: grab top player ratings from EA Sports FC's ratings page.
//
// The ratings page is server-rendered Next.js; the full record set for each
// page (100 players) is embedded in <script id="__NEXT_DATA__">. We just fetch
// page 1..N, parse JSON, and pick the top TARGET by overall rating.
//
// Output: ../data/players.json — [{ id, name, overall, position, club, nation, photo }]
//
// Run:
//   cd scraper && npm run scrape

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATH = path.resolve(__dirname, '../data/players.json');
const LIST_URL = 'https://www.ea.com/en/games/ea-sports-fc/ratings';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const PAGE_SIZE = 100;
const TARGET = 150;
const PAGES = Math.ceil(TARGET / PAGE_SIZE);

async function main() {
  const all = [];
  for (let p = 1; p <= PAGES; p++) {
    const url = `${LIST_URL}?page=${p}`;
    console.log(`Fetching ${url}`);
    const { items } = await fetchPage(url);
    console.log(`  got ${items.length} entries`);
    all.push(...items);
  }

  const out = all
    .sort((a, b) => b.overallRating - a.overallRating)
    .slice(0, TARGET)
    .map((p, i) => ({
      id: `p_${i + 1}`,
      name: pickName(p),
      overall: p.overallRating,
      position: p.position?.shortLabel || '',
      club: p.team?.label || '',
      clubImage: p.team?.imageUrl || '',
      nation: p.nationality?.label || '',
      nationImage: p.nationality?.imageUrl || '',
      photo: p.shieldUrl || '',
      stats: {
        pac: p.stats?.pac?.value ?? null,
        sho: p.stats?.sho?.value ?? null,
        pas: p.stats?.pas?.value ?? null,
        dri: p.stats?.dri?.value ?? null,
        def: p.stats?.def?.value ?? null,
        phy: p.stats?.phy?.value ?? null,
      },
    }));

  await fs.writeFile(OUT_PATH, JSON.stringify(out, null, 2), 'utf8');
  const withPhotos = out.filter(p => p.photo).length;
  console.log(`Wrote ${out.length} players (${withPhotos} with photos) → ${OUT_PATH}`);
}

async function fetchPage(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'text/html' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const html = await res.text();
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('__NEXT_DATA__ not found');
  const data = JSON.parse(m[1]);
  const rd = data?.props?.pageProps?.ratingDetails;
  if (!rd || !Array.isArray(rd.items)) throw new Error('ratingDetails.items missing');
  return { items: rd.items };
}

function pickName(p) {
  if (p.commonName) return p.commonName;
  return [p.firstName, p.lastName].filter(Boolean).join(' ');
}

main().catch((e) => {
  console.error('Scrape failed:', e);
  process.exit(1);
});
