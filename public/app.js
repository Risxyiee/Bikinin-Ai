// UI logic (ES module), driven by real agent events over SSE.
// All text is written with textContent or createTextNode, never innerHTML, so model output cannot inject markup.
// Static markup lives in index.html (templates); the browser never sees an API key.
import { parseBlocks } from "/md.js";

const $ = (s) => document.querySelector(s);
const main = $("#main");
const input = $("#input");
const sendBtn = $("#send");
const heroEl = $("#hero");
const isCoarsePointer = matchMedia("(pointer: coarse)").matches;
const CIRC = 97.39; // 2 * PI * 15.5, matches the ring in app.css

const state = {
  cfg: null,
  runId: null,
  source: null,
  busy: false,
  lastPrompt: "",
  approvalId: null,
  think: null, // { block, label, timer, lines: Map, count }
  explainEl: null,
  explainRaw: "",
  files: new Map(), // path -> { bytes }
  overlayPath: null,
  startedAt: 0,
  timerInt: 0,
  toastTimer: 0,
};

const fmtUsd = (n) => "$" + n.toFixed(4);
const fmtIdr = (usd) => "≈ Rp " + Math.round(usd * (state.cfg ? state.cfg.usd_idr : 17000)).toLocaleString("id-ID");
const fmtKb = (bytes) => (bytes / 1024).toFixed(1).replace(".", ",") + " KB";
const tpl = (id) => $(id).content.firstElementChild.cloneNode(true);

// ---------- Helpers ----------

function isNearBottom() {
  return main.scrollHeight - main.scrollTop - main.clientHeight < 140;
}
function scrollDown(force = false) {
  if (force || isNearBottom()) main.scrollTop = main.scrollHeight;
}

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
}

function setMeters(steps, cost) {
  const max = state.cfg ? state.cfg.max_steps : 0;
  const p = max > 0 ? Math.min(steps / max, 1) : 0;
  $("#ringArc").style.strokeDashoffset = (CIRC * (1 - p)).toFixed(2);
  $("#ringBtn").classList.toggle("full", max > 0 && steps >= max);
  $("#ringLabel").textContent = `${steps}/${max}`;
  $("#stSteps").textContent = `${steps} / ${max}`;
  $("#stCost").textContent = fmtUsd(cost);
  $("#stIdr").textContent = fmtIdr(cost);
}

function updateSendState() {
  sendBtn.disabled = !state.busy && input.value.trim() === "";
}

function setBusy(on) {
  state.busy = on;
  sendBtn.classList.toggle("stop", on);
  const icon = $("#tplIcons").content.querySelector(`[data-ic="${on ? "stop" : "send"}"]`);
  sendBtn.replaceChildren(icon.firstElementChild.cloneNode(true));
  sendBtn.setAttribute("aria-label", on ? "Hentikan agent" : "Kirim");
  input.disabled = on;
  updateSendState();
  if (!on) input.focus();
}

// ---------- Markdown (DOM only) ----------

function appendInline(parent, parts) {
  for (const p of parts) {
    if (p.t === "text") {
      parent.appendChild(document.createTextNode(p.v));
    } else if (p.t === "link") {
      const a = document.createElement("a");
      a.href = p.href; // the parser only allows http(s)
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = p.v;
      parent.appendChild(a);
    } else {
      const n = document.createElement(p.t === "strong" ? "strong" : p.t === "em" ? "em" : "code");
      n.textContent = p.v;
      parent.appendChild(n);
    }
  }
}

function codeBlock(block) {
  const wrap = document.createElement("div");
  wrap.className = "codeblock";
  const bar = document.createElement("div");
  bar.className = "codebar";
  const lang = document.createElement("span");
  lang.textContent = block.lang || "kode";
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "copy";
  copy.textContent = "Salin";
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(block.text);
      copy.textContent = "Tersalin";
    } catch {
      copy.textContent = "Gagal";
    }
    setTimeout(() => (copy.textContent = "Salin"), 1600);
  });
  bar.append(lang, copy);
  const pre = document.createElement("pre");
  const code = document.createElement("code");
  code.textContent = block.text;
  pre.appendChild(code);
  wrap.append(bar, pre);
  return wrap;
}

