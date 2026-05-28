"use strict";

// ---------- helpers ----------
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);
function setText(el, v) { if (el) el.textContent = (v === null || v === undefined) ? "—" : String(v); }
function setKV(rootSel, key, v) {
  const el = document.querySelector(`${rootSel} dd[data-key="${key}"]`);
  if (el) el.textContent = (v === null || v === undefined || v === "") ? "—" : String(v);
}
function fmt(n, digits = 1) {
  if (n === null || n === undefined || Number.isNaN(n) || !Number.isFinite(n)) return "—";
  return Number(n).toFixed(digits);
}
function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function stddev(arr) {
  if (arr.length < 2) return 0;
  const m = arr.reduce((a, b) => a + b, 0) / arr.length;
  const v = arr.reduce((a, b) => a + (b - m) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(v);
}

// ---------- charts ----------
const CHART_WINDOW = 120; // ~2 min at 1Hz
function buildChart(canvasId, label, color) {
  const ctx = document.getElementById(canvasId).getContext("2d");
  return new Chart(ctx, {
    type: "line",
    data: { labels: [], datasets: [{ label, data: [], borderColor: color, backgroundColor: color + "33", tension: 0.25, pointRadius: 0, borderWidth: 1.5 }] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { display: false },
        y: { ticks: { color: "#9aa6c7", font: { size: 10 } }, grid: { color: "#22305c" }, beginAtZero: true },
      },
    },
  });
}
function pushPoint(chart, label, v) {
  chart.data.labels.push(label);
  chart.data.datasets[0].data.push(v);
  while (chart.data.labels.length > CHART_WINDOW) {
    chart.data.labels.shift();
    chart.data.datasets[0].data.shift();
  }
  chart.update("none");
}

const charts = {
  ping: buildChart("chart-ping", "RTT ms", "#62b6ff"),
  delay: buildChart("chart-delay", "delay ms", "#ffb763"),
  bw: buildChart("chart-bw", "KB/s", "#63ff9a"),
  fps: buildChart("chart-fps", "fps", "#ff7da0"),
};

// ---------- ping / clock offset ----------
const pingState = {
  ws: null,
  open: false,
  samples: [],   // {rtt, offset, lostHints?}
  sent: 0,
  recv: 0,
  bestOffset: null,
  bestRtt: Infinity,
  reconnectDelay: 500,
  pingInterval: null,
  inflight: new Map(),
};

