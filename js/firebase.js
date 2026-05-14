// Firebase Realtime DB layer.
// Imports the v10 modular SDK from Google's CDN.

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getDatabase,
  ref,
  set,
  update,
  get,
  onValue,
  onDisconnect,
  push,
  runTransaction,
  serverTimestamp,
  remove,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js';

import { firebaseConfig } from '../firebase-config.js';
import { STARTING_BUDGET, SQUAD_SIZE, MIN_INCREMENT, nextMinBid, BID_TIMER_SECONDS } from './auction.js';

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

export function roomRef(roomCode) { return ref(db, `rooms/${roomCode}`); }
export function bidderRef(roomCode, bidderId) { return ref(db, `rooms/${roomCode}/bidders/${bidderId}`); }

// ---------------------------------------------------------------------------
// Server-authoritative time
// ---------------------------------------------------------------------------
// Firebase RTDB exposes its server-clock offset at /.info/serverTimeOffset.
// All timing checks (bid grace, finalize trigger, endsAt) should use
// serverNow() instead of Date.now() so clients with skewed clocks agree
// on when the buzzer fires. Otherwise a laptop with a 500ms-fast clock
// thinks the buzzer hit before bidders' laptops do.

let _serverOffset = 0;
onValue(ref(db, '.info/serverTimeOffset'), (snap) => {
  _serverOffset = Number(snap.val()) || 0;
});
export function serverNow() { return Date.now() + _serverOffset; }
export function serverOffset() { return _serverOffset; }

// ---------------------------------------------------------------------------
// Room lifecycle
// ---------------------------------------------------------------------------

export async function createRoom(roomCode, players) {
  const initial = {
    code: roomCode,
    status: 'lobby', // lobby | live | paused | finished
    createdAt: serverTimestamp(),
    pool: players.reduce((acc, p) => {
      acc[p.id] = { ...p, sold: false };
      return acc;
    }, {}),
    bidders: {},
    currentAuction: null,
    history: [],
  };
  await set(roomRef(roomCode), initial);
}

export async function deleteRoom(roomCode) {
  await remove(roomRef(roomCode));
}

// Rebuild the room's player pool from a fresh players.json list.
//
// Keeps every "in use" player from the old pool — anyone who has been
// sold, marked unsold, or is the current auction's player — so history,
// recap, and bidder squad references stay intact.
//
// For everyone else (unsold-and-not-yet-auctioned entries), the old
// entries are dropped and replaced with whatever the new list contains.
// New IDs are added with sold:false. Returns { before, after, added,
// removed, preserved } so the host can confirm what happened.
export async function rebuildPool(roomCode, newPlayers) {
  const r = roomRef(roomCode);
  const snap = await get(r);
  const room = snap.val();
  if (!room) throw new Error('Room not found');

  const oldPool = room.pool || {};
  const history = room.history || [];
  const currentAuction = room.currentAuction;

  // Collect IDs that must NOT be touched (history references would break)
  const inUse = new Set();
  for (const h of history) if (h.playerId) inUse.add(h.playerId);
  if (currentAuction?.playerId) inUse.add(currentAuction.playerId);
  for (const [id, p] of Object.entries(oldPool)) {
    if (p && p.sold) inUse.add(id); // sold or unsold, both are non-falsy
  }

  const newPool = {};
  let preserved = 0;
  for (const id of inUse) {
    if (oldPool[id]) { newPool[id] = oldPool[id]; preserved++; }
  }
  let added = 0;
  for (const p of (newPlayers || [])) {
    if (!p?.id) continue;
    if (!newPool[p.id]) {
      newPool[p.id] = { ...p, sold: false };
      if (!oldPool[p.id]) added++;
    }
  }
  let removed = 0;
  for (const id of Object.keys(oldPool)) {
    if (!newPool[id]) removed++;
  }

  await update(r, { pool: newPool });
  return {
    before: Object.keys(oldPool).length,
    after: Object.keys(newPool).length,
    added,
    removed,
    preserved,
  };
}

export function watchRoom(roomCode, cb) {
  return onValue(roomRef(roomCode), snap => cb(snap.val()));
}

// Subscribe to Firebase's built-in connection state. Useful as a "you're
// disconnected" indicator on mobile — Safari likes to suspend WebSockets when
// the tab goes to background.
export function watchConnection(cb) {
  return onValue(ref(db, '.info/connected'), snap => cb(snap.val() === true));
}

export async function getRoomOnce(roomCode) {
  const snap = await get(roomRef(roomCode));
  return snap.val();
}

// ---------------------------------------------------------------------------
// Joining
// ---------------------------------------------------------------------------

