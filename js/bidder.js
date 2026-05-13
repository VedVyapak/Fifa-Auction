import {
  formatMoney, parseMoney, validateBid, maxBidFor, nextMinBid,
  positionWarnings, isLockedOut, MIN_INCREMENT, SQUAD_SIZE, bucketFor,
  squadPositionCounts,
} from './auction.js';
import { watchRoom, placeBid, getRoomOnce, watchConnection } from './firebase.js';

const $ = (id) => document.getElementById(id);

const params = new URLSearchParams(location.search);
const roomCode = (params.get('room') || '').toUpperCase();
const myId = params.get('id');

if (!roomCode || !myId) {
  location.href = './join.html';
}

let room = null;
let me = null;
let tickInterval = null;

// =============================================================================
// boot
// =============================================================================

(function boot() {
  $('roomLabel').textContent = `ROOM ${roomCode}`;
  watchRoom(roomCode, onUpdate);
  watchConnection((connected) => {
    document.body.classList.toggle('offline', !connected);
    const dot = $('connDot');
    if (dot) dot.classList.toggle('offline', !connected);
  });

  $('btnHamburger').addEventListener('click', openDrawer);
  $('drawerClose').addEventListener('click', closeDrawer);
  $('drawerBackdrop').addEventListener('click', closeDrawer);
  $('btnCustomBid').addEventListener('click', onCustomBid);
  $('customBidInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') onCustomBid();
  });

  // When the tab returns to foreground (iOS Safari may have suspended the
  // websocket), force a fresh read so we don't show stale state.
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

// =============================================================================
// render
// =============================================================================

function onUpdate(data) {
  if (!data) {
    showLocked('Room not found. Please rejoin from the home screen.');
    return;
  }
  room = data;
  me = room.bidders?.[myId];
  if (!me) {
    showLocked('You\'re no longer in this room. Rejoin from the home screen.');
    return;
  }
  $('whoami').textContent = me.name?.toUpperCase() || 'YOU';
  $('balanceNum').textContent = formatMoney(me.budget);

  renderDrawer();
  renderWarnings();

  if (room.status === 'finished') {
    showLocked(`Auction finished. You ended with ${(me.squad||[]).length} players, ${formatMoney(me.budget)} left.`);
    return;
  }

  // locked out?
  if (isLockedOut(me)) {
    const owned = (me.squad||[]).length;
    if (owned >= SQUAD_SIZE) {
      showLocked(`Your squad is full (${SQUAD_SIZE}/${SQUAD_SIZE}). Watch the rest play out.`);
    } else {
      showLocked(`Your max bid is below the minimum. You're out of bidding for the rest.`);
    }
    return;
  }

  const a = room.currentAuction;
  if (!a) {
    showIdle();
    return;
  }

  const player = room.pool?.[a.playerId];
  if (!player) { showIdle(); return; }

  showLive(player, a);
}

function showLive(player, a) {
  $('idleArea').classList.add('hide');
  $('lockedArea').classList.add('hide');
  $('bidBox').classList.remove('hide');
  $('quickBids').classList.remove('hide');
  $('customBidArea').classList.remove('hide');

  // player card
  $('playerArea').innerHTML = `
    <div class="mobile-player">
      <div class="m-rating-block">
        <div class="m-rate">${player.overall || '?'}</div>
        <div class="m-pos">${player.position || ''}</div>
      </div>
      <div class="info">
        <div class="pname">${escapeHtml(player.name)}</div>
        <div class="pmeta">
          <span>${bucketFor(player.position)}</span>
          <span>·</span>
          <span>${escapeHtml(player.club || '')}</span>
        </div>
      </div>
    </div>
  `;

  // bid box
  const leadingName = a.leadingBidderName || 'no bids yet';
  const isMe = a.leadingBidderId === myId;
  $('bidBox').innerHTML = `
    <div class="current-label">Current bid</div>
    <div class="current">${formatMoney(a.currentBid)}</div>
    <div class="leading-by">
      ${isMe
        ? '<strong class="text-pitch">You\'re leading 🔥</strong>'
        : `Leading: <strong>${escapeHtml(leadingName)}</strong>`}
    </div>
    <div class="mobile-timer-bar"><div class="fill" id="timerFill"></div></div>
  `;

  // quick bids
  const minNext = nextMinBid(a.currentBid);
  const cap = maxBidFor(me);
  const increments = [100_000, 500_000, 1_000_000, 5_000_000];
  $('quickBids').innerHTML = increments.map(inc => {
    const target = a.currentBid + inc;
    const disabled = target < minNext || target > cap || a.paused || isMe;
    return `
      <button class="btn-bid" data-amount="${target}" ${disabled ? 'disabled' : ''}>
        <span class="amount">+${formatMoney(inc)}</span>
        <span class="label">${formatMoney(target)}</span>
      </button>
    `;
  }).join('');
  $('quickBids').querySelectorAll('[data-amount]').forEach(b => {
    b.addEventListener('click', () => submitBid(Number(b.dataset.amount)));
  });

  // custom bid placeholder reflects min next & cap
  $('customBidInput').placeholder = `min ${formatMoney(minNext)} · max ${formatMoney(cap)}`;
  if (a.paused) {
    $('customBidInput').disabled = true;
    $('btnCustomBid').disabled = true;
  } else {
    $('customBidInput').disabled = false;
    $('btnCustomBid').disabled = isMe;
  }
}