function openPingWs() {
  const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/ping`;
  const ws = new WebSocket(url);
  pingState.ws = ws;
  ws.addEventListener("open", () => {
    pingState.open = true;
    pingState.reconnectDelay = 500;
    document.getElementById("ping-status").className = "dot dot-on";
    if (pingState.pingInterval) clearInterval(pingState.pingInterval);
    pingState.pingInterval = setInterval(sendPing, 100);
  });
  ws.addEventListener("message", (ev) => {
    let data; try { data = JSON.parse(ev.data); } catch { return; }
    if (data.type !== "pong") return;
    const c2 = Date.now();
    const c1 = data.c1;
    const s = data.s;
    const rtt = c2 - c1;
    const offset = s - (c1 + rtt / 2);
    pingState.recv += 1;
    pingState.inflight.delete(c1);
    pingState.samples.push({ rtt, offset, t: c2 });
    while (pingState.samples.length > 100) pingState.samples.shift();
    if (rtt < pingState.bestRtt) {
      pingState.bestRtt = rtt;
      pingState.bestOffset = offset;
    }
    refreshPingPanel();
  });
  ws.addEventListener("close", () => {
    pingState.open = false;
    document.getElementById("ping-status").className = "dot dot-off";
    if (pingState.pingInterval) { clearInterval(pingState.pingInterval); pingState.pingInterval = null; }
    setTimeout(openPingWs, pingState.reconnectDelay);
    pingState.reconnectDelay = Math.min(10000, pingState.reconnectDelay * 2);
  });
  ws.addEventListener("error", () => { try { ws.close(); } catch {} });
}
function sendPing() {
  if (!pingState.open) return;
  const c1 = Date.now();
  pingState.inflight.set(c1, c1);
  pingState.sent += 1;
  try { pingState.ws.send(JSON.stringify({ type: "ping", c1 })); } catch {}
  // Stale in-flight cleanup (assume lost after 3s)
  const cutoff = c1 - 3000;
  for (const k of pingState.inflight.keys()) if (k < cutoff) pingState.inflight.delete(k);
}
function refreshPingPanel() {
  const s = pingState.samples;
  const rtts = s.map(x => x.rtt);
  setKV("#info-ping", "n", s.length);
  setKV("#info-ping", "min", fmt(Math.min(...rtts), 1));
  setKV("#info-ping", "avg", fmt(rtts.reduce((a, b) => a + b, 0) / rtts.length, 1));
  setKV("#info-ping", "med", fmt(median(rtts), 1));
  setKV("#info-ping", "max", fmt(Math.max(...rtts), 1));
  setKV("#info-ping", "jit", fmt(stddev(rtts), 2));
  const loss = pingState.sent ? (100 * (pingState.sent - pingState.recv) / pingState.sent) : 0;
  setKV("#info-ping", "loss", fmt(Math.max(0, loss), 1) + "%");
  setKV("#info-ping", "off", pingState.bestOffset === null ? "—" : `${fmt(pingState.bestOffset, 1)} ms`);
}

// per-second ping aggregator for chart
setInterval(() => {
  const cutoff = Date.now() - 1000;
  const recent = pingState.samples.filter(x => x.t > cutoff).map(x => x.rtt);
  if (recent.length) {
    const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
    pushPoint(charts.ping, "", avg);
  } else {
    pushPoint(charts.ping, "", null);
  }
}, 1000);

// ---------- video ws ----------
const videoState = {
  ws: null,
  open: false,
  canvas: null,
  ctx: null,
  bytesWindow: 0,   // bytes received in current 1s window
  framesWindow: 0,  // frames in current 1s window
  delaysWindow: [], // streaming delay samples in 1s window
  reconnectDelay: 500,
};

function openVideoWs() {
  const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/video`;
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  videoState.ws = ws;

  ws.addEventListener("open", () => {
    videoState.open = true;
    videoState.reconnectDelay = 500;
    document.getElementById("video-status").className = "dot dot-on";
    pushControlConfig();
  });
  ws.addEventListener("message", (ev) => {
    if (typeof ev.data === "string") return;
    const ab = ev.data;
    videoState.bytesWindow += ab.byteLength;
    if (ab.byteLength < 16) return;
    const dv = new DataView(ab);
    const tsUsHi = dv.getUint32(0);
    const tsUsLo = dv.getUint32(4);
    const serverTsUs = tsUsHi * 0x100000000 + tsUsLo;   // safe for our timestamps
    /* const seq = */ dv.getUint32(8);
    const jpegLen = dv.getUint32(12);
    const jpegBytes = new Uint8Array(ab, 16, jpegLen);

    const clientNowMs = Date.now();
    const serverTsMs = serverTsUs / 1000;
    const offset = pingState.bestOffset;
    if (offset !== null) {
      // offset = serverClock - clientClock at the moment of the min-RTT sample.
      // To convert a server timestamp into the client's timeline:
      //   client_equivalent = serverTs - offset
      // One-way delay = clientNow - client_equivalent = clientNow - serverTs + offset.
      const delay = clientNowMs - serverTsMs + offset;
      videoState.delaysWindow.push(delay);
    }
    videoState.framesWindow += 1;

    const blob = new Blob([jpegBytes], { type: "image/jpeg" });
    createImageBitmap(blob).then((bm) => {
      const c = videoState.canvas;
      if (c.width !== bm.width || c.height !== bm.height) {
        c.width = bm.width; c.height = bm.height;
      }
      videoState.ctx.drawImage(bm, 0, 0);
      bm.close && bm.close();
    }).catch(() => {});
  });
  ws.addEventListener("close", () => {
    videoState.open = false;
    document.getElementById("video-status").className = "dot dot-off";
    setTimeout(openVideoWs, videoState.reconnectDelay);
    videoState.reconnectDelay = Math.min(10000, videoState.reconnectDelay * 2);
  });
  ws.addEventListener("error", () => { try { ws.close(); } catch {} });
}

