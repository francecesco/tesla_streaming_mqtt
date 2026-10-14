/*
 * energia-cards.js — card Lovelace per i consumi elettrici di casa (tariffe a fasce F1/F2/F3)
 *
 *   custom:energia-summary-card   bolletta del mese scomposta (Tesla / clima / casa / quota fissa),
 *                                 kWh per fascia, totale e per utilizzo (Tesla / clima / casa)
 *   custom:energia-mesi-card      ultimi 12 mesi: spesa in € e consumi in kWh, a colonne
 *   custom:energia-colonne-card   contenitore: card affiancate in colonne della stessa altezza a colonne
 *   custom:energia-flow-card      flusso dell'energia del mese (rete → Tesla, clima, casa) + chi consuma adesso
 *   custom:energia-day-card       la giornata: potenza nelle 24 ore su sfondo colorato per fascia, eventi
 *
 * La Tesla e il clima sono SOTTO-contatori: la loro energia è già compresa nel contatore generale,
 * quindi "Casa" = totale − Tesla − clima. Colori delle fasce assegnati in base al prezzo
 * (la più cara rossa, la più economica verde). Nessuna dipendenza esterna.
 */
const E_VERSION = '1.3.0';

const nf = (v, d = 0) => (v === null || v === undefined || isNaN(v) ? '—'
  : Number(v).toLocaleString('it-IT', { minimumFractionDigits: d, maximumFractionDigits: d, useGrouping: 'always' }));
const MESI = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'];
const MESI_L = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];
const num = (hass, id) => { const v = parseFloat(hass.states[id]?.state); return isNaN(v) ? null : v; };
const sum = (arr) => arr.reduce((a, b) => a + (b || 0), 0);
const COL = { tesla: '#3e7bfa', clima: '#0ea5e9', casa: '#94a3b8', fissa: '#cbd5e1' };

const DEF = {
  bolletta: 'sensor.bolletta_stimata_mese',
  costo_casa: 'sensor.casa_costo_energia_mese',
  costo_tesla: 'sensor.tesla_costo_mese_fasce',
  costo_clima: 'sensor.condizionatore_costo_mese',
  quota_fissa: 'input_number.quota_fissa_mensile_casa',
  kwh_mese: 'sensor.consumo_luce_mensile',
  kwh_casa_fasce: ['sensor.casa_zha_consumi_casa_casa_energia_fasce_f1', 'sensor.casa_zha_consumi_casa_casa_energia_fasce_f2', 'sensor.casa_zha_consumi_casa_casa_energia_fasce_f3'],
  kwh_tesla_fasce: ['sensor.tesla_energia_fasce_f1', 'sensor.tesla_energia_fasce_f2', 'sensor.tesla_energia_fasce_f3'],
  kwh_clima_fasce: ['sensor.consumi_condizionatore_channel_1_condizionatore_energia_fasce_f1', 'sensor.consumi_condizionatore_channel_1_condizionatore_energia_fasce_f2', 'sensor.consumi_condizionatore_channel_1_condizionatore_energia_fasce_f3'],
  prezzi: ['input_number.prezzo_kwh_f1', 'input_number.prezzo_kwh_f2', 'input_number.prezzo_kwh_f3'],
  // contatori cumulativi (total_increasing) per lo storico mensile
  totale_kwh: 'sensor.energia_totale_casa',
  tesla_kwh: 'sensor.tesla_energy_home_charged',
  clima_kwh: 'sensor.consumi_condizionatore_channel_1_energia',
  potenza: 'sensor.zha_consumi_instantaneous_demand',
  fascia: 'sensor.fascia_corrente',
  prezzo_attuale: 'sensor.prezzo_kwh_attuale',
  festivo: 'calendar.festivita_in_italia',
  costo_oggi: 'sensor.casa_costo_energia_oggi',
  kwh_giorno_fasce: ['sensor.casa_zha_consumi_casa_casa_energia_fasce_giorno_f1', 'sensor.casa_zha_consumi_casa_casa_energia_fasce_giorno_f2', 'sensor.casa_zha_consumi_casa_casa_energia_fasce_giorno_f3'],
  kwh_oggi: 'sensor.consumo_luce_giornaliero',
};

// colori fasce per prezzo: [F1, F2, F3] → la più cara rossa, la media ambra, la più economica verde
function bandColors(hass, prezzi) {
  const p = prezzi.map((id, i) => ({ i, v: num(hass, id) ?? i }));
  const order = [...p].sort((a, b) => b.v - a.v).map((x) => x.i);
  const pal = ['#ef4444', '#f59e0b', '#22c55e'];
  const out = [];
  order.forEach((idx, rank) => { out[idx] = pal[rank]; });
  return out;
}
// regola delle fasce ARERA (uguale al template sensor.fascia_corrente)
function bandAt(d, festivo) {
  const wd = d.getDay(), h = d.getHours();
  if (wd === 0 || festivo) return 2;
  if (wd === 6) return h >= 7 && h < 23 ? 1 : 2;
  if (h >= 8 && h < 19) return 0;
  if (h === 7 || (h >= 19 && h < 23)) return 1;
  return 2;
}

const CSS = `
  :host { display: block; }
  ha-card { padding: 14px 16px; color: var(--primary-text-color); overflow: hidden; height: 100%; box-sizing: border-box; }
  .muted { color: var(--secondary-text-color); }
  .hd { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
  .ti { font-size: 15px; font-weight: 600; }
  .lb { font-size: 11px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--secondary-text-color); }
  .big { font-size: 34px; font-weight: 700; line-height: 1.1; white-space: nowrap; }
  .big small { font-size: 17px; font-weight: 500; margin-left: 2px; }
  .sec { margin-top: 16px; }
  .seg { display: flex; height: 14px; border-radius: 7px; overflow: hidden; gap: 2px; margin: 8px 0 6px; background: var(--divider-color); }
  .seg div { height: 100%; transition: width .6s ease; }
  .leg { display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 12px; }
  .leg span { display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; }
  .leg i { width: 9px; height: 9px; border-radius: 3px; display: inline-block; }
  .leg b { font-weight: 600; }
  .tip { position: absolute; top: -4px; transform: translateX(-50%); font-size: 11px; font-weight: 600; white-space: nowrap;
         background: var(--card-background-color, #fff); padding: 2px 7px; border-radius: 6px; box-shadow: 0 1px 4px rgba(0,0,0,.18);
         pointer-events: none; opacity: 0; transition: opacity .12s; z-index: 2; }
  .hov .tip { opacity: 1; }
`;

