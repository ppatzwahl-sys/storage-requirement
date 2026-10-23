'use strict';

// Protokoll siehe PROTOKOLL.md
const NUS_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const NUS_RX = '6e400002-b5a3-f393-e0a9-e50e24dcca9e'; // App schreibt
const NUS_TX = '6e400003-b5a3-f393-e0a9-e50e24dcca9e'; // Lampe meldet

const CMD_LIGHT = 0x02;
const CMD_OFF = 0x05;
const CMD_BATTERY = 0x20;
const CMD_SHUTDOWN = 0x88;
const MSG_HIT = 0x03;
const MSG_TIMEOUT = 0x09;
const MSG_BATTERY = 0x21;

const COLORS = [
  null,
  { name: 'Rot', hex: '#ff3b3b' },
  { name: 'Grün', hex: '#2fd16b' },
  { name: 'Gelb', hex: '#ffd400' },
  { name: 'Blau', hex: '#2f7bff' },
  { name: 'Lila', hex: '#c43bff' },
  { name: 'Cyan', hex: '#00dcff' },
  { name: 'Weiß', hex: '#ffffff' },
];

// Index entspricht der Auswahl in den Einstellungen.
// Nah und Fern laut Praxistest: 0x80 = nah, 0x40 = fern
const SENSE = [
  { b1: 0x00, b2: 0x00 }, // Standard
  { b1: 0x80, b2: 0x00 }, // Nah
  { b1: 0x40, b2: 0x00 }, // Fern
  { b1: 0xc0, b2: 0x00 }, // Vibration
  { b1: 0x40, b2: 0x10 }, // Fern plus
];

const KEEP_ALIVE_MS = 2 * 60 * 1000;
const FLASH_PERIOD = [0, 0, 10, 5, 2, 1];

const MODES = {
  random: 'Eine zufällige Lampe leuchtet in einer zufälligen Farbe aus deiner Auswahl. Treffen, so schnell es geht.',
  gonogo: 'Zielfarben treffen, Störfarben stehen lassen, bis sie von allein ausgehen. Trainiert Hemmung und Entscheidung.',
  sequence: 'Die Lampen leuchten der Reihe nach (1, 2, 3, ...). Gut für Laufwege und feste Muster.',
  multi: 'Jede gewählte Farbe ist ein Team. Jedes Team hat gleichzeitig eine eigene Lampe in seiner Farbe. Wer mehr trifft, gewinnt.',
  sprint: 'Zeitmessung: Startlampe abschlagen, zur Ziellampe laufen und dort abschlagen. Gemessen wird die Zeit dazwischen.',
  more: 'Es gehen immer mehr Lampen an. Abschlagen, bevor alle gleichzeitig leuchten, dann ist das Spiel vorbei.',
};

const MODE_NAMES = { random: 'Zufall', gonogo: 'Go/NoGo', sequence: 'Reihenfolge', multi: 'Duell', sprint: 'Sprint', more: 'Immer mehr' };

const SPRINT_START_COLOR = 2; // Grün
const SPRINT_FINISH_COLOR = 4; // Blau
const MORE_MIN_INTERVAL = 0.3;
// Zeitlimit 0 wird von den Lampen nicht als unbegrenzt behandelt, sie gehen trotzdem aus.
// Deshalb für Lampen, die bis zum Abschlagen leuchten sollen, ein langes Limit senden
const STAY_ON = 600;

/* ---------- Speicher ---------- */

const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem('rx.' + key);
      return v == null ? fallback : JSON.parse(v);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem('rx.' + key, JSON.stringify(value)); } catch { /* privat oder voll */ }
  },
};

const settings = Object.assign(
  { sense: 0, flash: 0, beepOn: false, beepHit: false, compact: false, keepAliveBlink: false },
  store.get('settings', {}),
);
if (!SENSE[settings.sense]) settings.sense = 0;
let players = store.get('players', ['Gast']);
let results = store.get('results', []);
const trainingCfg = store.get('training', {});

/* ---------- Hilfen ---------- */

const $ = (sel) => document.querySelector(sel);
const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ');
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const fmt = (s) => (s == null || isNaN(s) ? '·' : s.toFixed(2));
const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);

function log(msg) {
  const el = $('#log');
  const line = new Date().toLocaleTimeString() + '  ' + msg + '\n';
  el.textContent = (line + el.textContent).slice(0, 8000);
}

function buildLightCommand(color, timeoutSec) {
  const sense = SENSE[settings.sense] || SENSE[0];
  let b1 = (color & 0x07) | sense.b1;
  if (settings.beepOn) b1 |= 0x08;
  if (settings.beepHit) b1 |= 0x10;
  if (settings.flash > 0) b1 |= 0x20;
  if (settings.compact) return [CMD_LIGHT, b1];
  const t = Math.min(0xffff, Math.round((timeoutSec || 0) * 100));
  return [CMD_LIGHT, b1, sense.b2, FLASH_PERIOD[settings.flash] || 0, t & 0xff, (t >> 8) & 0xff];
}

