import {
  startingBid, makeRoomCode, formatMoney, bucketFor, SQUAD_SIZE, BID_TIMER_SECONDS,
  squadPositionCounts,
} from './auction.js';
import {
  createRoom, watchRoom, startAuctionForPlayer, pauseAuction,
  skipCurrentPlayer, finalizeAuction, undoLastSale, setStatus, getRoomOnce,
  watchConnection,
} from './firebase.js';

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let players = [];
let roomCode = null;
let room = null;
let unsubscribe = null;
let tickInterval = null;
let finalizingInFlight = false;
let lastSoldFlash = null;

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot() {
  try {
    const res = await fetch('./data/players.json', { cache: 'no-store' });
    if (!res.ok) throw new Error('players.json not found');
    players = await res.json();
  } catch (e) {
    console.warn('Falling back to demo players', e);
    players = makeDemoPlayers();
  }

  // restore room from URL if present
  const params = new URLSearchParams(location.search);
  const fromUrl = (params.get('room') || '').toUpperCase();
  if (fromUrl && /^[A-Z2-9]{4}$/.test(fromUrl)) {
    $('rejoinCode').value = fromUrl;
    // auto-rejoin if the room still exists in Firebase
    try {
      const existing = await getRoomOnce(fromUrl);
      if (existing) {
        enterRoom(fromUrl);
      }
    } catch (e) {
      console.warn('Auto-rejoin failed:', e);
    }
  }

  $('btnCreateRoom').addEventListener('click', onCreate);
  $('btnRejoin').addEventListener('click', onRejoin);
  $('btnStartAuction').addEventListener('click', onStartAuction);
  $('btnNextPlayer').addEventListener('click', onNextPlayer);
  $('btnPause').addEventListener('click', onPause);
  $('btnSkip').addEventListener('click', onSkip);
  $('btnUndo').addEventListener('click', onUndo);
  $('btnFinish').addEventListener('click', onFinish);
  $('btnNewAuction').addEventListener('click', () => location.href = location.pathname);
  $('btnExportAll').addEventListener('click', onExportAll);
  $('squadModalClose').addEventListener('click', closeSquadModal);
  $('squadModal').addEventListener('click', (e) => {
    if (e.target.id === 'squadModal') closeSquadModal();
  });

  watchConnection((connected) => {
    document.body.classList.toggle('offline', !connected);
  });

  $('btnShowQR').addEventListener('click', openQRModal);
  $('qrModalClose').addEventListener('click', closeQRModal);
  $('qrModal').addEventListener('click', (e) => {
    if (e.target.id === 'qrModal') closeQRModal();
  });
}

function openQRModal() {
  if (!roomCode) return;
  const joinUrl = new URL('./join.html', location.href);
  joinUrl.searchParams.set('room', roomCode);
  $('qrModalCode').textContent = roomCode;
  $('qrModalUrl').textContent = joinUrl.toString();
  renderQRInto($('qrModalSlot'), joinUrl.toString());
  const modal = $('qrModal');
  modal.classList.remove('hide');
  modal.classList.add('open');
}
function closeQRModal() {
  const modal = $('qrModal');
  modal.classList.remove('open');
  modal.classList.add('hide');
}

// ---------------------------------------------------------------------------
// Room creation / rejoin
// ---------------------------------------------------------------------------

async function onCreate() {
  setError('');
  const btn = $('btnCreateRoom');
  btn.disabled = true; btn.textContent = 'Creating…';
  try {
    const code = makeRoomCode();
    await createRoom(code, players);
    enterRoom(code);
  } catch (e) {
    console.error(e);
    setError('Couldn\'t create room. Check firebase-config.js and that Realtime Database is enabled.');
    btn.disabled = false; btn.textContent = 'Create new room';
  }
}

async function onRejoin() {
  setError('');
  const code = $('rejoinCode').value.trim().toUpperCase();
  if (!/^[A-Z2-9]{4}$/.test(code)) {
    setError('Room codes are 4 letters/numbers.');
    return;
  }
  const existing = await getRoomOnce(code);
  if (!existing) { setError('Room not found.'); return; }
  enterRoom(code);
}

