import {
  startingBid, makeRoomCode, formatMoney, bucketFor, SQUAD_SIZE, BID_TIMER_SECONDS,
  STARTING_BUDGET, MIN_INCREMENT,
  squadPositionCounts, pickNextPlayer, playerTier, positionWarnings,
} from './auction.js';
import {
  createRoom, watchRoom, startAuctionForPlayer, pauseAuction,
  skipCurrentPlayer, finalizeAuction, undoLastSale, setStatus, getRoomOnce,
  watchConnection,
} from './firebase.js';

// ---------------------------------------------------------------------------
// Formations & position math (shared with squad modal + recap)
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

// 3-letter nation code from a full nation name. Falls back to first 3 chars.
const NATION_CODES = {
  'England': 'ENG', 'Scotland': 'SCO', 'Wales': 'WAL', 'Northern Ireland': 'NIR',
  'France': 'FRA', 'Germany': 'GER', 'Spain': 'ESP', 'Portugal': 'POR',
  'Italy': 'ITA', 'Netherlands': 'NED', 'Belgium': 'BEL', 'Argentina': 'ARG',
  'Brazil': 'BRA', 'Norway': 'NOR', 'Egypt': 'EGY', 'Croatia': 'CRO',
  'Poland': 'POL', 'Denmark': 'DEN', 'Sweden': 'SWE', 'Switzerland': 'SUI',
  'Uruguay': 'URU', 'Colombia': 'COL', 'Mexico': 'MEX', 'USA': 'USA',
  'United States': 'USA', 'Senegal': 'SEN', 'Morocco': 'MAR', 'Nigeria': 'NGA',
  'Korea Republic': 'KOR', 'South Korea': 'KOR', 'Japan': 'JPN', 'Australia': 'AUS',
  'Austria': 'AUT', 'Serbia': 'SRB', 'Türkiye': 'TUR', 'Turkey': 'TUR',
  'Ghana': 'GHA', 'Ivory Coast': 'CIV', 'Côte d’Ivoire': 'CIV',
  'Cameroon': 'CMR', 'Czech Republic': 'CZE', 'Republic of Ireland': 'IRL',
  'Slovakia': 'SVK', 'Slovenia': 'SVN', 'Algeria': 'ALG', 'Ecuador': 'ECU',
  'Canada': 'CAN', 'Russia': 'RUS', 'Ukraine': 'UKR', 'Greece': 'GRE',
  'Hungary': 'HUN', 'Romania': 'ROU', 'Bulgaria': 'BUL', 'Finland': 'FIN',
  'Iceland': 'ISL', 'Israel': 'ISR', 'Iran': 'IRN', 'Iraq': 'IRQ',
  'Saudi Arabia': 'KSA', 'Tunisia': 'TUN', 'Mali': 'MLI', 'Gabon': 'GAB',
  'Guinea': 'GUI', 'Albania': 'ALB',
};
const nationCode = (n) => NATION_CODES[n] || (n ? n.slice(0, 3).toUpperCase() : '—');

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

// view-only state (not persisted to firebase)
let activeSoldTab = 'recent';
// nextQueue: the actual next 3 players that will be auctioned. Built by
// calling pickNextPlayer with a simulated history so the preview matches
// the real pacing logic (round-1 marquee, endgame marquees, anti-cluster).
// Shuffle button rebuilds it. onNextPlayer pops the head.
let nextQueue = [];
let prevAuctionPlayerId = null;
let prevBidCount = 0;       // for "BIDDING +N%" ticker
let prevAuctionBidCount = 0;
let lastRoundBidCount = 0;  // bids in last completed auction

// per-auction bid history. Keyed by playerId; resets when currentAuction
// switches. Bid history is NOT in the firebase schema (locked) — we capture
// it client-side as Firebase pushes leadingBidder updates. Lossy in edge
// cases (two bids in the same RTDB tick will collapse) but that's fine for
// a decorative "last 5 bids" panel.
let bidHistoryByPlayer = {};

// squad modal state
let modalBidderId = null;
let modalActiveTab = 'list';
let modalFormation = '4-3-3';

// image-preload state
const preloadedUrls = new Set();
let preloadQueueRunning = false;

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot() {
  // Wire event listeners IMMEDIATELY — before any async work — so the buttons
  // are responsive even if players.json is slow to fetch or auto-rejoin
  // is awaiting Firebase. (Previously this lived after the awaits, which
  // caused "Rejoin doesn't work" on slow links — the button had no handler
  // attached yet when the user clicked.)
  wireListeners();

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
}