export async function joinRoom(roomCode, bidderId, name) {
  const r = bidderRef(roomCode, bidderId);
  // Rejoin must preserve squad + budget. Transaction so first-join initializes
  // fresh, but if a bidder already exists (tab was reopened) we only refresh
  // name and connection state. set() here would wipe their team.
  await runTransaction(r, (existing) => {
    if (existing) {
      existing.name = name;
      existing.connected = true;
      return existing;
    }
    return {
      id: bidderId,
      name,
      budget: STARTING_BUDGET,
      squad: [],
      joinedAt: serverTimestamp(),
      connected: true,
    };
  });
  // mark disconnected on tab close
  onDisconnect(ref(db, `rooms/${roomCode}/bidders/${bidderId}/connected`)).set(false);
}

export async function setStatus(roomCode, status) {
  await update(roomRef(roomCode), { status });
}

// ---------------------------------------------------------------------------
// Auction control (host)
// ---------------------------------------------------------------------------

export async function startAuctionForPlayer(roomCode, player, startingBid) {
  const endsAt = serverNow() + BID_TIMER_SECONDS * 1000;
  const auction = {
    playerId: player.id,
    startingBid,
    currentBid: startingBid,
    leadingBidderId: null,
    leadingBidderName: null,
    endsAt,
    paused: false,
  };
  await update(roomRef(roomCode), {
    currentAuction: auction,
    status: 'live',
  });
}

export async function pauseAuction(roomCode, paused) {
  const roomSnap = await get(roomRef(roomCode));
  const room = roomSnap.val();
  if (!room?.currentAuction) return;
  // when un-pausing, reset the timer to a full BID_TIMER_SECONDS
  const updates = { 'currentAuction/paused': paused };
  if (!paused) {
    updates['currentAuction/endsAt'] = serverNow() + BID_TIMER_SECONDS * 1000;
  }
  await update(roomRef(roomCode), updates);
}

export async function skipCurrentPlayer(roomCode) {
  await update(roomRef(roomCode), { currentAuction: null });
}

// Maximum seconds we'll trust a finalizing claim before another client can
// "rescue" the auction. Covers the case where the host's tab dies between
// claim and award — otherwise the auction would be frozen forever.
const FINALIZE_CLAIM_TTL_MS = 6000;

// Grace window past the visible buzzer for late bids to land. Widened
// from 300ms to 1500ms after a real-world race where a network-delayed
// bid was rejected even though the bidder clicked well before zero.
// Host's finalize trigger waits +2000ms (host.js startTicker) to ensure
// finalize never claims the auction inside this window.
export const BID_GRACE_MS = 1500;
export const FINALIZE_DELAY_MS = 2000;

// Atomically finalize the current auction.
// Step 1: claim it via transaction. Aborts if:
//   - no auction (already cleared)
//   - someone else already claimed it AND their claim is still fresh
//   - timer hasn't actually expired
//   - a late bid just reset endsAt into the future
// Step 2: read room data and award the player.
// Bids racing with finalize get rejected (see placeBid's `finalizing` check)
// OR cause the claim to abort (if they reset endsAt). Net effect: no lost bids.
//
// Recovery: if a previous finalizer crashed mid-flight, their claim's
// timestamp goes stale and a later caller can re-claim. Safe because the
// award update is idempotent on the auction state.
export async function finalizeAuction(roomCode) {
  const r = roomRef(roomCode);
  const auctionRef = ref(db, `rooms/${roomCode}/currentAuction`);

  // Atomic claim
  let claimed = null;
  let rescued = false;
  const txn = await runTransaction(auctionRef, (auction) => {
    if (!auction) return; // already cleared
    if (auction.paused) return;
    if (serverNow() < (auction.endsAt || 0)) return;
    // Already being finalized?
    if (auction.finalizing) {
      const at = (typeof auction.finalizing === 'object' && auction.finalizing.at) || 0;
      const age = serverNow() - at;
      if (age < FINALIZE_CLAIM_TTL_MS) {
        return; // fresh claim — leave it alone
      }
      rescued = true; // stale, we take over
    }
    auction.finalizing = { at: serverNow() };
    claimed = JSON.parse(JSON.stringify(auction));
    return auction;
  });
  if (!txn.committed || !claimed) return null;
  if (rescued) {
    console.warn('[auction] rescued stale finalizing claim', { roomCode, playerId: claimed.playerId });
  }

  // We own this finalization. Read room and write awards.
  const snap = await get(r);
  const room = snap.val();
  if (!room) return null;
  const a = claimed;
  const player = room.pool?.[a.playerId];
  if (!player) {
    await update(r, { currentAuction: null });
    return null;
  }

  // If nobody bid, mark unsold and move on.
  if (!a.leadingBidderId) {
    const history = room.history || [];
    history.push({
      type: 'unsold',
      playerId: a.playerId,
      at: serverNow(),
    });
    await update(r, {
      currentAuction: null,
      history,
      [`pool/${a.playerId}/sold`]: 'unsold',
    });
    return { unsold: true, player };
  }

  const winnerId = a.leadingBidderId;
  const price = a.currentBid;
  const bidder = room.bidders?.[winnerId];
  if (!bidder) {
    await update(r, { currentAuction: null });
    return null;
  }

  const newSquad = [...(bidder.squad || []), { ...player, price }];
  const newBudget = (bidder.budget ?? STARTING_BUDGET) - price;

  const history = room.history || [];
  history.push({
    type: 'sold',
    playerId: a.playerId,
    winnerId,
    winnerName: bidder.name,
    price,
    at: serverNow(),
  });

  await update(r, {
    [`bidders/${winnerId}/budget`]: newBudget,
    [`bidders/${winnerId}/squad`]: newSquad,
    [`pool/${a.playerId}/sold`]: winnerId,
    currentAuction: null,
    history,
  });

  return { winnerId, winnerName: bidder.name, price, player };
}