function batteryLabel(mv) {
  if (mv > 3900) return 'voll';
  if (mv > 3650) return 'gut';
  if (mv > 3400) return 'mittel';
  return 'schwach';
}

/* ---------- Lampen ---------- */

const lamps = [];
let simCounter = 0;

class Lamp {
  constructor(name) {
    this.name = name;
    const m = /\$(?:react|xball)-(\d+)/i.exec(name || '');
    this.number = m ? Number(m[1]) : null;
    this.connected = false;
    this.color = 0;
    this.battery = null;
    this.version = null;
    this.onHit = null;
    this.onTimeout = null;
    this.el = null;
  }

  get label() { return this.number != null ? String(this.number) : '?'; }

  light(color, timeoutSec) {
    this.setColor(color);
    return this.send(buildLightCommand(color, timeoutSec));
  }

  off() {
    this.setColor(0);
    return this.send([CMD_OFF]);
  }

  requestBattery() { return this.send([CMD_BATTERY]); }

  shutdown() { return this.send([CMD_SHUTDOWN]); }

  handle(bytes) {
    log(`${this.name} → ${hex(bytes)}`);
    switch (bytes[0]) {
      case MSG_HIT: {
        const t = bytes.length >= 4 ? (bytes[2] | (bytes[3] << 8)) / 100 : null;
        this.setColor(0);
        if (this.onHit) this.onHit(this, t > 0 ? t : null);
        break;
      }
      case MSG_TIMEOUT:
        this.setColor(0);
        if (this.onTimeout) this.onTimeout(this);
        break;
      case MSG_BATTERY:
        if (bytes.length >= 4) {
          this.version = bytes[1] > 128 ? 4 : 3;
          this.battery = (bytes[2] | (bytes[3] << 8)) * 10;
          this.render();
        }
        break;
    }
  }

  setColor(color) {
    this.color = color;
    if (!this.el) return;
    const bulb = this.el.querySelector('.bulb');
    const c = COLORS[color];
    bulb.style.background = c ? c.hex : '';
    bulb.style.boxShadow = c ? `0 0 28px ${c.hex}` : '';
    bulb.style.color = color === 7 || color === 3 ? '#111' : '#fff';
  }

  render() {
    if (!this.el) {
      this.el = document.createElement('div');
      this.el.className = 'lamp';
      this.el.innerHTML = `
        <div class="bulb"></div>
        <div class="meta"></div>
        <div class="actions">
          <button class="small" data-act="test">Test</button>
          <button class="small" data-act="off">Aus</button>
          <button class="small" data-act="remove">Entfernen</button>
        </div>`;
      this.el.addEventListener('click', (e) => this.onClick(e));
    }
    this.el.classList.toggle('offline', !this.connected);
    this.el.classList.toggle('sim', this instanceof SimLamp);
    this.el.querySelector('.bulb').textContent = this.label;
    const parts = [this.name, this.connected ? 'verbunden' : 'getrennt'];
    if (this.battery) parts.push(`Akku ${(this.battery / 1000).toFixed(2)} V (${batteryLabel(this.battery)})`);
    this.el.querySelector('.meta').innerHTML = parts.join('<br>');
    this.setColor(this.color);
    return this.el;
  }

  onClick(e) {
    const act = e.target.dataset.act;
    if (act === 'test') this.light(pick([1, 2, 3, 4, 5, 6, 7]), 2);
    else if (act === 'off') this.off();
    else if (act === 'remove') removeLamp(this);
  }

  disconnect() {}
}

class BleLamp extends Lamp {
  constructor(device) {
    super(device.name || 'Lampe');
    this.device = device;
    this.rx = null;
    this.queue = Promise.resolve();
    this.retries = 0;
    this.manualDisconnect = false;
    device.addEventListener('gattserverdisconnected', () => this.onDisconnected());
  }

  async connect() {
    const server = await this.device.gatt.connect();
    const service = await server.getPrimaryService(NUS_SERVICE);
    this.rx = await service.getCharacteristic(NUS_RX);
    const tx = await service.getCharacteristic(NUS_TX);
    tx.addEventListener('characteristicvaluechanged', (e) => {
      const v = e.target.value;
      this.handle(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
    });
    await tx.startNotifications();
    this.connected = true;
    this.retries = 0;
    this.render();
    updateStatus();
    this.requestBattery();
  }

  async onDisconnected() {
    this.connected = false;
    this.rx = null;
    this.render();
    updateStatus();
    log(`${this.name} getrennt`);
    if (this.manualDisconnect || this.retries >= 3) return;
    this.retries++;
    await new Promise((r) => setTimeout(r, 1000));
    try {
      await this.connect();
      log(`${this.name} wieder verbunden`);
    } catch (err) {
      log(`${this.name} Wiederverbindung fehlgeschlagen: ${err.message}`);
    }
  }

  send(bytes) {
    // GATT erlaubt keine parallelen Schreibvorgänge, deshalb Warteschlange
    this.queue = this.queue.then(async () => {
      if (!this.rx) return;
      const data = new Uint8Array(bytes);
      log(`${this.name} ← ${hex(data)}`);
      if (this.rx.writeValueWithoutResponse) await this.rx.writeValueWithoutResponse(data);
      else await this.rx.writeValue(data);
    }).catch((err) => log(`${this.name} Fehler: ${err.message}`));
    return this.queue;
  }

  disconnect() {
    this.manualDisconnect = true;
    if (this.device.gatt.connected) this.device.gatt.disconnect();
  }
}

// Virtuelle Lampe zum Testen ohne Hardware: Antippen = Treffer
class SimLamp extends Lamp {
  constructor() {
    simCounter++;
    super(`$react-${simCounter}`);
    this.connected = true;
    this.litAt = 0;
    this.timer = null;
  }