function wireListeners() {
  $('btnCreateRoom').addEventListener('click', onCreate);
  $('btnRejoin').addEventListener('click', onRejoin);
  $('rejoinCode').addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z2-9]/g, '');
  });
  $('rejoinCode').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') onRejoin();
  });
  $('btnStartAuction').addEventListener('click', onStartAuction);
  $('btnNextPlayer').addEventListener('click', () => onNextPlayer());
  $('btnForceMarquee').addEventListener('click', onForceMarquee);
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

  // sold-tabs switching
  document.querySelectorAll('#soldTabs button').forEach(b => {
    b.addEventListener('click', () => {
      activeSoldTab = b.dataset.soldtab;
      renderSoldTabs();
    });
  });

  // up-next reshuffle — rebuilds the actual queue (and re-warms image cache)
  $('btnShuffle').addEventListener('click', () => {
    nextQueue = buildNextQueue();
    renderUpNext();
    preloadQueueImages();
    // refresh the ticker so "NEXT · {player}" updates immediately
    if (room) renderLive();
  });

  // squad modal navigation
  $('prevBidder').addEventListener('click', () => cycleBidder(-1));
  $('nextBidder').addEventListener('click', () => cycleBidder(1));
  document.querySelectorAll('#modalTabs button').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#modalTabs button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      modalActiveTab = btn.dataset.mtab;
      if (btn.dataset.fmt) modalFormation = btn.dataset.fmt;
      switchModalPanel();
    });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('squadModal').classList.contains('hidden')) closeSquadModal();
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
  const btn = $('btnRejoin');
  const code = $('rejoinCode').value.trim().toUpperCase();
  if (!/^[A-Z2-9]{4}$/.test(code)) {
    setError('Room codes are 4 letters/numbers.');
    return;
  }
  btn.disabled = true;
  const originalLabel = btn.textContent;
  btn.textContent = 'Checking…';
  try {
    const existing = await getRoomOnce(code);
    if (!existing) {
      setError(`Room "${code}" not found. Double-check the code.`);
      return;
    }
    enterRoom(code);
  } catch (e) {
    console.error('[rejoin] failed', e);
    setError(`Could not reach Firebase. ${e?.message || e}`);
  } finally {
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
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

const MIN_BIDDERS_TO_START = 2;

function renderLobby() {
  if (room.status !== 'lobby') return;
  const bidders = Object.values(room.bidders || {}).filter(b => b.name);
  const joinedCount = bidders.length;
  $('bidderCount').textContent = joinedCount;

  // Render one seat per joined bidder, plus a single "waiting" placeholder
  // at the bottom to signal that more can still join. Seat list grows
  // naturally — no fixed cap.
  const seats = bidders.map((b, i) => {
    const offline = b.connected === false ? ' · offline' : '';
    return `
      <div class="seat joined">
        <div class="num">${i + 1}</div>
        <div class="name">${escapeHtml(b.name)}</div>
        <div class="status">Ready${offline}</div>
      </div>
    `;
  });
  seats.push(`
    <div class="seat">
      <div class="num">${joinedCount + 1}</div>
      <div class="name">Waiting for next bidder…</div>
      <div class="status">Open</div>
    </div>
  `);
  $('lobbyBidders').innerHTML = seats.join('');

  const startBtn = $('btnStartAuction');
  const canStart = joinedCount >= MIN_BIDDERS_TO_START;
  startBtn.disabled = !canStart;

  const hint = $('startHint');
  if (hint) {
    if (canStart) {
      hint.classList.add('hide');
    } else {
      const need = MIN_BIDDERS_TO_START - joinedCount;
      hint.classList.remove('hide');
      hint.textContent = `need ${need} more`;
    }
  }
}

async function onStartAuction() {
  await setStatus(roomCode, 'live');
}

// ---------------------------------------------------------------------------
// Live render
// ---------------------------------------------------------------------------

function renderLive() {
  if (!(room.status === 'live' || room.status === 'paused')) return;

  trackBidHistory();

  // current auction shorthand — used by feature card, controls, bidders
  const a = room.currentAuction;

  // chrome ticker — multiple metrics that loop horizontally
  renderTicker();

  // live pill
  $('livePill').classList.toggle('hide', room.status !== 'live');

  // feature card (player + bid)
  renderFeatureCard(a);

  // controls
  $('btnPause').textContent = a?.paused ? 'Resume' : 'Pause';
  $('btnPause').disabled = !a;
  $('btnSkip').disabled = !a;
  $('btnNextPlayer').disabled = !!a;
  $('btnForceMarquee').disabled = !!a;

  // bidders sidebar
  renderBiddersSidebar(a);

  // up-next queue — keep filled to 3 picks. Rebuild if any queued player has
  // since been sold (e.g. host force-marqueed) or if it's empty.
  const queueStale = !nextQueue.length
    || nextQueue.some(p => !room.pool[p.id] || room.pool[p.id].sold);
  if (queueStale) {
    nextQueue = buildNextQueue();
    preloadQueueImages();
  }
  renderUpNext();

  // sold tabs
  renderSoldTabs();

  // refresh squad modal if it's open
  if (modalBidderId && !$('squadModal').classList.contains('hidden')) {
    renderSquadModal();
  }
}

function renderFeatureCard(a) {
  const card = $('featureCard');
  if (!a) {
    card.className = 'bp-feature idle';
    $('playerPane').innerHTML = `
      <div style="position:relative;z-index:1;">
        <div class="bp-eyebrow" style="margin-bottom:12px;">No active auction</div>
        <div class="bp-idle-title">Ready when you are.</div>
        <div class="bp-idle-sub">Click "Auction next player" to draw a player.</div>
      </div>
    `;
    $('bidPane').innerHTML = '';
    return;
  }

  const player = room.pool[a.playerId];
  if (!player) {
    $('playerPane').innerHTML = '';
    $('bidPane').innerHTML = '';
    return;
  }

  const tier = playerTier(player);
  card.className = `bp-feature tier-${tier}`;

  // player pane
  const nameParts = (player.name || '').trim().split(/\s+/);
  const first = nameParts.length > 1 ? nameParts[0] : '';
  const last = nameParts.length > 1 ? nameParts.slice(1).join(' ') : (nameParts[0] || '?');
  const stats = player.stats || {};
  const statKeys = ['pac','sho','pas','dri','def','phy'];
  const hasStats = statKeys.some(k => stats[k] != null);
  const photoHTML = player.photo
    ? `<img class="bp-player-photo" src="${player.photo}" alt="" fetchpriority="high" decoding="async" />`
    : '';
  const clubChip = player.club
    ? `<span class="bp-meta-chip">${player.clubImage ? `<img src="${player.clubImage}" alt="" />` : ''}${escapeHtml(player.club)}</span>`
    : '';
  const nationChip = player.nation
    ? `<span class="bp-meta-chip">${player.nationImage ? `<img src="${player.nationImage}" alt="" />` : ''}${escapeHtml(nationCode(player.nation))}</span>`
    : '';
  const leadingChip = a.leadingBidderId
    ? `<div class="bp-leading-chip">▲ Leading · ${escapeHtml(a.leadingBidderName || '—')}</div>`
    : `<div class="bp-leading-chip" style="background:rgba(255,255,255,0.04);border-color:var(--line);color:var(--dim);">Awaiting first bid · Start ${formatMoney(startingBid(player.overall))}</div>`;

  $('playerPane').innerHTML = `
    ${photoHTML}
    <div class="bp-player-meta">
      <span class="bp-meta-chip star">★ ${player.overall} OVR</span>
      <span class="bp-meta-chip">${escapeHtml(player.position || '')}</span>
      ${clubChip}
      ${nationChip}
    </div>
    <div>
      <span class="bp-player-name">
        ${first ? `<span class="first">${escapeHtml(first)}</span>` : ''}
        ${escapeHtml(last)}
      </span>
      ${leadingChip}
    </div>
    ${hasStats ? `
      <div class="bp-player-stats">
        ${statKeys.map(k => `<div class="s"><div class="v">${stats[k] ?? '—'}</div><div class="k">${k.toUpperCase()}</div></div>`).join('')}
      </div>
    ` : ''}
  `;

  // bid pane
  const remainingMs = Math.max(0, (a.endsAt || 0) - Date.now());
  const remaining = Math.ceil(remainingMs / 1000);
  const urgent = !a.paused && remaining <= 5;
  const pct = Math.max(0, Math.min(100, (remainingMs / (BID_TIMER_SECONDS * 1000)) * 100));
  const bids = bidHistoryByPlayer[a.playerId] || [];
  const last5 = bids.slice(0, 5);
  const bidsLabel = `${bids.length} bid${bids.length === 1 ? '' : 's'}`;

  $('bidPane').innerHTML = `
    <div>
      <div class="bp-eyebrow" style="margin-bottom:12px;">${a.paused ? 'Paused' : 'Time remaining'}</div>
      <div class="bp-countdown ${urgent ? 'tense' : ''} ${a.paused ? 'paused' : ''}">
        <div class="num" id="bidCountdownNum">${a.paused ? '——' : String(remaining).padStart(2, '0')}</div>
        <div class="bp-timer-bar" style="flex:1;"><i id="bidTimerFill" style="width:${pct}%"></i></div>
      </div>
    </div>
    <div class="bp-bid-readout">
      <div class="label">Current bid</div>
      <div class="amount" id="bidAmountDisplay">${formatMoney(a.currentBid)}</div>
      <div class="by">${a.leadingBidderId ? '▲ ' + escapeHtml((a.leadingBidderName || '').toUpperCase()) + ' · ' + bidTimeAgo(bids[0]?.at) : 'No bids yet'}</div>
    </div>
    <div>
      <div class="bp-bids-eyebrow" style="margin-bottom: 10px;">
        ${bids.length ? '<span class="bp-bid-pulse"></span>' : ''}Bid history · <span style="color:var(--green)">${bidsLabel}</span>
      </div>
      <div class="bp-bid-history">
        ${last5.length === 0
          ? `<div class="bp-bid-row"><span class="who">—</span><span class="amt" style="color:var(--faint);">no bids yet</span><span class="ago"></span></div>`
          : last5.map((b, i) => `
              <div class="bp-bid-row ${i === 0 ? 'top' : ''}">
                <span class="who">${escapeHtml((b.name || '?').toUpperCase())}</span>
                <span class="amt">${formatMoney(b.amount)}</span>
                <span class="ago">${bidTimeAgo(b.at)}</span>
              </div>
            `).join('')}
      </div>
    </div>
  `;
}

function bidTimeAgo(ts) {
  if (!ts) return '';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 1) return 'now';
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

function renderBiddersSidebar(a) {
  const bidders = Object.values(room.bidders || {}).filter(b => b.name);
  // sort by spent desc (more "rank-like" than budget desc)
  bidders.sort((x, y) => {
    const spentX = STARTING_BUDGET - (x.budget ?? STARTING_BUDGET);
    const spentY = STARTING_BUDGET - (y.budget ?? STARTING_BUDGET);
    return spentY - spentX;
  });

  $('hostLeaderboard').innerHTML = bidders.map((b, i) => {
    const isLeader = a?.leadingBidderId === b.id;
    const squad = b.squad || [];
    const spent = STARTING_BUDGET - (b.budget ?? STARTING_BUDGET);
    const spentPct = Math.round((spent / STARTING_BUDGET) * 100);
    const squadFull = squad.length >= SQUAD_SIZE;
    const brokeForBid = (b.budget ?? 0) < MIN_INCREMENT;
    const broke = squadFull || brokeForBid;

    let barClass = '';
    if (spentPct >= 90) barClass = 'critical';
    else if (spentPct >= 70) barClass = 'high';
    else if (spentPct >= 50) barClass = 'mid';

    const warnings = positionWarnings(squad);
    let warnChip = '';
    if (isLeader) {
      warnChip = '<span class="bp-warn-chip lead">▲ LEADING</span>';
    } else if (broke) {
      warnChip = `<span class="bp-warn-chip danger">${squadFull ? '● MAXED' : '● BROKE'}</span>`;
    } else if (warnings.length) {
      const labels = { GK: 'no GK', DEF: 'no DEF', MID: 'no MID', FWD: 'no FWD' };
      warnChip = `<span class="bp-warn-chip">${labels[warnings[0]] || ''}</span>`;
    }

    return `
      <div class="bp-bidder ${isLeader ? 'leading' : ''} ${broke ? 'broke' : ''}" data-bidder="${b.id}">
        <div class="bp-rank">${i + 1}</div>
        <div>
          <div class="name">${escapeHtml((b.name || '?').toUpperCase())} ${warnChip}</div>
          <div class="row2"><span>${squad.length} players</span><span>·</span><span>spent ${formatMoney(spent)}</span></div>
          <div class="bar"><i class="${barClass}" style="width:${Math.max(spentPct, broke ? 100 : 0)}%${broke && squadFull ? ';background:var(--faint)' : ''}"></i></div>
        </div>
        <div class="budget" ${broke && (b.budget ?? 0) < 1_000_000 ? 'style="color:var(--red)"' : ''}>${formatMoney(b.budget)}<span class="sub">LEFT</span></div>
      </div>
    `;
  }).join('');

  $('hostLeaderboard').querySelectorAll('[data-bidder]').forEach(el => {
    el.addEventListener('click', () => openSquadModal(el.dataset.bidder));
  });
}

// =============================================================================
// Top chrome ticker — scrolling marquee of live metrics
// =============================================================================

function renderTicker() {
  const track = $('tickerTrack');
  if (!track || !room) return;

  const pool = Object.values(room.pool || {});
  const total = pool.length;
  const sold = pool.filter(p => p.sold && p.sold !== false && p.sold !== 'unsold').length;
  const history = room.history || [];
  const sales = history.filter(h => h.type === 'sold');
  const totalVolume = sales.reduce((s, h) => s + (h.price || 0), 0);
  const avgPrice = sales.length ? totalVolume / sales.length : 0;
  const topSale = sales.length ? sales.reduce((m, h) => h.price > m.price ? h : m, sales[0]) : null;
  const topPlayer = topSale ? room.pool[topSale.playerId] : null;
  const lastSale = sales.length ? sales[sales.length - 1] : null;
  const lastPlayer = lastSale ? room.pool[lastSale.playerId] : null;
  const bidders = Object.values(room.bidders || {}).filter(b => b.name);
  const topBidder = bidders.length
    ? bidders.slice().sort((x, y) => (STARTING_BUDGET - (y.budget ?? STARTING_BUDGET)) - (STARTING_BUDGET - (x.budget ?? STARTING_BUDGET)))[0]
    : null;
  const a = room.currentAuction;
  const currentBidCount = (bidHistoryByPlayer[a?.playerId] || []).length;
  const nextUp = nextQueue[0];

  // Build the list of items
  const items = [];
  items.push({ label: 'POOL', value: `${sold}/${total}` });
  if (topSale && topPlayer) {
    items.push({ label: 'HIGHEST', value: formatMoney(topSale.price), suffix: topPlayer.name.split(' ').pop(), tone: 'gold' });
  }
  if (a) {
    if (lastRoundBidCount > 0) {
      const pct = Math.round(((currentBidCount - lastRoundBidCount) / Math.max(lastRoundBidCount, 1)) * 100);
      const sign = pct >= 0 ? '+' : '';
      items.push({ label: 'BIDDING', value: `${sign}${pct}%`, suffix: 'vs last', tone: pct < 0 ? 'down' : '' });
    } else {
      items.push({ label: 'BIDDING', value: `${currentBidCount}`, suffix: currentBidCount === 1 ? 'bid' : 'bids' });
    }
  } else if (nextUp) {
    items.push({ label: 'NEXT', value: nextUp.name, suffix: `${nextUp.overall} OVR` });
  }
  if (sales.length > 0) {
    items.push({ label: 'AVG', value: formatMoney(Math.round(avgPrice)) });
    items.push({ label: 'VOL', value: formatMoney(totalVolume), tone: 'gold' });
  }
  if (lastPlayer && lastSale) {
    items.push({ label: 'LAST', value: lastPlayer.name.split(' ').pop(), suffix: `→ ${formatMoney(lastSale.price)}` });
  }
  if (topBidder) {
    items.push({ label: 'LEADER', value: (topBidder.name || '').toUpperCase(), suffix: formatMoney(STARTING_BUDGET - (topBidder.budget ?? STARTING_BUDGET)) });
  }
  items.push({ label: 'BIDDERS', value: `${bidders.length}` });

  // Render each item once, then duplicate for seamless looping
  const itemsHTML = items.map(it => {
    const cls = it.tone ? ` ${it.tone}` : '';
    return `<span class="item${cls}"><span class="label">${it.label}</span><strong>${escapeHtml(String(it.value))}</strong>${it.suffix ? `<span class="sep">·</span><span>${escapeHtml(String(it.suffix))}</span>` : ''}</span>`;
  }).join('');
  // Duplicate so the -50% translate loop seams perfectly
  track.innerHTML = itemsHTML + itemsHTML;
}

// =============================================================================
// Bid history tracking (client-side, ephemeral)
// =============================================================================

function trackBidHistory() {
  const a = room.currentAuction;
  if (!a) {
    if (prevAuctionPlayerId) {
      // auction just ended — remember its bid count for the ticker
      lastRoundBidCount = (bidHistoryByPlayer[prevAuctionPlayerId] || []).length;
      prevAuctionPlayerId = null;
    }
    return;
  }
  if (a.playerId !== prevAuctionPlayerId) {
    // new auction — capture closing count from the previous one for ticker
    if (prevAuctionPlayerId) {
      lastRoundBidCount = (bidHistoryByPlayer[prevAuctionPlayerId] || []).length;
    }
    bidHistoryByPlayer[a.playerId] = [];
    prevAuctionPlayerId = a.playerId;
    prevBidCount = 0;
  }
  const hist = bidHistoryByPlayer[a.playerId];
  const latestKey = `${a.leadingBidderId || ''}@${a.currentBid || 0}`;
  const topRow = hist[0];
  const topKey = topRow ? `${topRow.bidderId || ''}@${topRow.amount}` : null;
  if (a.leadingBidderId && a.currentBid > 0 && latestKey !== topKey) {
    hist.unshift({
      bidderId: a.leadingBidderId,
      name: a.leadingBidderName,
      amount: a.currentBid,
      at: Date.now(),
    });
    // cap to keep memory in check
    if (hist.length > 30) hist.length = 30;
  }
}

// =============================================================================
// Up Next queue — these are the ACTUAL next players. onNextPlayer pops head,
// btnShuffle rebuilds. Uses the real pickNextPlayer logic with a simulated
// history so the queue respects pacing (opener marquee, endgame marquees,
// position anti-cluster).
// =============================================================================

const NEXT_QUEUE_SIZE = 3;

function buildNextQueue() {
  if (!room?.pool) return [];
  // Clone pool so we can mark queued players "sold" for the simulation
  const simPool = {};
  for (const id in room.pool) simPool[id] = { ...room.pool[id] };
  const simHistory = [...(room.history || [])];
  const queue = [];
  for (let i = 0; i < NEXT_QUEUE_SIZE; i++) {
    const pick = pickNextPlayer(simPool, simHistory);
    if (!pick) break;
    queue.push(pick);
    // Mark as "sold" in the sim so pickNextPlayer doesn't re-pick
    simPool[pick.id].sold = 'queued';
    simHistory.push({ type: 'sold', playerId: pick.id, at: Date.now() + i });
  }
  return queue;
}

function renderUpNext() {
  const el = $('upNextList');
  if (!nextQueue.length) {
    el.innerHTML = `<div class="empty">pool empty</div>`;
    return;
  }
  el.innerHTML = nextQueue.map((p, i) => `
    <div class="row">
      <span class="idx">${i + 1}</span>
      <span class="nm">${escapeHtml(p.name)}</span>
      <span class="ovr">${p.overall}</span>
    </div>
  `).join('');
}

// =============================================================================
// Image preload — cache-warm the upcoming photos so they pop in instantly
// =============================================================================

const preloadedPhotos = new Set();
function preloadQueueImages() {
  for (const p of nextQueue) {
    if (p.photo && !preloadedPhotos.has(p.photo)) {
      preloadedPhotos.add(p.photo);
      const img = new Image();
      img.src = p.photo;
    }
  }
}

// =============================================================================
// Sold tabs
// =============================================================================

function renderSoldTabs() {
  const history = room?.history || [];
  const sales = history.filter(h => h.type === 'sold');
  $('cntRecent').textContent = Math.min(6, history.length);
  $('cntTop').textContent = Math.min(10, sales.length);
  $('cntAll').textContent = history.length;

  // toggle active tab
  document.querySelectorAll('#soldTabs button').forEach(b => {
    b.classList.toggle('active', b.dataset.soldtab === activeSoldTab);
  });
  document.querySelectorAll('.bp-tab-panel').forEach(p => {
    p.classList.toggle('active', p.dataset.soldtab === activeSoldTab);
  });
  $('soldTabMeta').textContent = {
    recent: 'most recent transactions',
    top: 'highest prices · this auction',
    all: 'every sale · scroll for more',
  }[activeSoldTab] || '';

  // recent (6, reversed)
  $('soldPanelRecent').innerHTML = renderSoldRows(history.slice(-6).reverse(), false);

  // top 10 by price, with rank badges
  const top10 = [...sales].sort((a, b) => b.price - a.price).slice(0, 10);
  $('soldPanelTop').innerHTML = renderSoldRows(top10, true);

  // all (reversed)
  $('soldPanelAll').innerHTML = renderSoldRows([...history].reverse(), false);
}

function renderSoldRows(rows, withRanks) {
  if (rows.length === 0) {
    return `<div class="bp-empty-state">No sales yet</div>`;
  }
  return rows.map((h, i) => {
    const p = room.pool[h.playerId];
    if (h.type === 'unsold') {
      return `<div class="bp-sold-row unsold ${withRanks ? 'with-rank' : ''}">
        ${withRanks ? `<span class="bp-rank-badge r5">—</span>` : ''}
        <div class="ovr">${p?.overall ?? '—'}</div>
        <div>
          <div class="name">${escapeHtml(p?.name || '?')}</div>
          <div class="who">unsold</div>
        </div>
        <div class="price">—</div>
      </div>`;
    }
    const rankClass = i === 0 ? '' : i === 1 ? 'r2' : i === 2 ? 'r3' : i < 5 ? 'r4' : 'r5';
    return `<div class="bp-sold-row ${withRanks ? 'with-rank' : ''}">
      ${withRanks ? `<span class="bp-rank-badge ${rankClass}">${i + 1}</span>` : ''}
      <div class="ovr">${p?.overall ?? '—'}</div>
      <div>
        <div class="name">${escapeHtml(p?.name || '?')}</div>
        <div class="who">→ ${escapeHtml(h.winnerName)} · ${escapeHtml(p?.position || '')} · ${escapeHtml(p?.club || '')}</div>
      </div>
      <div class="price">${formatMoney(h.price)}</div>
    </div>`;
  }).join('');
}

// ---------------------------------------------------------------------------
// Host actions
// ---------------------------------------------------------------------------

async function onNextPlayer(opts = {}) {
  if (!room) return;
  let pick;
  if (opts.forceTier) {
    // Marquee override bypasses the queue
    pick = pickNextPlayer(room.pool, room.history, opts);
  } else {
    // Consume the queue head. If empty (or stale), build it now.
    if (!nextQueue.length) nextQueue = buildNextQueue();
    pick = nextQueue.shift();
    if (!pick) pick = pickNextPlayer(room.pool, room.history);
  }
  if (!pick) { alert('All players sold!'); return; }
  await startAuctionForPlayer(roomCode, pick, startingBid(pick.overall));
  // Refill the queue so the panel always shows 3 ahead, and preload images
  nextQueue = buildNextQueue();
  preloadQueueImages();
  renderUpNext();
}

async function onForceMarquee() {
  if (!room) return;
  const remainingMarquees = Object.values(room.pool || {})
    .filter(p => !p.sold && p.overall >= 90).length;
  if (remainingMarquees === 0) {
    alert('No marquee players (90+) left in the pool.');
    return;
  }
  await onNextPlayer({ forceTier: 'marquee' });
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
    const numEl = document.getElementById('bidCountdownNum');
    const fillEl = document.getElementById('bidTimerFill');
    const countdownWrap = numEl?.closest('.bp-countdown');

    if (remaining <= 0) {
      // Show a visible "FINALIZING…" cue so the 0→next-player gap doesn't
      // look frozen. The actual finalize is a Firebase round-trip (~1s
      // unavoidable) — this just communicates that the buzzer fired.
      if (numEl) numEl.textContent = a.leadingBidderId ? 'SOLD' : '—';
      if (fillEl) fillEl.style.width = '0%';
      if (countdownWrap) countdownWrap.classList.add('tense');
    } else {
      if (numEl) numEl.textContent = String(secs).padStart(2, '0');
      if (fillEl) fillEl.style.width = Math.max(0, Math.min(100, (remaining / (BID_TIMER_SECONDS * 1000)) * 100)) + '%';
      if (countdownWrap) countdownWrap.classList.toggle('tense', secs <= 5);
    }

    // Bid grace is 300ms past endsAt (see firebase.js placeBid). We finalize
    // at +350ms — just 50ms past the grace, the minimum safe window.
    if (remaining <= 0 && Date.now() > (a.endsAt || 0) + 350 && !finalizingInFlight) {
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
  }, 100);
}

