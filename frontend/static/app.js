/* ── app.js — Meshtastic Coverage Map ─────────────────────────────────────── */

// ── Color scales (used only for legend bar + marker colours) ─────────────────
const COLOR_SCALES = {
  rdylbu:  [[215,48,39],[252,141,89],[254,224,144],[145,191,219],[69,117,180]],
  viridis: [[68,1,84],[58,82,139],[32,144,140],[94,201,97],[253,231,37]],
  plasma:  [[13,8,135],[126,3,167],[204,71,120],[248,149,64],[240,249,33]],
  greens:  [[247,252,245],[199,233,192],[116,196,118],[35,139,69],[0,68,27]],
};


// ── Preferences — persisted to localStorage ───────────────────────────────────
const PREF_KEY = 'meshtastic_prefs';

function _loadPrefs() {
  try { return JSON.parse(localStorage.getItem(PREF_KEY)) || {}; } catch { return {}; }
}
function _savePrefs(patch) {
  try {
    const cur = _loadPrefs();
    localStorage.setItem(PREF_KEY, JSON.stringify({ ...cur, ...patch }));
  } catch { /* storage unavailable */ }
}

const _prefs = _loadPrefs();

let activeScale  = _prefs.colorscale || 'rdylbu';
let invertColors = _prefs.invert || false;
let snrMin = 0, snrMax = 1;

function snrColor(snr) {
  let t = (snrMax === snrMin) ? 0.5
        : Math.max(0, Math.min(1, (snr - snrMin) / (snrMax - snrMin)));
  if (invertColors) t = 1 - t;
  const stops = COLOR_SCALES[activeScale];
  const n = stops.length - 1;
  const idx = t * n;
  const lo = Math.floor(idx), hi = Math.min(n, lo + 1);
  const f  = idx - lo;
  const c  = stops[lo].map((v, i) => Math.round(v + f * (stops[hi][i] - v)));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

function updateLegendBar() {
  const steps = 24;
  const gradient = Array.from({length: steps}, (_, i) => {
    let t = i / (steps - 1);
    if (invertColors) t = 1 - t;
    const scale = COLOR_SCALES[activeScale];
    const n = scale.length - 1;
    const idx = t * n;
    const lo = Math.floor(idx), hi = Math.min(n, lo + 1);
    const f = idx - lo;
    const c = scale[lo].map((v, j) => Math.round(v + f * (scale[hi][j] - v)));
    return `rgb(${c[0]},${c[1]},${c[2]})`;
  }).join(',');
  document.getElementById('legend-bar').style.background =
    `linear-gradient(to right, ${gradient})`;
}


// ── State ─────────────────────────────────────────────────────────────────────
// Initialise from DOM so HTML value= is the single source of truth
const _opacityEl     = document.getElementById('opacity');
const _showMarkersEl = document.getElementById('show-markers');

const state = {
  measurements: [],
  mapType:      _prefs.mapType || 'osm',
  opacity:      (_prefs.opacity !== undefined ? _prefs.opacity : parseFloat(_opacityEl.value)),
  showMarkers:  (_prefs.showMarkers !== undefined ? _prefs.showMarkers : _showMarkersEl.checked),
  filter:       '',
};
document.getElementById('opacity-val').textContent = state.opacity.toFixed(2);
// Sync DOM controls to restored prefs
_opacityEl.value = state.opacity;
_showMarkersEl.checked = state.showMarkers;

// Multi-select state
const selection = {
  ids:         new Set(),
  anchorId:    null,
  filteredIds: [],
};

const markerById = {};


// ── Map setup ─────────────────────────────────────────────────────────────────
const map = L.map('map', { zoomControl: false }).setView([51, 10], 5);
L.control.zoom({ position: 'bottomright' }).addTo(map);

const tileLayers = {
  osm: L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors', maxZoom: 19,
  }),
  satellite: L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    { attribution: '© Esri', maxZoom: 19 }
  ),
  topo: L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenTopoMap contributors', maxZoom: 17,
  }),
  white: (function() {
    const W = L.GridLayer.extend({
      createTile: function() {
        const c = document.createElement('canvas');
        c.width = c.height = 256;
        c.getContext('2d').fillStyle = '#1a1d27';
        c.getContext('2d').fillRect(0, 0, 256, 256);
        return c;
      }
    });
    return new W({ attribution: '', maxZoom: 19 });
  })(),
};
tileLayers.osm.addTo(map);