  send(bytes) {
    log(`${this.name} ← ${hex(bytes)}`);
    clearTimeout(this.timer);
    if (bytes[0] === CMD_LIGHT) {
      this.litAt = performance.now();
      const t = bytes.length >= 6 ? (bytes[4] | (bytes[5] << 8)) * 10 : 0;
      if (t > 0) this.timer = setTimeout(() => this.handle([MSG_TIMEOUT]), t);
    } else if (bytes[0] === CMD_BATTERY) {
      setTimeout(() => this.handle([MSG_BATTERY, 0x85, 0x90, 0x01]), 50);
    } else if (bytes[0] === CMD_SHUTDOWN) {
      this.connected = false;
      this.render();
      updateStatus();
    }
    return Promise.resolve();
  }

  onClick(e) {
    if (e.target.classList.contains('bulb') && this.color) {
      clearTimeout(this.timer);
      const t = Math.round((performance.now() - this.litAt) / 10);
      this.handle([MSG_HIT, 0, t & 0xff, (t >> 8) & 0xff]);
      return;
    }
    super.onClick(e);
  }
}

function addLamp(lamp) {
  lamps.push(lamp);
  lamps.sort((a, b) => (a.number ?? 99) - (b.number ?? 99));
  renderLamps();
  updateStatus();
}

function removeLamp(lamp) {
  lamp.disconnect();
  lamps.splice(lamps.indexOf(lamp), 1);
  renderLamps();
  updateStatus();
}

function connectedLamps() { return lamps.filter((l) => l.connected); }

function renderLamps() {
  const grid = $('#lamp-grid');
  grid.replaceChildren(...lamps.map((l) => l.render()));
  const sel = $('#diag-lamp');
  sel.innerHTML = lamps.map((l, i) => `<option value="${i}">${l.name}</option>`).join('');
}

function updateStatus() {
  const n = connectedLamps().length;
  $('#status').textContent = n === 0 ? 'Keine Lampe verbunden' : n === 1 ? '1 Lampe verbunden' : `${n} Lampen verbunden`;
  renderSprintSelects();
}

async function connectLamp() {
  if (!navigator.bluetooth) {
    alert('Web Bluetooth ist in diesem Browser nicht verfügbar.');
    return;
  }
  try {
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: '$react' }, { namePrefix: '$xball' }, { services: [NUS_SERVICE] }],
      optionalServices: [NUS_SERVICE],
    });
    const existing = lamps.find((l) => l.device && l.device.id === device.id);
    const lamp = existing || new BleLamp(device);
    lamp.manualDisconnect = false;
    if (!existing) addLamp(lamp);
    await lamp.connect();
    log(`${lamp.name} verbunden`);
    lamp.light(4, 0.5);
  } catch (err) {
    if (err.name !== 'NotFoundError') {
      log('Verbindung fehlgeschlagen: ' + err.message);
      alert('Verbindung fehlgeschlagen: ' + err.message);
    }
  }
}

// Hält die Lampen wach, damit sie sich nicht selbst abschalten. Wie die offizielle App
// per Akkuabfrage, auf Wunsch zusätzlich mit kurzem Aufblinken (nicht während eines Trainings)
function keepAlive() {
  const training = session && session.running;
  for (const lamp of connectedLamps()) {
    if (training && session.active.has(lamp)) continue;
    lamp.requestBattery();
    if (settings.keepAliveBlink && !training && !lamp.color) lamp.light(7, 0.2);
  }
}

/* ---------- Training ---------- */

let session = null;
let wakeLock = null;

class Session {
  constructor(cfg) {
    this.cfg = cfg;
    this.lamps = connectedLamps();
    this.running = false;
    this.fired = 0;
    this.active = new Map(); // Lampe → { player, kind, start, timer }
    this.lastLamp = {};
    this.seqIndex = 0;
    this.timers = new Set();
    this.stats = {};
    for (const p of cfg.players) {
      this.stats[p] = { hits: 0, misses: 0, errors: 0, rejections: 0, times: [] };
    }
  }

  later(fn, ms) {
    const id = setTimeout(() => { this.timers.delete(id); fn(); }, ms);
    this.timers.add(id);
    return id;
  }

