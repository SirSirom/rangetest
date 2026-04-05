/* ── app.js — Meshtastic Coverage Map ─────────────────────────────────────── */

// ── Color scales ──────────────────────────────────────────────────────────────
const COLOR_SCALES = {
  rdylbu:  [[215,48,39],[252,141,89],[254,224,144],[145,191,219],[69,117,180]],
  viridis: [[68,1,84],[58,82,139],[32,144,140],[94,201,97],[253,231,37]],
  plasma:  [[13,8,135],[126,3,167],[204,71,120],[248,149,64],[240,249,33]],
  greens:  [[247,252,245],[199,233,192],[116,196,118],[35,139,69],[0,68,27]],
};

let activeScale  = 'rdylbu';
let invertColors = false;
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
const state = {
  measurements: [],
  heatmapData:  null,
  mode:         'heatmap',
  mapType:      'osm',
  opacity:      0.65,
  resolution:   80,
  showMarkers:  true,
  showLinks:    false,
  filter:       '',
};

// Multi-select state
const selection = {
  ids:        new Set(),   // selected row IDs
  anchorId:   null,        // last clicked ID (for shift-range)
  filteredIds: [],         // ordered IDs currently visible in sidebar
};

const markerById = {};
let heatmapPending = false;


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
  white: L.tileLayer('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJAAZ9jggAAAABJRU5ErkJggg==', {
    attribution: '', maxZoom: 19,
  }),
};
tileLayers.osm.addTo(map);

function setMapType(type) {
  Object.values(tileLayers).forEach(l => { if (map.hasLayer(l)) map.removeLayer(l); });
  tileLayers[type].addTo(map);
  state.mapType = type;
}

const heatLayer  = L.layerGroup().addTo(map);
const triLayer   = L.layerGroup();
const pointLayer = L.layerGroup().addTo(map);
const linkLayer  = L.layerGroup();


// ── Heatmap ───────────────────────────────────────────────────────────────────
function renderHeatmap(data) {
  state.heatmapData = data;
  heatLayer.clearLayers();
  triLayer.clearLayers();
  if (!data) return;

  snrMin = data.snr_min;
  snrMax = data.snr_max;
  document.getElementById('leg-min').textContent = snrMin.toFixed(1) + ' dB';
  document.getElementById('leg-max').textContent = snrMax.toFixed(1) + ' dB';
  updateLegendBar();

  (data.grid_cells || []).forEach(cell => {
    L.rectangle(cell.bounds, {
      color: 'none', weight: 0,
      fillColor: snrColor(cell.snr),
      fillOpacity: state.opacity,
    }).addTo(heatLayer);
  });

  (data.triangles || []).forEach(tri => {
    L.polygon(tri.coords, {
      color: '#fff', weight: 1, opacity: 0.28,
      fillColor: snrColor(tri.snr),
      fillOpacity: state.opacity,
    }).bindPopup(`Avg SNR: ${tri.snr.toFixed(1)} dB`).addTo(triLayer);
  });

  applyMode();
}

function applyMode() {
  [heatLayer, triLayer].forEach(l => { if (map.hasLayer(l)) map.removeLayer(l); });
  if (state.mode === 'heatmap'   || state.mode === 'both') heatLayer.addTo(map);
  if (state.mode === 'triangles' || state.mode === 'both') triLayer.addTo(map);
}