function flashSold(result) {
  const card = document.getElementById('featureCard');
  if (card) {
    card.classList.add('flash');
    setTimeout(() => card.classList.remove('flash'), 600);
  }
  lastSoldFlash = result;
}

// ---------------------------------------------------------------------------
// Squad modal
// ---------------------------------------------------------------------------

function openSquadModal(bidderId) {
  modalBidderId = bidderId;
  modalActiveTab = 'list';
  modalFormation = '4-3-3';
  // reset tab active state
  document.querySelectorAll('#modalTabs button').forEach(b => {
    b.classList.toggle('active', b.dataset.mtab === 'list');
  });
  switchModalPanel();
  renderSquadModal();
  $('squadModal').classList.remove('hidden');
}
function closeSquadModal() {
  modalBidderId = null;
  $('squadModal').classList.add('hidden');
}

function switchModalPanel() {
  document.querySelectorAll('.bp-modal-panel').forEach(p => {
    p.classList.toggle('active', p.dataset.mtab === modalActiveTab);
  });
  if (modalActiveTab === 'formation' && modalBidderId) {
    renderModalPitch();
  }
}

function cycleBidder(delta) {
  if (!modalBidderId || !room) return;
  const ids = Object.keys(room.bidders || {}).filter(id => room.bidders[id]?.name);
  if (!ids.length) return;
  const i = ids.indexOf(modalBidderId);
  modalBidderId = ids[(i + delta + ids.length) % ids.length];
  renderSquadModal();
}