function setMapType(type) {
  Object.values(tileLayers).forEach(l => { if (map.hasLayer(l)) map.removeLayer(l); });
  tileLayers[type].addTo(map);
  state.mapType = type;
  _savePrefs({ mapType: type });
}

const pointLayer = L.layerGroup();  // added to map conditionally at boot


// ── SNR tile layer ────────────────────────────────────────────────────────────
// The heatmap is rendered server-side as XYZ PNG tiles.
// Color scale, invert, opacity and resolution are passed as query params so
// appearance changes instantly without re-fetching data.

function _tileUrl() {
  const p = new URLSearchParams({
    colorscale: activeScale,
    invert:     invertColors ? 1 : 0,
    opacity:    state.opacity.toFixed(2),
    t:          _tileTs,
  });
  return `${window.HEATMAP_URL}/tiles/{z}/{x}/{y}.png?${p}`;
}

let _tileTs = Date.now();

const snrTileLayer = L.tileLayer(_tileUrl(), {
  opacity:       1,            // opacity baked into PNG alpha by server
  maxNativeZoom: 18,
  maxZoom:       19,
  tms:           false,
  attribution:   'SNR heatmap',
  zIndex:        200,
}).addTo(map);

// Show spinner while tiles load
snrTileLayer.on('loading', () =>
  document.getElementById('heatmap-spinner').classList.remove('hidden'));
snrTileLayer.on('load', () =>
  document.getElementById('heatmap-spinner').classList.add('hidden'));

function _applyTileUrl() {
  snrTileLayer.setUrl(_tileUrl());
}

// Call after any setting change that requires new tiles
function _bumpAndRefresh() {
  _tileTs = Date.now();
  _applyTileUrl();
}




// ── Markers ───────────────────────────────────────────────────────────────────
function renderMarkers(measurements) {
  pointLayer.clearLayers();
  Object.keys(markerById).forEach(k => delete markerById[k]);

  const byLoc = {};
  measurements.forEach(m => {
    const key = `${m.rx_lat.toFixed(7)},${m.rx_lon.toFixed(7)}`;
    (byLoc[key] = byLoc[key] || []).push(m);
  });

  Object.entries(byLoc).forEach(([key, rows]) => {
    const visible   = rows.filter(r => !r.hidden);
    const snr       = visible.length
      ? visible.reduce((s, r) => s + r.rx_snr, 0) / visible.length
      : rows[0].rx_snr;
    const allHidden = rows.every(r => r.hidden);
    const [lat, lon] = key.split(',').map(Number);

    const marker = L.circleMarker([lat, lon], {
      radius:      7,
      fillColor:   allHidden ? '#555' : snrColor(snr),
      color:       '#fff', weight: 1.5,
      fillOpacity: allHidden ? 0.4 : 1,
      opacity:     allHidden ? 0.4 : 1,
    });

    marker.bindPopup(() => buildPopup(rows, lat, lon));
    marker.on('click', () => {
      selectIds(rows.map(r => r.id), false);
      highlightDomRows(rows.map(r => r.id));
    });
    marker.addTo(pointLayer);
    rows.forEach(r => { markerById[r.id] = marker; });
  });
}

function buildPopup(rows, lat, lon) {
  const allHidden = rows.every(r => r.hidden);
  const visible   = rows.filter(r => !r.hidden);
  const snr       = visible.length
    ? (visible.reduce((s, r) => s + r.rx_snr, 0) / visible.length).toFixed(1)
    : '—';

  const div = document.createElement('div');
  div.innerHTML = `
    <b>RX Location</b><br>
    Avg SNR: <b>${snr} dB</b> · ${rows.length} measurement${rows.length !== 1 ? 's' : ''}<br>
    <span style="color:var(--muted);font-size:0.75rem">${lat.toFixed(6)}, ${lon.toFixed(6)}</span>
    <div style="margin-top:6px;font-size:0.75rem;color:var(--muted)">
      ${rows.map(r => `<div>${r.payload || '—'} &nbsp; ${r.rx_snr.toFixed(1)} dB &nbsp; ${r.date} ${r.time}</div>`).join('')}
    </div>
  `;
  const ids = rows.map(r => r.id);
  const btn = document.createElement('button');
  btn.className   = `popup-action-btn ${allHidden ? 'popup-show-btn' : 'popup-hide-btn'}`;
  btn.textContent = allHidden ? 'Show all here' : 'Hide all here';
  btn.onclick     = () => toggleRows(ids, !allHidden);
  div.appendChild(btn);
  return div;
}


// ── Multi-select ──────────────────────────────────────────────────────────────