function renderBlock(b) {
  switch (b.t) {
    case "p": {
      const p = document.createElement("p");
      appendInline(p, b.inline);
      return p;
    }
    case "h": {
      const h = document.createElement(b.level === 1 ? "h3" : "h4");
      appendInline(h, b.inline);
      return h;
    }
    case "ul":
    case "ol": {
      const list = document.createElement(b.t);
      for (const item of b.items) {
        const li = document.createElement("li");
        appendInline(li, item);
        list.appendChild(li);
      }
      return list;
    }
    case "hr":
      return document.createElement("hr");
    case "code":
      return codeBlock(b);
    default:
      return document.createTextNode("");
  }
}

function renderMarkdown(target, raw) {
  target.replaceChildren(...parseBlocks(raw).map(renderBlock));
}

// ---------- Hero: liquid folders (ported from the design, canvas only) ----------

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeFbm(seed) {
  const r = mulberry32(seed);
  const p = [];
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [p[i], p[j]] = [p[j], p[i]];
  }
  const perm = new Uint8Array(512);
  const grad = new Float32Array(512);
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  for (let i = 0; i < 256; i++) {
    const ang = r() * Math.PI * 2;
    grad[i * 2] = Math.cos(ang);
    grad[i * 2 + 1] = Math.sin(ang);
  }
  const fade = (v) => v * v * (3 - 2 * v);
  const g = (h, dx, dy) => grad[h * 2] * dx + grad[h * 2 + 1] * dy;
  const n2 = (x0, y0) => {
    let X = Math.floor(x0), Y = Math.floor(y0);
    const x = x0 - X, y = y0 - Y;
    X &= 255; Y &= 255;
    const u = fade(x), v = fade(y);
    const aa = perm[perm[X] + Y], ba = perm[perm[X + 1] + Y];
    const ab = perm[perm[X] + Y + 1], bb = perm[perm[X + 1] + Y + 1];
    const l1 = g(aa, x, y) + u * (g(ba, x - 1, y) - g(aa, x, y));
    const l2 = g(ab, x, y - 1) + u * (g(bb, x - 1, y - 1) - g(ab, x, y - 1));
    return l1 + v * (l2 - l1);
  };
  return (x, y, oct) => {
    let sum = 0, amp = 0.5, fr = 1;
    for (let o = 0; o < oct; o++) {
      const c = Math.cos(o * 1.7), s = Math.sin(o * 1.7);
      sum += amp * n2(x * fr * c - y * fr * s, x * fr * s + y * fr * c);
      fr *= 2.03;
      amp *= 0.55;
    }
    return sum;
  };
}