class Base extends HTMLElement {
  setConfig(c) { this._c = { ...DEF, ...c }; }
  set hass(h) {
    const first = !this._hass;
    this._hass = h;
    if (first) { this._init(); this._refresh(); this._timer = setInterval(() => this._refresh(), this._period || 5 * 60e3); }
    else this._live?.();
  }
  disconnectedCallback() { clearInterval(this._timer); this._timer = null; }
  connectedCallback() { if (this._hass && !this._timer) { this._refresh(); this._timer = setInterval(() => this._refresh(), this._period || 5 * 60e3); } }
  getGridOptions() { return { columns: 12, rows: 'auto', min_columns: 6 }; }
  _shadow(html) { const r = this.attachShadow({ mode: 'open' }); r.innerHTML = `<style>${CSS}${this._css || ''}</style><ha-card>${html}</ha-card>`; return r; }
  async _stats(ids, period, types, months) {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth() - months, 1);
    try { return await this._hass.callWS({ type: 'recorder/statistics_during_period', start_time: start.toISOString(), statistic_ids: ids, period, types }); }
    catch (e) { console.warn('energia-cards', e); return {}; }
  }
}

/* ───────────────── A · riepilogo bolletta ───────────────── */
class EnergiaSummaryCard extends Base {
  _init() {
    this._css = `
      .top { display: flex; justify-content: space-between; align-items: flex-end; gap: 12px; flex-wrap: wrap; }
      .pr { text-align: right; font-size: 12.5px; line-height: 1.5; }
      .pr b { font-weight: 600; color: var(--primary-text-color); }
      .uso { display: grid; grid-template-columns: 44px 1fr auto; column-gap: 10px; row-gap: 0; align-items: center; margin-top: 12px; font-size: 12.5px; }
      .uso .n { font-weight: 600; }
      .uso .bar { display: flex; gap: 2px; height: 8px; border-radius: 4px; overflow: hidden; background: var(--divider-color); }
      .uso .bar div { height: 100%; transition: width .6s ease; }
      .uso .v { text-align: right; white-space: nowrap; font-weight: 600; }
      .uso .v span { font-weight: 400; color: var(--secondary-text-color); }
      .uso .d { grid-column: 2 / 4; font-size: 10.5px; color: var(--secondary-text-color); margin: 2px 0 9px; }
      .uso .d b { font-weight: 600; }`;
    const r = this._shadow(`
      <div class="hd"><span class="ti">Bolletta</span><span class="muted mo" style="font-size:12.5px"></span></div>
      <div class="top" style="margin-top:8px"><div><div class="lb">Stimata del mese</div><div class="big bo">—</div></div><div class="pr muted"></div></div>
      <div class="seg s1"></div><div class="leg l1"></div>
      <div class="sec"><div class="lb fl">kWh per fascia</div><div class="seg s2"></div><div class="leg l2"></div>
        <div class="uso"></div></div>`);
    this.$ = (s) => r.querySelector(s);
  }

  _live() {
    const h = this._hass, c = this._c, now = new Date();
    const bol = num(h, c.bolletta), casa = num(h, c.costo_casa) ?? 0, tesla = num(h, c.costo_tesla) ?? 0,
      clima = num(h, c.costo_clima) ?? 0, fissa = num(h, c.quota_fissa) ?? 0;
    const altro = Math.max(0, casa - tesla - clima);
    const dim = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const elapsed = (now - new Date(now.getFullYear(), now.getMonth(), 1)) / 864e5;
    const proj = elapsed > 0.5 ? casa / elapsed * dim + fissa : null;
    this.$('.mo').textContent = `${MESI_L[now.getMonth()]} ${now.getFullYear()}`;
    this.$('.bo').innerHTML = `${nf(bol, 2)}<small>€</small>`;
    this.$('.pr').innerHTML = `${proj !== null ? `proiezione <b>${nf(proj)} €</b><br>` : ''}${this._prev != null ? `${MESI_L[(now.getMonth() + 11) % 12]} ${nf(this._prev, 2)} €` : ''}`;
    const tot = tesla + clima + altro + fissa || 1;
    const parts = [['Tesla', tesla, COL.tesla], ['Clima', clima, COL.clima], ['Casa', altro, COL.casa], ['Quota fissa', fissa, COL.fissa]];
    this.$('.s1').innerHTML = parts.map(([, v, col]) => (v > 0 ? `<div style="width:${v / tot * 100}%;background:${col}"></div>` : '')).join('');
    this.$('.l1').innerHTML = parts.map(([n, v, col]) => `<span><i style="background:${col}"></i>${n} <b>${nf(v, 2)} €</b></span>`).join('');
    // kWh per fascia (contatore generale, Tesla inclusa)
    const kf = c.kwh_casa_fasce.map((id) => num(h, id) ?? 0), kt = sum(kf) || 1;
    const bc = bandColors(h, c.prezzi), pr = c.prezzi.map((id) => num(h, id));
    const cheap = pr.indexOf(Math.min(...pr.filter((x) => x !== null)));
    this.$('.fl').textContent = `kWh per fascia · ${Math.round(kf[cheap] / kt * 100)}% in F${cheap + 1}, la più economica`;
    this.$('.s2').innerHTML = kf.map((v, i) => (v > 0 ? `<div style="width:${v / kt * 100}%;background:${bc[i]}"></div>` : '')).join('');
    this.$('.l2').innerHTML = kf.map((v, i) => `<span><i style="background:${bc[i]}"></i>F${i + 1} <b>${nf(v)} kWh</b> <span class="muted">${pr[i] !== null ? nf(pr[i], 3) + ' €' : ''}</span></span>`).join('');
    // la stessa divisione per utilizzo: Tesla e clima hanno i loro contatori a fasce, "Casa" è il resto
    const kTesla = c.kwh_tesla_fasce.map((id) => num(h, id) ?? 0), kClima = c.kwh_clima_fasce.map((id) => num(h, id) ?? 0);
    const kCasa = kf.map((v, i) => Math.max(0, v - kTesla[i] - kClima[i]));
    const rows = [['Tesla', kTesla, tesla], ['Clima', kClima, clima], ['Casa', kCasa, altro]];
    this.$('.uso').innerHTML = rows.map(([n, k, eur]) => {
      const t = sum(k);
      const bar = t > 0 ? k.map((v, i) => (v > 0 ? `<div style="width:${v / t * 100}%;background:${bc[i]}"></div>` : '')).join('') : '';
      const det = k.map((v, i) => `F${i + 1} <b>${nf(v, v > 0 && v < 10 ? 1 : 0)}</b>`).join(' · ');
      return `<span class="n">${n}</span><div class="bar">${bar}</div><span class="v">${nf(t, t < 10 ? 1 : 0)} kWh <span>· ${nf(eur, 2)} €</span></span>`
        + `<div class="d">${det} kWh${t > 0 ? ` · ${Math.round(k[cheap] / t * 100)}% in F${cheap + 1}` : ''}</div>`;
    }).join('');
  }