function selectIds(ids, additive) {
  if (!additive) selection.ids.clear();
  ids.forEach(id => selection.ids.add(id));
  if (ids.length) selection.anchorId = ids[ids.length - 1];
  updateSelectionBar();
  updateSelectionHighlights();
}

function clearSelection() {
  selection.ids.clear();
  selection.anchorId = null;
  updateSelectionBar();
  updateSelectionHighlights();
}

function handleRowClick(id, e) {
  if (e.shiftKey && selection.anchorId !== null) {
    const a = selection.filteredIds.indexOf(selection.anchorId);
    const b = selection.filteredIds.indexOf(id);
    if (a !== -1 && b !== -1) {
      const lo = Math.min(a, b), hi = Math.max(a, b);
      selection.filteredIds.slice(lo, hi + 1).forEach(rid => selection.ids.add(rid));
    }
  } else if (e.ctrlKey || e.metaKey) {
    if (selection.ids.has(id)) { selection.ids.delete(id); }
    else { selection.ids.add(id); selection.anchorId = id; }
  } else {
    const marker = markerById[id];
    if (marker) { map.panTo(marker.getLatLng()); marker.openPopup(); }
    selection.ids.clear();
    selection.ids.add(id);
    selection.anchorId = id;
  }
  updateSelectionBar();
  updateSelectionHighlights();
}

function updateSelectionHighlights() {
  document.querySelectorAll('.mrow').forEach(el => {
    el.classList.toggle('selected', selection.ids.has(Number(el.dataset.id)));
  });
}

function updateSelectionBar() {
  const bar   = document.getElementById('selection-bar');
  const count = selection.ids.size;
  if (count === 0) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  document.getElementById('selection-count').textContent = `${count} selected`;
}

document.getElementById('sel-hide-btn').addEventListener('click', () => {
  toggleRows([...selection.ids], true); clearSelection();
});
document.getElementById('sel-show-btn').addEventListener('click', () => {
  toggleRows([...selection.ids], false); clearSelection();
});
document.getElementById('sel-delete-btn').addEventListener('click', async () => {
  const ids = [...selection.ids];
  if (!confirm(`Delete ${ids.length} measurement${ids.length !== 1 ? 's' : ''}?`)) return;
  clearSelection();
  await deleteRows(ids);
});
document.getElementById('sel-clear-btn').addEventListener('click', clearSelection);

function highlightDomRows(ids) {
  selectIds(ids, false);
  const first = document.querySelector('.mrow.selected');
  if (first) first.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}


// ── API — row mutations ───────────────────────────────────────────────────────

let _opQueue = Promise.resolve();