function renderSquadModal() {
  if (!modalBidderId) return;
  const b = room.bidders?.[modalBidderId];
  if (!b) { closeSquadModal(); return; }

  const squad = b.squad || [];
  const spent = squad.reduce((s, p) => s + (p.price || 0), 0);
  $('bidderName').textContent = (b.name || '?').toUpperCase();
  $('bidderSub').textContent = `${squad.length} player${squad.length === 1 ? '' : 's'} · spent ${formatMoney(spent)}`;
  const budgetEl = $('bidderBudget');
  budgetEl.textContent = formatMoney(b.budget || 0);
  budgetEl.classList.toggle('low', (b.budget || 0) < 1_000_000);

  // counts
  const c = squadPositionCounts(squad);
  ['GK', 'DEF', 'MID', 'FWD'].forEach(k => {
    const el = $('cnt' + k);
    if (el) {
      el.textContent = c[k] || 0;
      el.classList.toggle('zero', !c[k]);
    }
  });

  renderSquadList(squad);
  if (modalActiveTab === 'formation') renderModalPitch();

  // wire view-full link
  const link = $('viewFullSquadLink');
  if (link) link.href = `./squad.html?room=${encodeURIComponent(roomCode || '')}&bidder=${encodeURIComponent(modalBidderId)}`;
}