  async _refresh() {
    const c = this._c, now = new Date();
    const bol = await this._stats([c.bolletta], 'month', ['state'], 1);
    const pk = new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime();
    const pb = (bol[c.bolletta] || []).find((r) => Math.abs(r.start - pk) < 3 * 36e5);
    this._prev = pb ? pb.state : null;
    this._live();
  }
}

/* ───────────────── B · flusso dell'energia ───────────────── */
const PAL = ['#8b5cf6', '#14b8a6', '#f97316', '#e11d48', '#eab308', '#6366f1', '#84cc16', '#ec4899', '#06b6d4', '#a16207'];
class EnergiaFlowCard extends Base {
  _init() {
    this._css = `
      svg.fl { width: 100%; height: auto; display: block; margin-top: 6px; }
      .now { display: flex; justify-content: space-between; align-items: baseline; margin-top: 14px; }
      .now .v { font-size: 22px; font-weight: 700; } .now .v small { font-size: 13px; font-weight: 500; }
      .hb { display: grid; grid-template-columns: 104px 1fr 58px; gap: 8px; align-items: center; font-size: 12.5px; margin: 6px 0; }
      .hb .bar { height: 9px; border-radius: 5px; background: var(--divider-color); overflow: hidden; }
      .hb .bar div { height: 100%; border-radius: 5px; transition: width .5s ease; }
      .hb .w { text-align: right; font-weight: 600; white-space: nowrap; }
      .hb .n { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .nt { font-size: 11px; margin-top: 2px; }`;
    const r = this._shadow(`
      <div class="hd"><span class="ti">Dove va l'energia</span><span class="muted mo" style="font-size:12.5px"></span></div>
      <svg class="fl" viewBox="0 0 340 220" preserveAspectRatio="xMidYMid meet"></svg>
      <div class="nt muted"></div>
      <div class="now"><span class="lb">Adesso</span><span class="v"></span></div>
      <div class="list"></div>`);
    this.$ = (s) => r.querySelector(s);
    this._lastNow = 0;
  }

  async _refresh() {
    // kWh del mese di ogni ramo misurato (statistiche a lungo termine, cumulativi total_increasing)
    const ids = (this._c.rami || []).map((r) => r.entity);
    if (ids.length) {
      const st = await this._stats(ids, 'month', ['change'], 0);
      const now = new Date(), k0 = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
      this._rami = (this._c.rami || []).map((r) => {
        const row = (st[r.entity] || []).find((x) => x.start >= k0 - 36e5);
        return { ...r, k: row && row.change != null ? Math.max(0, row.change) : 0 };
      });
    } else this._rami = [];
    this._base = await this._baseLoad();
    this._drawFlow();
    this._live();
  }

  // carico "sempre acceso": per ogni ora del mese, kWh del contatore generale meno tutti i rami misurati
  // (Tesla, clima, prese); il 10° percentile delle ore = consumo di fondo continuo, in kW
  async _baseLoad() {
    const c = this._c;
    const branch = [c.tesla_kwh, c.clima_kwh, ...(c.rami || []).map((r) => r.entity)];
    const now = new Date(), start = new Date(now.getFullYear(), now.getMonth(), 1);
    let st;
    try {
      st = await this._hass.callWS({ type: 'recorder/statistics_during_period', start_time: start.toISOString(),
        statistic_ids: [c.totale_kwh, ...branch], period: 'hour', types: ['change'] });
    } catch (e) { return null; }
    const H = {};
    (st[c.totale_kwh] || []).forEach((r) => { if (r.change != null) H[r.start] = r.change; });
    branch.forEach((id) => (st[id] || []).forEach((r) => { if (r.start in H) H[r.start] -= Math.max(0, r.change || 0); }));
    const v = Object.values(H).sort((a, b) => a - b);
    if (v.length < 24) return null;
    return { kw: Math.max(0, v[Math.floor(v.length * 0.1)]), hours: v.length };
  }