// ── Markers ───────────────────────────────────────────────────────────────────
function renderMarkers(measurements) {
  pointLayer.clearLayers();
  linkLayer.clearLayers();
  Object.keys(markerById).forEach(k => delete markerById[k]);

  const locSender = {};
  const byLoc     = {};
  measurements.forEach(m => {
    const key = `${m.rx_lat.toFixed(7)},${m.rx_lon.toFixed(7)}`;
    locSender[key] = { slat: m.sender_lat, slon: m.sender_lon };
    (byLoc[key] = byLoc[key] || []).push(m);
  });

  Object.entries(byLoc).forEach(([key, rows]) => {
    const visible  = rows.filter(r => !r.hidden);
    const snr      = visible.length
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

    const { slat, slon } = locSender[key];
    L.polyline([[slat, slon], [lat, lon]], {
      color: '#fff', weight: 1, opacity: 0.15, dashArray: '4 5',
    }).addTo(linkLayer);
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

/**
 * Update the selection set and re-render toolbar + DOM highlights.
 * Does NOT touch the map or sidebar list order.
 */
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

/**
 * Handle a click on a sidebar row.
 * - Plain click:       select only this row, set anchor
 * - Ctrl/Cmd click:   toggle this row in the set
 * - Shift click:      range from anchor to this row
 */
function handleRowClick(id, e) {
  if (e.shiftKey && selection.anchorId !== null) {
    // Range select from anchorId to id using filteredIds order
    const a = selection.filteredIds.indexOf(selection.anchorId);
    const b = selection.filteredIds.indexOf(id);
    if (a !== -1 && b !== -1) {
      const lo = Math.min(a, b), hi = Math.max(a, b);
      const range = selection.filteredIds.slice(lo, hi + 1);
      // Keep anchor, add range (don't clear)
      range.forEach(rid => selection.ids.add(rid));
    }
  } else if (e.ctrlKey || e.metaKey) {
    // Toggle
    if (selection.ids.has(id)) {
      selection.ids.delete(id);
    } else {
      selection.ids.add(id);
      selection.anchorId = id;
    }
  } else {
    // Plain click — also pan to marker
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
  if (count === 0) {
    bar.classList.add('hidden');
    return;
  }
  bar.classList.remove('hidden');
  document.getElementById('selection-count').textContent =
    `${count} selected`;
}

// Toolbar button handlers
document.getElementById('sel-hide-btn').addEventListener('click', () => {
  toggleRows([...selection.ids], true);
  clearSelection();
});
document.getElementById('sel-show-btn').addEventListener('click', () => {
  toggleRows([...selection.ids], false);
  clearSelection();
});
document.getElementById('sel-delete-btn').addEventListener('click', async () => {
  const ids = [...selection.ids];
  if (!confirm(`Delete ${ids.length} measurement${ids.length !== 1 ? 's' : ''}?`)) return;
  clearSelection();
  await deleteRows(ids);
});
document.getElementById('sel-clear-btn').addEventListener('click', clearSelection);

// Highlight DOM rows (from map click — not a selection event, just scroll+flash)
function highlightDomRows(ids) {
  selectIds(ids, false);
  const first = document.querySelector('.mrow.selected');
  if (first) first.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}


// ── API — row mutations ───────────────────────────────────────────────────────

let _opQueue = Promise.resolve();

function toggleRows(ids, hide) {
  // Optimistic
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
    await fetchHeatmap();
  }).catch(e => console.error('Toggle error', e));
}

async function deleteRows(ids) {
  // Optimistic
  state.measurements = state.measurements.filter(m => !ids.includes(m.id));
  renderMarkers(state.measurements);
  renderSidebar();

  await Promise.all(ids.map(id =>
    fetch(`/api/measurements/${id}`, { method: 'DELETE' })
  ));
  await fetchHeatmap();
}


// ── API — data loading ────────────────────────────────────────────────────────

function setStatus(msg, cls = '') {
  const el = document.getElementById('import-status');
  el.textContent = msg;
  el.className   = cls;
}

async function loadMeasurements() {
  const res  = await fetch('/api/measurements?limit=100000');
  state.measurements = await res.json();
  renderMarkers(state.measurements);
  renderSidebar();
  return state.measurements;
}

async function fetchHeatmap() {
  if (heatmapPending) return;
  heatmapPending = true;
  document.getElementById('heatmap-spinner').classList.remove('hidden');
  try {
    const res  = await fetch('/api/heatmap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resolution: state.resolution }),
    });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    renderHeatmap(data);
    renderMarkers(state.measurements);
    renderSidebar();
  } catch (e) {
    console.error('Heatmap failed', e);
  } finally {
    heatmapPending = false;
    document.getElementById('heatmap-spinner').classList.add('hidden');
  }
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
    const data = await loadMeasurements();
    fitToData(data);
    await fetchHeatmap();
  } catch (e) {
    setStatus('Upload failed: ' + e.message, 'error');
  }
}