function renderSquadList(squad) {
  const wrap = $('squadList');
  if (!squad.length) {
    wrap.innerHTML = `<div class="bp-empty-state">No players yet</div>`;
    return;
  }
  const order = { GK: 0, DEF: 1, MID: 2, FWD: 3 };
  const sorted = [...squad].sort((a, b) => {
    const ca = order[posCat(a.position)], cb = order[posCat(b.position)];
    if (ca !== cb) return ca - cb;
    return (b.overall || 0) - (a.overall || 0);
  });
  wrap.innerHTML = sorted.map(p => {
    const cat = posCat(p.position).toLowerCase();
    return `
      <div class="bp-squad-player ${cat}">
        <div class="ovr-badge">${p.overall || '—'}</div>
        <div>
          <div class="nm-line">${escapeHtml(p.name || '?')}</div>
          <div class="meta-line"><span class="pos">${escapeHtml(p.position || '')}</span><span>·</span><span>${escapeHtml(p.club || '')}</span></div>
        </div>
        <div class="price-tag">${formatMoney(p.price)}</div>
      </div>
    `;
  }).join('');
}

function renderModalPitch() {
  const pitch = $('modalPitch');
  if (!pitch) return;
  const b = room.bidders?.[modalBidderId];
  if (!b) return;
  renderPitchInto(pitch, b.squad || [], modalFormation);
}

