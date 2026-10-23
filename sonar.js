// Shared logic for index.html, map.html and panel.html.
// Every UI element is optional: each page only includes the parts it shows.
const $ = id => document.getElementById(id);
const setText = (id, v) => { const el = $(id); if (el) el.textContent = v; };

if (new URLSearchParams(location.search).has("display")) document.body.classList.add("display");

const API_KEY = "a67be567-6409-4e50-906a-f3e5721e6e14";
const API_URL = `https://airlabs.co/api/v9/flights?api_key=${API_KEY}&airline_iata=LH`;
// Seconds between API requests: 60 by default, or a page's <body data-refresh="…">.
// AirLabs developer plan: 25,000 requests/month (60 s ≈ 60/hour, 15 s ≈ 240/hour per open page).
const REFRESH_MS = (+document.body.dataset.refresh || 60) * 1000;

// Altitude layers, each with its own audio track
const LAYERS = [
  { id: "ground",  label: "Ground",               range: "0 – 450 m",      max: 450,      color: "var(--ground)" },
  { id: "between", label: "Ascending/Descending", range: "450 – 10,000 m", max: 10000,    color: "var(--between)" },
  { id: "air",     label: "Cruising",             range: "above 10,000 m", max: Infinity, color: "var(--air)" },
];
const layerOf = d => LAYERS.find(l => (d.alt || 0) < l.max);
// Vertical speed from AirLabs; small values count as level flight
const climbOf = d => (d.v_speed || 0) > 1 ? "asc" : (d.v_speed || 0) < -1 ? "desc" : "level";

function showError(msg) {
  if ($("err")) $("err").textContent = msg;
  else if (msg) console.warn(msg);
}

// ---------- Map ----------
const W = 1600, H = 800;
const CELL = 0.25; // degrees per grid cell for the octilinear coastline
const svg = d3.select("#map").attr("viewBox", `0 0 ${W} ${H}`).attr("preserveAspectRatio", "xMidYMid meet");
const GLOWS = { ground: ["#f1fcd9", "#a3e635"], between: ["#fff6c0", "#ffd400"], air: ["#e6fbff", "#4fe3ff"] };
svg.append("defs").selectAll("radialGradient").data(Object.entries(GLOWS)).join("radialGradient")
  .attr("id", ([id]) => `glow-${id}`)
  .html(([, [core, c]]) => `<stop offset="0%" stop-color="${core}" stop-opacity="1"/>
    <stop offset="25%" stop-color="${c}" stop-opacity=".85"/><stop offset="100%" stop-color="${c}" stop-opacity="0"/>`);
const root = svg.append("g");
const gMap = root.append("g");
const gPlanes = root.append("g");
const projection = d3.geoEquirectangular().scale(W / (2 * Math.PI)).translate([W / 2, H / 2]);

gMap.append("rect").attr("class", "ocean").attr("width", W).attr("height", H);
const gLand = gMap.append("g");
gMap.append("path").datum(d3.geoGraticule().step([15, 15])()).attr("class", "grid").attr("d", d3.geoPath(projection));
for (let lon = -180; lon <= 180; lon += 30) {
  gMap.append("text").attr("class", "grid-label").attr("x", projection([lon, 0])[0] + 2).attr("y", H - 4)
    .text(`${Math.abs(lon)}°${lon < 0 ? "W" : lon > 0 ? "E" : ""}`);
}
for (let lat = -60; lat <= 90; lat += 30) {
  gMap.append("text").attr("class", "grid-label").attr("x", 3).attr("y", projection([-180, lat])[1] - 2)
    .text(`${Math.abs(lat)}°${lat < 0 ? "S" : lat > 0 ? "N" : ""}`);
}

