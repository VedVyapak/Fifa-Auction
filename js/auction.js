// Shared auction rules: starting bids, reserve-budget math, position warnings.
// Pure functions. Imported by host.js and bidder.js.

export const SQUAD_SIZE = 15;
export const STARTING_BUDGET = 100_000_000;
export const MIN_INCREMENT = 100_000;
export const BID_TIMER_SECONDS = 10;
export const POSITION_WARN_THRESHOLD = 10; // banner kicks in after this many players owned

// Position normalization. FUT positions → 4 buckets.
// GK is its own bucket. Defenders: CB/LB/RB/LWB/RWB. Mids: CDM/CM/CAM/LM/RM.
// Forwards: ST/CF/LW/RW.
const POSITION_BUCKETS = {
  GK:  'GK',
  CB:  'DEF', LB: 'DEF', RB: 'DEF', LWB: 'DEF', RWB: 'DEF',
  CDM: 'MID', CM: 'MID', CAM: 'MID', LM: 'MID', RM: 'MID',
  ST:  'FWD', CF: 'FWD', LW: 'FWD', RW: 'FWD',
};

export function bucketFor(position) {
  if (!position) return 'MID';
  const key = position.toUpperCase().trim();
  return POSITION_BUCKETS[key] || 'MID';
}

// Starting bid scaled by overall rating.
// >=90 → 5M, 85-89 → 2M, 80-84 → 500k, <80 → 100k.
export function startingBid(overall) {
  const r = Number(overall) || 0;
  if (r >= 90) return 5_000_000;
  if (r >= 85) return 2_000_000;
  if (r >= 80) return 500_000;
  return 100_000;
}

// Theatre pacing — pick the next player to auction.
//
// Goal: build emotional waves instead of pure-random clumping.
//   - Round 1 → guaranteed marquee opener
//   - Mid-auction → tier weights modulated by recency, with position
//     anti-clustering (no two same-position players back-to-back)
//   - End-game → save the remaining marquees for the final 3-4 rounds
//
// Pass { forceTier: 'marquee' } to bypass pacing (host's "🔥" override).
export function pickNextPlayer(pool, history, options = {}) {
  const unsold = Object.values(pool || {}).filter(p => !p.sold);
  if (!unsold.length) return null;

  const tier = playerTier; // exported below
  const slotsLeft = unsold.length;
  const sold = Object.keys(pool).length - unsold.length;

  // Manual override: pick best-of-tier
  if (options.forceTier) {
    const candidates = unsold.filter(p => tier(p) === options.forceTier);
    if (candidates.length) {
      // Pick the highest-rated within tier, break ties randomly
      const top = Math.max(...candidates.map(p => p.overall));
      const best = candidates.filter(p => p.overall === top);
      return best[Math.floor(Math.random() * best.length)];
    }
    // Fall through to normal pacing if no candidates
  }

  // OPENER: round 1 is always a marquee (if any exist)
  if (sold === 0) {
    const marquees = unsold.filter(p => tier(p) === 'marquee');
    if (marquees.length) {
      return marquees[Math.floor(Math.random() * marquees.length)];
    }
  }

  // ENDGAME: with ≤3 slots left, force any remaining marquee in
  const marqueesLeft = unsold.filter(p => tier(p) === 'marquee').length;
  if (slotsLeft <= 3 && marqueesLeft > 0) {
    const marquees = unsold.filter(p => tier(p) === 'marquee');
    return marquees[Math.floor(Math.random() * marquees.length)];
  }

  // Recency: how many rounds since we last saw each tier / position?
  // 99 means "never" (within our 8-round lookback)
  const recent = (history || []).slice(-8).reverse();
  const tierSeen = { marquee: 99, star: 99, mid: 99, filler: 99 };
  const posSeen = {};
  recent.forEach((h, i) => {
    const p = pool[h.playerId];
    if (!p) return;
    const t = tier(p);
    if (tierSeen[t] === 99) tierSeen[t] = i;
    if (posSeen[p.position] === undefined) posSeen[p.position] = i;
  });

  // Weight each unsold player. Designed so the average run has:
  //   - a marquee every ~10-12 rounds
  //   - a star every ~4-5 rounds
  //   - mid/filler in between, but not 4 same-position in a row
  const weightFor = (p) => {
    const t = tier(p);
    let w;
    if (t === 'marquee') {
      // Stay quiet until at least 8 rounds since last marquee, then ramp hard
      const since = tierSeen.marquee;
      w = since < 5 ? 0.05 : since < 8 ? 0.4 : Math.min(40, Math.pow(2.2, since - 7));
    } else if (t === 'star') {
      const since = tierSeen.star;
      w = since < 2 ? 0.4 : Math.min(15, Math.pow(1.8, since - 1));
    } else if (t === 'mid') {
      w = 3 + 0.4 * tierSeen.mid;
    } else {
      // filler — always available, slight boost if absent
      w = 2.2 + 0.25 * tierSeen.filler;
    }
    // Position anti-cluster
    if (posSeen[p.position] === 0) w *= 0.45;
    else if (posSeen[p.position] === 1) w *= 0.75;
    return Math.max(0.01, w);
  };

  const weighted = unsold.map(p => ({ p, w: weightFor(p) }));
  const total = weighted.reduce((s, x) => s + x.w, 0);
  let r = Math.random() * total;
  for (const x of weighted) {
    if ((r -= x.w) <= 0) return x.p;
  }
  return weighted[weighted.length - 1].p;
}

