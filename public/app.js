// UI logic (ES module). Text is always written with textContent or createTextNode, never innerHTML,
// so model output cannot inject markup. The browser never sees an API key; only the server calls the LLM.
import { parseBlocks } from "/md.js";

const $ = (id) => document.getElementById(id);
const el = {
  model: $("model"),
  status: $("status"),
  statusText: $("statusText"),
  steps: $("steps"),
  stepsBar: $("stepsBar"),
  cost: $("cost"),
  costIdr: $("costIdr"),
  feed: $("feed"),
  empty: $("empty"),
  activity: $("activity"),
  stepList: $("stepList"),
  stepCount: $("stepCount"),
  results: $("results"),
  fileList: $("fileList"),
  previewWrap: $("previewWrap"),
  preview: $("preview"),
  previewOpen: $("previewOpen"),
  composer: $("composer"),
  input: $("input"),
  send: $("send"),
  stop: $("stop"),
  sheet: $("sheet"),
  sheetReason: $("sheetReason"),
  sheetCmd: $("sheetCmd"),
  allow: $("allow"),
  deny: $("deny"),
  toast: $("toast"),
};

const state = {
  cfg: null,
  runId: null,
  source: null,
  busy: false,
  agentRaw: "", // raw markdown of the current assistant message
  agentEl: null, // its bubble element
  typingEl: null,
  approvalId: null,
  rows: new Map(),
  files: new Map(),
  toastTimer: 0,
};

const isCoarsePointer = matchMedia("(pointer: coarse)").matches;
const fmtUsd = (n) => "$" + n.toFixed(4);
const fmtIdr = (usd) =>
  "≈ Rp " +
  Math.round(usd * (state.cfg ? state.cfg.usd_idr : 17000)).toLocaleString(
    "id-ID",
  );

function nearBottom() {
  return el.feed.scrollHeight - el.feed.scrollTop - el.feed.clientHeight < 140;
}
function scrollFeed(force = false) {
  if (force || nearBottom()) el.feed.scrollTop = el.feed.scrollHeight;
}

function toast(text) {
  el.toast.textContent = text;
  el.toast.classList.remove("hidden");
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => el.toast.classList.add("hidden"), 3500);
}

function setStatus(kind, text) {
  el.status.className = "pill " + kind;
  el.statusText.textContent = text;
}

function setMeters(steps, cost) {
  const max = state.cfg ? state.cfg.max_steps : 0;
  el.steps.textContent = steps + " / " + max;
  const pct = max > 0 ? Math.min(100, (steps / max) * 100) : 0;
  el.stepsBar.style.width = pct + "%";
  el.stepsBar.classList.toggle("danger", pct >= 80);
  el.cost.textContent = fmtUsd(cost);
  el.costIdr.textContent = fmtIdr(cost);
  el.stepCount.textContent = steps ? `(${steps})` : "";
}

function setBusy(busy) {
  state.busy = busy;
  el.stop.classList.toggle("hidden", !busy);
  el.send.classList.toggle("hidden", busy);
  el.input.disabled = busy;
  if (!busy) updateSendState();
  if (!busy) el.input.focus();
}

function updateSendState() {
  el.send.disabled = state.busy || el.input.value.trim() === "";
}

// ---------- Rendering (DOM only) ----------

