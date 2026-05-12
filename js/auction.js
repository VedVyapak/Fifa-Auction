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