export function playerTier(p) {
  const o = (p && p.overall) || 0;
  if (o >= 87) return 'marquee';
  if (o >= 85) return 'star';
  if (o >= 83) return 'mid';
  return 'filler';
}

// Reserve-budget rule.
// max_bid = remaining_budget - (MIN_INCREMENT * slots_left_after_this_one)
// where slots_left_after_this_one = SQUAD_SIZE - players_owned - 1
export function maxBidFor(player) {
  const owned = (player.squad || []).length;
  const slotsAfterWin = Math.max(0, SQUAD_SIZE - owned - 1);
  const reserve = MIN_INCREMENT * slotsAfterWin;
  return Math.max(0, (player.budget ?? 0) - reserve);
}

// True if this person is locked out entirely (no remaining slots or zero max-bid).
export function isLockedOut(player) {
  const owned = (player.squad || []).length;
  if (owned >= SQUAD_SIZE) return true;
  return maxBidFor(player) < startingBid(0); // can't even afford minimum
}

// Validate a candidate bid amount for a given participant + current auction state.
// Returns { ok: true } or { ok: false, reason }.
export function validateBid({ player, currentBid, minNext, amount }) {
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, reason: 'Enter a valid amount.' };
  }
  if (amount % MIN_INCREMENT !== 0) {
    return { ok: false, reason: `Bid must be a multiple of ${formatMoney(MIN_INCREMENT)}.` };
  }
  if (amount < minNext) {
    return { ok: false, reason: `Must bid at least ${formatMoney(minNext)}.` };
  }
  const cap = maxBidFor(player);
  if (amount > cap) {
    return {
      ok: false,
      reason: `Max bid is ${formatMoney(cap)} — reserve for remaining squad slots.`,
    };
  }
  return { ok: true };
}

// Next minimum bid given the current bid.
export function nextMinBid(currentBid) {
  return (currentBid || 0) + MIN_INCREMENT;
}

// Position summary for a person's squad.
export function squadPositionCounts(squad) {
  const counts = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
  for (const p of (squad || [])) {
    counts[bucketFor(p.position)] = (counts[bucketFor(p.position)] || 0) + 1;
  }
  return counts;
}

