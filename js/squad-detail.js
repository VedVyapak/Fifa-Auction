// Read-only squad-detail page. Loaded by squad.html?room=CODE&bidder=ID.
// Fetches the room snapshot once, renders one bidder's roster + a formation
// view + position breakdown + tile summary.

import { formatMoney, bucketFor, SQUAD_SIZE } from './auction.js';
import { getRoomOnce, watchConnection } from './firebase.js';

const $ = (id) => document.getElementById(id);

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

const params = new URLSearchParams(location.search);
const roomCode = (params.get('room') || '').toUpperCase();
const bidderId = params.get('bidder');

let room = null;
let bidder = null;
let formation = '4-3-3';
let rankIndex = 0; // 0-indexed rank by avg OVR

watchConnection((connected) => {
  document.body.classList.toggle('offline', !connected);
});

document.querySelectorAll('#formationTabs button').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#formationTabs button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    formation = btn.dataset.fmt;
    renderPitch();
  });
});

boot();

async function boot() {
  if (!roomCode || !bidderId) {
    renderError('Missing room or bidder. Check the link.');
    return;
  }
  $('squadRoomCode').textContent = roomCode;
  $('crumbRoom').textContent = `Room ${roomCode}`;
  $('backLink').href = `./index.html?room=${encodeURIComponent(roomCode)}`;
  $('managerSub').textContent = `Manager · Room ${roomCode}`;

  try {
    room = await getRoomOnce(roomCode);
  } catch (e) {
    console.error(e);
    renderError('Couldn\'t reach the room. Check firebase-config.js.');
    return;
  }
  if (!room) {
    renderError('Room not found.');
    return;
  }
  bidder = room.bidders?.[bidderId];
  if (!bidder) {
    renderError('Bidder not found in this room.');
    return;
  }

  // figure out rank by avg OVR among non-empty bidders
  const bidders = Object.values(room.bidders || {}).filter(b => b.name);
  const ranked = bidders.map(b => {
    const squad = b.squad || [];
    const avg = squad.length ? squad.reduce((s, p) => s + (p.overall || 0), 0) / squad.length : 0;
    const spent = squad.reduce((s, p) => s + (p.price || 0), 0);
    return { id: b.id, avg, spent };
  }).sort((a, b) => (b.avg - a.avg) || (b.spent - a.spent));
  rankIndex = ranked.findIndex(r => r.id === bidderId);
  if (rankIndex < 0) rankIndex = 0;

  renderHeader();
  renderPosTiles();
  renderRoster();
  renderPitch();
}

function renderError(msg) {
  $('managerName').textContent = '—';
  document.querySelector('main.bp-squad-stage').innerHTML =
    `<div class="bp-empty-state" style="padding:64px;border:1px solid var(--line);border-radius:14px;background:rgba(255,255,255,0.02);">${msg}</div>`;
}

function renderHeader() {
  const squad = bidder.squad || [];
  const avg = squad.length ? squad.reduce((s, p) => s + (p.overall || 0), 0) / squad.length : 0;
  const spent = squad.reduce((s, p) => s + (p.price || 0), 0);
  $('managerName').textContent = (bidder.name || '?').toUpperCase();
  $('crumbName').textContent = bidder.name || '—';
  $('rankPos').textContent = rankIndex + 1;
  $('headOvr').textContent = avg.toFixed(1);
  $('headSpent').textContent = formatMoney(spent);
  $('headLeft').textContent = formatMoney(bidder.budget || 0);
  $('squadSlot').textContent = squad.length;

  const c = posCount(squad);
  const champLabel = rankIndex === 0 ? 'Champion' : rankIndex === 1 ? 'Runner-up' : rankIndex === 2 ? 'Third' : `Rank ${rankIndex + 1}`;
  const champClass = rankIndex === 0 ? 'silver' : rankIndex === 1 ? 'silver' : rankIndex === 2 ? 'silver' : '';
  const chips = [
    `<span class="bp-chip ${rankIndex < 3 ? 'silver' : ''}">${champLabel}</span>`,
    `<span class="bp-chip gk">${c.GK} GK</span>`,
    `<span class="bp-chip def">${c.DEF} DEF</span>`,
    `<span class="bp-chip mid">${c.MID} MID</span>`,
    `<span class="bp-chip fwd">${c.FWD} FWD</span>`,
  ].join('');
  $('managerChips').innerHTML = chips;

  // rank-block tint
  const rb = document.querySelector('.bp-rank-block');
  if (rb) {
    rb.classList.toggle('gold', rankIndex === 0);
    rb.classList.toggle('silver', rankIndex === 1);
    rb.classList.toggle('bronze', rankIndex === 2);
  }
}