  start() {
    this.running = true;
    this.startedAt = performance.now();
    for (const l of this.lamps) {
      l.onHit = (lamp, t) => this.onHit(lamp, t);
      l.onTimeout = (lamp) => this.expire(lamp, false);
    }
    this.ticker = setInterval(() => this.renderProgress(), 200);
    if (this.cfg.mode === 'sprint') {
      this.runs = 0;
      this.later(() => this.sprintReady(), 600);
      return;
    }
    if (this.cfg.mode === 'more') {
      this.interval = this.cfg.moreInterval;
      this.later(() => this.moreTick(), 600);
      return;
    }
    if (this.cfg.endType === 'time') this.later(() => this.finish(), this.cfg.endTime * 1000);
    this.cfg.players.forEach((p, i) => this.later(() => this.fire(p), 600 + i * 150));
  }

  done() {
    if (this.cfg.mode === 'sprint' || this.cfg.mode === 'more') return false;
    return this.cfg.endType === 'hits' && this.fired >= this.cfg.endHits;
  }

  /* Sprint: Start abschlagen startet die Uhr, Ziel abschlagen stoppt sie */

  sprintReady() {
    if (!this.running) return;
    if (this.runs >= this.cfg.runs) return this.finish();
    const lamp = this.lamps.find((l) => l.name === this.cfg.sprintStart && l.connected);
    if (!lamp) {
      this.flash('Startlampe nicht verbunden.');
      return this.finish();
    }
    this.active.set(lamp, { player: this.cfg.players[0], kind: 'sprint-start', start: performance.now(), timer: null, stayOn: SPRINT_START_COLOR });
    lamp.light(SPRINT_START_COLOR, STAY_ON);
    this.flash(`Lauf ${this.runs + 1} von ${this.cfg.runs}: bereit an Lampe ${lamp.label}`);
  }

  sprintGo(player) {
    const startLamp = this.lamps.find((l) => l.name === this.cfg.sprintStart);
    let finish;
    if (this.cfg.sprintFinish === 'random') {
      const others = this.lamps.filter((l) => l.connected && l !== startLamp);
      finish = others.length ? pick(others) : startLamp;
    } else {
      finish = this.lamps.find((l) => l.name === this.cfg.sprintFinish && l.connected);
    }
    if (!finish) {
      this.flash('Ziellampe nicht verbunden.');
      return this.finish();
    }
    this.active.set(finish, { player, kind: 'sprint-finish', start: performance.now(), timer: null, stayOn: SPRINT_FINISH_COLOR });
    finish.light(SPRINT_FINISH_COLOR, STAY_ON);
    this.flash(`Lauf ${this.runs + 1}: Zeit läuft, Ziel ist Lampe ${finish.label}`);
  }

  /* Immer mehr: in festem oder kürzer werdendem Abstand geht eine weitere Lampe an */

  moreTick() {
    if (!this.running) return;
    const player = this.cfg.players[0];
    const lamp = this.pickLamp(player);
    if (!lamp) return this.gameOver();
    this.fired++;
    this.lastLamp[player] = lamp;
    const color = pick(this.cfg.colors);
    this.active.set(lamp, { player, kind: 'go', start: performance.now(), timer: null, stayOn: color });
    lamp.light(color, STAY_ON);
    this.renderLive();
    if (this.lamps.every((l) => !l.connected || this.active.has(l))) return this.gameOver();
    if (this.cfg.moreTempo === 'faster') {
      this.interval = Math.max(MORE_MIN_INTERVAL, this.interval * (1 - this.cfg.moreAccel / 100));
    }
    this.later(() => this.moreTick(), this.interval * 1000);
  }

  gameOver() {
    const lamps = this.lamps.filter((l) => l.connected);
    this.finish();
    // Alle kurz rot als Signal für das Spielende
    lamps.forEach((l) => l.light(1, 1.5));
  }

  next(player) {
    if (!this.running) return;
    if (this.done()) {
      if (this.active.size === 0) this.finish();
      return;
    }
    this.later(() => this.fire(player), this.cfg.delay * 1000);
  }

  pickLamp(player) {
    const free = this.lamps.filter((l) => l.connected && !this.active.has(l));
    if (free.length === 0) return null;
    if (this.cfg.mode === 'sequence') {
      const ordered = this.lamps.filter((l) => l.connected);
      for (let i = 0; i < ordered.length; i++) {
        const l = ordered[(this.seqIndex + i) % ordered.length];
        if (!this.active.has(l)) {
          this.seqIndex = (ordered.indexOf(l) + 1) % ordered.length;
          return l;
        }
      }
      return null;
    }
    const fresh = free.filter((l) => l !== this.lastLamp[player]);
    return pick(fresh.length ? fresh : free);
  }