  _drawFlow() {
    const h = this._hass, c = this._c, now = new Date();
    this.$('.mo').textContent = `${MESI_L[now.getMonth()]} · dal contatore generale`;
    const tot = num(h, c.kwh_mese) ?? 0;
    const tk = sum(c.kwh_tesla_fasce.map((id) => num(h, id))), ck = sum(c.kwh_clima_fasce.map((id) => num(h, id)));
    const te = num(h, c.costo_tesla) ?? 0, ce = num(h, c.costo_clima) ?? 0, cc = num(h, c.costo_casa) ?? 0;
    const pm = tot > 0 ? cc / tot : 0; // prezzo medio del mese, per stimare il costo dei rami senza fasce
    let items = [{ n: 'Tesla', k: tk, e: te, col: COL.tesla }, { n: 'Clima', k: ck, e: ce, col: COL.clima }];
    const T = Math.max(tot, 0.001);
    let small = 0;
    (this._rami || []).forEach((r, i) => {
      if (r.k / T < (c.soglia_ramo ?? 0.015)) small += r.k;
      else items.push({ n: r.name, k: r.k, e: r.k * pm, col: r.color || PAL[i % PAL.length], st: true });
    });
    items.sort((a, b) => b.k - a.k);
    if (small > 0) items.push({ n: 'Altri dispositivi', k: small, e: small * pm, col: '#a8a29e', st: true });
    const measured = sum(items.map((x) => x.k));
    const rest = Math.max(0, tot - measured);
    if (this._base && rest > 0) {
      const always = Math.min(rest, this._base.kw * this._base.hours);
      items.push({ n: 'Sempre acceso', pre: `~${nf(this._base.kw * 1000)} W · `, k: always, e: always * pm, col: '#64748b', st: true });
      items.push({ n: 'Saltuari', k: rest - always, e: (rest - always) * pm, col: '#cbd5e1', st: true });
    } else items.push({ n: 'Non misurato', k: rest, e: rest * pm, col: '#94a3b8', st: true });
    items = items.filter((x) => x.k > 0.05);
    // geometria: bande proporzionali; ogni destinazione occupa almeno LH px così le etichette non si sovrappongono
    const top = 8, x0 = 20, x1 = 200, avail = 190, gap = 4, LH = 30;
    const Ts = sum(items.map((x) => x.k)) || 1;
    const hs = items.map((x) => Math.max(1.5, x.k / Ts * avail));
    let ys = top, yd = top, svg = '', bottom = 0;
    const mx = (x0 + 12 + x1) / 2;
    items.forEach((it, i) => {
      const hh = hs[i], block = Math.max(hh, LH);
      const s0 = ys, s1 = ys + hh, d0 = yd + (block - hh) / 2, d1 = d0 + hh, cy = yd + block / 2;
      svg += `<path d="M${x0 + 12},${s0} C${mx},${s0} ${mx},${d0} ${x1},${d0} L${x1},${d1} C${mx},${d1} ${mx},${s1} ${x0 + 12},${s1} Z" fill="${it.col}" opacity=".26"/>`;
      svg += `<rect x="${x1}" y="${d0}" width="7" height="${hh}" rx="2" fill="${it.col}"/>`;
      const pct = Math.round(it.k / Ts * 100);
      svg += `<text x="${x1 + 14}" y="${cy - 2}" style="font-size:11.5px;font-weight:600;fill:var(--primary-text-color)">${it.n} <tspan style="font-weight:400;fill:var(--secondary-text-color)">${pct}%</tspan></text>`;
      svg += `<text x="${x1 + 14}" y="${cy + 11}" style="font-size:10px;fill:var(--secondary-text-color)">${it.pre || ''}${nf(it.k, it.k < 10 ? 1 : 0)} kWh · ${it.st ? '~' : ''}${nf(it.e, 2)} €</text>`;
      ys = s1; yd += block + gap; bottom = Math.max(bottom, yd);
    });
    const srcH = ys - top;
    svg = `<rect x="${x0}" y="${top}" width="12" height="${srcH}" rx="3" fill="var(--secondary-text-color)" opacity=".75"/>`
      + `<text x="${x0 + 6}" y="${top + srcH + 14}" text-anchor="middle" style="font-size:10.5px;fill:var(--secondary-text-color)">Rete</text>`
      + `<text x="${x0 + 6}" y="${top + srcH + 26}" text-anchor="middle" style="font-size:10.5px;font-weight:600;fill:var(--primary-text-color)">${nf(tot)} kWh</text>` + svg;
    const H = Math.max(bottom, top + srcH + 30) + 6;
    this.$('svg').setAttribute('viewBox', `0 0 340 ${H}`);
    this.$('svg').innerHTML = svg;
    this.$('.nt').textContent = `~ costo stimato al prezzo medio del mese (${nf(pm, 3)} €/kWh); Tesla e clima calcolati per fascia.`
      + (this._base ? ` Sempre acceso: consumo di fondo non misurato (standby). Saltuari: ${c.etichetta_saltuari || 'bollitore, lavastoviglie, phon, Bimby, luci'}.` : '');
  }

  _live() {
    const h = this._hass, c = this._c;
    if (!this._rami) return;
    if (Date.now() - this._lastNow < 5000) return; // aggiorna "adesso" al massimo ogni 5 s
    this._lastNow = Date.now();
    const w = (id) => {
      const s = h.states[id]; if (!s) return null;
      const v = parseFloat(s.state); if (isNaN(v)) return null;
      return (s.attributes.unit_of_measurement || '').toLowerCase() === 'kw' ? v * 1000 : v;
    };
    const totW = w(c.potenza) ?? 0;
    const devs = (c.dispositivi || []).map((d) => ({ ...d, w: w(d.entity) ?? 0 })).filter((d) => d.w >= (d.min ?? 3)).sort((a, b) => b.w - a.w);
    const shown = devs.slice(0, c.max_dispositivi || 6);
    const altro = Math.max(0, totW - sum(devs.map((d) => d.w)));
    const fmtW = (v) => (v >= 1000 ? `${nf(v / 1000, 2)} kW` : `${nf(v)} W`);
    this.$('.now .v').innerHTML = totW >= 1000 ? `${nf(totW / 1000, 2)}<small> kW</small>` : `${nf(totW)}<small> W</small>`;
    const ref = Math.max(totW, ...shown.map((d) => d.w), 1);
    this.$('.list').innerHTML = [...shown, ...(altro > 5 ? [{ name: 'Altro', w: altro, color: 'var(--secondary-text-color)', o: .35 }] : [])]
      .map((d) => `<div class="hb"><span class="n">${d.name}</span><div class="bar"><div style="width:${d.w / ref * 100}%;background:${d.color || COL.casa};opacity:${d.o ?? 1}"></div></div><span class="w">${fmtW(d.w)}</span></div>`).join('')
      || '<div class="muted" style="font-size:12.5px;margin-top:6px">Nessun dispositivo misurato sta consumando.</div>';
  }
}