function paintLiquid(canvas, seed, colors, scale, warp, gloss, veins) {
  const w = canvas.width, h = canvas.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const img = ctx.createImageData(w, h);
  const d = img.data;
  const fbm = makeFbm(seed);
  const cols = colors.map((hex) => {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  });
  const s = (scale * 3.2) / Math.max(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const px = x * s, py = y * s;
      const qx = fbm(px, py, 3), qy = fbm(px + 5.2, py + 1.3, 3);
      const rx = fbm(px + 4 * warp * qx + 1.7, py + 4 * warp * qy + 9.2, 3);
      const ry = fbm(px + 4 * warp * qx + 8.3, py + 4 * warp * qy + 2.8, 3);
      const f = fbm(px + 4 * warp * rx, py + 4 * warp * ry, 4);
      let v = Math.pow(Math.min(1, Math.max(0, f * 0.5 + 0.5)), 1.75);
      v = Math.min(0.999, v) * (cols.length - 1);
      const i0 = Math.floor(v), fv = v - i0;
      const c0 = cols[i0], c1 = cols[i0 + 1];
      let R = c0[0] + (c1[0] - c0[0]) * fv, G = c0[1] + (c1[1] - c0[1]) * fv, B = c0[2] + (c1[2] - c0[2]) * fv;
      const vein = Math.max(0, 1 - Math.abs(f) * (3.2 + veins * 4)) * veins;
      R -= vein * 46; G -= vein * 44; B -= vein * 40;
      const sp = Math.pow(Math.max(0, 1 - Math.abs(f + 0.35)), 6) * gloss;
      R += sp * 150; G += sp * 150; B += sp * 160;
      const o = (y * w + x) * 4;
      d[o] = R; d[o + 1] = G; d[o + 2] = B; d[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

const ART_RECIPES = [
  { colors: ["#03040a", "#071026", "#0e2260", "#1e44c8", "#315ff2", "#6f97ff", "#a7c4ff"], scale: 0.5, warp: 3.1, veins: 0.5, gloss: 0.38 },
  { colors: ["#03040a", "#0a1330", "#16307e", "#274fd4", "#4a79ff", "#8fb4ff", "#c9dbff"], scale: 0.62, warp: 3.8, veins: 0.55, gloss: 0.4 },
];

function paintFolders() {
  const jobs = [];
  document.querySelectorAll(".gfolder").forEach((f, i) => {
    const back = f.querySelector(".gf-art");
    if (back && !back.dataset.done) jobs.push({ c: back, r: ART_RECIPES[i % ART_RECIPES.length], seed: 17 + i * 97 });
  });
  const step = () => {
    const j = jobs.shift();
    if (!j) return;
    paintLiquid(j.c, j.seed, j.r.colors, j.r.scale, j.r.warp, j.r.gloss, j.r.veins);
    j.c.dataset.done = "1";
    j.c.classList.add("ready");
    requestAnimationFrame(step);
  };
  step();
}

function bindHero() {
  // The design stores per-sheet CSS variables inline; CSP forbids inline style, so set them here.
  document.querySelectorAll(".gf-sheet").forEach((s) => {
    s.style.setProperty("--s", s.dataset.s || "0");
    s.style.setProperty("--jr", s.dataset.jr || "0deg");
  });
  $("#folderHistoryBtn").addEventListener("click", () => toast("Riwayat proyek belum tersedia di versi ini"));
  $("#folderSkillsBtn").addEventListener("click", () => toast("Skill agent belum tersedia di versi ini"));
  if (matchMedia("(hover:hover)").matches) {
    document.querySelectorAll(".gfolder").forEach((f) => {
      f.addEventListener("pointermove", (e) => {
        const r = f.getBoundingClientRect();
        f.style.setProperty("--px", (((e.clientX - r.left) / r.width) * 2 - 1).toFixed(3));
        f.style.setProperty("--py", (((e.clientY - r.top) / r.height) * 2 - 1).toFixed(3));
      });
      f.addEventListener("pointerleave", () => {
        f.style.setProperty("--px", "0");
        f.style.setProperty("--py", "0");
      });
    });
  }
  document.querySelectorAll(".sug").forEach((s) => {
    s.addEventListener("click", () => {
      if (!state.busy) void start(s.dataset.prompt || "");
    });
  });
  paintFolders();
}

// ---------- Messages ----------

function addUser(text) {
  const div = document.createElement("div");
  div.className = "msg user";
  div.textContent = text;
  main.appendChild(div);
  scrollDown(true);
}

function addThink(label) {
  const block = tpl("#tplThink");
  const labelEl = block.querySelector(".think-label");
  const timer = block.querySelector(".think-timer-pill");
  labelEl.textContent = label;
  const toggle = block.querySelector(".think-toggle");
  toggle.addEventListener("click", () => {
    const collapsed = block.classList.toggle("collapsed");
    toggle.setAttribute("aria-expanded", String(!collapsed));
  });
  main.appendChild(block);
  scrollDown(true);
  state.startedAt = Date.now();
  clearInterval(state.timerInt);
  state.timerInt = setInterval(() => {
    timer.textContent = ((Date.now() - state.startedAt) / 1000).toFixed(1) + "s";
  }, 100);
  state.think = { block, labelEl, timer, linesEl: block.querySelector(".think-lines"), rows: new Map(), count: 0 };
}

function thinkLine(callId, text) {
  const t = state.think;
  if (!t) return;
  const line = document.createElement("div");
  line.className = "think-line";
  line.textContent = text;
  t.linesEl.appendChild(line);
  t.rows.set(callId, { line, text });
  t.count += 1;
  t.labelEl.textContent = text;
  scrollDown();
}

function finishThink(status, steps) {
  clearInterval(state.timerInt);
  const t = state.think;
  if (!t) return;
  t.timer.textContent = ((Date.now() - state.startedAt) / 1000).toFixed(1) + "s";
  t.labelEl.classList.remove("shimmer");
  if (t.count === 0) {
    t.block.remove(); // a plain chat answer needs no "steps" block
  } else {
    const labels = {
      completed: `Selesai · ${steps} langkah`,
      stopped: "Dihentikan pengguna",
      budget_exceeded: "Berhenti: batas tercapai",
      error: "Berhenti karena error",
    };
    t.labelEl.textContent = labels[status] || "Selesai";
    t.block.classList.add(status === "error" ? "err" : "done");
    if (status === "completed") t.block.classList.add("collapsed");
  }
  state.think = null;
}

function explainBox() {
  if (!state.explainEl) {
    const box = document.createElement("div");
    box.className = "agent-explain";
    main.appendChild(box);
    state.explainEl = box;
    state.explainRaw = "";
  }
  return state.explainEl;
}

function addErrorCard(title, message) {
  const card = tpl("#tplError");
  card.querySelector("b").textContent = title;
  card.querySelector("small").textContent = message;
  card.querySelector(".retry-btn").addEventListener("click", () => {
    card.remove();
    if (!state.busy && state.lastPrompt) void start(state.lastPrompt);
  });
  main.appendChild(card);
  scrollDown(true);
}

// ---------- Result card + overlay ----------

const previewUrl = (path, bust = false) =>
  "/preview/" + path.split("/").map(encodeURIComponent).join("/") + (bust ? "?t=" + Date.now() : "");

function fitThumb(wrap, iframe) {
  const w = wrap.clientWidth || 580;
  const scale = w / 1024;
  iframe.style.transform = `scale(${scale.toFixed(4)})`;
  wrap.style.height = Math.max(150, Math.min(210, Math.round(560 * scale))) + "px";
}

function addResult(path, bytes) {
  const card = tpl("#tplResult");
  const wrap = card.querySelector(".thumb-wrap");
  const frame = card.querySelector(".thumb-frame");
  card.querySelector(".res-title").textContent = path;
  card.querySelector(".res-sub").textContent = fmtKb(bytes);
  frame.src = previewUrl(path, true);
  main.appendChild(card);
  fitThumb(wrap, frame);
  if (window.ResizeObserver) new ResizeObserver(() => fitThumb(wrap, frame)).observe(wrap);
  wrap.addEventListener("click", () => openOverlay(path, "preview"));
  card.querySelector('[data-act="preview"]').addEventListener("click", () => openOverlay(path, "preview"));
  card.querySelector('[data-act="code"]').addEventListener("click", () => openOverlay(path, "code"));
  card.querySelector('[data-act="download"]').addEventListener("click", () => void downloadFile(path));
  card.querySelector('[data-act="regen"]').addEventListener("click", () => {
    if (!state.busy && state.lastPrompt) void start(state.lastPrompt);
  });
  scrollDown(true);
}

async function fetchText(path) {
  const r = await fetch(previewUrl(path, true));
  if (!r.ok) throw new Error("gagal memuat file");
  return r.text();
}

async function downloadFile(path) {
  try {
    const text = await fetchText(path);
    const url = URL.createObjectURL(new Blob([text], { type: "text/html" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = path.split("/").pop() || "index.html";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
    toast(`${a.download} diunduh`);
  } catch {
    toast("Gagal mengunduh file");
  }
}

function setOverlayMode(mode) {
  document.querySelectorAll(".ov-mode").forEach((b) => b.classList.toggle("active", b.dataset.ov === mode));
  const isCode = mode === "code";
  const mobile = $("#ovStage").classList.contains("mobile-vp");
  $("#ovStage").hidden = isCode;
  $("#ovCode").hidden = !isCode;
  $("#ovVp").hidden = isCode;
  $("#ovRefreshBtn").hidden = isCode;
  $("#vpBadge").hidden = isCode || !mobile;
  if (isCode) void renderCode();
}

async function renderCode() {
  const path = state.overlayPath;
  if (!path) return;
  const tabs = $("#ovFtabs");
  const tab = document.createElement("button");
  tab.type = "button";
  tab.className = "ov-ftab active";
  tab.textContent = path;
  tabs.replaceChildren(tab);
  try {
    const text = await fetchText(path);
    const lines = text.split("\n");
    $("#ovLineCount").textContent = `${lines.length} baris`;
    const gutter = $("#codeGutter");
    gutter.replaceChildren(
      ...lines.map((_, i) => {
        const s = document.createElement("span");
        s.textContent = String(i + 1);
        return s;
      }),
    );
    $("#ovPre").textContent = text;
  } catch {
    $("#ovPre").textContent = "Gagal memuat kode.";
  }
}

function openOverlay(path, mode) {
  state.overlayPath = path;
  $("#previewFrame").src = previewUrl(path, true);
  $("#overlay").hidden = false;
  setOverlayMode(mode);
}

function closeOverlay() {
  $("#overlay").hidden = true;
  $("#previewFrame").removeAttribute("src");
}

document.querySelectorAll(".ov-mode").forEach((b) => b.addEventListener("click", () => setOverlayMode(b.dataset.ov)));
document.querySelectorAll("#ovVp button").forEach((b) =>
  b.addEventListener("click", () => {
    document.querySelectorAll("#ovVp button").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    const mobile = b.dataset.vp === "mobile";
    $("#ovStage").classList.toggle("mobile-vp", mobile);
    $("#vpBadge").hidden = !mobile;
  }),
);
$("#ovRefreshBtn").addEventListener("click", () => {
  if (state.overlayPath) $("#previewFrame").src = previewUrl(state.overlayPath, true);
});
$("#ovNewTabBtn").addEventListener("click", () => {
  if (state.overlayPath) window.open(previewUrl(state.overlayPath), "_blank", "noopener,noreferrer");
});
$("#ovCopyBtn").addEventListener("click", async () => {
  if (!state.overlayPath) return;
  try {
    await navigator.clipboard.writeText(await fetchText(state.overlayPath));
    toast("Kode disalin");
  } catch {
    toast("Gagal menyalin");
  }
});
$("#ovDlBtn").addEventListener("click", () => {
  if (state.overlayPath) void downloadFile(state.overlayPath);
});
$("#closeOverlay").addEventListener("click", closeOverlay);

// ---------- Approval ----------

function openApproval(e) {
  state.approvalId = e.approval_id;
  $("#approveReason").textContent = `${e.reason} (risiko ${e.risk})`;
  $("#approveCmd").textContent = e.command || "";
  $("#approveSheet").hidden = false;
  $("#allowBtn").focus();
}

function closeApproval() {
  state.approvalId = null;
  $("#approveSheet").hidden = true;
}

async function answer(decision) {
  if (!state.runId || !state.approvalId) return;
  const approvalId = state.approvalId;
  closeApproval();
  try {
    const r = await fetch(`/api/runs/${state.runId}/approval`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approval_id: approvalId, decision }),
    });
    if (!r.ok) toast("Jawaban tidak terkirim. Mungkin sudah kedaluwarsa.");
  } catch {
    toast("Gagal menghubungi server.");
  }
}
$("#allowBtn").addEventListener("click", () => void answer("allow"));
$("#denyBtn").addEventListener("click", () => void answer("deny"));

// ---------- Events ----------

function handle(e) {
  switch (e.type) {
    case "run_started":
      break;

    case "text_delta": {
      const box = explainBox();
      state.explainRaw += e.text;
      renderMarkdown(box, state.explainRaw);
      scrollDown();
      break;
    }

    case "tool_call_started":
      state.explainEl = null; // text after a tool call starts a new block
      thinkLine(e.call_id, e.label);
      break;

    case "tool_call_finished": {
      const row = state.think && state.think.rows.get(e.call_id);
      if (row) {
        row.line.className = "think-line " + (e.ok ? "ok" : "fail");
        row.line.textContent = e.summary ? `${row.text} — ${e.summary}` : row.text;
      }
      break;
    }

    case "approval_requested":
      openApproval(e);
      break;

    case "approval_resolved":
      closeApproval();
      break;

    case "file_changed":
      state.files.set(e.path, { bytes: e.bytes });
      break;

    case "usage":
      setMeters(e.totals.steps, e.totals.cost_usd);
      break;

    case "budget_warning":
      toast(`Batas ${e.kind === "steps" ? "langkah" : "biaya"} ${e.percent}% tercapai`);
      break;

    case "error":
      if (!e.retryable) addErrorCard("Agent mengalami masalah", e.message);
      break;

    case "run_finished": {
      closeApproval();
      setMeters(e.totals.steps, e.totals.cost_usd);
      finishThink(e.status, e.totals.steps);
      if (!state.explainEl && e.summary && e.status !== "error") {
        renderMarkdown(explainBox(), e.summary);
      }
      const htmlFiles = [...state.files.entries()].filter(([p]) => /\.html?$/i.test(p));
      if (htmlFiles.length > 0) {
        const [path, info] = htmlFiles[htmlFiles.length - 1];
        addResult(path, info.bytes);
      }
      if (state.source) state.source.close();
      state.source = null;
      setBusy(false);
      break;
    }

    default:
      break;
  }
}

function listen(runId) {
  const es = new EventSource(`/api/runs/${runId}/events`);
  state.source = es;
  const types = [
    "run_started", "text_delta", "plan_updated", "tool_call_started", "tool_call_finished",
    "approval_requested", "approval_resolved", "file_changed", "usage", "budget_warning",
    "preview_ready", "artifact_ready", "error", "run_finished",
  ];
  for (const t of types) {
    es.addEventListener(t, (ev) => {
      try {
        handle(JSON.parse(ev.data));
      } catch {
        /* skip a malformed frame */
      }
    });
  }
  // EventSource resumes by itself with Last-Event-ID; it is closed on run_finished.
}

async function start(message) {
  if (!message || state.busy) return;
  state.lastPrompt = message;
  state.files.clear();
  state.explainEl = null;
  state.explainRaw = "";
  if (heroEl.isConnected) heroEl.remove();
  addUser(message);
  setBusy(true);
  setMeters(0, 0);
  addThink("Menyusun rencana…");
  try {
    const r = await fetch("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    });
    if (r.status === 409) throw new Error("Masih ada run yang berjalan. Tunggu atau hentikan dulu.");
    if (!r.ok) throw new Error(`Server menolak permintaan (${r.status}).`);
    const data = await r.json();
    state.runId = data.run_id;
    listen(data.run_id);
  } catch (err) {
    finishThink("error", 0);
    setBusy(false);
    addErrorCard("Koneksi ke agent terputus", err instanceof Error ? err.message : "Gagal menghubungi server.");
  }
}

async function stopRun() {
  if (!state.busy || !state.runId) return;
  try {
    await fetch(`/api/runs/${state.runId}/stop`, { method: "POST" });
    toast("Menghentikan agent…");
  } catch {
    toast("Gagal mengirim perintah henti.");
  }
}

function resetSession() {
  if (state.busy) {
    toast("Hentikan agent dulu");
    return;
  }
  closeOverlay();
  main.replaceChildren(heroEl);
  state.runId = null;
  state.files.clear();
  setMeters(0, 0);
  input.value = "";
  autoGrow();
  updateSendState();
  paintFolders();
}

// ---------- Input ----------

function autoGrow() {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 150) + "px";
}

input.addEventListener("input", () => {
  autoGrow();
  updateSendState();
});

// Desktop: Enter sends, Shift+Enter adds a line. Touch screens: Enter adds a line (use the send button).
input.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" && !ev.shiftKey && !isCoarsePointer && !ev.isComposing) {
    ev.preventDefault();
    $("#form").requestSubmit();
  }
});

$("#form").addEventListener("submit", (ev) => {
  ev.preventDefault();
  if (state.busy) {
    void stopRun();
    return;
  }
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  autoGrow();
  void start(text);
});

$("#resetBtn").addEventListener("click", resetSession);
$("#ringBtn").addEventListener("click", (ev) => {
  ev.stopPropagation();
  const pop = $("#statPop");
  pop.hidden = !pop.hidden;
});
document.addEventListener("click", () => {
  $("#statPop").hidden = true;
});
document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") {
    $("#statPop").hidden = true;
    if (!$("#overlay").hidden) closeOverlay();
  }
});

// ---------- Boot ----------

bindHero();
setMeters(0, 0);
updateSendState();
fetch("/api/config")
  .then((r) => r.json())
  .then((cfg) => {
    state.cfg = cfg;
    $("#modelLabel").textContent = cfg.model;
    $("#stModel").textContent = cfg.model;
    setMeters(0, 0);
  })
  .catch(() => {
    $("#modelLabel").textContent = "server tidak terjangkau";
  });