async function clearData() {
  if (!confirm('Delete all stored measurements?')) return;
  await fetch('/api/measurements', { method: 'DELETE' });
  state.measurements = [];
  state.heatmapData  = null;
  clearSelection();
  [heatLayer, triLayer, pointLayer, linkLayer].forEach(l => l.clearLayers());
  renderSidebar();
  document.getElementById('leg-min').textContent = '—';
  document.getElementById('leg-max').textContent = '—';
  setStatus('All data cleared.');
}

function fitToData(measurements) {
  const pts = measurements.map(m => [m.rx_lat, m.rx_lon]);
  if (pts.length) map.fitBounds(L.latLngBounds(pts), { padding: [40, 40] });
}


// ── Sidebar render ────────────────────────────────────────────────────────────
function renderSidebar() {
  const list  = document.getElementById('measurement-list');
  const noMsg = document.getElementById('no-data-msg');   // lives outside list
  const q     = state.filter.toLowerCase();

  const filtered = q
    ? state.measurements.filter(m =>
        (m.payload     || '').toLowerCase().includes(q) ||
        (m.sender_name || '').toLowerCase().includes(q) ||
        String(m.rx_snr).includes(q) ||
        `${m.date} ${m.time}`.includes(q))
    : state.measurements;

  // Store ordered IDs for shift-range calculation
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
    const color = snrColor(m.rx_snr);
    const isSelected = selection.ids.has(m.id);
    const row = document.createElement('div');
    row.className  = ['mrow', m.hidden ? 'is-hidden' : '', isSelected ? 'selected' : '']
                       .filter(Boolean).join(' ');
    row.dataset.id = m.id;
    row.innerHTML = `
      <span class="mrow-snr" style="color:${color}">${m.rx_snr.toFixed(1)}</span>
      <div class="mrow-info">
        <div class="mrow-main">${m.payload || '—'} <small style="color:var(--muted)">${m.sender_name}</small></div>
        <div class="mrow-meta">${m.date} ${m.time} · ${m.distance_m != null ? m.distance_m + ' m' : '?'}</div>
      </div>
      <button class="mrow-vis-btn">${m.hidden ? 'Show' : 'Hide'}</button>
    `;

    // Vis button: toggle single row, don't bubble to row click
    row.querySelector('.mrow-vis-btn').addEventListener('click', e => {
      e.stopPropagation();
      toggleRows([m.id], !m.hidden);
    });

    // Row click: multi-select logic
    row.addEventListener('click', e => handleRowClick(m.id, e));

    // Prevent text selection on shift-click
    row.addEventListener('mousedown', e => {
      if (e.shiftKey) e.preventDefault();
    });

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

document.getElementById('show-markers').addEventListener('change', function () {
  this.checked ? pointLayer.addTo(map) : map.removeLayer(pointLayer);
});
document.getElementById('show-links').addEventListener('change', function () {
  this.checked ? linkLayer.addTo(map) : map.removeLayer(linkLayer);
});

document.querySelectorAll('.mode-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.mode = btn.dataset.mode;
    applyMode();
  });
});

document.getElementById('resolution').addEventListener('input', function () {
  state.resolution = parseInt(this.value);
  document.getElementById('res-val').textContent = this.value;
  clearTimeout(this._t);
  this._t = setTimeout(fetchHeatmap, 700);
});

document.getElementById('opacity').addEventListener('input', function () {
  state.opacity = parseFloat(this.value);
  document.getElementById('opacity-val').textContent = parseFloat(this.value).toFixed(2);
  heatLayer.eachLayer(l => l.setStyle({ fillOpacity: state.opacity }));
  triLayer.eachLayer(l => l.setStyle({ fillOpacity: state.opacity }));
});

document.querySelectorAll('.preset-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeScale = btn.dataset.preset;
    renderHeatmap(state.heatmapData);
    renderMarkers(state.measurements);
    renderSidebar();
    updateLegendBar();
  });
});

document.getElementById('invert-colors').addEventListener('change', function () {
  invertColors = this.checked;
  renderHeatmap(state.heatmapData);
  renderMarkers(state.measurements);
  renderSidebar();
  updateLegendBar();
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

// Clicking the map background clears selection
map.on('click', clearSelection);


// ── Boot ──────────────────────────────────────────────────────────────────────
updateLegendBar();
(async () => {
  const data = await loadMeasurements();
  if (data.length) {
    fitToData(data);
    await fetchHeatmap();
  }
})();
