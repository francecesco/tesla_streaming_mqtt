/*
 * tesla-cards.js — card Lovelace per Tesla Fleet Telemetry → Home Assistant
 *
 *   custom:tesla-trips-card   mappa + elenco viaggi (dallo storico del recorder)
 *   custom:tesla-stats-card   km, costi ed energia caricata: numeri + andamento 12 mesi
 *
 * Nessuna dipendenza da HACS. La mappa usa Leaflet (caricato da unpkg) e le tile OpenStreetMap;
 * i nomi dei luoghi fuori dalle zone di HA arrivano da Nominatim (OSM), con cache locale.
 */
const VERSION = '1.1.0';

const fmtNum = (v, d = 0) =>
  v === null || v === undefined || isNaN(v)
    ? '—'
    : Number(v).toLocaleString('it-IT', { minimumFractionDigits: d, maximumFractionDigits: d, useGrouping: 'always' });
const MONTHS = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'];
const MONTHS_LONG = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto',
  'settembre', 'ottobre', 'novembre', 'dicembre'];
const asList = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
const lsGet = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } };

const BASE_CSS = `
  :host { display: block; }
  ha-card { overflow: hidden; color: var(--primary-text-color); }
  .muted { color: var(--secondary-text-color); }
`;

/* ───────────────────────────── viaggi ───────────────────────────── */

const LEAFLET = 'https://unpkg.com/leaflet@1.9.4/dist';
let leafletPromise;
const loadLeaflet = () => (leafletPromise ||= import(`${LEAFLET}/leaflet-src.esm.js`));