  fire(player) {
    if (!this.running || this.done()) return;
    const lamp = this.pickLamp(player);
    if (!lamp) {
      this.later(() => this.fire(player), 200);
      return;
    }
    const { mode } = this.cfg;
    let kind = 'go';
    let color;
    if (mode === 'multi') {
      color = this.cfg.playerColors[player];
    } else if (mode === 'gonogo' && this.cfg.nogoColors.length && Math.random() * 100 < this.cfg.nogoRatio) {
      kind = 'nogo';
      color = pick(this.cfg.nogoColors);
    } else {
      color = pick(this.cfg.colors);
    }
    // Störreize brauchen ein Zeitlimit, sonst bleiben sie für immer an
    const timeout = this.cfg.timeout > 0 ? this.cfg.timeout : kind === 'nogo' ? 2 : 0;
    this.fired++;
    this.lastLamp[player] = lamp;
    const entry = { player, kind, start: performance.now(), timer: null };
    if (timeout > 0) entry.timer = this.later(() => this.expire(lamp, true), timeout * 1000 + 800);
    this.active.set(lamp, entry);
    lamp.light(color, timeout);
    this.renderLive();
  }

  onHit(lamp, lampTime) {
    const a = this.active.get(lamp);
    if (!a || !this.running) return;
    this.release(lamp, a);
    const s = this.stats[a.player];
    if (a.kind === 'sprint-start') {
      this.sprintT0 = performance.now();
      this.sprintGo(a.player);
      return;
    }
    if (a.kind === 'sprint-finish') {
      // Beide Zeitpunkte kommen über Bluetooth an, die Funkverzögerung hebt sich weitgehend auf
      const t = (performance.now() - this.sprintT0) / 1000;
      s.hits++;
      s.times.push(t);
      this.lastRt = t;
      this.runs++;
      this.flash(`Lauf ${this.runs}: ${fmt(t)} s`);
      this.renderLive();
      if (this.runs >= this.cfg.runs) return this.finish();
      this.later(() => this.sprintReady(), Math.max(1, this.cfg.delay) * 1000);
      return;
    }
    const rt = lampTime ?? (performance.now() - a.start) / 1000;
    if (a.kind === 'go') {
      s.hits++;
      s.times.push(rt);
      this.lastRt = rt;
    } else {
      s.errors++;
      this.flash('Störfarbe berührt!');
    }
    this.renderLive();
    if (this.cfg.mode !== 'more') this.next(a.player);
  }

  // fromApp = Sicherheitstimer der App, falls die Lampe kein 09 meldet
  expire(lamp, fromApp) {
    const a = this.active.get(lamp);
    if (!a || !this.running) return;
    if (a.stayOn) {
      // Lampe ist von selbst ausgegangen, soll aber bis zum Abschlagen leuchten
      lamp.light(a.stayOn, STAY_ON);
      return;
    }
    this.release(lamp, a);
    if (fromApp) lamp.off();
    const s = this.stats[a.player];
    if (a.kind === 'go') s.misses++;
    else s.rejections++;
    this.renderLive();
    this.next(a.player);
  }

  release(lamp, a) {
    if (a.timer) {
      clearTimeout(a.timer);
      this.timers.delete(a.timer);
    }
    this.active.delete(lamp);
  }

  stop() { this.finish(); }

  finish() {
    if (!this.running) return;
    this.running = false;
    for (const id of this.timers) clearTimeout(id);
    clearInterval(this.ticker);
    for (const l of this.lamps) {
      l.onHit = null;
      l.onTimeout = null;
      if (this.active.has(l)) l.off();
    }
    this.active.clear();
    const date = new Date().toISOString();
    const duration = (performance.now() - this.startedAt) / 1000;
    for (const p of this.cfg.players) {
      const s = this.stats[p];
      results.push({
        date,
        mode: this.cfg.mode,
        player: p,
        duration: Math.round(duration),
        hits: s.hits,
        misses: s.misses,
        errors: s.errors,
        rejections: s.rejections,
        avg: avg(s.times),
        best: s.times.length ? Math.min(...s.times) : null,
        times: s.times.map((t) => Math.round(t * 1000) / 1000),
      });
    }
    store.set('results', results);
    this.renderProgress(true);
    this.flash(this.summary());
    onSessionEnd();
  }

  summary() {
    if (this.cfg.mode === 'multi') {
      const ranked = [...this.cfg.players].sort((a, b) => this.stats[b].hits - this.stats[a].hits);
      const top = ranked[0];
      const tie = ranked.length > 1 && this.stats[ranked[1]].hits === this.stats[top].hits;
      return tie ? 'Unentschieden!' : `${top} gewinnt mit ${this.stats[top].hits} Treffern!`;
    }
    const s = this.stats[this.cfg.players[0]];
    if (this.cfg.mode === 'sprint') {
      if (!s.times.length) return 'Abgebrochen, kein Lauf gemessen.';
      return `Fertig: ${s.hits} Läufe, Schnitt ${fmt(avg(s.times))} s, Bestzeit ${fmt(Math.min(...s.times))} s`;
    }
    if (this.cfg.mode === 'more') {
      const secs = ((performance.now() - this.startedAt) / 1000).toFixed(1);
      return `Spielende: ${s.hits} Treffer in ${secs} s`;
    }
    let msg = `Fertig: ${s.hits} Treffer, Schnitt ${fmt(avg(s.times))} s`;
    if (this.cfg.mode === 'gonogo') msg += `, ${s.errors} Fehler, ${s.rejections} richtig ignoriert`;
    return msg;
  }