// Returns array of position codes the user has zero of, IF they own >= threshold.
// Used to render persistent banners on the mobile view.
export function positionWarnings(squad, threshold = POSITION_WARN_THRESHOLD) {
  const owned = (squad || []).length;
  if (owned < threshold) return [];
  const counts = squadPositionCounts(squad);
  return ['GK', 'DEF', 'MID', 'FWD'].filter(p => (counts[p] || 0) === 0);
}

// Money formatter: 1500000 → "1.5M", 100000 → "100K".
export function formatMoney(amount) {
  const v = Number(amount) || 0;
  if (v >= 1_000_000) {
    const m = v / 1_000_000;
    return (Math.round(m * 10) / 10).toString().replace(/\.0$/, '') + 'M';
  }
  if (v >= 1_000) {
    return Math.round(v / 1_000) + 'K';
  }
  return String(v);
}

// Parse a money string like "1.5M", "500k", "2,000,000" → integer
export function parseMoney(str) {
  if (str == null) return NaN;
  const s = String(str).trim().toLowerCase().replace(/[,\s]/g, '');
  if (!s) return NaN;
  const m = s.match(/^(\d+(?:\.\d+)?)([km]?)$/);
  if (!m) return NaN;
  const num = parseFloat(m[1]);
  const suffix = m[2];
  if (suffix === 'm') return Math.round(num * 1_000_000);
  if (suffix === 'k') return Math.round(num * 1_000);
  return Math.round(num);
}

// Generate a 4-letter room code.
export function makeRoomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I, O, 0, 1
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return code;
}

export function makeBidderId() {
  return 'b_' + Math.random().toString(36).slice(2, 10);
}

// Build the player pool sized for a given bidder count.
//
//   total       = bidderCount * SQUAD_SIZE + 10
//   minimums    = { GK: n*2, DEF: n*4, MID: n*4, FWD: n*3 }
//
// Approach: take the TOP X players by overall first (so the pool is
// densely marquee/star at the top), THEN enforce category minimums by
// swapping. For any category that's under its minimum, swap in the best
// unpicked player from that category in exchange for the LOWEST-OVR
// player in the pool whose category is currently over its minimum.
// The pool never goes below top-OVR for any swap — only the floor of
// the pool shifts. No randomisation anywhere.
export function buildPoolForBidderCount(allPlayers, bidderCount) {
  const n = Math.max(1, bidderCount | 0);
  const total = n * SQUAD_SIZE + 10;
  const mins = { GK: n * 2, DEF: n * 4, MID: n * 4, FWD: n * 3 };

  const cat = (p) => {
    const key = (p?.position || '').toUpperCase().trim();
    return POSITION_BUCKETS[key] || 'MID';
  };

  const sorted = [...(allPlayers || [])].sort((a, b) => (b.overall || 0) - (a.overall || 0));
  const selected = sorted.slice(0, total);
  const selectedIds = new Set(selected.map(p => p.id));

  const countCats = (arr) => {
    const c = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
    for (const p of arr) c[cat(p)]++;
    return c;
  };

  for (const [needCat, needCount] of Object.entries(mins)) {
    let counts = countCats(selected);
    while (counts[needCat] < needCount) {
      // Best unpicked candidate from the missing category
      const candidate = sorted.find(p => cat(p) === needCat && !selectedIds.has(p.id));
      if (!candidate) break; // dataset just doesn't have enough at this position

      // Lowest-OVR player in selected from a category that's still over its
      // minimum (so removing them doesn't break a different minimum).
      let removeIdx = -1;
      for (let i = selected.length - 1; i >= 0; i--) {
        const c = cat(selected[i]);
        if (counts[c] > mins[c]) { removeIdx = i; break; }
      }
      if (removeIdx === -1) break; // can't free a slot without breaking another minimum

      const removed = selected[removeIdx];
      selected[removeIdx] = candidate;
      selectedIds.delete(removed.id);
      selectedIds.add(candidate.id);
      counts = countCats(selected);
    }
  }

  return selected.sort((a, b) => (b.overall || 0) - (a.overall || 0));
}