/* ───────────────── C · la giornata per fasce ───────────────── */
class EnergiaDayCard extends Base {
  _init() {
    this._off = 0; // 0 = oggi, 1 = ieri, …
    this._css = `
      .top { display: flex; justify-content: space-between; align-items: flex-end; gap: 12px; flex-wrap: wrap; }
      .nav { display: inline-flex; align-items: center; gap: 4px; }
      .nav button { border: 0; background: var(--secondary-background-color); color: var(--primary-text-color); width: 26px; height: 26px;
                    border-radius: 8px; font-size: 15px; cursor: pointer; line-height: 1; }
      .nav button[disabled] { opacity: .35; cursor: default; }
      .kp { display: flex; gap: 18px; align-items: baseline; flex-wrap: wrap; }
      .kp .v { font-size: 26px; font-weight: 700; } .kp .v small { font-size: 14px; font-weight: 500; }
      .nw { text-align: right; font-size: 12.5px; } .nw b { font-size: 17px; color: var(--primary-text-color); }
      .chart { position: relative; margin-top: 10px; touch-action: none; }
      .chart svg { width: 100%; height: 150px; display: block; }
      .ev { position: relative; margin-top: 6px; }
      .lane { position: relative; height: 14px; margin: 3px 0; }
      .lane span { position: absolute; top: 2px; height: 10px; border-radius: 5px; }
      .lane em { position: absolute; left: 0; top: 0; font-size: 10px; font-style: normal; color: var(--secondary-text-color); background: var(--card-background-color, #fff); padding-right: 4px; line-height: 14px; }
.fs { margin-top: 10px; } .fs .seg { height: 10px; margin: 0 0 6px; }
      .ymax { position: absolute; left: 6px; top: 4px; font-size: 10.5px; color: var(--secondary-text-color); pointer-events: none; }
      .hx { display: flex; justify-content: space-between; font-size: 10px; color: var(--secondary-text-color); margin-top: 2px; }`;
    const r = this._shadow(`
      <div class="hd"><span class="ti">La giornata</span><span class="nav"><button class="pv">‹</button><span class="dl muted" style="font-size:12.5px;min-width:86px;text-align:center"></span><button class="nx">›</button></span></div>
      <div class="top" style="margin-top:6px"><div class="kp"><div><div class="lb">Costo</div><span class="v cs">—</span></div><div><div class="lb">Consumo</div><span class="v kw">—</span></div></div><div class="nw muted"></div></div>
      <div class="fs"><div class="seg sd"></div><div class="leg ld"></div></div>
      <div class="chart"><svg viewBox="0 0 480 150" preserveAspectRatio="none"></svg><span class="ymax"></span><div class="tip"></div></div>
      <div class="hx"><span>0</span><span>6</span><span>12</span><span>18</span><span>24</span></div>
      <div class="ev"></div><div class="leg lg" style="margin-top:8px"></div>`);
    this.$ = (s) => r.querySelector(s);
    this.$('.pv').addEventListener('click', () => { if (this._off < 9) { this._off++; this._refresh(); } });
    this.$('.nx').addEventListener('click', () => { if (this._off > 0) { this._off--; this._refresh(); } });
    const ch = this.$('.chart');
    const show = (x) => {
      if (!this._buckets) return;
      const b = ch.getBoundingClientRect(), f = Math.min(0.9999, Math.max(0, (x - b.left) / b.width));
      const i = Math.floor(f * this._buckets.length), v = this._buckets[i];
      const t = new Date(this._day0.getTime() + f * 864e5);
      const band = bandAt(t, this._fest);
      const tip = this.$('.tip');
      tip.textContent = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes() - t.getMinutes() % 5).padStart(2, '0')} · ${v == null ? 'n.d.' : nf(v, 2) + ' kW'} · F${band + 1}`;
      tip.style.left = `${Math.min(Math.max(f * 100, 14), 86)}%`;
      ch.classList.add('hov');
      const cur = this.$('svg .cur'); cur.setAttribute('x1', f * 480); cur.setAttribute('x2', f * 480); cur.style.display = '';
    };
    ch.addEventListener('pointermove', (e) => show(e.clientX));
    ch.addEventListener('pointerdown', (e) => show(e.clientX));
    ch.addEventListener('pointerleave', () => { ch.classList.remove('hov'); const cur = this.$('svg .cur'); if (cur) cur.style.display = 'none'; });
  }

  _live() {
    if (this._off !== 0) return;
    const h = this._hass, c = this._c;
    this.$('.cs').innerHTML = `${nf(num(h, c.costo_oggi), 2)}<small> €</small>`;
    this.$('.kw').innerHTML = `${nf(num(h, c.kwh_oggi), 1)}<small> kWh</small>`;
    const p = h.states[c.potenza]; let w = parseFloat(p?.state);
    if (!isNaN(w) && (p.attributes.unit_of_measurement || '').toLowerCase() === 'kw') w *= 1000;
    this._bands(c.kwh_giorno_fasce.map((id) => num(h, id)));
    this.$('.nw').innerHTML = `adesso <b>${isNaN(w) ? '—' : w >= 1000 ? nf(w / 1000, 2) + ' kW' : nf(w) + ' W'}</b><br>${h.states[c.fascia]?.state || ''} · ${nf(num(h, c.prezzo_attuale), 3)} €/kWh`;
  }

  // ripartizione della giornata per fascia: kWh e € (prezzo della fascia)
  _bands(kwh) {
    const h = this._hass, c = this._c, bc = bandColors(h, c.prezzi);
    const pr = c.prezzi.map((id) => num(h, id) ?? 0), k = kwh.map((v) => v ?? 0), t = sum(k) || 1;
    this.$('.sd').innerHTML = k.map((v, i) => `<div style="width:${v / t * 100}%;background:${bc[i]}"></div>`).join('');
    this.$('.ld').innerHTML = k.map((v, i) => `<span><i style="background:${bc[i]}"></i>F${i + 1} <b>${nf(v * pr[i], 2)} €</b> <span class="muted">${nf(v, 1)} kWh</span></span>`).join('');
  }

  async _refresh() {
    const h = this._hass, c = this._c;
    const d0 = new Date(); d0.setHours(0, 0, 0, 0); d0.setDate(d0.getDate() - this._off);
    const d1 = new Date(d0.getTime() + 864e5), end = this._off ? d1 : new Date();
    this._day0 = d0;
    const evs = c.eventi || [];
    const ids = [c.potenza, c.costo_oggi, c.kwh_oggi, c.festivo, ...c.kwh_giorno_fasce, ...evs.map((e) => e.entity)];
    let hist = {};
    try {
      hist = await h.callWS({ type: 'history/history_during_period', start_time: d0.toISOString(), end_time: end.toISOString(),
        entity_ids: [...new Set(ids)], minimal_response: true, no_attributes: true, significant_changes_only: false });
    } catch (e) { console.warn('energia-day-card', e); }
    const ts = (s) => (s.lu ?? s.lc) * 1000;
    // festivo: il calendario è "on" in un giorno di festa
    this._fest = (hist[c.festivo] || []).some((s) => s.s === 'on') || (this._off === 0 && h.states[c.festivo]?.state === 'on');
    // potenza → medie su 5 minuti (288 punti); valori in kW
    const kwFactor = (h.states[c.potenza]?.attributes.unit_of_measurement || '').toLowerCase() === 'kw' ? 1 : 1 / 1000;
    const pts = (hist[c.potenza] || []).map((s) => ({ t: ts(s), v: parseFloat(s.s) * kwFactor })).filter((p) => !isNaN(p.v));
    const NB = 288, step = 864e5 / NB, nowIdx = Math.floor((end - d0) / step);
    const buckets = new Array(NB).fill(null);
    let j = 0, last = pts.length ? pts[0].v : null;
    for (let i = 0; i < Math.min(NB, nowIdx + 1); i++) {
      const b0 = d0.getTime() + i * step, b1 = b0 + step;
      let acc = 0, wt = 0, cur = last, t = b0;
      while (j < pts.length && pts[j].t < b1) {
        if (pts[j].t > t && cur !== null) { acc += cur * (pts[j].t - t); wt += pts[j].t - t; t = pts[j].t; }
        cur = pts[j].v; j++;
      }
      const tEnd = Math.min(b1, end.getTime());
      if (cur !== null && tEnd > t) { acc += cur * (tEnd - t); wt += tEnd - t; }
      last = cur;
      buckets[i] = wt > 0 ? acc / wt : null;
    }
    this._buckets = buckets;
    const W = 480, H = 150, top = 6, bot = 4;
    const max = Math.max(0.5, ...buckets.filter((v) => v != null)) * 1.1;
    const bc = bandColors(h, c.prezzi);
    let svg = '';
    // sfondo per fascia: blocchi contigui della stessa fascia (niente righe tra un'ora e l'altra)
    let runStart = 0, runBand = bandAt(d0, this._fest);
    for (let hr = 1; hr <= 24; hr++) {
      const b = hr < 24 ? bandAt(new Date(d0.getTime() + hr * 36e5), this._fest) : -1;
      if (b !== runBand) {
        svg += `<rect x="${runStart * W / 24}" y="0" width="${(hr - runStart) * W / 24}" height="${H}" fill="${bc[runBand]}" opacity=".12"/>`;
        runStart = hr; runBand = b;
      }
    }
    const x = (i) => (i + 0.5) * W / NB, y = (v) => H - bot - v / max * (H - top - bot);
    let line = '', area = '', open = false, firstX = 0, lastX = 0;
    buckets.forEach((v, i) => {
      if (v == null) { if (open) { area += `L${lastX},${H} L${firstX},${H} Z `; open = false; } return; }
      if (!open) { line += `M${x(i)},${y(v)} `; area += `M${x(i)},${H} L${x(i)},${y(v)} `; firstX = x(i); open = true; }
      else { line += `L${x(i)},${y(v)} `; area += `L${x(i)},${y(v)} `; }
      lastX = x(i);
    });
    if (open) area += `L${lastX},${H} L${firstX},${H} Z`;
    const acc = 'var(--primary-color, #03a9f4)';
    svg += `<path d="${area}" fill="${acc}" opacity=".22"/><path d="${line}" fill="none" stroke="${acc}" stroke-width="1.6" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>`;
    if (!this._off) svg += `<line x1="${x(nowIdx)}" x2="${x(nowIdx)}" y1="0" y2="${H}" stroke="var(--secondary-text-color)" stroke-dasharray="3 3" stroke-opacity=".5" vector-effect="non-scaling-stroke"/>`;
    svg += `<line class="cur" x1="0" x2="0" y1="0" y2="${H}" stroke="var(--primary-text-color)" stroke-opacity=".4" vector-effect="non-scaling-stroke" style="display:none"/>`;
    this.$('svg').innerHTML = svg;
    this.$('.ymax').textContent = `${nf(max / 1.1, 1)} kW`;
    // eventi: intervalli in cui l'entità è "on" o supera la soglia
    const lanes = evs.map((e) => {
      const st = hist[e.entity] || [];
      const segs = []; let s0 = null;
      const isOn = (s) => (e.above != null ? parseFloat(s.s) > e.above : s.s === (e.state || 'on'));
      st.forEach((s) => { const t = ts(s); if (isOn(s)) { if (s0 === null) s0 = t; } else if (s0 !== null) { segs.push([s0, t]); s0 = null; } });
      if (s0 !== null) segs.push([s0, end.getTime()]);
      const minMs = (e.min_minutes ?? 2) * 6e4;
      return { ...e, segs: segs.filter(([a, b]) => b - a >= minMs) };
    }).filter((l) => l.segs.length);
    this.$('.ev').innerHTML = lanes.map((l) => `<div class="lane">${l.segs.map(([a, b]) =>
      `<span title="${l.name}" style="left:${(a - d0) / 864e5 * 100}%;width:${Math.max(0.6, (b - a) / 864e5 * 100)}%;background:${l.color}"></span>`).join('')}</div>`).join('');
    const pr = c.prezzi.map((id) => num(h, id));
    this.$('.lg').innerHTML = [0, 1, 2].map((i) => `<span><i style="background:${bc[i]};opacity:.6"></i>F${i + 1} ${pr[i] != null ? nf(pr[i], 3) : ''}</span>`).join('')
      + lanes.map((l) => `<span><i style="background:${l.color}"></i>${l.name}</span>`).join('');
    // intestazione
    const dl = this._off === 0 ? 'Oggi' : this._off === 1 ? 'Ieri' : d0.toLocaleDateString('it-IT', { weekday: 'short', day: 'numeric', month: 'short' });
    this.$('.dl').textContent = dl;
    this.$('.pv').disabled = this._off >= 9; this.$('.nx').disabled = this._off === 0;
    if (this._off === 0) this._live();
    else {
      const lastOf = (id) => { const a = (hist[id] || []).map((s) => parseFloat(s.s)).filter((v) => !isNaN(v)); return a.length ? Math.max(...a) : null; };
      this.$('.cs').innerHTML = `${nf(lastOf(c.costo_oggi), 2)}<small> €</small>`;
      this.$('.kw').innerHTML = `${nf(lastOf(c.kwh_oggi), 1)}<small> kWh</small>`;
      this._bands(c.kwh_giorno_fasce.map((id) => lastOf(id)));
      const vals = buckets.filter((v) => v != null);
      this.$('.nw').innerHTML = vals.length ? `picco <b>${nf(Math.max(...vals), 2)} kW</b><br>${this._fest ? 'festivo' : ''}` : '';
    }
  }
}

/* ───────────────── D · mese per mese (spesa € e consumi kWh) ───────────────── */
class EnergiaMesiCard extends Base {
  _init() {
    this._css = `
      ha-card { display: flex; flex-direction: column; }
      .blk { flex: 1; display: flex; flex-direction: column; }
      .blk + .blk { margin-top: 16px; }
      .bh { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
      .bh .muted { font-size: 11.5px; white-space: nowrap; }
      .chart { position: relative; flex: 1; min-height: 84px; margin-top: 6px; padding-top: 14px; display: flex; touch-action: none; }
      .cols { flex: 1; display: flex; align-items: flex-end; gap: 4px; }
      .col { flex: 1; height: 100%; display: flex; flex-direction: column; justify-content: flex-end; transition: opacity .12s; }
      .col div { width: 100%; }
      .col div:first-child { border-radius: 4px 4px 0 0; }
      .col.past { opacity: .45; } .hov .col { opacity: .3; } .hov .col.hl { opacity: 1; }
      .col.nd div { height: 3px !important; background: var(--divider-color) !important; border-radius: 2px; }
      .mx { position: absolute; left: 0; top: -1px; font-size: 10px; color: var(--secondary-text-color); pointer-events: none; }
      .grid { position: absolute; left: 0; right: 0; top: 14px; border-top: 1px dashed var(--divider-color); pointer-events: none; }
      .ax { display: flex; gap: 4px; font-size: 10px; color: var(--secondary-text-color); margin-top: 3px; }
      .ax span { flex: 1; text-align: center; } .ax .cur { color: var(--primary-text-color); font-weight: 600; }
      .tip { line-height: 1.35; text-align: center; } .tip small { display: block; font-weight: 400; color: var(--secondary-text-color); }
      .leg { margin-top: 8px; }`;
    const blk = (k, title) => `
      <div class="blk ${k}"><div class="bh"><span class="lb">${title}</span><span class="muted av"></span></div>
        <div class="chart"><div class="grid"></div><span class="mx"></span><div class="cols"></div><div class="tip"></div></div>
        <div class="ax"></div><div class="leg"></div></div>`;
    const r = this._shadow(`
      <div class="hd"><span class="ti">Mese per mese</span><span class="muted" style="font-size:12.5px">ultimi 12 mesi</span></div>
      <div style="height:10px"></div>${blk('eur', 'Spesa')}${blk('kwh', 'Consumi')}`);
    this.$ = (s) => r.querySelector(s);
    // un solo cursore per i due grafici: il mese evidenziato è lo stesso
    const charts = [...r.querySelectorAll('.chart')];
    const pick = (ch, x) => { const b = ch.getBoundingClientRect(); return Math.min(11, Math.max(0, Math.floor((x - b.left) / b.width * 12))); };
    const off = () => charts.forEach((ch) => { ch.classList.remove('hov'); ch.querySelectorAll('.col').forEach((c) => c.classList.remove('hl')); });
    charts.forEach((ch) => {
      const on = (e) => this._show(pick(ch, e.clientX));
      ch.addEventListener('pointermove', on); ch.addEventListener('pointerdown', on); ch.addEventListener('pointerleave', off);
    });
  }

  _show(i) {
    const m = this._months?.[i]; if (!m) return;
    const cur = i === 11 ? ' (in corso)' : '';
    const tips = {
      eur: m.eur ? `${m.lblL}${cur} · ${nf(m.eur.bol, 2)} €<small>Tesla ${nf(m.eur.tesla)} · Clima ${nf(m.eur.clima)} · Casa ${nf(m.eur.casa)} · fissa ${nf(m.eur.fissa)}</small>`
        : `${m.lblL} · non disponibile`,
      kwh: m.tot !== null ? `${m.lblL}${cur} · ${nf(m.tot)} kWh<small>Tesla ${nf(m.tesla)} · Clima ${nf(m.clima)} · Casa ${nf(Math.max(0, m.tot - m.tesla - m.clima))}</small>`
        : `${m.lblL} · non disponibile`,
    };
    for (const k of ['eur', 'kwh']) {
      const ch = this.$(`.${k} .chart`), t = ch.querySelector('.tip');
      ch.classList.add('hov');
      ch.querySelectorAll('.col').forEach((c, j) => c.classList.toggle('hl', j === i));
      t.innerHTML = tips[k];
      // centrato sulla colonna ma sempre dentro la card
      const W = ch.clientWidth, w = t.offsetWidth, x = (i + 0.5) / 12 * W;
      t.style.left = `${Math.min(Math.max(x, w / 2), W - w / 2)}px`;
    }
  }

  async _refresh() {
    const c = this._c, h = this._hass, now = new Date(), N = 12;
    const [chg, st] = await Promise.all([
      this._stats([c.totale_kwh, c.tesla_kwh, c.clima_kwh], 'month', ['change'], N - 1),
      this._stats([c.bolletta, c.costo_casa, c.costo_tesla, c.costo_clima], 'month', ['state'], N - 1),
    ]);
    const key = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${d.getMonth()}`; };
    const by = (src, id, f) => { const o = {}; (src[id] || []).forEach((r) => { if (r[f] != null) o[key(r.start)] = r[f]; }); return o; };
    const T = by(chg, c.totale_kwh, 'change'), S = by(chg, c.tesla_kwh, 'change'), K = by(chg, c.clima_kwh, 'change');
    // i sensori di costo si azzerano a inizio mese: il loro ultimo valore del mese è il totale del mese
    const B = by(st, c.bolletta, 'state'), EC = by(st, c.costo_casa, 'state'), ET = by(st, c.costo_tesla, 'state'), EK = by(st, c.costo_clima, 'state');
    this._months = [];
    for (let i = N - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1), k = `${d.getFullYear()}-${d.getMonth()}`;
      const m = { lbl: MESI[d.getMonth()], lblL: `${MESI_L[d.getMonth()]} ${d.getFullYear()}`,
        tot: k in T ? T[k] : null, tesla: Math.max(0, S[k] ?? 0), clima: Math.max(0, K[k] ?? 0), eur: null };
      // mese in corso dai valori attuali, mesi passati dalle statistiche
      const bol = i === 0 ? num(h, c.bolletta) : B[k], casa = i === 0 ? num(h, c.costo_casa) : EC[k];
      if (bol != null && casa != null) {
        const tesla = Math.max(0, (i === 0 ? num(h, c.costo_tesla) : ET[k]) ?? 0), clima = Math.max(0, (i === 0 ? num(h, c.costo_clima) : EK[k]) ?? 0);
        m.eur = { bol, tesla, clima, casa: Math.max(0, casa - tesla - clima), fissa: Math.max(0, bol - casa) };
      }
      this._months.push(m);
    }
    const L = N - 1, ax = this._months.map((m, i) => `<span class="${i === L ? 'cur' : ''}">${m.lbl.charAt(0).toUpperCase()}</span>`).join('');
    const draw = (k, segs, unit, dec) => {
      const vals = this._months.map((m) => segs(m)), tots = vals.map((v) => (v ? sum(v.map((x) => x[0])) : 0));
      const max = Math.max(...tots, 0.001);
      this.$(`.${k} .cols`).innerHTML = vals.map((v, i) => {
        if (!v) return '<div class="col nd"><div></div></div>';
        // dall'alto verso il basso: l'ultimo segmento sta alla base della colonna
        return `<div class="col ${i < L ? 'past' : ''}">${[...v].reverse().map(([x, col]) => `<div style="height:${x / max * 100}%;background:${col}"></div>`).join('')}</div>`;
      }).join('');
      this.$(`.${k} .mx`).textContent = `${nf(max, dec)} ${unit}`;
      this.$(`.${k} .ax`).innerHTML = ax;
      // media dei mesi chiusi con dati
      const closed = tots.filter((t, i) => i < L && vals[i]);
      this.$(`.${k} .av`).textContent = closed.length ? `media ${nf(sum(closed) / closed.length, dec)} ${unit}/mese` : '';
    };
    draw('eur', (m) => m.eur && [[m.eur.tesla, COL.tesla], [m.eur.clima, COL.clima], [m.eur.casa, COL.casa], [m.eur.fissa, COL.fissa]], '€', 0);
    draw('kwh', (m) => m.tot !== null && [[m.tesla, COL.tesla], [m.clima, COL.clima], [Math.max(0, m.tot - m.tesla - m.clima), COL.casa]], 'kWh', 0);
    const lg = (arr) => arr.map(([n, col]) => `<span><i style="background:${col}"></i>${n}</span>`).join('');
    this.$('.eur .leg').innerHTML = lg([['Tesla', COL.tesla], ['Clima', COL.clima], ['Casa', COL.casa], ['Quota fissa', COL.fissa]]);
    this.$('.kwh .leg').innerHTML = lg([['Tesla', COL.tesla], ['Clima', COL.clima], ['Casa', COL.casa]]) + '<span class="muted">· dal contatore generale</span>';
  }
}

