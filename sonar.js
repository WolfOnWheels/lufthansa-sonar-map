// Shared logic for index.html, map.html and panel.html.
// Every UI element is optional: each page only includes the parts it shows.
const $ = id => document.getElementById(id);
const setText = (id, v) => { const el = $(id); if (el) el.textContent = v; };

if (new URLSearchParams(location.search).has("display")) document.body.classList.add("display");

const API_KEY = "a67be567-6409-4e50-906a-f3e5721e6e14";
const API_URL = `https://airlabs.co/api/v9/flights?api_key=${API_KEY}&airline_iata=LH`;
// Note: free AirLabs plan = 1000 requests/month; 60 s polling uses ~60 requests/hour.
const REFRESH_MS = 60 * 1000;

// Altitude layers, each with its own audio track
const LAYERS = [
  { id: "ground",  label: "Ground layer",  range: "0 – 450 m",       max: 450,      color: "var(--ground)",  src: "audio/ground.wav" },
  { id: "between", label: "Between layer", range: "450 – 10,000 m",  max: 10000,    color: "var(--between)", src: "audio/between.wav" },
  { id: "air",     label: "Air layer",     range: "above 10,000 m",  max: Infinity, color: "var(--air)",     src: "audio/air.wav" },
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
// The three layer tracks start together and loop in sync.
// Note onsets in the Between track are detected from its waveform; on each onset one random
// on-screen Between-layer plane flashes its ring and is shown at the top left.
const RING_FADE_IN_MS = 90;
const RING_FADE_OUT_MS = 2200;
const RING_GROW = 3;

// Note times of the Between track, used when the page is opened straight from disk (file://),
// where browsers block reading the audio data so the notes can't be detected on the fly.
const BETWEEN_ONSETS_FALLBACK = [
  { t: 1.25, dir: "dep" }, { t: 6.0, dir: "arr" }, { t: 19.33, dir: "dep" }, { t: 33.07, dir: "arr" }, { t: 37.41, dir: "dep" },
];

let onsets = [], loopLen = 0, lastPos = 0;
const volumes = Object.fromEntries(LAYERS.map(l => [l.id, 0.8]));

// Per-track volume sliders (index.html only)
d3.select("#tracks").selectAll("div.track").data([...LAYERS].reverse()).join("div").attr("class", "track").html(l => `
  <span class="sw" style="background:${l.color};box-shadow:0 0 6px ${l.color}"></span>
  <span class="name">${l.label} <small>${l.range} · <span id="n-${l.id}">–</span> flights</small></span>
  <output id="v-${l.id}">80</output>
  <input type="range" min="0" max="100" value="80" id="vol-${l.id}" aria-label="${l.label} volume">`);

function detectOnsets(buffer) {
  // 10 ms peak envelope; an onset is a rise above 20% of the track peak,
  // re-armed once the level has fallen back below 5%.
  const hop = Math.round(buffer.sampleRate / 100);
  const chans = [...Array(buffer.numberOfChannels)].map((_, i) => buffer.getChannelData(i));
  const env = [];
  for (let i = 0; i < buffer.length; i += hop) {
    let m = 0;
    for (const c of chans) for (let j = i; j < Math.min(i + hop, buffer.length); j++) m = Math.max(m, Math.abs(c[j]));
    env.push(m);
  }
  const peak = Math.max(...env);
  const out = [];
  let armed = true;
  env.forEach((v, i) => {
    if (armed && v > 0.2 * peak) { out.push(i * hop / buffer.sampleRate); armed = false; }
    else if (!armed && v < 0.05 * peak) armed = true;
  });
  return out;
}

// Label each note arrival or departure by pitch. The autocorrelation peak (over ~85 ms
// after the attack) reads the D note lower than the F, but the D is heard as the higher
// note, so the lower measured pitch is departure.
function classifyNotes(buffer, times) {
  const x = buffer.getChannelData(0), sr = buffer.sampleRate, N = 4096;
  const pitches = times.map(t => {
    const s = Math.floor((t + 0.08) * sr);
    let best = -Infinity, lag = 1;
    for (let L = Math.floor(sr / 1200); L <= Math.floor(sr / 40); L++) {
      let c = 0;
      for (let i = 0; i < N - L; i += 2) c += x[s + i] * x[s + i + L];
      if (c > best) { best = c; lag = L; }
    }
    return sr / lag;
  });
  const mid = (Math.min(...pitches) + Math.max(...pitches)) / 2;
  return times.map((t, i) => ({ t, dir: pitches[i] > mid ? "arr" : "dep", hz: Math.round(pitches[i]) }));
}

// Web Audio engine (served over http/https): sample-accurate sync, notes detected from the file.
async function webAudioEngine() {
  const ctx = new AudioContext();
  const buffers = await Promise.all(LAYERS.map(l =>
    fetch(l.src).then(r => { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); })
      .then(b => ctx.decodeAudioData(b))));
  const gains = {};
  for (const l of LAYERS) {
    gains[l.id] = ctx.createGain();
    gains[l.id].gain.value = volumes[l.id];
    gains[l.id].connect(ctx.destination);
  }
  loopLen = Math.min(...buffers.map(b => b.duration));
  const betweenBuf = buffers[LAYERS.findIndex(l => l.id === "between")];
  onsets = classifyNotes(betweenBuf, detectOnsets(betweenBuf));
  let startAt = null;
  return {
    async play() {
      // schedule first, then resume: if the browser holds audio back until a click,
      // the tracks simply start (still in sync) once the context is allowed to run
      if (startAt === null) {
        startAt = ctx.currentTime + 0.15;
        LAYERS.forEach((l, i) => {
          const src = ctx.createBufferSource();
          src.buffer = buffers[i];
          src.loop = true;
          src.loopEnd = loopLen;
          src.connect(gains[l.id]);
          src.start(startAt);
        });
      }
      await ctx.resume();
    },
    pause: () => ctx.suspend(),
    playing: () => startAt !== null && ctx.state === "running",
    onChange(cb) { ctx.addEventListener("statechange", cb); },
    position() {
      if (startAt === null) return null;
      const t = ctx.currentTime - startAt - (ctx.outputLatency || ctx.baseLatency || 0);
      return t < 0 ? null : t % loopLen;
    },
    setVolume: (id, v) => gains[id].gain.setTargetAtTime(v, ctx.currentTime, 0.02),
    tick() {},
  };
}

