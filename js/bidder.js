// Mobile bidder — broadcast pro state machine.
//
// The single `screen` element carries a data-state attribute:
//   bidding | leading | idle | locked | finished
// CSS reacts to it to swap pill colors, timer colors, and show/hide
// the player card / bid hero / actions vs idle / locked panels.
// All five states keep their markup in the DOM at all times so the
// transitions are pure CSS — JS only flips data-state and the per-
// state fields (player meta, current bid, etc).

import {
  formatMoney, parseMoney, validateBid, maxBidFor, nextMinBid,
  positionWarnings, isLockedOut, MIN_INCREMENT, SQUAD_SIZE, BID_TIMER_SECONDS,
  squadPositionCounts,
} from './auction.js';
import { watchRoom, placeBid, getRoomOnce, watchConnection, finalizeAuction, serverNow } from './firebase.js';

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Formations + position math
// ---------------------------------------------------------------------------

const POS_CATEGORY = {
  GK: 'GK',
  CB: 'DEF', LB: 'DEF', RB: 'DEF', LWB: 'DEF', RWB: 'DEF',
  CDM: 'MID', CM: 'MID', CAM: 'MID', LM: 'MID', RM: 'MID',
  ST: 'FWD', CF: 'FWD', LW: 'FWD', RW: 'FWD',
};
const posCat = (p) => POS_CATEGORY[(p || '').toUpperCase()] || 'MID';

const FORMATIONS = {
  '4-3-3': [
    { x: 50, y: 92, role: 'GK' },
    { x: 12, y: 73, role: 'LB' }, { x: 36, y: 76, role: 'CB' }, { x: 64, y: 76, role: 'CB' }, { x: 88, y: 73, role: 'RB' },
    { x: 25, y: 52, role: 'CM' }, { x: 50, y: 56, role: 'CDM' }, { x: 75, y: 52, role: 'CM' },
    { x: 18, y: 20, role: 'LW' }, { x: 50, y: 14, role: 'ST' }, { x: 82, y: 20, role: 'RW' },
  ],
  '4-4-2': [
    { x: 50, y: 92, role: 'GK' },
    { x: 12, y: 73, role: 'LB' }, { x: 36, y: 76, role: 'CB' }, { x: 64, y: 76, role: 'CB' }, { x: 88, y: 73, role: 'RB' },
    { x: 12, y: 46, role: 'LM' }, { x: 36, y: 48, role: 'CM' }, { x: 64, y: 48, role: 'CM' }, { x: 88, y: 46, role: 'RM' },
    { x: 36, y: 16, role: 'ST' }, { x: 64, y: 16, role: 'ST' },
  ],
  '4-2-3-1': [
    { x: 50, y: 92, role: 'GK' },
    { x: 12, y: 73, role: 'LB' }, { x: 36, y: 76, role: 'CB' }, { x: 64, y: 76, role: 'CB' }, { x: 88, y: 73, role: 'RB' },
    { x: 35, y: 56, role: 'CDM' }, { x: 65, y: 56, role: 'CDM' },
    { x: 18, y: 32, role: 'LW' }, { x: 50, y: 34, role: 'CAM' }, { x: 82, y: 32, role: 'RW' },
    { x: 50, y: 12, role: 'ST' },
  ],
  '3-2-4-1': [
    { x: 50, y: 92, role: 'GK' },
    { x: 22, y: 75, role: 'CB' }, { x: 50, y: 78, role: 'CB' }, { x: 78, y: 75, role: 'CB' },
    { x: 35, y: 56, role: 'CDM' }, { x: 65, y: 56, role: 'CDM' },
    { x: 12, y: 32, role: 'LW' }, { x: 38, y: 34, role: 'CAM' }, { x: 62, y: 34, role: 'CAM' }, { x: 88, y: 32, role: 'RW' },
    { x: 50, y: 12, role: 'ST' },
  ],
};