function renderPitchInto(pitchEl, squad, formationKey) {
  pitchEl.querySelectorAll('.bp-pitch-player').forEach(n => n.remove());
  const slots = FORMATIONS[formationKey] || FORMATIONS['4-3-3'];
  const players = [...squad];
  const used = new Set();
  slots.forEach(slot => {
    const cat = posCat(slot.role);
    let pIdx = players.findIndex((p, idx) => !used.has(idx) && (p.position || '').toUpperCase() === slot.role);
    if (pIdx === -1) pIdx = players.findIndex((p, idx) => !used.has(idx) && posCat(p.position) === cat);
    const p = pIdx > -1 ? players[pIdx] : null;
    if (p) used.add(pIdx);
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
    pitchEl.appendChild(el);
  });
}

// ---------------------------------------------------------------------------
// Finished
// ---------------------------------------------------------------------------

function renderFinished() {
  if (room.status !== 'finished') return;

  const bidders = Object.values(room.bidders || {}).filter(b => b.name);
  const history = room.history || [];
  const sales = history.filter(h => h.type === 'sold');

  // hero stats
  const totalVolume = sales.reduce((s, h) => s + (h.price || 0), 0);
  const avgPrice = sales.length ? totalVolume / sales.length : 0;
  const topSale = sales.length ? sales.reduce((m, h) => h.price > m.price ? h : m, sales[0]) : null;
  const topPlayer = topSale ? room.pool[topSale.playerId] : null;
  const startedAt = room.startedAt || room.createdAt || (sales[0]?.at) || Date.now();
  const finishedAt = room.finishedAt || (sales[sales.length - 1]?.at) || Date.now();
  const durationMs = Math.max(0, finishedAt - startedAt);

  // eyebrow
  const today = new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
  $('finalHeroEyebrow').textContent = `Auction complete · ${today}`;
  $('finalHeroSub').innerHTML =
    `${bidders.length} managers · <b>${sales.length} players</b> · ${formatDuration(durationMs)} on the clock · <b>${formatMoney(totalVolume)}</b> in total value moved`;

  $('finalEyebrow').textContent = `Room ${roomCode} · ${sales.length} sold · auction complete`;

  // hero stats cells
  $('finalHeroStats').innerHTML = `
    <div class="cell accent-gold">
      <span class="val">${formatMoney(totalVolume)}</span>
      <span class="key">Total volume</span>
    </div>
    <div class="cell">
      <span class="val">${formatMoney(Math.round(avgPrice))}</span>
      <span class="key">Avg price</span>
    </div>
    <div class="cell accent-green">
      <span class="val">${topSale ? formatMoney(topSale.price) : '—'}</span>
      <span class="key">${topPlayer ? `Top sale · ${escapeHtml(topPlayer.name.split(' ').pop())}` : 'Top sale'}</span>
    </div>
    <div class="cell">
      <span class="val">${formatDuration(durationMs)}</span>
      <span class="key">Duration</span>
    </div>
  `;

  // awards
  const awards = computeAwards(bidders, sales);
  $('finalAwards').innerHTML = `
    ${awardCardHTML('gold', '🏆', 'Best squad', awards.bestSquad)}
    ${awardCardHTML('green', '🎯', 'Steal of the night', awards.steal)}
    ${awardCardHTML('blue', '💰', 'Biggest spender', awards.spender)}
    ${awardCardHTML('red', '🔥', 'Top buy', awards.topBuy)}
  `;

  // standings — rank by avg OVR desc, tiebreak by spent desc
  const standings = bidders.map(b => {
    const squad = b.squad || [];
    const avgOvr = squad.length ? squad.reduce((s, p) => s + (p.overall || 0), 0) / squad.length : 0;
    const spent = squad.reduce((s, p) => s + (p.price || 0), 0);
    return { b, squad, avgOvr, spent };
  }).sort((a, b) => (b.avgOvr - a.avgOvr) || (b.spent - a.spent));

  $('finalStandings').innerHTML = standings.map((row, i) => {
    const c = squadPositionCounts(row.squad);
    const rankClass = i === 0 ? 'r1' : i === 1 ? 'r2' : i === 2 ? 'r3' : '';
    const champ = i === 0 ? '<span class="tag">Champion</span>' : '';
    return `
      <tr>
        <td><span class="bp-rank-pill ${rankClass}">${i + 1}</span></td>
        <td><div class="bp-bidder-cell"><span class="nm">${escapeHtml((row.b.name || '?').toUpperCase())}</span>${champ}</div></td>
        <td class="bp-spent-cell">${row.squad.length} players · ${c.GK} GK · ${c.DEF} DEF · ${c.MID} MID · ${c.FWD} FWD</td>
        <td class="r bp-spent-cell">${formatMoney(row.spent)}</td>
        <td class="r bp-spent-cell">${formatMoney(row.b.budget || 0)}</td>
        <td class="r"><span class="bp-ovr-cell">${row.avgOvr.toFixed(1)}</span></td>
      </tr>
    `;
  }).join('');

  // squad cards
  $('finalGrid').innerHTML = standings.map((row, i) => {
    const squad = row.squad;
    const top3 = [...squad].sort((a, b) => (b.overall || 0) - (a.overall || 0)).slice(0, 3);
    const cardClass = i === 0 ? 'first' : i === 1 ? 'second' : i === 2 ? 'third' : '';
    const rankClass = i === 0 ? 'r1' : i === 1 ? 'r2' : i === 2 ? 'r3' : '';
    const avgBuy = squad.length ? row.spent / squad.length : 0;
    const link = `./squad.html?room=${encodeURIComponent(roomCode || '')}&bidder=${encodeURIComponent(row.b.id)}`;
    return `
      <a href="${link}" class="bp-squad-card ${cardClass}" id="team-${row.b.id}">
        <div class="head">
          <div class="left">
            <span class="bp-rank-pill ${rankClass}">${i + 1}</span>
            <span class="nm">${escapeHtml((row.b.name || '?').toUpperCase())}</span>
          </div>
          <div class="ovr-block">
            <span class="num">${row.avgOvr.toFixed(1)}</span>
            <span class="lbl">avg OVR</span>
          </div>
        </div>
        <div class="bp-top-players">
          ${top3.length === 0 ? '<div class="empty">no players</div>' : top3.map(p => `
            <div class="row">
              <span class="o">${p.overall || '—'}</span>
              <div>
                <div class="n">${escapeHtml(p.name || '?')}</div>
                <div class="meta">${escapeHtml(p.position || '')} · ${escapeHtml(p.club || '')}</div>
              </div>
              <span class="p">${formatMoney(p.price)}</span>
            </div>
          `).join('')}
        </div>
        <div class="bp-squad-foot">
          <div class="ft"><span class="v">${squad.length}</span><span class="l">Players</span></div>
          <div class="ft spent"><span class="v">${formatMoney(row.spent)}</span><span class="l">Spent</span></div>
          <div class="ft eff"><span class="v">${squad.length ? formatMoney(Math.round(avgBuy)) : '—'}</span><span class="l">Avg buy</span></div>
        </div>
        <div class="view-link">View full squad →</div>
      </a>
    `;
  }).join('');
}