const haversine = (a, b) => {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b[0] - a[0]) * rad, dLon = (b[1] - a[1]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

// coda Nominatim: max 1 richiesta/s, risultati in localStorage
const geoQueue = [];
let geoBusy = false;
function reverseGeocode(lat, lon) {
  const key = `tesla-geo:${lat.toFixed(3)},${lon.toFixed(3)}`;
  const hit = lsGet(key);
  if (hit) return Promise.resolve(hit);
  return new Promise((resolve) => {
    geoQueue.push({ lat, lon, key, resolve });
    pumpGeo();
  });
}
async function pumpGeo() {
  if (geoBusy) return;
  geoBusy = true;
  while (geoQueue.length) {
    const { lat, lon, key, resolve } = geoQueue.shift();
    let name = null;
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=17&accept-language=it&lat=${lat}&lon=${lon}`);
      if (r.ok) {
        const j = await r.json(), a = j.address || {};
        const place = a.road || a.pedestrian || a.suburb || a.neighbourhood || a.hamlet;
        const town = a.city || a.town || a.village || a.municipality;
        name = [place, town].filter(Boolean).join(', ') || j.name || null;
      }
    } catch (e) { /* offline o bloccato */ }
    if (name) lsSet(key, name);
    resolve(name);
    await new Promise((res) => setTimeout(res, 1100));
  }
  geoBusy = false;
}

class TeslaTripsCard extends HTMLElement {
  setConfig(config) {
    this._cfg = {
      tracker: 'device_tracker.tesla_posizione',
      odometer: 'sensor.tesla_contachilometri',
      battery: 'sensor.tesla_batteria',
      gear: 'sensor.tesla_marcia',
      days: 10,
      visible: 6,
      map_height: 260,
      min_km: 0.3,
      ...config,
    };
    this._trips = [];
    this._sel = 0;
    this._showAll = false;
    this._names = {};
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (first) { this._render(); this._load(); return; }
    // ricarica quando l'auto si ferma (marcia → P / sconosciuta)
    const g = hass.states[this._cfg.gear]?.state;
    if (this._lastGear && ['D', 'R', 'N'].includes(this._lastGear) && !['D', 'R', 'N'].includes(g)) {
      clearTimeout(this._reload);
      this._reload = setTimeout(() => this._load(), 20000);
    }
    this._lastGear = g;
  }

  getCardSize() { return 8; }
  getGridOptions() { return { columns: 12, rows: 'auto', min_columns: 6 }; }

  _render() {
    if (this.shadowRoot) return;
    const root = this.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <link rel="stylesheet" href="${LEAFLET}/leaflet.css">
      <style>${BASE_CSS}
        .map { height: ${this._cfg.map_height}px; background: var(--secondary-background-color); z-index: 0; }
        .leaflet-container { font: inherit; font-size: 12px; }
        .leaflet-control-attribution { font-size: 10px; }
        .leaflet-tile-pane { filter: saturate(.55) brightness(1.04) contrast(.96); }
        .sum { padding: 12px 16px 6px; }
        .sum .route { font-size: 15px; font-weight: 600; line-height: 1.3; }
        .sum .meta { display: flex; flex-wrap: wrap; gap: 4px 14px; margin-top: 4px; font-size: 12.5px; }
        .sum .meta b { color: var(--primary-text-color); font-weight: 600; }
        .list { padding: 4px 8px 10px; }
        .day { font-size: 11px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase;
               color: var(--secondary-text-color); padding: 10px 8px 4px; }
        .trip { display: grid; grid-template-columns: 44px 1fr auto; gap: 10px; align-items: center;
                padding: 8px; border-radius: 10px; cursor: pointer; transition: background .15s; }
        .trip:hover { background: var(--secondary-background-color); }
        .trip.sel { background: rgba(var(--rgb-primary-color, 3, 169, 244), .12); }
        .trip .t { font-size: 13px; font-weight: 600; }
        .trip .r { font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .trip .k { text-align: right; font-size: 13px; font-weight: 600; white-space: nowrap; }
        .trip .k span { display: block; font-size: 11px; font-weight: 400; color: var(--secondary-text-color); }
        .more { display: block; width: 100%; margin-top: 4px; padding: 8px; border: 0; background: none;
                color: var(--primary-color); font: inherit; font-size: 13px; cursor: pointer; border-radius: 10px; }
        .more:hover { background: var(--secondary-background-color); }
        .empty { padding: 18px 16px; font-size: 13px; }
        .pin { width: 12px; height: 12px; border-radius: 50%; border: 3px solid #fff;
               box-shadow: 0 1px 4px rgba(0,0,0,.35); box-sizing: content-box; }
      </style>
      <ha-card>
        <div class="map"></div>
        <div class="sum"></div>
        <div class="list"></div>
      </ha-card>`;
    this._mapEl = root.querySelector('.map');
    this._sumEl = root.querySelector('.sum');
    this._listEl = root.querySelector('.list');
    this._listEl.addEventListener('click', (ev) => {
      const t = ev.target.closest('[data-i]');
      if (t) { this._sel = Number(t.dataset.i); this._draw(); }
      if (ev.target.closest('.more')) { this._showAll = !this._showAll; this._draw(); }
    });
  }

  async _ensureMap() {
    if (this._map) return this._map;
    const L = await loadLeaflet();
    this._L = L;
    this._map = L.map(this._mapEl, { zoomControl: false, attributionControl: true, scrollWheelZoom: false });
    L.control.zoom({ position: 'topright' }).addTo(this._map);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      // HA imposta <meta name="referrer" content="same-origin">: senza un Referer esplicito
      // i server OSM rispondono 403 "Access blocked" (tile usage policy). Stessa scelta del map card di HA.
      referrerPolicy: 'strict-origin-when-cross-origin',
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(this._map);
    this._layer = L.layerGroup().addTo(this._map);
    new ResizeObserver(() => this._map.invalidateSize()).observe(this._mapEl);
    return this._map;
  }

  async _load() {
    const c = this._cfg;
    const end = new Date();
    const start = new Date(end.getTime() - c.days * 864e5);
    let h = {};
    try {
      h = await this._hass.callWS({
        type: 'history/history_during_period',
        start_time: start.toISOString(), end_time: end.toISOString(),
        entity_ids: [c.tracker, c.odometer, c.battery, c.gear],
        minimal_response: false, no_attributes: false, significant_changes_only: false,
      });
    } catch (e) { console.warn('tesla-trips-card: history', e); }
    this._trips = this._segment(h);
    this._sel = Math.min(this._sel, Math.max(0, this._trips.length - 1));
    await this._ensureMap();
    this._draw();
  }

  _segment(h) {
    const c = this._cfg;
    const ts = (s) => (s.lu ?? s.lc) * 1000;
    const pts = [];
    let lastA = null;
    for (const s of h[c.tracker] || []) {
      const a = s.a || lastA;
      lastA = a;
      if (a && typeof a.latitude === 'number') pts.push({ t: ts(s), ll: [a.latitude, a.longitude], z: s.s });
    }
    const series = (id) => (h[id] || []).map((s) => ({ t: ts(s), v: parseFloat(s.s) })).filter((x) => !isNaN(x.v));
    const odo = series(c.odometer), bat = series(c.battery);
    const at = (arr, t) => { let v = null; for (const x of arr) { if (x.t <= t) v = x.v; else break; } return v; };
    const after = (arr, t) => { for (const x of arr) if (x.t >= t) return x.v; return arr.length ? arr[arr.length - 1].v : null; };

    // 1) intervalli di guida dalla marcia (R/N/D); 2) in mancanza, pause > 10 min tra le posizioni
    let spans = [];
    let cur = null;
    for (const s of h[c.gear] || []) {
      const t = ts(s), driving = ['D', 'R', 'N'].includes(s.s);
      if (driving && !cur) cur = [t, null];
      if (!driving && cur) { cur[1] = t; spans.push(cur); cur = null; }
    }
    if (cur) { cur[1] = Date.now(); spans.push(cur); }
    spans = spans.reduce((acc, sp) => {
      const prev = acc[acc.length - 1];
      if (prev && sp[0] - prev[1] < 180e3) prev[1] = sp[1]; else acc.push([...sp]);
      return acc;
    }, []);
    if (!spans.length && pts.length > 1) {
      let s0 = pts[0].t, prevT = pts[0].t;
      for (const p of pts.slice(1)) {
        if (p.t - prevT > 600e3) { spans.push([s0, prevT]); s0 = p.t; }
        prevT = p.t;
      }
      spans.push([s0, prevT]);
    }

    const trips = [];
    for (const [t0, t1] of spans) {
      const before = pts.filter((p) => p.t <= t0).pop();
      const inside = pts.filter((p) => p.t > t0 && p.t <= t1 + 60e3);
      const path = [...(before ? [before] : []), ...inside];
      if (path.length < 2) continue;
      let km = null;
      const o0 = at(odo, t0) ?? after(odo, t0), o1 = at(odo, t1 + 90e3);
      if (o0 !== null && o1 !== null && o1 >= o0) km = o1 - o0;
      if (km === null || km === 0) km = path.reduce((s, p, i) => (i ? s + haversine(path[i - 1].ll, p.ll) : 0), 0);
      if (km < c.min_km) continue;
      const b0 = at(bat, t0), b1 = after(bat, t1 + 60e3);
      trips.push({
        t0, t1, km, path: path.map((p) => p.ll),
        from: path[0], to: path[path.length - 1],
        soc: b0 !== null && b1 !== null ? b1 - b0 : null,
      });
    }
    return trips.reverse(); // più recente in alto
  }

  _place(p) {
    const z = p.z;
    if (z === 'home') return 'Casa';
    if (z && !['not_home', 'unknown', 'unavailable'].includes(z)) return z;
    const key = p.ll.map((v) => v.toFixed(3)).join(',');
    if (this._names[key]) return this._names[key];
    if (!(key in this._names)) {
      this._names[key] = null;
      reverseGeocode(p.ll[0], p.ll[1]).then((n) => { this._names[key] = n || `${p.ll[0].toFixed(3)}, ${p.ll[1].toFixed(3)}`; this._drawList(); this._drawSummary(); });
    }
    return '…';
  }

  _draw() { this._drawMap(); this._drawSummary(); this._drawList(); }

  _drawMap() {
    const L = this._L, m = this._map;
    if (!L || !m) return;
    this._layer.clearLayers();
    const pin = (color) => L.divIcon({ className: '', html: `<div class="pin" style="background:${color}"></div>`, iconSize: [18, 18], iconAnchor: [9, 9] });
    const trip = this._trips[this._sel];
    if (!trip) {
      const a = this._hass.states[this._cfg.tracker]?.attributes;
      if (a && typeof a.latitude === 'number') {
        L.marker([a.latitude, a.longitude], { icon: pin('#e53935') }).addTo(this._layer);
        m.setView([a.latitude, a.longitude], 14);
      }
      return;
    }
    L.polyline(trip.path, { color: '#ffffff', weight: 9, opacity: 0.9, lineJoin: 'round' }).addTo(this._layer);
    L.polyline(trip.path, { color: '#3e7bfa', weight: 5, opacity: 1, lineJoin: 'round' }).addTo(this._layer);
    L.marker(trip.path[0], { icon: pin('#43a047') }).addTo(this._layer);
    L.marker(trip.path[trip.path.length - 1], { icon: pin('#e53935') }).addTo(this._layer);
    m.fitBounds(L.latLngBounds(trip.path), { padding: [28, 28], maxZoom: 16 });
  }

  _drawSummary() {
    const trip = this._trips[this._sel];
    if (!trip) {
      this._sumEl.innerHTML = `<div class="empty muted">Nessun viaggio negli ultimi ${this._cfg.days} giorni.
        La mappa mostra la posizione attuale.</div>`;
      return;
    }
    const hm = (t) => new Date(t).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
    const min = Math.max(1, Math.round((trip.t1 - trip.t0) / 60e3));
    const dur = min >= 60 ? `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')}′` : `${min}′`;
    const avg = trip.km / ((trip.t1 - trip.t0) / 3600e3);
    this._sumEl.innerHTML = `
      <div class="route">${this._place(trip.from)} → ${this._place(trip.to)}</div>
      <div class="meta muted">
        <span>${hm(trip.t0)}–${hm(trip.t1)}</span>
        <span><b>${fmtNum(trip.km, 1)}</b> km</span>
        <span><b>${dur}</b></span>
        ${isFinite(avg) ? `<span>media <b>${fmtNum(avg)}</b> km/h</span>` : ''}
        ${trip.soc !== null ? `<span>batteria <b>${trip.soc > 0 ? '+' : ''}${fmtNum(trip.soc)}%</b></span>` : ''}
      </div>`;
  }

  _drawList() {
    if (!this._trips.length) { this._listEl.innerHTML = ''; return; }
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const dayLabel = (t) => {
      const d = new Date(t); d.setHours(0, 0, 0, 0);
      const diff = Math.round((today - d) / 864e5);
      if (diff === 0) return 'Oggi';
      if (diff === 1) return 'Ieri';
      return d.toLocaleDateString('it-IT', { weekday: 'short', day: 'numeric', month: 'short' });
    };
    const n = this._showAll ? this._trips.length : Math.min(this._cfg.visible, this._trips.length);
    let html = '', lastDay = '';
    this._trips.slice(0, n).forEach((t, i) => {
      const dl = dayLabel(t.t0);
      if (dl !== lastDay) { html += `<div class="day">${dl}</div>`; lastDay = dl; }
      const min = Math.max(1, Math.round((t.t1 - t.t0) / 60e3));
      html += `<div class="trip ${i === this._sel ? 'sel' : ''}" data-i="${i}">
        <div class="t">${new Date(t.t0).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}</div>
        <div class="r">${this._place(t.from)} → ${this._place(t.to)}</div>
        <div class="k">${fmtNum(t.km, 1)} km<span>${min >= 60 ? `${Math.floor(min / 60)} h ${min % 60}′` : `${min}′`}</span></div>
      </div>`;
    });
    if (this._trips.length > this._cfg.visible) {
      html += `<button class="more">${this._showAll ? 'Mostra meno' : `Mostra tutti (${this._trips.length})`}</button>`;
    }
    this._listEl.innerHTML = html;
  }
}

/* ─────────────────────────── statistiche ─────────────────────────── */

class TeslaStatsCard extends HTMLElement {
  setConfig(config) {
    this._cfg = {
      title: 'Statistiche',
      months: 12,
      odometer: ['sensor.tesla_contachilometri'],
      energy: ['sensor.tesla_energia_ricarica_ac_sessione', 'sensor.tesla_energia_ricarica_dc_sessione'],
      energy_legacy: [],
      energy_home: null,
      cost: null,
      ...config,
    };
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (first) {
      this._render();
      this._load();
      this._timer = setInterval(() => this._load(), 30 * 60e3);
    }
  }

  disconnectedCallback() { clearInterval(this._timer); this._timer = null; }
  connectedCallback() { if (this._hass && !this._timer) { this._load(); this._timer = setInterval(() => this._load(), 30 * 60e3); } }
  getCardSize() { return 5; }
  getGridOptions() { return { columns: 12, rows: 'auto', min_columns: 6 }; }

  _render() {
    if (this.shadowRoot) return;
    const root = this.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>${BASE_CSS}
        ha-card { padding: 14px 16px 6px; }
        .hd { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 2px; }
        .hd .ti { font-size: 15px; font-weight: 600; }
        .hd .mo { font-size: 12.5px; }
        .row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(120px, 46%); gap: 12px; align-items: center;
               padding: 12px 0; border-bottom: 1px solid var(--divider-color); }
        .row:last-child { border-bottom: 0; }
        .lb { font-size: 11px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--secondary-text-color); }
        .vl { font-size: 28px; font-weight: 700; line-height: 1.15; margin-top: 2px; white-space: nowrap; }
        .vl small { font-size: 15px; font-weight: 500; margin-left: 2px; }
        .sb { font-size: 12.5px; margin-top: 2px; }
        .sb .good { color: #2e7d32; } .sb .bad { color: #d84315; }
        .sp { position: relative; height: 64px; touch-action: none; }
        .bars { display: flex; align-items: flex-end; gap: 3px; height: 100%; }
        .col { flex: 1; height: 100%; display: flex; align-items: flex-end; }
        .b { width: 100%; background: var(--c); opacity: .32; border-radius: 4px 4px 1.5px 1.5px; transition: opacity .15s, height .6s ease; }
        .b.cur { opacity: 1; }
        .b.nd { background: var(--divider-color, #e5e7eb); opacity: 1; }
        .sp.hov .b:not(.nd) { opacity: .22; }
        .sp.hov .col.hl .b:not(.nd) { opacity: 1; }
        .tip { position: absolute; top: -6px; transform: translateX(-50%); font-size: 11px; font-weight: 600; white-space: nowrap;
               background: var(--card-background-color, #fff); padding: 1px 6px; border-radius: 6px;
               box-shadow: 0 1px 4px rgba(0,0,0,.15); pointer-events: none; opacity: 0; transition: opacity .12s; }
        .sp:hover .tip, .sp.touch .tip { opacity: 1; }
        .ax { display: flex; gap: 3px; font-size: 10px; color: var(--secondary-text-color); margin-top: 3px; }
        .ax span { flex: 1; text-align: center; }
        .ax span.cur { color: var(--primary-text-color); font-weight: 600; }
      </style>
      <ha-card>
        <div class="hd"><span class="ti">${this._cfg.title}</span><span class="mo muted"></span></div>
        <div class="rows"><div class="row"><div class="muted">Caricamento…</div></div></div>
      </ha-card>`;
    this._rowsEl = root.querySelector('.rows');
    this._moEl = root.querySelector('.mo');
  }

  async _stats(ids, types) {
    ids = asList(ids);
    if (!ids.length) return {};
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth() - this._cfg.months, 1);
    try {
      return await this._hass.callWS({
        type: 'recorder/statistics_during_period',
        start_time: start.toISOString(), statistic_ids: ids, period: 'month', types,
      });
    } catch (e) { console.warn('tesla-stats-card', e); return {}; }
  }

  async _load() {
    const c = this._cfg;
    const now = new Date();
    // chiavi mese: gli ultimi `months` mesi incluso il corrente, più quello precedente (base contachilometri)
    const keys = [];
    for (let i = c.months; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      keys.push(`${d.getFullYear()}-${d.getMonth()}`);
    }
    const mk = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${d.getMonth()}`; };
    const [odoS, enS, legS, homeS, costS] = await Promise.all([
      this._stats(c.odometer, ['state']),
      this._stats(c.energy, ['change']),
      this._stats(c.energy_legacy, ['change']),
      this._stats(c.energy_home, ['change']),
      this._stats(c.cost, ['state']),
    ]);
    const per = (res, ids, field, combine) => {
      const out = {};
      for (const id of asList(ids)) for (const r of res[id] || []) {
        const v = r[field];
        if (v === null || v === undefined) continue;
        const k = mk(r.start);
        out[k] = k in out ? combine(out[k], v) : v;
      }
      return out;
    };
    // km: lettura del contachilometri a fine mese (massimo tra le fonti) → differenza tra mesi
    const odoEnd = per(odoS, c.odometer, 'state', Math.max);
    const km = keys.slice(1).map((k, i) => {
      const a = odoEnd[keys[i]], b = odoEnd[k];
      if (b === undefined) return null;
      if (a === undefined) return null;
      return Math.max(0, b - a);
    });
    // energia: somma delle sessioni AC+DC; con una fonte "legacy" prende il massimo per mese
    const enNew = per(enS, c.energy, 'change', (a, b) => a + b);
    const enOld = per(legS, c.energy_legacy, 'change', (a, b) => a + b);
    const energy = keys.slice(1).map((k) => {
      const v = [enNew[k], enOld[k]].filter((x) => x !== undefined);
      return v.length ? Math.max(...v) : null;
    });
    const homeM = per(homeS, c.energy_home, 'change', (a, b) => a + b);
    const home = keys.slice(1).map((k) => (k in homeM ? homeM[k] : null));
    const costM = per(costS, c.cost, 'state', Math.max);
    const cost = keys.slice(1).map((k) => (k in costM ? costM[k] : null));
    const labels = keys.slice(1).map((k) => MONTHS[Number(k.split('-')[1])]);
    this._data = { km, energy, home, cost, labels };
    this._draw();
  }

  _draw() {
    const { km, energy, home, cost, labels } = this._data;
    const L = km.length - 1;
    const now = new Date();
    this._moEl.textContent = `${MONTHS_LONG[now.getMonth()]} ${now.getFullYear()}`;
    const avg = (arr) => { const v = arr.slice(0, L).filter((x) => x !== null && x > 0); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
    const day = now.getDate(), dim = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const rows = [];

    const kmAvg = avg(km);
    const kmProj = km[L] !== null ? km[L] / day * dim : null;
    rows.push(this._row('Km percorsi', fmtNum(km[L]), 'km',
      kmAvg ? `media ${fmtNum(kmAvg)} km/mese · proiezione <b>${fmtNum(kmProj)}</b>` : '', km, labels, 'km', '#3e7bfa'));

    if (this._cfg.cost) {
      const prev = cost[L - 1];
      const eurKm = cost[L] !== null && km[L] ? cost[L] / km[L] * 100 : null;
      rows.push(this._row('Costo ricariche a casa', fmtNum(cost[L], 2), '€',
        `${prev !== null ? `${MONTHS_LONG[(now.getMonth() + 11) % 12]} ${fmtNum(prev, 2)} €` : ''}${eurKm !== null ? ` · <b>${fmtNum(eurKm, 2)}</b> €/100 km` : ''}`,
        cost, labels, '€', '#2e9d5b', 2));
    }

    let sub = '';
    if (this._cfg.energy_home && energy[L]) {
      const pct = Math.min(100, Math.round((home[L] || 0) / energy[L] * 100));
      sub = `<b>${pct}%</b> a casa · ${fmtNum(Math.max(0, energy[L] - (home[L] || 0)))} kWh fuori`;
    }
    rows.push(this._row('Energia caricata', fmtNum(energy[L]), 'kWh', sub, energy, labels, 'kWh', '#f59e0b'));
    this._rowsEl.innerHTML = rows.join('');
    this._rowsEl.querySelectorAll('.sp').forEach((el) => this._wireTip(el));
  }

  _row(label, value, unit, sub, series, labels, u, color, dec = 0) {
    // istogramma a colonne verticali: mese corrente pieno, mesi precedenti attenuati
    const vals = series.map((v) => (v === null || v === undefined ? null : v));
    const max = Math.max(...vals.filter((v) => v !== null), 0) || 1;
    const L = vals.length - 1;
    const bars = vals.map((v, i) => {
      const hgt = v === null ? 0 : Math.max(2, (v / max) * 100);
      return `<div class="col" data-i="${i}"><div class="b ${i === L ? 'cur' : ''} ${v === null ? 'nd' : ''}"
        style="height:${v === null ? 3 : hgt}%;--c:${color}"></div></div>`;
    }).join('');
    const ax = labels.map((l, i) => `<span class="${i === L ? 'cur' : ''}">${l.charAt(0).toUpperCase()}</span>`).join('');
    const data = JSON.stringify(vals.map((v, i) => [labels[i], v]));
    return `<div class="row">
      <div><div class="lb">${label}</div><div class="vl">${value}<small>${unit}</small></div><div class="sb muted">${sub}</div></div>
      <div><div class="sp" data-u="${u}" data-d="${dec}" data-v='${data}'><div class="bars">${bars}</div><div class="tip"></div></div>
        <div class="ax">${ax}</div></div>
    </div>`;
  }

  _wireTip(el) {
    const data = JSON.parse(el.dataset.v), tip = el.querySelector('.tip');
    const cols = [...el.querySelectorAll('.col')];
    const u = el.dataset.u, dec = Number(el.dataset.d);
    const show = (clientX) => {
      const r = el.getBoundingClientRect();
      const i = Math.min(cols.length - 1, Math.max(0, Math.floor((clientX - r.left) / r.width * cols.length)));
      const [lbl, v] = data[i];
      cols.forEach((c, j) => c.classList.toggle('hl', j === i));
      el.classList.add('hov');
      tip.textContent = `${lbl} · ${v === null ? 'n.d.' : `${fmtNum(v, dec)} ${u}`}`;
      tip.style.left = `${Math.min(Math.max((i + 0.5) / cols.length * 100, 14), 86)}%`;
    };
    const hide = () => { el.classList.remove('touch', 'hov'); cols.forEach((c) => c.classList.remove('hl')); };
    el.addEventListener('pointermove', (e) => show(e.clientX));
    el.addEventListener('pointerdown', (e) => { el.classList.add('touch'); show(e.clientX); });
    el.addEventListener('pointerleave', hide);
  }
}

if (!customElements.get('tesla-trips-card')) customElements.define('tesla-trips-card', TeslaTripsCard);
if (!customElements.get('tesla-stats-card')) customElements.define('tesla-stats-card', TeslaStatsCard);
window.customCards = window.customCards || [];
window.customCards.push(
  { type: 'tesla-trips-card', name: 'Tesla – Viaggi', description: 'Mappa ed elenco dei viaggi dallo storico di Home Assistant' },
  { type: 'tesla-stats-card', name: 'Tesla – Statistiche', description: 'Km, costi ed energia caricata: valore del mese e andamento' },
);
console.info(`%c tesla-cards %c ${VERSION} `, 'background:#3e7bfa;color:#fff;border-radius:3px 0 0 3px', 'background:#eee;border-radius:0 3px 3px 0');