/* ───────────────── contenitore a colonne ─────────────────
 * Mette altre card in colonne della stessa altezza: l'ultima card di ogni colonna si allunga fino in fondo,
 * così non restano spazi vuoti accanto alla colonna più corta. Sotto i 640 px diventa una colonna sola,
 * con le card in ordine per riga (prima di ogni colonna, poi le seconde, …).
 *   type: custom:energia-colonne-card
 *   colonne: [[card, card], [card]]
 */
class EnergiaColonneCard extends HTMLElement {
  setConfig(c) {
    if (!Array.isArray(c?.colonne) || !c.colonne.length || !c.colonne.every(Array.isArray)) throw new Error('energia-colonne-card: "colonne" deve essere una lista di liste di card');
    this._c = c;
    if (!this.shadowRoot) this.attachShadow({ mode: 'open' });
    this._build();
  }
  set hass(h) { this._hass = h; (this._els || []).forEach((e) => { e.hass = h; }); }
  getCardSize() { return 12; }
  getGridOptions() { return { columns: 'full', rows: 'auto' }; }

  async _build() {
    const cols = this._c.colonne, R = Math.max(...cols.map((x) => x.length)), n = cols.length;
    const token = (this._token = {});
    let helpers = null;
    const needHelpers = cols.flat().some((cfg) => !/^custom:energia-/.test(cfg.type || ''));
    if (needHelpers && window.loadCardHelpers) helpers = await window.loadCardHelpers();
    if (token !== this._token) return; // nel frattempo è arrivata un'altra configurazione
    const make = (cfg) => {
      if (/^custom:energia-/.test(cfg.type || '')) { const el = document.createElement(cfg.type.slice(7)); el.setConfig(cfg); return el; }
      return helpers ? helpers.createCardElement(cfg) : Object.assign(document.createElement('div'), { textContent: `card non disponibile: ${cfg.type}` });
    };
    const els = [], styles = [];
    cols.forEach((col, ci) => col.forEach((cfg, ri) => {
      const el = make(cfg);
      // ultima card della colonna: occupa le righe rimanenti
      const row = ri === col.length - 1 ? `${ri + 1} / ${R + 1}` : `${ri + 1}`;
      el.style.cssText = `--o:${ri * n + ci};--c:${ci + 1};--r:${row}`;
      els.push(el);
    }));
    const rows = R > 1 ? `repeat(${R - 1}, auto) minmax(0, 1fr)` : 'minmax(0, 1fr)';
    this.shadowRoot.innerHTML = `<style>
      :host { display: block; container-type: inline-size; }
      .g { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--ha-section-grid-row-gap, 8px); }
      .g > * { order: var(--o); min-width: 0; }
      @container (min-width: 640px) {
        .g { grid-template-columns: repeat(${n}, minmax(0, 1fr)); grid-template-rows: ${rows};
             column-gap: var(--ha-view-sections-column-gap, 32px); }
        .g > * { order: 0; grid-column: var(--c); grid-row: var(--r); }
      }</style><div class="g"></div>`;
    const g = this.shadowRoot.querySelector('.g');
    els.forEach((el) => g.appendChild(el));
    this._els = els;
    if (this._hass) els.forEach((e) => { e.hass = this._hass; });
  }
}