function showIdle() {
  $('idleArea').classList.remove('hide');
  $('lockedArea').classList.add('hide');
  $('bidBox').classList.add('hide');
  $('quickBids').classList.add('hide');
  $('customBidArea').classList.add('hide');
  $('playerArea').innerHTML = '';
}

function showLocked(msg) {
  $('idleArea').classList.add('hide');
  $('bidBox').classList.add('hide');
  $('quickBids').classList.add('hide');
  $('customBidArea').classList.add('hide');
  $('playerArea').innerHTML = '';
  $('lockedArea').classList.remove('hide');
  $('lockedReason').textContent = msg;
}

function renderWarnings() {
  const warnings = positionWarnings(me?.squad);
  const el = $('positionWarnings');
  if (warnings.length === 0) {
    el.innerHTML = '';
    return;
  }
  el.innerHTML = warnings.map(p => `
    <div class="banner warn">⚠️ You have 0 ${positionLabel(p)} — get one before the pool runs out.</div>
  `).join('');
}

function positionLabel(code) {
  return { GK: 'goalkeepers', DEF: 'defenders', MID: 'midfielders', FWD: 'forwards' }[code] || code;
}

// =============================================================================
// drawer
// =============================================================================

function openDrawer() {
  $('drawer').classList.add('open');
  $('drawerBackdrop').classList.add('open');
}
function closeDrawer() {
  $('drawer').classList.remove('open');
  $('drawerBackdrop').classList.remove('open');
}

function renderDrawer() {
  const squad = me?.squad || [];
  const spent = squad.reduce((s, p) => s + (p.price || 0), 0);
  $('drawerCount').textContent = squad.length;
  $('drawerSpent').textContent = formatMoney(spent);
  $('drawerLeft').textContent = formatMoney(me?.budget || 0);

  // mirror warnings inside drawer too
  const warnings = positionWarnings(squad);
  $('drawerWarnings').innerHTML = warnings.map(p => `
    <div class="banner warn">⚠️ 0 ${positionLabel(p)}</div>
  `).join('');

  // position counts strip
  const c = squadPositionCounts(squad);
  const cell = (label, n) => `
    <div class="pos-count ${n > 0 ? 'has' : 'zero'}">
      <div class="label">${label}</div>
      <div class="num">${n}</div>
    </div>`;
  const counts = `
    <div class="position-counts">
      ${cell('GK', c.GK)}${cell('DEF', c.DEF)}${cell('MID', c.MID)}${cell('FWD', c.FWD)}
    </div>`;

  // slots grid
  const slots = [];
  for (let i = 0; i < SQUAD_SIZE; i++) {
    const p = squad[i];
    if (p) {
      slots.push(`
        <div class="squad-slot filled">
          <span class="rate">${p.overall}</span>
          <span class="pos-tag">${p.position}</span>
          <div class="pname">${escapeHtml(p.name)}</div>
          <div class="pclub">${escapeHtml(p.club || '')}</div>
          <div class="pprice">${formatMoney(p.price)}</div>
        </div>
      `);
    } else {
      slots.push(`<div class="squad-slot empty">
        <span class="empty-circle"></span>
        <span class="slot-label">slot ${i+1}</span>
      </div>`);
    }
  }
  $('drawerSquad').innerHTML = counts + `<div class="squad-grid">${slots.join('')}</div>`;
}

// =============================================================================
// bidding
// =============================================================================

async function submitBid(amount) {
  if (!room?.currentAuction) return;
  const minNext = nextMinBid(room.currentAuction.currentBid);
  const v = validateBid({ player: me, currentBid: room.currentAuction.currentBid, minNext, amount });
  if (!v.ok) {
    showBidStatus(v.reason, true);
    return;
  }
  const expectedPlayerId = room.currentAuction.playerId;
  const res = await placeBid(roomCode, myId, me.name, amount, expectedPlayerId);
  if (!res.ok) {
    showBidStatus(res.reason || 'Bid rejected.', true);
  } else {
    showBidStatus(`Bid placed: ${formatMoney(amount)}`, false);
    haptic();
  }
}

function onCustomBid() {
  const raw = $('customBidInput').value;
  const parsed = parseMoney(raw);
  if (!Number.isFinite(parsed)) {
    showBidStatus(`Couldn't parse "${raw}". Try 1.5M, 500k, or 2000000.`, true);
    return;
  }
  submitBid(parsed);
  $('customBidInput').value = '';
}

function showBidStatus(msg, isError) {
  const el = $('bidStatus');
  el.className = isError ? 'banner danger' : 'banner good';
  el.textContent = msg;
  clearTimeout(showBidStatus._t);
  showBidStatus._t = setTimeout(() => { el.textContent = ''; el.className = ''; }, 3000);
}

function haptic() {
  if ('vibrate' in navigator) navigator.vibrate(30);
}

// =============================================================================
// timer bar tick
// =============================================================================

function startTicker() {
  if (tickInterval) clearInterval(tickInterval);
  tickInterval = setInterval(() => {
    if (!room?.currentAuction) return;
    const a = room.currentAuction;
    if (a.paused) {
      const fill = document.getElementById('timerFill');
      if (fill) fill.style.transform = 'scaleX(1)';
      return;
    }
    const total = 10_000; // BID_TIMER_SECONDS * 1000 — keep in sync
    const remaining = Math.max(0, (a.endsAt || 0) - Date.now());
    const pct = Math.max(0, Math.min(1, remaining / total));
    const fill = document.getElementById('timerFill');
    if (fill) fill.style.transform = `scaleX(${pct})`;
  }, 100);
}

// =============================================================================
// util
// =============================================================================

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;',
  }[c]));
}
