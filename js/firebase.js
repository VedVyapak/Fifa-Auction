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

export function watchRoom(roomCode, cb) {
  return onValue(roomRef(roomCode), snap => cb(snap.val()));
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
  await set(r, {
    id: bidderId,
    name,
    budget: STARTING_BUDGET,
    squad: [],
    joinedAt: serverTimestamp(),
    connected: true,
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
  const endsAt = Date.now() + BID_TIMER_SECONDS * 1000;
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
    updates['currentAuction/endsAt'] = Date.now() + BID_TIMER_SECONDS * 1000;
  }
  await update(roomRef(roomCode), updates);
}

export async function skipCurrentPlayer(roomCode) {
  await update(roomRef(roomCode), { currentAuction: null });
}

// finalize: award current leading bid; mutate budgets & pool.
export async function finalizeAuction(roomCode) {
  const r = roomRef(roomCode);
  const snap = await get(r);
  const room = snap.val();
  if (!room?.currentAuction) return null;
  const a = room.currentAuction;
  const player = room.pool?.[a.playerId];
  if (!player) return null;

  // If nobody bid, mark unsold and move on.
  if (!a.leadingBidderId) {
    const history = room.history || [];
    history.push({
      type: 'unsold',
      playerId: a.playerId,
      at: Date.now(),
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
  if (!bidder) return null;

  const newSquad = [...(bidder.squad || []), { ...player, price }];
  const newBudget = (bidder.budget ?? STARTING_BUDGET) - price;

  const history = room.history || [];
  history.push({
    type: 'sold',
    playerId: a.playerId,
    winnerId,
    winnerName: bidder.name,
    price,
    at: Date.now(),
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

// Transactional bid: refuses to overwrite a higher bid. Resets timer.
export async function placeBid(roomCode, bidderId, bidderName, amount) {
  const r = ref(db, `rooms/${roomCode}/currentAuction`);
  let result = { ok: false, reason: 'unknown' };
  await runTransaction(r, (auction) => {
    if (!auction) { result = { ok: false, reason: 'No active auction.' }; return; }
    if (auction.paused) { result = { ok: false, reason: 'Auction is paused.' }; return; }
    const minNext = nextMinBid(auction.currentBid);
    if (amount < minNext) { result = { ok: false, reason: 'Bid too low.' }; return; }
    if (auction.leadingBidderId === bidderId && auction.currentBid >= amount) {
      result = { ok: false, reason: 'You already lead.' }; return;
    }
    auction.currentBid = amount;
    auction.leadingBidderId = bidderId;
    auction.leadingBidderName = bidderName;
    auction.endsAt = Date.now() + BID_TIMER_SECONDS * 1000;
    result = { ok: true };
    return auction;
  });
  return result;
}