function enterRoom(code) {
  roomCode = code;
  const url = new URL(location.href);
  url.searchParams.set('room', code);
  history.replaceState(null, '', url);

  $('setupScreen').classList.add('hide');
  $('lobbyScreen').classList.remove('hide');
  $('roomCodeBig').textContent = code;
  $('liveRoomCode').textContent = code;

  // QR points phones at join.html with the code embedded
  const joinUrl = new URL('./join.html', location.href);
  joinUrl.searchParams.set('room', code);
  $('joinUrlDisplay').textContent = joinUrl.toString().replace(/^https?:\/\//, '');
  renderQR(joinUrl.toString());

  unsubscribe = watchRoom(code, onRoomUpdate);
  startTicker();
}

// ---------------------------------------------------------------------------
// Realtime updates
// ---------------------------------------------------------------------------

function onRoomUpdate(data) {
  if (!data) return;
  room = data;

  // Screen routing
  const status = room.status;
  if (status === 'lobby') showLobby();
  else if (status === 'finished') showFinished();
  else if (status === 'live' || status === 'paused') showLive();

  renderAll();
}

function renderAll() {
  if (!room) return;
  renderLobby();
  renderLive();
  renderFinished();
}

function showLobby()    { swap('lobbyScreen'); }
function showLive()     { swap('liveScreen'); }
function showFinished() { swap('finishedScreen'); }
function swap(visible) {
  ['setupScreen','lobbyScreen','liveScreen','finishedScreen'].forEach(id => {
    $(id).classList.toggle('hide', id !== visible);
  });
}

// ---------------------------------------------------------------------------
// Lobby render
// ---------------------------------------------------------------------------

function renderLobby() {
  if (room.status !== 'lobby') return;
  const bidders = Object.values(room.bidders || {});
  $('bidderCount').textContent = bidders.length;
  $('lobbyBidders').innerHTML = bidders.length === 0
    ? `<div class="text-dim text-center" style="padding:32px 0;">No one yet. Share the QR.</div>`
    : bidders.map(b => bidderRowHTML(b)).join('');
  $('btnStartAuction').disabled = bidders.length < 1;
}

function bidderRowHTML(b) {
  const initial = (b.name || '?').trim().charAt(0).toUpperCase();
  const connected = b.connected ? '' : '<span class="meta-row"><span class="text-broadcast">offline</span></span>';
  return `
    <div class="player-row">
      <div class="avatar">${initial}</div>
      <div>
        <div class="name">${escapeHtml(b.name || '?')}</div>
        <div class="meta-row">
          <span>${formatMoney(b.budget)} left</span>
          <span>${(b.squad || []).length} / ${SQUAD_SIZE} players</span>
          ${connected}
        </div>
      </div>
      <div class="budget">${formatMoney(b.budget)}</div>
    </div>
  `;
}

async function onStartAuction() {
  await setStatus(roomCode, 'live');
}

// ---------------------------------------------------------------------------
// Live render
// ---------------------------------------------------------------------------

function renderLive() {
  if (!(room.status === 'live' || room.status === 'paused')) return;

  // counts
  const total = Object.keys(room.pool || {}).length;
  const sold = Object.values(room.pool || {}).filter(p => p.sold && p.sold !== false && p.sold !== 'unsold').length;
  $('livePoolCount').textContent = total;
  $('liveSoldCount').textContent = sold;

  // player + bid
  const a = room.currentAuction;
  if (a) {
    const player = room.pool[a.playerId];
    $('playerCardWrap').innerHTML = playerCardHTML(player);
    $('bidDisplayWrap').innerHTML = bidDisplayHTML(a);
  } else {
    $('playerCardWrap').innerHTML = `
      <div style="padding:64px;text-align:center;">
        <div class="eyebrow" style="margin-bottom:12px;">No active auction</div>
        <div class="display" style="font-size:56px;line-height:1;margin-bottom:8px;">
          Ready when you are.
        </div>
        <p class="text-dim">Click "Auction next player" to draw a random unsold player.</p>
      </div>`;
    $('bidDisplayWrap').innerHTML = '';
  }

  // controls
  $('btnPause').textContent = a?.paused ? 'Resume' : 'Pause';
  $('btnPause').disabled = !a;
  $('btnSkip').disabled = !a;
  $('btnNextPlayer').disabled = !!a;

  // bidders
  const bidders = Object.values(room.bidders || {})
    .sort((x, y) => (y.budget ?? 0) - (x.budget ?? 0));
  $('hostLeaderboard').innerHTML = bidders.map(b => {
    const initial = (b.name || '?').trim().charAt(0).toUpperCase();
    const isLeader = a?.leadingBidderId === b.id;
    return `
      <div class="player-row ${isLeader ? 'leading' : ''}" data-bidder="${b.id}">
        <div class="avatar">${initial}</div>
        <div>
          <div class="name">${escapeHtml(b.name)}</div>
          <div class="meta-row">
            <span>${(b.squad || []).length}/${SQUAD_SIZE} players</span>
            ${isLeader ? '<span class="text-pitch">leading</span>' : ''}
          </div>
        </div>
        <div class="budget">${formatMoney(b.budget)}</div>
      </div>`;
  }).join('');
  // wire up click to open squad
  $('hostLeaderboard').querySelectorAll('[data-bidder]').forEach(el => {
    el.addEventListener('click', () => openSquadModal(el.dataset.bidder));
  });

  // recently sold
  const recent = (room.history || []).slice(-6).reverse();
  $('recentSold').innerHTML = recent.length === 0
    ? `<div class="text-dim text-center" style="padding:16px 0;">No sales yet.</div>`
    : recent.map(h => {
        if (h.type === 'unsold') {
          const p = room.pool[h.playerId];
          return `<div class="player-row" style="border-color:var(--border);">
            <div class="avatar" style="color:var(--text-dim);">—</div>
            <div>
              <div class="name">${escapeHtml(p?.name || '?')}</div>
              <div class="meta-row"><span class="text-dim">unsold</span></div>
            </div>
            <div class="budget text-dim">—</div>
          </div>`;
        }
        const p = room.pool[h.playerId];
        return `<div class="player-row">
          <div class="avatar">${(h.winnerName||'?').charAt(0).toUpperCase()}</div>
          <div>
            <div class="name">${escapeHtml(p?.name || '?')}</div>
            <div class="meta-row">
              <span>${p?.position || ''} · ${p?.overall || ''}</span>
              <span>→ ${escapeHtml(h.winnerName)}</span>
            </div>
          </div>
          <div class="budget text-pitch">${formatMoney(h.price)}</div>
        </div>`;
      }).join('');
}

function playerCardHTML(p) {
  return `
    <div class="player-card" id="bigPlayerCard">
      <div class="rating-block">
        <div class="rating-overall">${p.overall || '?'}</div>
        <div class="rating-pos">${p.position || ''}</div>
        <div class="rating-divider"></div>
        <div class="rating-bucket">${bucketFor(p.position)}</div>
      </div>
      <div class="meta">
        <div class="eyebrow">On the block</div>
        <div class="name">${escapeHtml(p.name || '?')}</div>
        <div class="club">${escapeHtml(p.club || '')}${p.nation ? ' · ' + escapeHtml(p.nation) : ''}</div>
        <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap;">
          <span class="bc-tag" style="background:var(--panel-2);color:var(--text);border:1px solid var(--border);">Start ${formatMoney(startingBid(p.overall))}</span>
        </div>
      </div>
    </div>
  `;
}

function bidDisplayHTML(a) {
  const leader = a.leadingBidderName || 'No bids yet';
  const remainingMs = Math.max(0, (a.endsAt || 0) - Date.now());
  const remaining = Math.ceil(remainingMs / 1000);
  const urgent = remaining <= 3 && !a.paused;
  return `
    <div class="bid-display">
      <div class="leading">
        <div class="eyebrow">Leading bidder</div>
        <div class="display" style="font-size:36px;color:${a.leadingBidderId ? 'var(--pitch)' : 'var(--text-dim)'};">
          ${escapeHtml(leader)}
        </div>
      </div>
      <div>
        <div class="eyebrow text-center" style="margin-bottom:4px;">Current bid</div>
        <div class="amount" id="bidAmountDisplay">${formatMoney(a.currentBid)}</div>
      </div>
      <div class="timer">
        <div class="eyebrow">${a.paused ? 'Paused' : 'Time left'}</div>
        <div class="num ${urgent ? 'urgent' : ''}" id="bidTimerDisplay">${a.paused ? '——' : remaining}</div>
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Host actions
// ---------------------------------------------------------------------------

async function onNextPlayer() {
  if (!room) return;
  const unsold = Object.values(room.pool || {}).filter(p => !p.sold);
  if (unsold.length === 0) { alert('All players sold!'); return; }
  const pick = unsold[Math.floor(Math.random() * unsold.length)];
  await startAuctionForPlayer(roomCode, pick, startingBid(pick.overall));
}

async function onPause() {
  if (!room?.currentAuction) return;
  await pauseAuction(roomCode, !room.currentAuction.paused);
}

async function onSkip() {
  if (!confirm('Skip this player (no sale)?')) return;
  await skipCurrentPlayer(roomCode);
}

async function onUndo() {
  if (!confirm('Undo last sale? Player returns to pool, money refunded.')) return;
  const ok = await undoLastSale(roomCode);
  if (!ok) alert('Nothing to undo.');
}

async function onFinish() {
  if (!confirm('End the auction and show final squads?')) return;
  await setStatus(roomCode, 'finished');
}

// ---------------------------------------------------------------------------
// Timer tick — locally decrement the countdown; finalize when expired.
// ---------------------------------------------------------------------------

function startTicker() {
  if (tickInterval) clearInterval(tickInterval);
  tickInterval = setInterval(async () => {
    if (!room?.currentAuction) return;
    const a = room.currentAuction;
    if (a.paused) return;
    const remaining = Math.max(0, (a.endsAt || 0) - Date.now());
    const secs = Math.ceil(remaining / 1000);
    const el = document.getElementById('bidTimerDisplay');
    if (el) {
      el.textContent = secs;
      el.classList.toggle('urgent', secs <= 3);
    }
    // Wait an extra 400ms past the buzzer to give late bids room to land
    // (placeBid grants a 300ms grace). `finalizingInFlight` only prevents
    // double-call from THIS tab; finalizeAuction itself is atomic and will
    // rescue stale claims from crashed peers.
    if (remaining <= 0 && Date.now() > (a.endsAt || 0) + 400 && !finalizingInFlight) {
      finalizingInFlight = true;
      try {
        const result = await finalizeAuction(roomCode);
        if (result && !result.unsold) flashSold(result);
      } catch (e) {
        console.error('[host] finalize failed', e);
      } finally {
        finalizingInFlight = false;
      }
    }
  }, 200);
}

function flashSold(result) {
  const card = document.getElementById('bigPlayerCard');
  if (card) card.classList.add('flash');
  lastSoldFlash = result;
}

// ---------------------------------------------------------------------------
// Squad modal
// ---------------------------------------------------------------------------

function openSquadModal(bidderId) {
  const b = room.bidders?.[bidderId];
  if (!b) return;
  $('squadModalTitle').textContent = `${b.name} · ${formatMoney(b.budget)} left`;
  $('squadModalBody').innerHTML = positionCountsHTML(b.squad) + squadGridHTML(b.squad);
  const modal = $('squadModal');
  modal.classList.remove('hide');
  modal.classList.add('open');
}

function positionCountsHTML(squad) {
  const c = squadPositionCounts(squad);
  const cell = (label, count) => `
    <div class="pos-count ${count > 0 ? 'has' : 'zero'}">
      <div class="label">${label}</div>
      <div class="num">${count}</div>
    </div>`;
  return `
    <div class="position-counts">
      ${cell('GK', c.GK)}
      ${cell('DEF', c.DEF)}
      ${cell('MID', c.MID)}
      ${cell('FWD', c.FWD)}
    </div>`;
}
function closeSquadModal() {
  const modal = $('squadModal');
  modal.classList.remove('open');
  modal.classList.add('hide');
}

function squadGridHTML(squad) {
  const filled = (squad || []);
  const slots = [];
  for (let i = 0; i < SQUAD_SIZE; i++) {
    const p = filled[i];
    if (p) {
      slots.push(`
        <div class="squad-slot filled">
          <span class="rate">${p.overall}</span>
          <span class="pos-tag">${p.position}</span>
          <div class="pname">${escapeHtml(p.name)}</div>
          <div class="pclub">${escapeHtml(p.club || '')}</div>
          <div class="pprice">${formatMoney(p.price)}</div>
        </div>`);
    } else {
      slots.push(`<div class="squad-slot empty">
        <span class="empty-circle"></span>
        <span class="slot-label">slot ${i+1}</span>
      </div>`);
    }
  }
  return `<div class="squad-grid">${slots.join('')}</div>`;
}

// ---------------------------------------------------------------------------
// Finished
// ---------------------------------------------------------------------------

function renderFinished() {
  if (room.status !== 'finished') return;
  const bidders = Object.values(room.bidders || {});
  $('finalGrid').innerHTML = bidders.map(b => {
    const spent = (b.squad || []).reduce((s, p) => s + (p.price || 0), 0);
    const avg = (b.squad || []).length
      ? Math.round((b.squad.reduce((s, p) => s + (p.overall || 0), 0) / b.squad.length) * 10) / 10
      : 0;
    return `
      <div class="final-team-card" id="team-${b.id}">
        <h3>${escapeHtml(b.name)}</h3>
        <div class="stats-row">
          <span>spent ${formatMoney(spent)}</span>
          <span>left ${formatMoney(b.budget)}</span>
          <span>avg ${avg}</span>
          <span>${(b.squad||[]).length} players</span>
        </div>
        ${squadGridHTML(b.squad)}
        <div style="margin-top:12px;text-align:right;">
          <button class="btn btn-ghost" data-export="${b.id}">Save as image</button>
        </div>
      </div>
    `;
  }).join('');
  $('finalGrid').querySelectorAll('[data-export]').forEach(el => {
    el.addEventListener('click', () => exportOne(el.dataset.export));
  });
}

async function exportOne(bidderId) {
  const el = document.getElementById(`team-${bidderId}`);
  if (!el) return;
  const canvas = await html2canvas(el, { backgroundColor: '#0a0d14', scale: 2 });
  downloadCanvas(canvas, `squad-${bidderId}.png`);
}
async function onExportAll() {
  const el = $('finalGrid');
  if (!el) return;
  const canvas = await html2canvas(el, { backgroundColor: '#0a0d14', scale: 1.5 });
  downloadCanvas(canvas, `auction-${roomCode}.png`);
}
function downloadCanvas(canvas, filename) {
  const a = document.createElement('a');
  a.href = canvas.toDataURL('image/png');
  a.download = filename;
  a.click();
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function renderQR(text) { renderQRInto($('qrSlot'), text); }

function renderQRInto(slot, text) {
  if (!slot) return;
  const services = [
    (t) => `https://api.qrserver.com/v1/create-qr-code/?size=240x240&margin=4&data=${encodeURIComponent(t)}`,
    (t) => `https://quickchart.io/qr?size=240&margin=2&text=${encodeURIComponent(t)}`,
  ];
  let attempt = 0;
  const load = () => {
    if (attempt >= services.length) {
      slot.innerHTML = `<span style="font-family:var(--mono);color:#0a0d14;font-size:10px;padding:8px;text-align:center;">QR unavailable. Open<br/>${text.replace(/^https?:\/\//, '')}</span>`;
      return;
    }
    const img = new Image();
    img.width = 240; img.height = 240;
    img.style.display = 'block';
    img.style.borderRadius = '8px';
    img.alt = 'Scan to join';
    img.onload = () => {
      slot.innerHTML = '';
      slot.appendChild(img);
    };
    img.onerror = () => { attempt++; load(); };
    img.src = services[attempt](text);
  };
  load();
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;',
  }[c]));
}

function setError(msg) {
  const el = $('setupError');
  if (!msg) { el.classList.add('hide'); return; }
  el.classList.remove('hide');
  el.textContent = msg;
}

function makeDemoPlayers() {
  // small fallback so the host screen works even without scraping
  const pos = ['ST','CAM','CM','CDM','CB','LB','RB','GK','LW','RW'];
  const clubs = ['Real Madrid','Man City','Bayern','PSG','Arsenal','Inter','Liverpool'];
  return Array.from({ length: 120 }, (_, i) => ({
    id: 'demo_' + i,
    name: `Player ${i + 1}`,
    overall: 92 - Math.floor(i / 8),
    position: pos[i % pos.length],
    club: clubs[i % clubs.length],
    nation: '',
    photo: '',
  }));
}

boot();