function toggleRows(ids, hide) {
  ids.forEach(id => {
    const m = state.measurements.find(m => m.id === id);
    if (m) m.hidden = hide;
  });
  renderMarkers(state.measurements);
  renderSidebar();

  _opQueue = _opQueue.then(async () => {
    await Promise.all(ids.map(id =>
      fetch(`/api/measurements/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hidden: hide }),
      })
    ));
    // Invalidate server cache so new tiles reflect visibility change
    await fetch(`${window.HEATMAP_URL}/invalidate`, { method: 'POST' });
    _bumpAndRefresh();
  }).catch(e => console.error('Toggle error', e));
}

async function deleteRows(ids) {
  state.measurements = state.measurements.filter(m => !ids.includes(m.id));
  renderMarkers(state.measurements);
  renderSidebar();

  await Promise.all(ids.map(id =>
    fetch(`/api/measurements/${id}`, { method: 'DELETE' })
  ));
  await fetch(`${window.HEATMAP_URL}/invalidate`, { method: 'POST' });
  _bumpAndRefresh();
}


// ── API — data loading ────────────────────────────────────────────────────────

function setStatus(msg, cls = '') {
  const el = document.getElementById('import-status');
  el.textContent = msg;
  el.className   = cls;
}

async function loadMeasurements() {
  const res = await fetch('/api/measurements?limit=100000');
  const data = await res.json();
  // Derive snrMin/snrMax for marker colours from loaded data
  const snrs = data.filter(m => !m.hidden).map(m => m.rx_snr);
  if (snrs.length) {
    snrMin = Math.min(...snrs);
    snrMax = Math.max(...snrs);
    document.getElementById('leg-min').textContent = snrMin.toFixed(1) + ' dB';
    document.getElementById('leg-max').textContent = snrMax.toFixed(1) + ' dB';
    updateLegendBar();
  }
  state.measurements = data;
  renderMarkers(state.measurements);
  renderSidebar();
  return state.measurements;
}

async function uploadCSV(file) {
  setStatus('Uploading…');
  const fd = new FormData();
  fd.append('file', file);
  try {
    const res  = await fetch('/api/measurements/import', { method: 'POST', body: fd });
    const json = await res.json();
    if (json.detail) { setStatus('Error: ' + JSON.stringify(json.detail), 'error'); return; }
    setStatus(`+${json.inserted} new, ${json.skipped} skipped (${json.total} total)`, 'success');
    // Invalidate so fresh tiles include new data
    await fetch(`${window.HEATMAP_URL}/invalidate`, { method: 'POST' });
    const data = await loadMeasurements();
    fitToData(data);
    _bumpAndRefresh();
  } catch (e) {
    setStatus('Upload failed: ' + e.message, 'error');
  }
}

async function clearData() {
  if (!confirm('Delete all stored measurements?')) return;
  await fetch('/api/measurements', { method: 'DELETE' });
  await fetch(`${window.HEATMAP_URL}/invalidate`, { method: 'POST' });
  state.measurements = [];
  clearSelection();
  pointLayer.clearLayers();
  renderSidebar();
  document.getElementById('leg-min').textContent = '—';
  document.getElementById('leg-max').textContent = '—';
  setStatus('All data cleared.');
  _bumpAndRefresh();
}

function fitToData(measurements) {
  const pts = measurements.map(m => [m.rx_lat, m.rx_lon]);
  if (pts.length) map.fitBounds(L.latLngBounds(pts), { padding: [40, 40] });
}


// ── Sidebar render ────────────────────────────────────────────────────────────
function renderSidebar() {
  const list  = document.getElementById('measurement-list');
  const noMsg = document.getElementById('no-data-msg');
  const q     = state.filter.toLowerCase();

  const filtered = q
    ? state.measurements.filter(m =>
        (m.payload     || '').toLowerCase().includes(q) ||
        (m.sender_name || '').toLowerCase().includes(q) ||
        String(m.rx_snr).includes(q) ||
        `${m.date} ${m.time}`.includes(q))
    : state.measurements;

  selection.filteredIds = filtered.map(m => m.id);
  list.innerHTML = '';

  if (!filtered.length) {
    noMsg.textContent = state.measurements.length ? 'No results.' : 'No data loaded yet.';
    noMsg.classList.remove('hidden');
    return;
  }
  noMsg.classList.add('hidden');

  const frag = document.createDocumentFragment();
  filtered.forEach(m => {
    const color      = snrColor(m.rx_snr);
    const isSelected = selection.ids.has(m.id);
    const row        = document.createElement('div');
    row.className    = ['mrow', m.hidden ? 'is-hidden' : '', isSelected ? 'selected' : '']
                         .filter(Boolean).join(' ');
    row.dataset.id   = m.id;
    row.innerHTML    = `
      <span class="mrow-snr" style="color:${color}">${m.rx_snr.toFixed(1)}</span>
      <div class="mrow-info">
        <div class="mrow-main">${m.payload || '—'} <small style="color:var(--muted)">${m.sender_name}</small></div>
        <div class="mrow-meta">${m.date} ${m.time} · ${m.distance_m != null ? m.distance_m + ' m' : '?'}</div>
      </div>
      <button class="mrow-vis-btn">${m.hidden ? 'Show' : 'Hide'}</button>
    `;
    row.querySelector('.mrow-vis-btn').addEventListener('click', e => {
      e.stopPropagation();
      toggleRows([m.id], !m.hidden);
    });
    row.addEventListener('click', e => handleRowClick(m.id, e));
    row.addEventListener('mousedown', e => { if (e.shiftKey) e.preventDefault(); });
    frag.appendChild(row);
  });
  list.appendChild(frag);
}


// ── Settings & controls ───────────────────────────────────────────────────────

document.getElementById('sidebar-toggle').addEventListener('click', () => {
  const collapsed = document.getElementById('sidebar').classList.toggle('collapsed');
  document.getElementById('sidebar-toggle').textContent = collapsed ? '›' : '‹';
  document.body.classList.toggle('sidebar-closed', collapsed);
  setTimeout(() => map.invalidateSize(), 260);
});

document.getElementById('settings-toggle').addEventListener('click', () =>
  document.getElementById('settings-panel').classList.toggle('hidden'));
document.getElementById('settings-close').addEventListener('click', () =>
  document.getElementById('settings-panel').classList.add('hidden'));

document.querySelectorAll('.map-type-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.map-type-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    setMapType(btn.dataset.type);
  });
});

_showMarkersEl.addEventListener('change', function () {
  state.showMarkers = this.checked;
  _savePrefs({ showMarkers: state.showMarkers });
  this.checked ? pointLayer.addTo(map) : map.removeLayer(pointLayer);
});


document.getElementById('opacity').addEventListener('input', function () {
  state.opacity = parseFloat(this.value);
  document.getElementById('opacity-val').textContent = parseFloat(this.value).toFixed(2);
  _savePrefs({ opacity: state.opacity });
  // Opacity is baked into tiles by server; update URL params
  _applyTileUrl();
  _updateExportBox();
});

document.querySelectorAll('.preset-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeScale = btn.dataset.preset;
    updateLegendBar();
    renderMarkers(state.measurements);
    renderSidebar();
    _applyTileUrl();
    _updateExportBox();
    _savePrefs({ colorscale: activeScale });
  });
});

document.getElementById('invert-colors').addEventListener('change', function () {
  invertColors = this.checked;
  updateLegendBar();
  renderMarkers(state.measurements);
  renderSidebar();
  _applyTileUrl();
  _updateExportBox();
  _savePrefs({ invert: invertColors });
});

document.getElementById('search-box').addEventListener('input', function () {
  state.filter = this.value;
  clearSelection();
  renderSidebar();
});

document.getElementById('csv-input').addEventListener('change', function () {
  if (this.files[0]) { uploadCSV(this.files[0]); this.value = ''; }
});
document.getElementById('clear-btn').addEventListener('click', clearData);

map.on('click', clearSelection);


// ── Tile export panel ─────────────────────────────────────────────────────────
// Shows the actual heatmap-service tile URL with current settings baked in,
// so the user can paste it directly into OsmAnd / QGIS / curl.

function _exportTileUrl() {
  const p = new URLSearchParams({
    colorscale: activeScale,
    invert:     invertColors ? 1 : 0,
    opacity:    state.opacity.toFixed(2),
  });
  return `${window.HEATMAP_URL}/tiles/{z}/{x}/{y}.png?${p}`;
}

function _updateExportBox() {
  const box = document.getElementById('tile-export-url');
  if (box) box.textContent = _exportTileUrl();
}

async function loadTileMetadata() {
  try {
    const resp = await fetch(`${window.HEATMAP_URL}/tiles/metadata.json`);
    if (!resp.ok) return;
    const meta = await resp.json();

    _updateExportBox();

    document.getElementById('btn-copy-tile-url')?.addEventListener('click', () => {
      navigator.clipboard.writeText(_exportTileUrl()).then(() => {
        const btn = document.getElementById('btn-copy-tile-url');
        const orig = btn.textContent;
        btn.textContent = '✓ Copied!';
        setTimeout(() => { btn.textContent = orig; }, 1800);
      });
    });
    document.getElementById('btn-copy-tilejson')?.addEventListener('click', () => {
      const jsonUrl = `${window.HEATMAP_URL}/tiles/metadata.json`;
      navigator.clipboard.writeText(jsonUrl).then(() => {
        const btn = document.getElementById('btn-copy-tilejson');
        const orig = btn.textContent;
        btn.textContent = '✓ Copied!';
        setTimeout(() => { btn.textContent = orig; }, 1800);
      });
    });

    if (meta.bounds) {
      const [w, s, e, n] = meta.bounds;
      if (Math.abs(e - w) < 355) {
        map.fitBounds([[s, w], [n, e]], { padding: [40, 40] });
      }
    }
  } catch (e) {
    console.warn('TileJSON unavailable', e);
  }
}


// ── Boot ──────────────────────────────────────────────────────────────────────
// ── Boot ─────────────────────────────────────────────────────────────────────
// Restore persisted settings before anything renders.

// Map type
if (state.mapType !== 'osm') {
  setMapType(state.mapType);
  document.querySelectorAll('.map-type-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.type === state.mapType);
  });
}

// Color scale button
document.querySelectorAll('.preset-btn').forEach(b => {
  b.classList.toggle('active', b.dataset.preset === activeScale);
});

// Invert checkbox
document.getElementById('invert-colors').checked = invertColors;

updateLegendBar();

// Markers — applied last so browser form-restore cannot desync it
if (state.showMarkers) pointLayer.addTo(map);

(async () => {
  const data = await loadMeasurements();
  if (data.length) fitToData(data);
  await loadTileMetadata();
})();