function awardCardHTML(color, icon, label, award) {
  if (!award) {
    return `
      <div class="bp-award ${color}">
        <span class="award-tag"><span class="ico">${icon}</span>${label}</span>
        <div class="winner-name">—</div>
        <div class="winner-line">no data yet</div>
        <div class="award-stat"><span class="empty-line">awaiting sales</span></div>
      </div>
    `;
  }
  return `
    <div class="bp-award ${color}">
      <span class="award-tag"><span class="ico">${icon}</span>${label}</span>
      <div class="winner-name">${escapeHtml(award.winner)}</div>
      <div class="winner-line">${escapeHtml(award.line)}</div>
      <div class="award-stat">
        <span class="num">${award.stat}</span>
        <span class="label">${escapeHtml(award.statLabel)}</span>
      </div>
    </div>
  `;
}

function computeAwards(bidders, sales) {
  // Best squad — highest avg OVR (min 1 player)
  let bestSquad = null;
  bidders.forEach(b => {
    const squad = b.squad || [];
    if (squad.length === 0) return;
    const avg = squad.reduce((s, p) => s + (p.overall || 0), 0) / squad.length;
    if (!bestSquad || avg > bestSquad.avg) {
      bestSquad = { winner: (b.name || '?').toUpperCase(), avg, count: squad.length };
    }
  });
  if (bestSquad) {
    bestSquad = {
      winner: bestSquad.winner,
      line: `avg ${bestSquad.avg.toFixed(1)} OVR · ${bestSquad.count} player${bestSquad.count === 1 ? '' : 's'}`,
      stat: bestSquad.avg.toFixed(1),
      statLabel: 'average overall',
    };
  }

  // Steal of the night — highest overall / max(price, 0.1) (in millions)
  let steal = null;
  sales.forEach(h => {
    const p = room.pool[h.playerId];
    if (!p) return;
    const priceM = Math.max(h.price / 1_000_000, 0.1);
    const ratio = (p.overall || 0) / priceM;
    if (!steal || ratio > steal.ratio) {
      steal = {
        ratio,
        winner: (h.winnerName || '?').toUpperCase(),
        line: `${p.name} · ${p.overall} OVR · ${formatMoney(h.price)}`,
        stat: `${ratio.toFixed(1)}<span style="font-family:var(--sans);font-weight:700;font-size:18px;margin-left:1px;">×</span>`,
        statLabel: 'OVR per million',
      };
    }
  });

  // Biggest spender — highest sum of squad prices
  let spender = null;
  bidders.forEach(b => {
    const spent = (b.squad || []).reduce((s, p) => s + (p.price || 0), 0);
    if (!spender || spent > spender.spentN) {
      spender = {
        spentN: spent,
        winner: (b.name || '?').toUpperCase(),
        line: `${formatMoney(spent)} of ${formatMoney(STARTING_BUDGET)} deployed`,
        stat: formatMoney(spent),
        statLabel: 'total spent',
      };
    }
  });

  // Top buy — highest single sale
  let topBuy = null;
  sales.forEach(h => {
    if (!topBuy || h.price > topBuy.priceN) {
      const p = room.pool[h.playerId];
      topBuy = {
        priceN: h.price,
        winner: (h.winnerName || '?').toUpperCase(),
        line: p ? `${p.name} · ${p.overall} OVR · ${p.position || ''}` : 'unknown player',
        stat: formatMoney(h.price),
        statLabel: 'highest sale',
      };
    }
  });

  return { bestSquad, steal, spender, topBuy };
}

function formatDuration(ms) {
  const totalSec = Math.round(Math.max(0, ms) / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}<span class="unit" style="font-family:var(--sans);font-size:13px;font-weight:700;color:var(--dim);margin-left:2px;">h</span> ${String(m).padStart(2,'0')}<span class="unit" style="font-family:var(--sans);font-size:13px;font-weight:700;color:var(--dim);margin-left:2px;">m</span>`;
  if (m > 0) return `${m}<span class="unit" style="font-family:var(--sans);font-size:13px;font-weight:700;color:var(--dim);margin-left:2px;">m</span> ${String(s).padStart(2,'0')}<span class="unit" style="font-family:var(--sans);font-size:13px;font-weight:700;color:var(--dim);margin-left:2px;">s</span>`;
  return `${s}<span class="unit" style="font-family:var(--sans);font-size:13px;font-weight:700;color:var(--dim);margin-left:2px;">s</span>`;
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