// Fallback engine (file://): three <audio> elements kept in step with the Between track.
async function mediaElementEngine() {
  const els = Object.fromEntries(LAYERS.map(l => {
    const el = new Audio(l.src);
    el.loop = true;
    el.preload = "auto";
    el.volume = volumes[l.id];
    return [l.id, el];
  }));
  await Promise.all(Object.values(els).map(el => new Promise((ok, fail) => {
    if (el.readyState >= 4) return ok();
    el.addEventListener("canplaythrough", ok, { once: true });
    el.addEventListener("error", () => fail(new Error(`can't load ${el.src.split("/").pop()}`)), { once: true });
  })));
  const master = els.between;
  loopLen = master.duration;
  onsets = BETWEEN_ONSETS_FALLBACK;
  let lastResync = 0;
  return {
    async play() {
      for (const el of Object.values(els)) if (el !== master && Math.abs(el.currentTime - master.currentTime) > 0.04) el.currentTime = master.currentTime;
      await Promise.all(Object.values(els).map(el => el.play()));
    },
    pause() { for (const el of Object.values(els)) el.pause(); },
    playing: () => !master.paused,
    onChange(cb) { master.addEventListener("play", cb); master.addEventListener("pause", cb); },
    position: () => master.currentTime,
    setVolume: (id, v) => { els[id].volume = v; },
    tick() {
      // nudge the other tracks back into step if they drift (skip right around the loop point)
      const now = performance.now(), t = master.currentTime;
      if (now - lastResync < 1000 || t < 0.5 || t > loopLen - 0.5) return;
      lastResync = now;
      for (const el of Object.values(els)) if (el !== master && Math.abs(el.currentTime - t) > 0.04) el.currentTime = t;
    },
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
    requestAnimationFrame(syncLoop);
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
  lastPos = engine.position() ?? 0;
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

function syncLoop() {
  requestAnimationFrame(syncLoop);
  if (!engine.playing()) return;
  engine.tick();
  const pos = engine.position();
  if (pos === null) return;
  const crossed = pos >= lastPos
    ? onsets.filter(o => o.t > lastPos && o.t <= pos)
    : onsets.filter(o => o.t > lastPos || o.t <= pos); // wrapped around the loop
  lastPos = pos;
  if (crossed.length) flashBetweenRings(crossed[crossed.length - 1].dir);
}

function flashBetweenRings(dir) {
  const visible = gPlanes.selectAll("g.plane.between").nodes().filter(n => {
    const b = n.getBoundingClientRect();
    return b.right > 0 && b.bottom > 0 && b.left < innerWidth && b.top < innerHeight;
  });
  if (!visible.length) return;
  const node = visible[Math.floor(Math.random() * visible.length)];
  node.querySelector(".ring").animate([
    { opacity: 0, transform: "scale(1)", easing: "ease-out" },
    { opacity: 1, transform: "scale(1.05)", offset: RING_FADE_IN_MS / (RING_FADE_IN_MS + RING_FADE_OUT_MS), easing: "ease-in-out" },
    { opacity: 0, transform: `scale(${RING_GROW})` },
  ], { duration: RING_FADE_IN_MS + RING_FADE_OUT_MS });
  showFlight(d3.select(node).datum(), dir);
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
    document.fonts.ready.then(fitRoute);
    nowEl.classList.add("show");
  }, nowEl.textContent.trim() ? 200 : 0);
}
addEventListener("resize", () => { if (nowEl?.textContent.trim()) fitRoute(); });