// Coastlines with straight and 45° diagonal segments only: rasterise the land onto a
// lat/lng grid, then trace it with unsmoothed marching squares, whose segments always
// join cell-edge midpoints (horizontal, vertical or exactly diagonal).
d3.json("https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/land-50m.json").then(world => {
  const land = topojson.feature(world, world.objects.land);
  const GW = 360 / CELL, GH = 180 / CELL;
  const canvas = Object.assign(document.createElement("canvas"), { width: GW, height: GH });
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const gridProj = d3.geoEquirectangular().scale(GW / (2 * Math.PI)).translate([GW / 2, GH / 2]);
  ctx.fillStyle = "#fff";
  ctx.beginPath();
  d3.geoPath(gridProj, ctx)(land);
  ctx.fill();
  const px = ctx.getImageData(0, 0, GW, GH).data;
  const values = new Float32Array(GW * GH);
  for (let i = 0; i < values.length; i++) values[i] = px[i * 4 + 3] / 255;
  const contour = d3.contours().size([GW, GH]).smooth(false).thresholds([0.5])(values)[0];
  const toMap = d3.geoIdentity().scale(W / GW); // grid units → map pixels
  gLand.append("path").datum(contour).attr("class", "land").attr("d", d3.geoPath(toMap));
});

// Zoom
let k = 1;
const zoom = d3.zoom().scaleExtent([1, 20]).translateExtent([[0, 0], [W, H]]).on("zoom", e => {
  k = e.transform.k;
  root.attr("transform", e.transform);
  renderPositions();
});
// Start zoomed in on Europe; the reset button returns here
const [ex, ey] = projection([12, 49]);
const HOME = d3.zoomIdentity.translate(W / 2, H / 2).scale(8).translate(-ex, -ey);
svg.call(zoom).call(zoom.transform, HOME);
d3.select("#zoom-in").on("click", () => svg.transition().duration(300).call(zoom.scaleBy, 2));
d3.select("#zoom-out").on("click", () => svg.transition().duration(300).call(zoom.scaleBy, 0.5));
d3.select("#zoom-reset").on("click", () => svg.transition().duration(400).call(zoom.transform, HOME));

// ---------- Flights ----------
const PLANE = "M0,-5 L1,-1.5 L5,1 L5,2 L1,0.8 L0.7,3.5 L2,4.6 L2,5.3 L0,4.8 L-2,5.3 L-2,4.6 L-0.7,3.5 L-1,0.8 L-5,2 L-5,1 L-1,-1.5 Z";
// Between-layer ring radius by altitude (m): 450 m → 9 px, 10,000 m → 42 px
const ringR = alt => 1.5 * 6 + 1.5 * 22 * Math.sqrt(Math.min(Math.max(alt || 0, 0), 10000) / 10000);
const GLOW_R = 25;
const tip = d3.select("#tip");
let flights = [];
let nextAt = 0;

function deadReckon(f, now) {
  // advance along heading at ground speed (km/h) since data timestamp
  const hours = Math.max(0, (now / 1000 - f.updated)) / 3600;
  const dist = (f.speed || 0) * hours / 6371;
  const lat1 = f.lat * Math.PI / 180, lon1 = f.lng * Math.PI / 180, brg = (f.dir || 0) * Math.PI / 180;
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(dist) + Math.cos(lat1) * Math.sin(dist) * Math.cos(brg));
  const lon2 = lon1 + Math.atan2(Math.sin(brg) * Math.sin(dist) * Math.cos(lat1), Math.cos(dist) - Math.sin(lat1) * Math.sin(lat2));
  return [((lon2 * 180 / Math.PI + 540) % 360) - 180, lat2 * 180 / Math.PI];
}

function joinFlights() {
  const sel = gPlanes.selectAll("g.plane").data(flights, d => d.hex || d.flight_icao);
  sel.exit().remove();
  const enter = sel.enter().append("g")
    .on("mousemove", (e, d) => {
      tip.style("display", "block").style("left", e.clientX + 14 + "px").style("top", e.clientY + 10 + "px")
        .html(`<b style="color:#ffd400">${d.flight_iata || d.flight_icao}</b> ${d.dep_iata || "?"} → ${d.arr_iata || "?"}<br>
               ${d.aircraft_icao || ""} ${d.reg_number || ""}<br>
               Alt ${d.alt?.toLocaleString() ?? "–"} m · ${d.speed ?? "–"} km/h · Hdg ${Math.round(d.dir ?? 0)}°<br>
               ${layerOf(d).label}`);
    })
    .on("mouseleave", () => tip.style("display", "none"));
  enter.append("circle").attr("class", "glow").attr("r", GLOW_R)
    .style("animation-delay", () => `${(-Math.random() * 4.5).toFixed(2)}s`);
  enter.append("circle").attr("class", "ring");
  enter.append("circle").attr("class", "hit").attr("r", 8);
  enter.append("path").attr("class", "icon").attr("d", PLANE);
  enter.append("text").attr("y", 3);
  sel.merge(enter).each(function (d) {
    const g = d3.select(this).attr("class", `plane ${layerOf(d).id}`);
    g.select(".ring").attr("r", ringR(d.alt));
    g.select(".icon").attr("transform", `rotate(${d.dir || 0}) scale(0.9)`);
    g.select("text").attr("x", 7).text(d.flight_iata || d.flight_icao);
  });
  renderPositions();
}