const NATION_CODES = {
  'England': 'ENG', 'France': 'FRA', 'Germany': 'GER', 'Spain': 'ESP',
  'Portugal': 'POR', 'Italy': 'ITA', 'Netherlands': 'NED', 'Belgium': 'BEL',
  'Argentina': 'ARG', 'Brazil': 'BRA', 'Norway': 'NOR', 'Egypt': 'EGY',
  'Croatia': 'CRO', 'Poland': 'POL', 'Denmark': 'DEN', 'Sweden': 'SWE',
  'Switzerland': 'SUI', 'Uruguay': 'URU', 'Colombia': 'COL',
  'Korea Republic': 'KOR', 'Japan': 'JPN', 'Australia': 'AUS',
  'Serbia': 'SRB', 'Türkiye': 'TUR', 'Cameroon': 'CMR',
  'Republic of Ireland': 'IRL', 'Algeria': 'ALG', 'Ecuador': 'ECU',
};
const nationCode = (n) => NATION_CODES[n] || (n ? n.slice(0, 3).toUpperCase() : '—');

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const params = new URLSearchParams(location.search);
const roomCode = (params.get('room') || '').toUpperCase();
const myId = params.get('id');

if (!roomCode || !myId) {
  location.href = './join.html';
}

let room = null;
let me = null;
let tickInterval = null;
let rescueInFlight = false;
let drawerFormation = '4-3-3';
let drawerActiveTab = 'list';
let bidsForCurrent = 0;       // count of bids on the current auction
let prevAuctionPlayerId = null;
let currentLeaderAtKey = null; // detect new bids
let lastBidAt = 0;

// === Bid submission state ===
// pendingBid: { amount, playerId } while a placeBid call is in flight.
// While pending, the bid hero shows a "submitting…" overlay and the bid
// buttons are disabled. Set to null on response.
let pendingBid = null;
// rejectedBid: persistent banner state — { amount, reason, playerId }.
// Stays visible until currentAuction.playerId changes (new auction
// starts) or the user dismisses it.
let rejectedBid = null;
// Live connection state from .info/connected. When false, all bid
// controls are disabled — clicking Bid into a dead socket is the
// single biggest cause of phantom-lead UIs.
let isConnected = true;

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

(function boot() {
  $('roomLabel').textContent = `Room ${roomCode}`;
  watchRoom(roomCode, onUpdate);
  watchConnection((connected) => {
    isConnected = connected;
    document.body.classList.toggle('offline', !connected);
    const dot = $('connDot');
    if (dot) dot.classList.toggle('offline', !connected);
    // Re-apply button disabled state when connection changes
    if (room?.currentAuction) {
      const isMe = room.currentAuction.leadingBidderId === myId;
      renderQuickBids(room.currentAuction, isMe);
    }
  });

  $('btnOpenDrawer').addEventListener('click', openDrawer);
  $('btnCloseDrawer').addEventListener('click', closeDrawer);
  $('drawerBackdrop').addEventListener('click', closeDrawer);

  $('btnCustomBid').addEventListener('click', onCustomBid);
  $('customBidInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') onCustomBid();
  });
  document.querySelectorAll('.bp-qb').forEach(b => {
    b.addEventListener('click', () => {
      const delta = Number(b.dataset.delta);
      const a = room?.currentAuction;
      if (!a) return;
      submitBid((a.currentBid || 0) + delta);
    });
  });

  document.querySelectorAll('#drawerTabs button').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#drawerTabs button').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.dpanel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      drawerActiveTab = btn.dataset.dtab;
      document.querySelector(`.dpanel[data-dtab="${drawerActiveTab}"]`)?.classList.add('active');
      if (btn.dataset.fmt) {
        drawerFormation = btn.dataset.fmt;
        renderPitch();
      } else if (drawerActiveTab === 'formation') {
        renderPitch();
      }
    });
  });

  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible') {
      try {
        const fresh = await getRoomOnce(roomCode);
        if (fresh) onUpdate(fresh);
      } catch (e) { console.warn('visibility refresh failed', e); }
    }
  });

  startTicker();
})();

// ---------------------------------------------------------------------------
// Update + state machine
// ---------------------------------------------------------------------------