function renderPosTiles() {
  const squad = bidder.squad || [];
  const c = posCount(squad);
  $('rosterMeta').textContent = `${squad.length} player${squad.length === 1 ? '' : 's'} · squad slot ${squad.length} of ${SQUAD_SIZE}`;
  $('posTiles').innerHTML = `
    <div class="bp-pos-tile gk ${c.GK ? '' : 'zero'}"><span class="v">${c.GK}</span><span class="l">Goalkeeper${c.GK === 1 ? '' : 's'}</span></div>
    <div class="bp-pos-tile def ${c.DEF ? '' : 'zero'}"><span class="v">${c.DEF}</span><span class="l">Defenders</span></div>
    <div class="bp-pos-tile mid ${c.MID ? '' : 'zero'}"><span class="v">${c.MID}</span><span class="l">Midfielders</span></div>
    <div class="bp-pos-tile fwd ${c.FWD ? '' : 'zero'}"><span class="v">${c.FWD}</span><span class="l">Forwards</span></div>
  `;
}

function renderRoster() {
  const squad = bidder.squad || [];
  if (squad.length === 0) {
    $('rosterGroups').innerHTML = `<div class="bp-empty-state">No players bought yet</div>`;
    return;
  }
  const groups = { GK: [], DEF: [], MID: [], FWD: [] };
  squad.forEach(p => groups[posCat(p.position)].push(p));
  Object.values(groups).forEach(arr => arr.sort((a, b) => (b.overall || 0) - (a.overall || 0)));

  const labels = { GK: 'Goalkeeper', DEF: 'Defenders', MID: 'Midfielders', FWD: 'Forwards' };
  const html = ['GK', 'DEF', 'MID', 'FWD'].filter(k => groups[k].length).map(k => {
    const arr = groups[k];
    const total = arr.reduce((s, p) => s + (p.price || 0), 0);
    return `
      <div class="bp-roster-group ${k.toLowerCase()}">
        <div class="group-head">
          <span class="tag">${labels[k]}</span>
          <span class="ct">${arr.length} player${arr.length === 1 ? '' : 's'} · ${formatMoney(total)}</span>
          <span class="line"></span>
        </div>
        ${arr.map(p => `
          <div class="bp-player-row-roster ${k.toLowerCase()}">
            <span class="ovr">${p.overall || '—'}</span>
            <div>
              <div class="nm-line">${escapeHtml(p.name || '?')}</div>
              <div class="meta-line">
                <span class="pos">${escapeHtml(p.position || '')}</span>
                <span>·</span>
                <span>${escapeHtml(p.club || '')}</span>
                ${p.nation ? `<span>·</span><span>${escapeHtml(p.nation)}</span>` : ''}
              </div>
            </div>
            <div></div>
            <div class="stat-mini">
              <span class="top">${formatMoney(p.price)}</span>
              <span class="bot">paid</span>
            </div>
          </div>
        `).join('')}
      </div>
    `;
  }).join('');
  $('rosterGroups').innerHTML = html;
}

function renderPitch() {
  const pitch = $('pitch');
  if (!pitch) return;
  pitch.querySelectorAll('.bp-pitch-player').forEach(n => n.remove());
  const slots = FORMATIONS[formation];
  const squad = bidder?.squad || [];
  // Sort by OVR desc so best-at-position wins the exact-match slot.
  const players = [...squad].sort((a, b) => (b.overall || 0) - (a.overall || 0));
  const assignments = new Array(slots.length).fill(null);
  const usedPlayers = new Set();
  // Pass 1: exact role match first.
  slots.forEach((slot, slotIdx) => {
    const pIdx = players.findIndex((p, idx) =>
      !usedPlayers.has(idx) && (p.position || '').toUpperCase() === slot.role
    );
    if (pIdx > -1) { assignments[slotIdx] = players[pIdx]; usedPlayers.add(pIdx); }
  });
  // Pass 2: category fallback.
  slots.forEach((slot, slotIdx) => {
    if (assignments[slotIdx]) return;
    const cat = posCat(slot.role);
    const pIdx = players.findIndex((p, idx) =>
      !usedPlayers.has(idx) && posCat(p.position) === cat
    );
    if (pIdx > -1) { assignments[slotIdx] = players[pIdx]; usedPlayers.add(pIdx); }
  });

  let filled = 0;
  slots.forEach((slot, slotIdx) => {
    const p = assignments[slotIdx];
    if (p) filled++;
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
  $('filledCount').textContent = filled;

  // Bench
  const bench = players.filter((_, idx) => !usedPlayers.has(idx));
  const benchEl = $('bench');
  if (benchEl) {
    if (!bench.length) {
      benchEl.innerHTML = '';
      benchEl.classList.add('hide');
    } else {
      benchEl.classList.remove('hide');
      benchEl.innerHTML = `
        <div class="bp-bench-head">Bench · ${bench.length}</div>
        <div class="bp-bench-grid">
          ${bench.map(p => {
            const cat = posCat(p.position).toLowerCase();
            return `
              <div class="bp-bench-card ${cat}">
                <span class="ovr">${p.overall || '—'}</span>
                <span class="nm">${escapeHtml((p.name || '?').split(' ').pop())}</span>
                <span class="pos">${escapeHtml(p.position || '')}</span>
              </div>
            `;
          }).join('')}
        </div>
      `;
    }
  }
}

function posCount(squad) {
  const c = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
  (squad || []).forEach(p => c[posCat(p.position)]++);
  return c;
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;',
  }[c]));
}