function pushControlConfig() {
  if (!videoState.open) return;
  const cfg = {
    type: "config",
    target_kbps: parseInt($("#ctl-bitrate").value, 10),
    fps: parseInt($("#ctl-fps").value, 10),
    resolution: $("#ctl-resolution").value,
    jpeg_quality: parseInt($("#ctl-quality").value, 10),
  };
  try { videoState.ws.send(JSON.stringify(cfg)); } catch {}
}

// per-second rollups for bandwidth/fps/delay
setInterval(() => {
  const kbps = videoState.bytesWindow / 1024;
  const fps = videoState.framesWindow;
  const delays = videoState.delaysWindow;
  const avgDelay = delays.length ? delays.reduce((a, b) => a + b, 0) / delays.length : null;
  pushPoint(charts.bw, "", kbps);
  pushPoint(charts.fps, "", fps);
  pushPoint(charts.delay, "", avgDelay);
  setText($("#hud-kbps"), `${fmt(kbps, 1)} KB/s`);
  setText($("#hud-fps"), `${fps} fps`);
  setText($("#hud-delay"), avgDelay === null ? "— ms" : `${fmt(avgDelay, 0)} ms`);
  videoState.bytesWindow = 0;
  videoState.framesWindow = 0;
  videoState.delaysWindow = [];
}, 1000);

// ---------- controls ----------
function wireControls() {
  const bind = (rangeId, lblId, suffix = "") => {
    const r = $(rangeId), l = $(lblId);
    if (r && l) {
      l.textContent = r.value + suffix;
      r.addEventListener("input", () => { l.textContent = r.value + suffix; pushControlConfig(); });
      r.addEventListener("change", pushControlConfig);
    }
  };
  bind("#ctl-bitrate", "#lbl-bitrate");
  bind("#ctl-fps", "#lbl-fps");
  bind("#ctl-quality", "#lbl-quality");
  $("#ctl-resolution").addEventListener("change", pushControlConfig);
}

// ---------- info panels ----------
async function loadServerInfo() {
  try {
    const r = await fetch("/api/server-info");
    const d = await r.json();
    setKV("#info-server", "ip", d.public_ip || "—");
    const geo = d.geo || {};
    const loc = [geo.city, geo.regionName, geo.country].filter(Boolean).join(", ");
    setKV("#info-server", "loc", loc || "—");
    setKV("#info-server", "asn", geo.as || geo.asname || "—");
    setKV("#info-server", "isp", geo.isp || geo.org || "—");
    setKV("#info-server", "host", d.hostname || "—");
    if (d.started_at) {
      const uptimeSec = Math.max(0, Date.now() / 1000 - d.started_at);
      setKV("#info-server", "uptime", `${(uptimeSec / 60).toFixed(1)} min`);
    }
    const banner = [d.public_ip, geo.city, geo.country].filter(Boolean).join(" · ");
    if (banner) setText($("#server-banner"), banner);
  } catch (e) {
    setKV("#info-server", "host", "(api error)");
  }
}