function onUpdate(data) {
  if (!data) { setState('locked', 'Room not found. Please rejoin from the home screen.'); return; }
  room = data;
  me = room.bidders?.[myId];
  if (!me) { setState('locked', 'You\'re no longer in this room. Rejoin from the home screen.'); return; }

  $('bidderName').textContent = (me.name || 'YOU').toUpperCase();
  $('budgetNum').textContent = formatMoney(me.budget);

  renderDrawer();

  // bid count tracking (decorative — used for "N bids" meta)
  const a = room.currentAuction;
  if (a) {
    if (a.playerId !== prevAuctionPlayerId) {
      bidsForCurrent = 0;
      currentLeaderAtKey = null;
      lastBidAt = 0;
      prevAuctionPlayerId = a.playerId;
      // New auction → drop any stale rejection banner from the prior round
      if (rejectedBid && rejectedBid.playerId !== a.playerId) {
        rejectedBid = null;
        renderRejectionBanner();
      }
      // Also drop pending state if the previous auction ended before
      // placeBid could resolve (shouldn't happen but defensive).
      if (pendingBid && pendingBid.playerId !== a.playerId) {
        pendingBid = null;
        renderPendingOverlay();
      }
    }
    const key = `${a.leadingBidderId || ''}@${a.currentBid || 0}`;
    if (a.leadingBidderId && a.currentBid > 0 && key !== currentLeaderAtKey) {
      bidsForCurrent++;
      currentLeaderAtKey = key;
      lastBidAt = serverNow();
    }
  } else if (prevAuctionPlayerId) {
    prevAuctionPlayerId = null;
  }

  // determine state
  if (room.status === 'finished') {
    const playerCount = (me.squad || []).length;
    setState('finished', `Auction finished. You ended with ${playerCount} player${playerCount === 1 ? '' : 's'}, ${formatMoney(me.budget)} left.`);
    return;
  }
  if (isLockedOut(me)) {
    const owned = (me.squad || []).length;
    if (owned >= SQUAD_SIZE) {
      setState('locked', `Your squad is full (${SQUAD_SIZE}/${SQUAD_SIZE}). Watch the rest play out.`);
    } else {
      setState('locked', `Your max bid is below the minimum. You're out for the rest.`);
    }
    return;
  }
  if (!a) { setState('idle'); return; }
  const player = room.pool?.[a.playerId];
  if (!player) { setState('idle'); return; }

  const isMe = a.leadingBidderId === myId;
  setState(isMe ? 'leading' : 'bidding');
  renderPlayerCard(player);
  renderBidHero(a, isMe);
  renderQuickBids(a, isMe);
  renderWarning();
}

function setState(state, reason) {
  $('screen').dataset.state = state;
  if (state === 'locked' || state === 'finished') {
    $('lockedReason').textContent = reason || '';
  }
}

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

function renderPlayerCard(player) {
  const nameParts = (player.name || '').trim().split(/\s+/);
  const first = nameParts.length > 1 ? nameParts[0] : '';
  const last = nameParts.length > 1 ? nameParts.slice(1).join(' ') : (nameParts[0] || '?');
  $('playerFirst').textContent = first;
  $('playerLast').textContent = last;

  const photo = $('playerPhoto');
  if (player.photo) {
    photo.src = player.photo;
    photo.style.display = '';
  } else {
    photo.removeAttribute('src');
    photo.style.display = 'none';
  }

  const meta = [
    `<span class="chip star">★ ${player.overall} OVR</span>`,
    `<span class="chip">${escapeHtml(player.position || '')}</span>`,
  ];
  if (player.club) {
    meta.push(`<span class="chip">${player.clubImage ? `<img src="${player.clubImage}" alt="" />` : ''}${escapeHtml(player.club)}</span>`);
  }
  if (player.nation) {
    meta.push(`<span class="chip">${player.nationImage ? `<img src="${player.nationImage}" alt="" />` : ''}${escapeHtml(nationCode(player.nation))}</span>`);
  }
  $('playerMeta').innerHTML = meta.join('');

  const stats = player.stats || {};
  const statKeys = ['pac', 'sho', 'pas', 'dri', 'def', 'phy'];
  const hasStats = statKeys.some(k => stats[k] != null);
  $('playerStats').innerHTML = hasStats
    ? statKeys.map(k => `<div class="s"><div class="v">${stats[k] ?? '—'}</div><div class="k">${k.toUpperCase()}</div></div>`).join('')
    : '';
}