if (!customElements.get('energia-summary-card')) customElements.define('energia-summary-card', EnergiaSummaryCard);
if (!customElements.get('energia-flow-card')) customElements.define('energia-flow-card', EnergiaFlowCard);
if (!customElements.get('energia-day-card')) customElements.define('energia-day-card', EnergiaDayCard);
if (!customElements.get('energia-mesi-card')) customElements.define('energia-mesi-card', EnergiaMesiCard);
if (!customElements.get('energia-colonne-card')) customElements.define('energia-colonne-card', EnergiaColonneCard);
window.customCards = window.customCards || [];
window.customCards.push(
  { type: 'energia-summary-card', name: 'Energia – Bolletta', description: 'Bolletta del mese scomposta, kWh per fascia anche per Tesla, clima e casa' },
  { type: 'energia-flow-card', name: 'Energia – Flusso', description: 'Dove va l\'energia del mese e chi consuma adesso' },
  { type: 'energia-day-card', name: 'Energia – Giornata', description: 'Potenza nelle 24 ore con le fasce e gli eventi' },
  { type: 'energia-mesi-card', name: 'Energia – Mese per mese', description: 'Spesa in € e consumi in kWh degli ultimi 12 mesi' },
  { type: 'energia-colonne-card', name: 'Energia – Colonne', description: 'Contenitore a colonne della stessa altezza, senza spazi vuoti' },
);
console.info(`%c energia-cards %c ${E_VERSION} `, 'background:#22c55e;color:#fff;border-radius:3px 0 0 3px', 'background:#eee;border-radius:0 3px 3px 0');