async function loadClientInfo() {
  try {
    const r = await fetch("/api/client-info");
    const d = await r.json();
    setKV("#info-client", "ip", d.client_ip || "—");
    const geo = d.geo || {};
    const loc = [geo.city, geo.regionName, geo.country].filter(Boolean).join(", ");
    setKV("#info-client", "loc", loc || "—");
    setKV("#info-client", "asn", [geo.as, geo.isp].filter(Boolean).join(" / ") || "—");
    setKV("#info-client", "ua", navigator.userAgent);
    setKV("#info-client", "screen", `${screen.width}×${screen.height} @ ${window.devicePixelRatio || 1}x`);
    setKV("#info-client", "vp", `${window.innerWidth}×${window.innerHeight}`);
    setKV("#info-client", "tz", Intl.DateTimeFormat().resolvedOptions().timeZone);
  } catch (e) {
    setKV("#info-client", "ip", "(api error)");
  }
  // Browser geolocation (optional, may prompt)
  if ("geolocation" in navigator) {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude, accuracy } = pos.coords;
        setKV("#info-client", "geo", `${latitude.toFixed(4)}, ${longitude.toFixed(4)} (±${Math.round(accuracy)}m)`);
      },
      () => { setKV("#info-client", "geo", "(denied or unavailable)"); },
      { timeout: 4000, enableHighAccuracy: false }
    );
  } else {
    setKV("#info-client", "geo", "(not supported)");
  }
}

function loadNavConnection() {
  const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (!c) {
    setKV("#info-nav", "downlink", "(unsupported)");
    return;
  }
  const refresh = () => {
    setKV("#info-nav", "downlink", c.downlink !== undefined ? `${c.downlink} Mb/s` : "—");
    setKV("#info-nav", "rtt", c.rtt !== undefined ? `${c.rtt} ms` : "—");
    setKV("#info-nav", "eff", c.effectiveType || "—");
    setKV("#info-nav", "type", c.type || "—");
    setKV("#info-nav", "sd", c.saveData ? "true" : "false");
  };
  refresh();
  c.addEventListener && c.addEventListener("change", refresh);
}

async function loadTraceroute() {
  const tbody = document.querySelector("#info-trace tbody");
  const counter = document.getElementById("trace-count");
  tbody.innerHTML = '<tr><td colspan="7" class="muted">running…</td></tr>';
  if (counter) counter.textContent = "running…";
  try {
    const r = await fetch("/api/traceroute");
    const d = await r.json();
    if (d.status !== "ok") {
      tbody.innerHTML = `<tr><td colspan="7" class="muted">${d.error || d.status}</td></tr>`;
      if (counter) counter.textContent = d.status || "error";
      return;
    }
    const hubs = d.report && d.report.hubs ? d.report.hubs : [];
    if (!hubs.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="muted">(no hops)</td></tr>';
      if (counter) counter.textContent = "0 hops";
      return;
    }
    const reachableHops = hubs.filter(h => h.host && h.host !== "???").length;
    if (counter) {
      counter.textContent = reachableHops === hubs.length
        ? `${hubs.length} hops`
        : `${hubs.length} hops (${reachableHops} reachable)`;
    }
    tbody.innerHTML = "";
    for (const h of hubs) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td>${h.count ?? ""}</td><td>${h.host || "???"}</td><td>${fmt(h["Loss%"], 1)}</td><td>${h.Snt ?? ""}</td><td>${fmt(h.Avg, 1)}</td><td>${fmt(h.Best, 1)}</td><td>${fmt(h.Wrst, 1)}</td>`;
      tbody.appendChild(tr);
    }
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="7" class="muted">(error: ${e.message})</td></tr>`;
    if (counter) counter.textContent = "error";
  }
}

// ---------- boot ----------
function boot() {
  videoState.canvas = document.getElementById("video-canvas");
  videoState.ctx = videoState.canvas.getContext("2d");
  wireControls();
  loadServerInfo();
  loadClientInfo();
  loadNavConnection();
  loadTraceroute();
  document.getElementById("btn-trace").addEventListener("click", loadTraceroute);
  openPingWs();
  openVideoWs();
  // Periodic server uptime refresh
  setInterval(loadServerInfo, 30000);
}
document.addEventListener("DOMContentLoaded", boot);