function renderBidHero(a, isMe) {
  $('bidAmount').textContent = formatMoney(a.currentBid);
  const flag = $('leaderFlag');
  if (isMe) {
    flag.textContent = '▲ You are leading';
  } else if (a.leadingBidderName) {
    flag.textContent = `▲ ${a.leadingBidderName} is leading`;
  } else {
    flag.textContent = '▲ Open · awaiting first bid';
  }
  const sec = Math.max(0, Math.ceil((a.endsAt - serverNow()) / 1000));
  $('timerNum').textContent = formatTime(sec);
  $('bidCount').textContent = `${bidsForCurrent} bid${bidsForCurrent === 1 ? '' : 's'}`;
  $('bidAgo').textContent = lastBidAt ? bidTimeAgo(lastBidAt) : 'just opened';

  // Pending bid overlay — shows "submitting X.XM…" while waiting for the
  // server. With applyLocally:false, the bid hero won't show the optimistic
  // state, so this overlay is the only visual confirmation that the bid
  // was sent. Clears as soon as placeBid resolves.
  renderPendingOverlay();
  renderRejectionBanner();
}

function renderPendingOverlay() {
  let overlay = document.getElementById('bidPendingOverlay');
  if (pendingBid) {
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'bidPendingOverlay';
      overlay.className = 'bp-bid-pending';
      $('bidHero').appendChild(overlay);
    }
    overlay.textContent = `Submitting ${formatMoney(pendingBid.amount)}…`;
  } else if (overlay) {
    overlay.remove();
  }
}

function renderRejectionBanner() {
  let banner = document.getElementById('bidRejectBanner');
  if (rejectedBid) {
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'bidRejectBanner';
      banner.className = 'bp-bid-reject';
      $('bidHero').appendChild(banner);
    }
    banner.innerHTML = `
      <div class="head">
        <span class="ico">●</span>
        <span class="title">Bid did not register</span>
        <button class="dismiss" id="dismissReject" aria-label="Dismiss">✕</button>
      </div>
      <div class="amt">${formatMoney(rejectedBid.amount)}</div>
      <div class="reason">${escapeHtml(rejectedBid.reason)}</div>
    `;
    document.getElementById('dismissReject')?.addEventListener('click', () => {
      rejectedBid = null;
      renderRejectionBanner();
    });
  } else if (banner) {
    banner.remove();
  }
}

function renderQuickBids(a, isMe) {
  const minNext = nextMinBid(a.currentBid);
  const cap = maxBidFor(me);
  $('minNextBid').textContent = formatMoney(minNext);

  // Any of these conditions disables ALL bid controls
  const lockedOutByConn = !isConnected;
  const lockedOutByPending = !!pendingBid;

  document.querySelectorAll('.bp-qb').forEach(b => {
    const delta = Number(b.dataset.delta);
    const target = (a.currentBid || 0) + delta;
    b.textContent = `+${formatMoney(delta)}`;
    b.disabled =
      target < minNext || target > cap ||
      a.paused || isMe ||
      lockedOutByConn || lockedOutByPending;
  });

  $('customBidInput').placeholder = lockedOutByConn
    ? 'reconnecting…'
    : `min ${formatMoney(minNext)} · max ${formatMoney(cap)}`;
  $('customBidInput').disabled = !!a.paused || lockedOutByConn || lockedOutByPending;
  $('btnCustomBid').disabled = !!a.paused || isMe || lockedOutByConn || lockedOutByPending;
}