// Reset every "unsold" player in the room back to fresh (sold: false) so
// they can be auctioned again. Returns the number recycled. Used when the
// fresh pool runs out but there are unsold leftovers — gives the host a
// chance to push those players through the auction again.
export async function recycleUnsoldPlayers(roomCode) {
  const r = roomRef(roomCode);
  const snap = await get(r);
  const room = snap.val();
  if (!room?.pool) return 0;
  const updates = {};
  let count = 0;
  for (const [id, p] of Object.entries(room.pool)) {
    if (p?.sold === 'unsold') {
      updates[`pool/${id}/sold`] = false;
      count++;
    }
  }
  if (count > 0) await update(r, updates);
  return count;
}

export async function undoLastSale(roomCode) {
  const r = roomRef(roomCode);
  const snap = await get(r);
  const room = snap.val();
  const history = (room?.history || []).slice();
  if (!history.length) return false;
  const last = history.pop();
  if (last.type === 'unsold') {
    await update(r, {
      history,
      [`pool/${last.playerId}/sold`]: false,
    });
    return true;
  }
  if (last.type === 'sold') {
    const bidder = room.bidders?.[last.winnerId];
    if (!bidder) return false;
    const newSquad = (bidder.squad || []).filter(p => p.id !== last.playerId);
    const newBudget = (bidder.budget ?? 0) + last.price;
    await update(r, {
      history,
      [`bidders/${last.winnerId}/budget`]: newBudget,
      [`bidders/${last.winnerId}/squad`]: newSquad,
      [`pool/${last.playerId}/sold`]: false,
    });
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Bidding (mobile)
// ---------------------------------------------------------------------------

// Transactional bid: refuses to overwrite a higher bid, refuses if the auction
// has moved to a different player since the bidder saw it. Resets timer.
//
// Critical: { applyLocally: false } — without this, the transaction
// handler's optimistic mutation is broadcast to the LOCAL watcher
// immediately, so the bidder's UI flips to "you are leading" before the
// server has confirmed (or even seen) the bid. If the bid is later
// rejected server-side (e.g. raced with finalize, conflict with another
// bidder), the rollback can be delayed or missed — leaving the bidder
// staring at a phantom win. Disabling local apply means the bidder's UI
// only updates when the server has actually committed the new state.
export async function placeBid(roomCode, bidderId, bidderName, amount, expectedPlayerId) {
  const r = ref(db, `rooms/${roomCode}/currentAuction`);
  let result = { ok: false, reason: 'unknown' };
  console.log('[bid] submit', { amount, expectedPlayerId, bidder: bidderName });
  await runTransaction(r, (auction) => {
    if (!auction) {
      result = { ok: false, reason: 'Auction already ended — too late.' };
      return;
    }
    if (expectedPlayerId && auction.playerId !== expectedPlayerId) {
      result = { ok: false, reason: 'Auction moved to a different player.' };
      return;
    }
    if (auction.finalizing) {
      result = { ok: false, reason: 'Bidding closed — finalizing sale.' };
      return;
    }
    // Wider grace past the buzzer for network jitter. The host's finalize
    // trigger waits FINALIZE_DELAY_MS (>BID_GRACE_MS) so finalize never
    // claims the auction inside this window.
    if (serverNow() > (auction.endsAt || 0) + BID_GRACE_MS) {
      result = { ok: false, reason: 'Too late — buzzer.' };
      return;
    }
    if (auction.paused) { result = { ok: false, reason: 'Auction is paused.' }; return; }
    const minNext = nextMinBid(auction.currentBid);
    if (amount < minNext) { result = { ok: false, reason: `Bid too low — min ${minNext.toLocaleString()}.` }; return; }
    if (auction.leadingBidderId === bidderId && auction.currentBid >= amount) {
      result = { ok: false, reason: 'You already lead.' }; return;
    }
    auction.currentBid = amount;
    auction.leadingBidderId = bidderId;
    auction.leadingBidderName = bidderName;
    auction.endsAt = serverNow() + BID_TIMER_SECONDS * 1000;
    result = { ok: true };
    return auction;
  }, { applyLocally: false });
  if (!result.ok) console.warn('[bid] rejected', result.reason, { amount, bidder: bidderName });
  else console.log('[bid] accepted', { amount, bidder: bidderName });
  return result;
}