function renderPositions() {
  const now = Date.now();
  gPlanes.selectAll("g.plane").attr("transform", d => {
    const [x, y] = projection(deadReckon(d, now));
    return `translate(${x},${y}) scale(${1 / k})`;
  });
}

function updateStats() {
  setText("count", flights.length);
  setText("updated", new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
  for (const l of LAYERS) setText(`n-${l.id}`, flights.filter(f => layerOf(f) === l).length);
  const between = flights.filter(f => layerOf(f).id === "between");
  for (const c of ["asc", "desc", "level"]) setText(`n-${c}`, between.filter(f => climbOf(f) === c).length);
}

async function load() {
  try {
    const res = await fetch(API_URL);
    const json = await res.json();
    if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
    flights = (json.response || []).filter(f => f.status === "en-route" && f.lat != null && f.lng != null);
    showError("");
    updateStats();
    joinFlights();
    scheduleFlightEvents(flights);
  } catch (e) {
    showError("Error: " + e.message);
  }
  nextAt = Date.now() + REFRESH_MS;
}

setInterval(() => { if (Date.now() >= nextAt) load(); }, 1000);
setInterval(() => {
  const s = Math.max(0, Math.round((nextAt - Date.now()) / 1000));
  setText("next", `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`);
}, 1000);
setInterval(renderPositions, 2000); // smooth movement between API polls
load();

// ---------- Audio ----------
// Two background loops (Ground, Cruising) play continuously. Eight one-shot sounds are
// triggered by what the flight data shows each plane doing between two API updates:
//   takeoff   below 450 m and climbing (once per flight)
//   ascend1   crosses 450 m going up       descend3  crosses 10,000 m going down
//   ascend2   crosses 4,500 m going up     descend2  crosses 5,500 m going down
//   ascend3   crosses 10,000 m going up    descend1  crosses 450 m going down
//   landing   below 450 m and descending (once per flight)
// Crossings are found by comparing a flight's altitude with its previous reading; each one is
// played at the point in the following minute that matches where between the two readings
// the threshold was crossed, so events spread out instead of all firing at each update.
const LOOPS = { ground: "audio/ground.wav", air: "audio/air.wav" };
const EVENTS = {
  // takeoff/landing happen inside the Ground layer, where only the ground loop plays:
  // they still flash a ring and show the flight, but have no sound (src: null)
  takeoff:  { src: null, dir: "dep" },
  ascend1:  { src: "audio/ascend1.wav",  dir: "dep" },
  ascend2:  { src: "audio/ascend2.wav",  dir: "dep" },
  ascend3:  { src: "audio/ascend3.wav",  dir: "dep" },
  descend3: { src: "audio/descend3.wav", dir: "arr" },
  descend2: { src: "audio/descend2.wav", dir: "arr" },
  descend1: { src: "audio/descend1.wav", dir: "arr" },
  landing:  { src: null, dir: "arr" },
};
// [event, threshold (m), direction]: up = previous below and now at/above; down = previous above and now at/below
const CROSSINGS = [
  ["ascend1", 450, "up"], ["ascend2", 4500, "up"], ["ascend3", 10000, "up"],
  ["descend3", 10000, "down"], ["descend2", 5500, "down"], ["descend1", 450, "down"],
];
const EVENT_PEAK_DB = -12; // event sounds are played back peaking at −12 dBFS unless EVENTS sets peakDb
const RING_FADE_IN_MS = 90;
const RING_FADE_OUT_MS = 2200;
const RING_GROW = 3;

// Volumes: Ground slider → ground loop, Cruising slider → air loop,
// Ascending/Descending slider ("between") → all eight event sounds
const volumes = Object.fromEntries(LAYERS.map(l => [l.id, 0.8]));

// Per-track volume sliders (index.html only)
d3.select("#tracks").selectAll("div.track").data([...LAYERS].reverse()).join("div").attr("class", "track").html(l => `
  <span class="sw" style="background:${l.color};box-shadow:0 0 6px ${l.color}"></span>
  <span class="name">${l.label} <small>${l.range} · <span id="n-${l.id}">–</span> flights</small></span>
  <output id="v-${l.id}">80</output>
  <input type="range" min="0" max="100" value="80" id="vol-${l.id}" aria-label="${l.label} volume">`);

// Web Audio engine (served over http/https): loops start together; events are short buffer sources.
async function webAudioEngine() {
  const ctx = new AudioContext();
  const load = src => fetch(src).then(r => { if (!r.ok) throw new Error(`${src}: ${r.status}`); return r.arrayBuffer(); })
    .then(b => ctx.decodeAudioData(b));
  const names = [...Object.keys(LOOPS), ...Object.keys(EVENTS).filter(n => EVENTS[n].src)];
  const decoded = await Promise.all(names.map(n => load(LOOPS[n] || EVENTS[n].src)));
  const buffers = Object.fromEntries(names.map((n, i) => [n, decoded[i]]));
  // The event stems are mastered much quieter than the loops (the six tones peak around
  // −28 to −34 dBFS), so each event is normalised to the same peak level to stand out.
  const peakOf = b => { let m = 0; for (let c = 0; c < b.numberOfChannels; c++) for (const v of b.getChannelData(c)) m = Math.max(m, Math.abs(v)); return m; };
  const eventGain = Object.fromEntries(Object.entries(EVENTS).filter(([, e]) => e.src).map(([n, e]) =>
    [n, 10 ** ((e.peakDb ?? EVENT_PEAK_DB) / 20) / Math.max(peakOf(buffers[n]), 1e-4)]));
  const gains = {};
  for (const l of LAYERS) {
    gains[l.id] = ctx.createGain();
    gains[l.id].gain.value = volumes[l.id];
    gains[l.id].connect(ctx.destination);
  }
  let started = false;
  return {
    async play() {
      // schedule first, then resume: if the browser holds audio back until a click,
      // the loops simply start once the context is allowed to run
      if (!started) {
        started = true;
        const at = ctx.currentTime + 0.15;
        for (const n of Object.keys(LOOPS)) {
          const src = ctx.createBufferSource();
          src.buffer = buffers[n];
          src.loop = true;
          src.connect(gains[n]);
          src.start(at);
        }
      }
      await ctx.resume();
    },
    pause: () => ctx.suspend(),
    playing: () => started && ctx.state === "running",
    onChange(cb) { ctx.addEventListener("statechange", cb); },
    trigger(name) {
      const src = ctx.createBufferSource();
      const level = ctx.createGain();
      src.buffer = buffers[name];
      level.gain.value = eventGain[name];
      src.connect(level).connect(gains.between);
      src.start();
    },
    setVolume: (id, v) => gains[id].gain.setTargetAtTime(v, ctx.currentTime, 0.02),
  };
}

// Fallback engine (file://, where pages can't read audio data): <audio> elements.
async function mediaElementEngine() {
  const ready = el => new Promise((ok, fail) => {
    if (el.readyState >= 4) return ok();
    el.addEventListener("canplaythrough", ok, { once: true });
    el.addEventListener("error", () => fail(new Error(`can't load ${el.src.split("/").pop()}`)), { once: true });
  });
  const loops = Object.fromEntries(Object.entries(LOOPS).map(([n, src]) => {
    const el = new Audio(src);
    el.loop = true;
    el.preload = "auto";
    el.volume = volumes[n];
    return [n, el];
  }));
  await Promise.all(Object.values(loops).map(ready));
  // preload the event sounds once so later plays start immediately
  for (const e of Object.values(EVENTS)) if (e.src) Object.assign(new Audio(e.src), { preload: "auto" }).load();
  const master = loops.ground;
  return {
    async play() { await Promise.all(Object.values(loops).map(el => el.play())); },
    pause() { for (const el of Object.values(loops)) el.pause(); },
    playing: () => !master.paused,
    onChange(cb) { master.addEventListener("play", cb); master.addEventListener("pause", cb); },
    trigger(name) {
      const el = new Audio(EVENTS[name].src);
      el.volume = volumes.between;
      el.play().catch(() => {});
    },
    setVolume: (id, v) => { if (loops[id]) loops[id].volume = v; },
  };
}

let engine = null;
const playBtn = $("play");
// Icon-only play buttons (in the zoom column) show ▶ / ❚❚; the full one shows a label too
const COMPACT = playBtn.classList.contains("icon");
(location.protocol === "file:" ? mediaElementEngine() : webAudioEngine().catch(() => mediaElementEngine()))
  .then(e => {
    engine = e;
    playBtn.disabled = false;
    engine.onChange(updatePlayState);
    updatePlayState();
    autoplay();
  })
  .catch(e => {
    playBtn.title = "Audio failed to load";
    if (!COMPACT) playBtn.textContent = "Audio failed to load";
    showError("Audio: " + e.message);
  });

for (const l of LAYERS) {
  $(`vol-${l.id}`)?.addEventListener("input", e => {
    const v = +e.target.value;
    volumes[l.id] = v / 100;
    engine?.setVolume(l.id, v / 100);
    setText(`v-${l.id}`, v);
  });
}

function updatePlayState() {
  const on = engine.playing();
  playBtn.textContent = COMPACT ? (on ? "❚❚" : "▶") : (on ? "❚❚ Pause" : "▶ Play");
  playBtn.title = on ? "Pause" : "Play";
  playBtn.setAttribute("aria-label", playBtn.title);
  postState();
}

function startPlayback() {
  return engine.play().then(updatePlayState, () => {}); // blocked until a click/tap/key press
}

// Sound plays by default. Browsers only allow audio after the visitor interacts with the
// page, so if playback is held back it starts on the first click, tap or key press.
function autoplay() {
  startPlayback();
  const unlock = e => {
    if (e.target.closest?.("#play")) return; // the Play button handles itself
    if (!engine.playing()) startPlayback();
    for (const ev of ["pointerdown", "keydown"]) removeEventListener(ev, unlock, true);
  };
  for (const ev of ["pointerdown", "keydown"]) addEventListener(ev, unlock, true);
}

playBtn.onclick = async () => {
  if (engine.playing()) await engine.pause();
  else await startPlayback();
  updatePlayState();
};

// Remote control from a parent page (mockup.html embeds a page in an iframe)
function postState() {
  if (window.parent !== window) window.parent.postMessage({ type: "sonar-state", ready: !!engine, playing: !!engine?.playing() }, "*");
}
window.addEventListener("message", e => {
  if (e.source !== window.parent || !e.data) return;
  const { cmd, id, value } = e.data;
  if (cmd === "toggle" && engine) playBtn.onclick();
  if (cmd === "play" && engine && !engine.playing()) startPlayback();
  if (cmd === "volume" && LAYERS.some(l => l.id === id)) {
    volumes[id] = value / 100;
    engine?.setVolume(id, value / 100);
    const input = $(`vol-${id}`);
    if (input) { input.value = value; setText(`v-${id}`, value); }
  }
  if (cmd === "state") postState();
});

// ---------- Flight events from the data ----------
const lastSeen = new Map();   // flight key → { alt, updated } from the previous API update
const playedOnce = new Set(); // "key:takeoff" / "key:landing", so those play once per flight
const keyOf = d => d.hex || d.flight_icao;

function scheduleFlightEvents(list) {
  const pending = [];
  for (const f of list) {
    const key = keyOf(f), alt = f.alt || 0, prev = lastSeen.get(key);
    if (prev && f.updated > prev.updated) {
      const span = Math.min(REFRESH_MS, (f.updated - prev.updated) * 1000);
      for (const [name, th, way] of CROSSINGS) {
        const crossed = way === "up" ? prev.alt < th && alt >= th : prev.alt > th && alt <= th;
        if (crossed) pending.push({ key, name, delay: span * (th - prev.alt) / (alt - prev.alt) });
      }
    }
    if (alt < 450) {
      const once = climbOf(f) === "asc" ? "takeoff" : climbOf(f) === "desc" ? "landing" : null;
      if (once && !playedOnce.has(`${key}:${once}`)) {
        playedOnce.add(`${key}:${once}`);
        pending.push({ key, name: once, delay: Math.random() * REFRESH_MS * 0.5 });
      }
    }
    lastSeen.set(key, { alt, updated: f.updated });
  }
  for (const ev of pending) setTimeout(() => fireEvent(ev), Math.max(0, ev.delay));
}

function fireEvent({ key, name }) {
  if (EVENTS[name].src && engine?.playing()) engine.trigger(name);
  const node = gPlanes.selectAll("g.plane").filter(d => keyOf(d) === key).node();
  if (!node) return;
  // takeoff/landing rings use the Ground colour, the six climb/descent tones the Ascending/Descending colour
  flashRing(node, name === "takeoff" || name === "landing" ? "var(--ground)" : "var(--between)");
  showFlight(d3.select(node).datum(), EVENTS[name].dir);
}

function flashRing(node, color) {
  const ring = node.querySelector(".ring");
  ring.style.stroke = color;
  ring.style.fill = `color-mix(in srgb, ${color} 25%, transparent)`;
  ring.animate([
    { opacity: 0, transform: "scale(1)", easing: "ease-out" },
    { opacity: 1, transform: "scale(1.05)", offset: RING_FADE_IN_MS / (RING_FADE_IN_MS + RING_FADE_OUT_MS), easing: "ease-in-out" },
    { opacity: 0, transform: `scale(${RING_GROW})` },
  ], { duration: RING_FADE_IN_MS + RING_FADE_OUT_MS });
}

// ---------- Flight info (top left) ----------
// Departure / arrival pictograms after Otl Aicher's Munich 1972 airport signs: a side-view
// aircraft climbing to the right (departure) or descending to the left with its gear down
// (arrival), in solid white inside a white-outlined rounded box.
const AIRCRAFT = `<path d="M2.6 12.6c.5-.7 1.4-1.2 2.6-1.2H19.4c1.9 0 3.4.5 3.9 1.2-.5.7-2 1.2-3.9 1.2H5.2c-1.2 0-2.1-.5-2.6-1.2z"/>
  <path d="M2.4 12.2V8.4h1.7l2.4 3.4z"/>
  <path d="M8.6 11.6 5.8 5.4h2.5l5.8 6.2z"/>`;
const GEAR = `<circle cx="18.8" cy="15.3" r=".8"/><circle cx="10.6" cy="15" r=".8"/><circle cx="12.3" cy="15" r=".8"/>`;
const icon = (plane, mirror) => `<rect x=".375" y=".375" width="23.25" height="23.25" rx="3.6" fill="none" stroke="currentColor" stroke-width=".75"/>
  <g fill="currentColor" transform="translate(12 12.4) rotate(-22) scale(${mirror ? -0.86 : 0.86} 0.86) translate(-12.8 -11.2)">${plane}</g>`;
const ICONS = { dep: icon(AIRCRAFT, false), arr: icon(AIRCRAFT + GEAR, true) };
document.querySelectorAll("[data-icon]").forEach(el => { el.innerHTML = ICONS[el.dataset.icon]; });

// The route line is sized so it is exactly as wide as a 5-character flight number
// (e.g. LH470) set in the same font above it.
const measureCtx = document.createElement("canvas").getContext("2d");
function fitRoute() {
  const flightEl = $("now-flight"), routeEl = $("now-route");
  const cs = getComputedStyle(flightEl);
  const font = px => `${cs.fontWeight} ${px}px ${cs.fontFamily}`;
  const base = parseFloat(cs.fontSize);
  measureCtx.font = font(base);
  const target = measureCtx.measureText("LH470").width;
  const routeW = measureCtx.measureText(routeEl.textContent).width;
  routeEl.style.fontSize = `${(base * target / routeW).toFixed(2)}px`;
}

// Large flight number + route at the top left; stays until the next note replaces it
const nowEl = $("now");
function showFlight(d, dir) {
  if (!nowEl) return;
  nowEl.classList.remove("show");
  setTimeout(() => {
    $("now-icon").innerHTML = ICONS[dir] || "";
    $("now-flight").textContent = d.flight_iata || d.flight_icao;
    $("now-route").textContent = `${d.dep_iata || "???"}:${d.arr_iata || "???"}`;
    setText("now-alt", d.alt != null ? `${Math.round(d.alt).toLocaleString("en-US")} m` : "");
    document.fonts.ready.then(fitRoute);
    nowEl.classList.add("show");
  }, nowEl.textContent.trim() ? 200 : 0);
}
addEventListener("resize", () => { if (nowEl?.textContent.trim()) fitRoute(); });