function renderWarning() {
  const warnings = positionWarnings(me?.squad);
  const wrap = $('warning');
  if (!warnings.length) { wrap.classList.add('hide'); return; }
  const labels = { GK: 'You haven\'t bought a GK yet', DEF: 'No defenders yet', MID: 'No midfielders yet', FWD: 'No forwards yet' };
  $('warningText').textContent = labels[warnings[0]] || '';
  wrap.classList.remove('hide');
}

function renderDrawer() {
  const squad = me?.squad || [];
  const spent = squad.reduce((s, p) => s + (p.price || 0), 0);
  $('dPlayers').textContent = squad.length;
  $('dSpent').textContent = formatMoney(spent);
  $('dLeft').textContent = formatMoney(me?.budget || 0);
  const c = squadPositionCounts(squad);
  $('dGK').textContent = c.GK;
  $('dDEF').textContent = c.DEF;
  $('dMID').textContent = c.MID;
  $('dFWD').textContent = c.FWD;

  // list
  const order = { GK: 0, DEF: 1, MID: 2, FWD: 3 };
  const sorted = [...squad].sort((a, b) => {
    const ca = order[posCat(a.position)], cb = order[posCat(b.position)];
    if (ca !== cb) return ca - cb;
    return (b.overall || 0) - (a.overall || 0);
  });
  $('squadList').innerHTML = sorted.length === 0
    ? `<div class="bp-empty-state">Nothing yet</div>`
    : sorted.map(p => `
        <div class="item ${posCat(p.position).toLowerCase()}">
          <div class="o">${p.overall || '—'}</div>
          <div>
            <div class="nm">${escapeHtml(p.name || '?')}</div>
            <div class="mt">${escapeHtml(p.position || '')} · ${escapeHtml(p.club || '')}</div>
          </div>
          <div class="p">${formatMoney(p.price)}</div>
        </div>
      `).join('');

  if (drawerActiveTab === 'formation') renderPitch();
}

function renderPitch() {
  const pitch = $('mobilePitch');
  if (!pitch) return;
  pitch.querySelectorAll('.bp-pitch-player').forEach(n => n.remove());
  const slots = FORMATIONS[drawerFormation];
  const squad = me?.squad || [];
  const players = [...squad];
  const assignments = new Array(slots.length).fill(null);
  const usedPlayers = new Set();

  // Pass 1: exact role match across all slots — prevents an ST being
  // placed at LW just because LW appears earlier in the slot list.
  slots.forEach((slot, slotIdx) => {
    if (assignments[slotIdx]) return;
    const pIdx = players.findIndex((p, idx) =>
      !usedPlayers.has(idx) && (p.position || '').toUpperCase() === slot.role
    );
    if (pIdx > -1) { assignments[slotIdx] = players[pIdx]; usedPlayers.add(pIdx); }
  });
  // Pass 2: category fallback for any remaining slot.
  slots.forEach((slot, slotIdx) => {
    if (assignments[slotIdx]) return;
    const cat = posCat(slot.role);
    const pIdx = players.findIndex((p, idx) =>
      !usedPlayers.has(idx) && posCat(p.position) === cat
    );
    if (pIdx > -1) { assignments[slotIdx] = players[pIdx]; usedPlayers.add(pIdx); }
  });

  slots.forEach((slot, slotIdx) => {
    const p = assignments[slotIdx];
    const short = p ? (p.name || '').split(' ').pop() : slot.role;
    const el = document.createElement('div');
    el.className = 'bp-pitch-player' + (p ? '' : ' empty');
    el.style.left = slot.x + '%';
    el.style.top = slot.y + '%';
    el.innerHTML = `
      <div class="badge">${p ? p.overall : '—'}</div>
      <div class="name-tag">${escapeHtml(short)}</div>
      <div class="pos-tag">${slot.role}</div>
    `;
    pitch.appendChild(el);
  });
}

function openDrawer() { $('drawer').classList.add('open'); $('drawerBackdrop').classList.add('open'); }
function closeDrawer() { $('drawer').classList.remove('open'); $('drawerBackdrop').classList.remove('open'); }