  flash(msg) { $('#live-msg').textContent = msg; }

  renderLive() {
    const all = Object.values(this.stats);
    const times = all.flatMap((s) => s.times);
    $('#live-hits').textContent = all.reduce((n, s) => n + s.hits, 0);
    $('#live-err').textContent = all.reduce((n, s) => n + s.errors + s.misses, 0);
    $('#live-last').textContent = fmt(this.lastRt);
    $('#live-avg').textContent = fmt(avg(times));
    if (this.cfg.mode === 'multi') {
      $('#live-scores').innerHTML = this.cfg.players.map((p) => {
        const c = COLORS[this.cfg.playerColors[p]];
        return `<div class="score" style="background:${c.hex}">${escapeHtml(p)}: ${this.stats[p].hits}</div>`;
      }).join('');
    }
  }

  renderProgress(final) {
    let ratio;
    if (this.cfg.mode === 'sprint') ratio = this.runs / this.cfg.runs;
    else if (this.cfg.mode === 'more') {
      const n = this.lamps.filter((l) => l.connected).length;
      ratio = n ? this.active.size / n : 0;
    } else if (this.cfg.endType === 'time') ratio = (performance.now() - this.startedAt) / 1000 / this.cfg.endTime;
    else ratio = this.fired / this.cfg.endHits;
    $('#live-progress > div').style.width = `${Math.min(1, final ? 1 : ratio) * 100}%`;
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------- Trainings Formular ---------- */

const selected = {
  colors: new Set(trainingCfg.colors || [1, 2, 4]),
  nogo: new Set(trainingCfg.nogoColors || [1]),
};

function colorChips(container, set, onChange) {
  container.innerHTML = '';
  for (let c = 1; c <= 7; c++) {
    const chip = document.createElement('span');
    chip.className = 'chip' + (set.has(c) ? ' on' : '');
    chip.innerHTML = `<span class="dot" style="background:${COLORS[c].hex}"></span>${COLORS[c].name}`;
    chip.onclick = () => {
      if (set.has(c)) set.delete(c); else set.add(c);
      chip.classList.toggle('on', set.has(c));
      if (onChange) onChange();
    };
    container.appendChild(chip);
  }
}

function syncColorExclusivity() {
  // Eine Farbe kann nicht gleichzeitig Ziel und Störfarbe sein
  for (const c of selected.nogo) selected.colors.delete(c);
}

const COLOR_LABELS = { gonogo: 'Zielfarben (treffen)', multi: 'Teams: jede Farbe ist ein Team (2 bis 4)' };

function renderTrainingForm() {
  const mode = $('#mode').value;
  $('#mode-desc').textContent = MODES[mode];
  document.querySelectorAll('[data-show]').forEach((el) => {
    el.classList.toggle('hidden', !el.dataset.show.split(' ').includes(mode));
  });
  $('#colors-label').textContent = COLOR_LABELS[mode] || 'Farben';
  const endType = $('#end-type').value;
  if (endType !== 'hits') $('#end-hits-wrap').classList.add('hidden');
  if (endType !== 'time') $('#end-time-wrap').classList.add('hidden');
  $('#more-accel-wrap').classList.toggle('hidden', $('#more-tempo').value !== 'faster');
  // Raster ohne sichtbare Felder ausblenden, damit keine leeren Abstände bleiben
  document.querySelectorAll('#tab-training .grid2').forEach((g) => {
    g.classList.toggle('hidden', [...g.children].every((el) => el.classList.contains('hidden')));
  });
}

function renderColorPickers() {
  colorChips($('#colors'), selected.colors, () => {
    for (const c of selected.colors) selected.nogo.delete(c);
    renderColorPickers();
  });
  colorChips($('#nogo-colors'), selected.nogo, () => {
    syncColorExclusivity();
    renderColorPickers();
  });
}

function renderSprintSelects() {
  const named = lamps.filter((l) => l.connected);
  const opts = named.map((l) => `<option value="${escapeHtml(l.name)}">Lampe ${l.label}</option>`).join('');
  const start = $('#sprint-start').value || trainingCfg.sprintStart;
  const finish = $('#sprint-finish').value || trainingCfg.sprintFinish;
  $('#sprint-start').innerHTML = opts;
  $('#sprint-finish').innerHTML = '<option value="random">Zufällig</option>' + opts;
  if (named.some((l) => l.name === start)) $('#sprint-start').value = start;
  if (finish === 'random' || named.some((l) => l.name === finish)) $('#sprint-finish').value = finish;
  else if (named.length > 1) $('#sprint-finish').value = named[1].name;
}

function renderPlayerSelects() {
  const opts = players.map((p) => `<option>${escapeHtml(p)}</option>`).join('');
  const cur = $('#player').value || trainingCfg.player;
  $('#player').innerHTML = opts;
  if (players.includes(cur)) $('#player').value = cur;
  const fcur = $('#filter-player').value;
  const teams = [...new Set(results.map((r) => r.player))].filter((p) => !players.includes(p));
  $('#filter-player').innerHTML = '<option value="">Alle</option>' + opts +
    teams.map((p) => `<option>${escapeHtml(p)}</option>`).join('');
  $('#filter-player').value = players.includes(fcur) || teams.includes(fcur) ? fcur : '';
  $('#player-list').innerHTML = '';
  for (const p of players) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.innerHTML = `${escapeHtml(p)} <span class="x" title="Entfernen">✕</span>`;
    chip.querySelector('.x').onclick = () => {
      if (players.length <= 1) return;
      players = players.filter((x) => x !== p);
      store.set('players', players);
      renderPlayerSelects();
    };
    $('#player-list').appendChild(chip);
  }
}

function readTrainingForm() {
  const num = (id) => Number($(id).value);
  const mode = $('#mode').value;
  const cfg = {
    mode,
    endType: $('#end-type').value,
    endHits: Math.max(1, num('#end-hits')),
    endTime: Math.max(5, num('#end-time')),
    delay: Math.max(0, num('#delay')),
    timeout: Math.max(0, num('#timeout')),
    colors: [...selected.colors],
    nogoColors: [...selected.nogo],
    nogoRatio: num('#nogo-ratio'),
    player: $('#player').value,
    runs: Math.max(1, num('#runs')),
    sprintStart: $('#sprint-start').value,
    sprintFinish: $('#sprint-finish').value,
    moreInterval: Math.max(MORE_MIN_INTERVAL, num('#more-interval')),
    moreTempo: $('#more-tempo').value,
    moreAccel: Math.min(50, Math.max(1, num('#more-accel'))),
  };
  store.set('training', cfg);
  if (mode === 'multi') {
    cfg.playerColors = {};
    cfg.players = cfg.colors.map((c) => {
      const team = `Team ${COLORS[c].name}`;
      cfg.playerColors[team] = c;
      return team;
    });
  } else {
    cfg.players = [cfg.player || 'Gast'];
  }
  return cfg;
}

function restoreTrainingForm() {
  const c = trainingCfg;
  // Früher gab es Pause min und max, daraus wird einmalig der Mittelwert
  if (c.delay == null && c.delayMin != null) c.delay = Math.round(((c.delayMin + (c.delayMax ?? c.delayMin)) / 2) * 10) / 10;
  if (c.mode && MODES[c.mode]) $('#mode').value = c.mode;
  if (c.endType) $('#end-type').value = c.endType;
  if (c.moreTempo) $('#more-tempo').value = c.moreTempo;
  const fields = {
    endHits: '#end-hits', endTime: '#end-time', delay: '#delay',
    timeout: '#timeout', nogoRatio: '#nogo-ratio', runs: '#runs', moreInterval: '#more-interval', moreAccel: '#more-accel',
  };
  for (const [k, id] of Object.entries(fields)) if (c[k] != null) $(id).value = c[k];
}

async function startTraining() {
  const cfg = readTrainingForm();
  const n = connectedLamps().length;
  if (n === 0) return alert('Bitte zuerst Lampen verbinden oder simulierte Lampen hinzufügen.');
  if (cfg.mode === 'multi') {
    if (cfg.players.length < 2 || cfg.players.length > 4) return alert('Bitte 2 bis 4 Farben als Teams auswählen.');
    if (n < cfg.players.length) return alert('Für das Duell braucht es mindestens so viele Lampen wie Teams.');
  } else if (cfg.mode === 'sprint') {
    if (!cfg.sprintStart) return alert('Bitte eine Startlampe auswählen.');
  } else if (cfg.colors.length === 0) {
    return alert('Bitte mindestens eine Farbe auswählen.');
  }
  if (cfg.mode === 'more' && n < 2) return alert('Für „Immer mehr“ braucht es mindestens 2 Lampen.');
  if (cfg.mode === 'gonogo' && cfg.nogoColors.length === 0) return alert('Bitte mindestens eine Störfarbe auswählen.');

  $('#btn-start').disabled = true;
  $('#btn-stop').disabled = false;
  $('#live-scores').innerHTML = '';
  $('#live-msg').textContent = 'Los gehts!';
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { wakeLock = null; }
  session = new Session(cfg);
  session.renderLive();
  session.start();
}

function onSessionEnd() {
  $('#btn-start').disabled = false;
  $('#btn-stop').disabled = true;
  try { wakeLock?.release(); } catch { /* egal */ }
  wakeLock = null;
  renderPlayerSelects();
  renderResults();
}

/* ---------- Ergebnisse ---------- */

function renderResults() {
  const filter = $('#filter-player').value;
  const list = results.filter((r) => !filter || r.player === filter).slice().reverse();
  if (list.length === 0) {
    $('#results').innerHTML = '<p class="hint">Noch keine Ergebnisse.</p>';
    return;
  }
  const rows = list.map((r) => `
    <tr>
      <td>${new Date(r.date).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })}</td>
      <td>${escapeHtml(r.player)}</td>
      <td>${MODE_NAMES[r.mode] || r.mode}</td>
      <td class="num">${r.duration}</td>
      <td class="num">${r.hits}</td>
      <td class="num">${fmt(r.avg)}</td>
      <td class="num">${fmt(r.best)}</td>
      <td class="num">${r.misses}</td>
      <td class="num">${r.mode === 'gonogo' ? r.errors : '·'}</td>
    </tr>`).join('');
  $('#results').innerHTML = `
    <div class="card" style="overflow-x:auto">
      <table>
        <thead><tr><th>Datum</th><th>Spieler</th><th>Programm</th><th>Dauer (s)</th><th>Treffer</th><th>Schnitt (s)</th><th>Beste (s)</th><th>Verpasst</th><th>Fehler</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function exportCsv() {
  const num = (v) => (v == null ? '' : String(Math.round(v * 1000) / 1000).replace('.', ','));
  const head = ['Datum', 'Spieler', 'Programm', 'Dauer (s)', 'Treffer', 'Schnitt (s)', 'Beste (s)', 'Verpasst', 'Fehler', 'Richtig ignoriert', 'Einzelzeiten (s)'];
  const lines = results.map((r) => [
    new Date(r.date).toLocaleString('de-DE'),
    r.player,
    MODE_NAMES[r.mode] || r.mode,
    r.duration,
    r.hits,
    num(r.avg),
    num(r.best),
    r.misses,
    r.errors,
    r.rejections,
    r.times.map(num).join(' '),
  ].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(';'));
  const blob = new Blob(['﻿' + [head.join(';'), ...lines].join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `reactionx_ergebnisse_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* ---------- Einstellungen ---------- */

function bindSettings() {
  const bind = (id, key, type) => {
    const el = $(id);
    if (type === 'bool') el.checked = !!settings[key];
    else el.value = settings[key];
    el.onchange = () => {
      settings[key] = type === 'bool' ? el.checked : Number(el.value);
      store.set('settings', settings);
    };
  };
  bind('#set-sense', 'sense');
  bind('#set-flash', 'flash');
  bind('#set-beep-on', 'beepOn', 'bool');
  bind('#set-beep-hit', 'beepHit', 'bool');
  bind('#set-compact', 'compact', 'bool');
  bind('#set-keepalive-blink', 'keepAliveBlink', 'bool');
}

function diagSend() {
  const lamp = lamps[Number($('#diag-lamp').value)];
  if (!lamp) return alert('Keine Lampe ausgewählt.');
  const bytes = $('#diag-bytes').value.trim().split(/[\s,]+/).filter(Boolean).map((h) => parseInt(h, 16));
  if (bytes.length === 0 || bytes.some((b) => isNaN(b) || b < 0 || b > 255)) return alert('Ungültige Hex Bytes.');
  lamp.send(bytes);
}

/* ---------- Start ---------- */

function init() {
  document.querySelectorAll('nav button').forEach((b) => {
    b.onclick = () => {
      document.querySelectorAll('nav button').forEach((x) => x.classList.toggle('active', x === b));
      document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + b.dataset.tab));
      if (b.dataset.tab === 'results') renderResults();
    };
  });