function appendInline(parent, parts) {
  for (const p of parts) {
    if (p.t === "text") {
      parent.appendChild(document.createTextNode(p.v));
    } else if (p.t === "link") {
      const a = document.createElement("a");
      a.href = p.href; // parser guarantees http(s) only
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = p.v;
      parent.appendChild(a);
    } else {
      const node = document.createElement(
        p.t === "strong" ? "strong" : p.t === "em" ? "em" : "code",
      );
      node.textContent = p.v;
      parent.appendChild(node);
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

function addUserMessage(text) {
  el.empty.classList.add("hidden");
  const row = document.createElement("div");
  row.className = "row user";
  const msg = document.createElement("div");
  msg.className = "msg user";
  msg.textContent = text;
  row.appendChild(msg);
  el.feed.appendChild(row);
  scrollFeed(true);
}

function startAgentMessage() {
  const row = document.createElement("div");
  row.className = "row";
  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.setAttribute("aria-hidden", "true");
  avatar.textContent = "◆";
  const msg = document.createElement("div");
  msg.className = "msg agent";
  row.append(avatar, msg);
  el.feed.appendChild(row);
  state.agentEl = msg;
  state.agentRaw = "";
  return msg;
}

function showTyping() {
  if (state.typingEl) return;
  const row = document.createElement("div");
  row.className = "row";
  row.setAttribute("aria-label", "Agent sedang berpikir");
  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.setAttribute("aria-hidden", "true");
  avatar.textContent = "◆";
  const dots = document.createElement("div");
  dots.className = "typing";
  for (let i = 0; i < 3; i++) dots.appendChild(document.createElement("i"));
  row.append(avatar, dots);
  el.feed.appendChild(row);
  state.typingEl = row;
  scrollFeed(true);
}

function hideTyping() {
  if (state.typingEl) {
    state.typingEl.remove();
    state.typingEl = null;
  }
}

function addNote(text, bad = false) {
  const n = document.createElement("div");
  n.className = "note" + (bad ? " bad" : "");
  n.textContent = text;
  el.feed.appendChild(n);
  scrollFeed();
}

function resetRun() {
  state.agentEl = null;
  state.agentRaw = "";
  state.rows.clear();
  state.files.clear();
  el.stepList.replaceChildren();
  el.fileList.replaceChildren();
  el.previewWrap.classList.add("hidden");
  el.preview.removeAttribute("src");
  el.activity.classList.add("hidden");
  el.activity.removeAttribute("open");
  el.results.classList.add("hidden");
  setMeters(0, 0);
}

function showPreview(path) {
  const url = "/preview/" + path.split("/").map(encodeURIComponent).join("/");
  el.preview.src = url;
  el.previewOpen.href = url;
  el.previewWrap.classList.remove("hidden");
}

function addFile(path, op) {
  el.results.classList.remove("hidden");
  let row = state.files.get(path);
  if (!row) {
    row = document.createElement("li");
    state.files.set(path, row);
    el.fileList.appendChild(row);
  }
  row.replaceChildren();
  const mark = document.createElement("span");
  mark.className = "mark ok";
  mark.textContent = op === "created" ? "+" : "~";
  const name = document.createElement("span");
  name.textContent = path;
  row.append(mark, name);
  if (/\.html?$/i.test(path)) showPreview(path);
}

// ---------- Approval ----------

function openApproval(e) {
  state.approvalId = e.approval_id;
  el.sheetReason.textContent = `${e.reason} (risiko ${e.risk})`;
  el.sheetCmd.textContent = e.command || "";
  el.sheet.classList.remove("hidden");
  el.allow.focus();
}

function closeApproval() {
  state.approvalId = null;
  el.sheet.classList.add("hidden");
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

// ---------- Events ----------

const DONE = {
  completed: ["ok", "Selesai"],
  stopped: ["warn", "Dihentikan"],
  budget_exceeded: ["warn", "Batas tercapai"],
  error: ["err", "Error"],
};

function handle(e) {
  switch (e.type) {
    case "run_started":
      el.model.textContent = e.model;
      setStatus("run", "Bekerja");
      break;

    case "text_delta": {
      hideTyping();
      if (!state.agentEl) startAgentMessage();
      state.agentRaw += e.text;
      renderMarkdown(state.agentEl, state.agentRaw);
      scrollFeed();
      break;
    }

    case "tool_call_started": {
      hideTyping();
      state.agentEl = null; // text after a tool call starts a new message
      state.agentRaw = "";
      el.activity.classList.remove("hidden");
      el.activity.setAttribute("open", "");
      const li = document.createElement("li");
      const mark = document.createElement("span");
      mark.className = "mark run";
      mark.textContent = "•";
      const body = document.createElement("div");
      const label = document.createElement("span");
      label.textContent = e.label;
      const sum = document.createElement("span");
      sum.className = "sum";
      body.append(label, sum);
      li.append(mark, body);
      el.stepList.appendChild(li);
      state.rows.set(e.call_id, { mark, sum });
      scrollFeed();
      break;
    }

    case "tool_call_finished": {
      const r = state.rows.get(e.call_id);
      if (r) {
        r.mark.className = "mark " + (e.ok ? "ok" : "fail");
        r.mark.textContent = e.ok ? "✓" : "✗";
        r.sum.textContent = e.summary;
      }
      showTyping();
      break;
    }

    case "approval_requested":
      openApproval(e);
      break;

    case "approval_resolved":
      closeApproval();
      break;

    case "file_changed":
      addFile(e.path, e.op);
      break;

    case "usage":
      setMeters(e.totals.steps, e.totals.cost_usd);
      break;

    case "budget_warning":
      toast(
        `Batas ${e.kind === "steps" ? "langkah" : "biaya"} ${e.percent}% tercapai`,
      );
      break;

    case "error":
      if (!e.retryable) addNote(e.message, true);
      break;

    case "run_finished": {
      hideTyping();
      closeApproval();
      setMeters(e.totals.steps, e.totals.cost_usd);
      if (!state.agentEl && e.summary) addNote(e.summary);
      const [kind, text] = DONE[e.status] || ["err", e.status];
      setStatus(kind, text);
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
    "run_started",
    "text_delta",
    "plan_updated",
    "tool_call_started",
    "tool_call_finished",
    "approval_requested",
    "approval_resolved",
    "file_changed",
    "usage",
    "budget_warning",
    "preview_ready",
    "artifact_ready",
    "error",
    "run_finished",
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
  // EventSource resumes by itself with Last-Event-ID; we close only on run_finished.
}

async function start(message) {
  resetRun();
  addUserMessage(message);
  setBusy(true);
  setStatus("run", "Memulai");
  showTyping();
  try {
    const r = await fetch("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    });
    if (r.status === 409)
      throw new Error(
        "Masih ada run yang berjalan. Tunggu atau hentikan dulu.",
      );
    if (!r.ok) throw new Error(`Server menolak permintaan (${r.status}).`);
    const data = await r.json();
    state.runId = data.run_id;
    listen(data.run_id);
  } catch (err) {
    hideTyping();
    setBusy(false);
    setStatus("err", "Gagal");
    addNote(
      err instanceof Error ? err.message : "Gagal menghubungi server.",
      true,
    );
  }
}

// ---------- Input ----------

function autoGrow() {
  el.input.style.height = "auto";
  el.input.style.height = Math.min(el.input.scrollHeight, 160) + "px";
}

el.input.addEventListener("input", () => {
  autoGrow();
  updateSendState();
});

// Desktop: Enter sends, Shift+Enter adds a line. Touch screens: Enter adds a line (use the Kirim button).
el.input.addEventListener("keydown", (ev) => {
  if (
    ev.key === "Enter" &&
    !ev.shiftKey &&
    !isCoarsePointer &&
    !ev.isComposing
  ) {
    ev.preventDefault();
    el.composer.requestSubmit();
  }
});

el.composer.addEventListener("submit", (ev) => {
  ev.preventDefault();
  const text = el.input.value.trim();
  if (!text || state.busy) return;
  el.input.value = "";
  autoGrow();
  updateSendState();
  void start(text);
});

document.querySelectorAll(".chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    el.input.value = chip.dataset.prompt || "";
    autoGrow();
    updateSendState();
    el.input.focus();
  });
});

el.stop.addEventListener("click", async () => {
  if (!state.runId) return;
  try {
    await fetch(`/api/runs/${state.runId}/stop`, { method: "POST" });
    setStatus("warn", "Menghentikan…");
  } catch {
    toast("Gagal mengirim perintah henti.");
  }
});

el.allow.addEventListener("click", () => void answer("allow"));
el.deny.addEventListener("click", () => void answer("deny"));

setMeters(0, 0);
updateSendState();
fetch("/api/config")
  .then((r) => r.json())
  .then((cfg) => {
    state.cfg = cfg;
    el.model.textContent = cfg.model;
    setMeters(0, 0);
  })
  .catch(() => {
    el.model.textContent = "server tidak terjangkau";
  });