// ---------------------------------------------------------------------------
// Bidding
// ---------------------------------------------------------------------------

async function submitBid(amount) {
  if (!room?.currentAuction) return;
  if (!isConnected) {
    setRejectedBid(amount, 'Offline — bid not sent. Reconnect and try again.');
    return;
  }
  if (pendingBid) return; // already submitting, prevent double-tap
  const a = room.currentAuction;
  const minNext = nextMinBid(a.currentBid);
  const v = validateBid({ player: me, currentBid: a.currentBid, minNext, amount });
  if (!v.ok) {
    setRejectedBid(amount, v.reason);
    return;
  }

  // Mark pending — disables buttons, shows the "submitting…" overlay
  pendingBid = { amount, playerId: a.playerId };
  rejectedBid = null;        // clear any prior rejection
  renderPendingOverlay();
  renderRejectionBanner();
  const isMe = a.leadingBidderId === myId;
  renderQuickBids(a, isMe);

  let res;
  try {
    res = await placeBid(roomCode, myId, me.name, amount, a.playerId);
  } catch (e) {
    res = { ok: false, reason: `Network error — ${e?.message || e}` };
  }

  pendingBid = null;
  renderPendingOverlay();

  if (res.ok) {
    haptic();
    // No success banner — when applyLocally:false fires watchRoom with the
    // confirmed server state, the bid hero will update to "you are leading"
    // naturally. That visible flip is the success signal.
  } else {
    setRejectedBid(amount, res.reason || 'Bid rejected.');
  }

  // Restore button state
  if (room?.currentAuction) {
    const stillMe = room.currentAuction.leadingBidderId === myId;
    renderQuickBids(room.currentAuction, stillMe);
  }
}

function setRejectedBid(amount, reason) {
  rejectedBid = {
    amount,
    reason,
    playerId: room?.currentAuction?.playerId,
  };
  renderRejectionBanner();
}

function onCustomBid() {
  const raw = $('customBidInput').value;
  const parsed = parseMoney(raw);
  if (!Number.isFinite(parsed)) {
    setRejectedBid(0, `Couldn't parse "${raw}". Try 1.5M, 500k, or 2000000.`);
    return;
  }
  submitBid(parsed);
  $('customBidInput').value = '';
}

function haptic() { if ('vibrate' in navigator) navigator.vibrate(30); }

// ---------------------------------------------------------------------------
// Timer bar + rescue tick
// ---------------------------------------------------------------------------

function startTicker() {
  if (tickInterval) clearInterval(tickInterval);
  tickInterval = setInterval(() => {
    const a = room?.currentAuction;
    if (!a) return;
    const fill = $('timerFill');
    if (a.paused) {
      if (fill) fill.style.transform = 'scaleX(1)';
      return;
    }
    const total = BID_TIMER_SECONDS * 1000;
    const now = serverNow();
    const remaining = Math.max(0, (a.endsAt || 0) - now);
    const pct = Math.max(0, Math.min(1, remaining / total));
    if (fill) fill.style.transform = `scaleX(${pct})`;
    const sec = Math.ceil(remaining / 1000);
    $('timerNum').textContent = formatTime(sec);

    // Rescue: if the auction is stuck >5s past buzzer (well past
    // FINALIZE_DELAY_MS of 2s), this bidder offers to finalize.
    // finalizeAuction is atomic — racing clients gracefully back off.
    // Only matters if the host's tab has died.
    if (!rescueInFlight && remaining <= 0 && now > (a.endsAt || 0) + 5000) {
      rescueInFlight = true;
      finalizeAuction(roomCode)
        .then(res => { if (res) console.warn('[bidder] rescued stuck auction', res); })
        .catch(e => console.error('[bidder] rescue failed', e))
        .finally(() => { rescueInFlight = false; });
    }
  }, 100);
}

function formatTime(totalSec) {
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function bidTimeAgo(ts) {
  const s = Math.max(0, Math.round((serverNow() - ts) / 1000));
  if (s < 1) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s ago`;
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;',
  }[c]));
}