  if (!navigator.bluetooth) {
    $('#ble-warning').classList.remove('hidden');
    $('#btn-connect').disabled = true;
  }

  $('#btn-connect').onclick = connectLamp;
  $('#btn-sim').onclick = () => addLamp(new SimLamp());
  $('#btn-battery').onclick = () => connectedLamps().forEach((l) => l.requestBattery());
  $('#btn-identify').onclick = () => connectedLamps().forEach((l) => l.light(7, 1));
  $('#btn-alloff').onclick = () => connectedLamps().forEach((l) => l.off());

  $('#mode').onchange = renderTrainingForm;
  $('#end-type').onchange = renderTrainingForm;
  $('#more-tempo').onchange = renderTrainingForm;
  $('#btn-start').onclick = startTraining;
  $('#btn-stop').onclick = () => session && session.stop();

  $('#filter-player').onchange = renderResults;
  $('#btn-export').onclick = exportCsv;
  $('#btn-clear').onclick = () => {
    if (!confirm('Wirklich alle Ergebnisse löschen?')) return;
    results = [];
    store.set('results', results);
    renderResults();
  };

  $('#btn-add-player').onclick = () => {
    const name = $('#new-player').value.trim();
    if (!name || players.includes(name)) return;
    players.push(name);
    store.set('players', players);
    $('#new-player').value = '';
    renderPlayerSelects();
  };
  $('#new-player').onkeydown = (e) => { if (e.key === 'Enter') $('#btn-add-player').click(); };
  $('#btn-diag-send').onclick = diagSend;

  restoreTrainingForm();
  bindSettings();
  syncColorExclusivity();
  renderColorPickers();
  renderPlayerSelects();
  renderTrainingForm();
  renderLamps();
  renderResults();
  setInterval(keepAlive, KEEP_ALIVE_MS);
}

init();
