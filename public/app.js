// UI logic. Renders only with textContent (never innerHTML), so model output cannot inject markup.
// Talks to the server only; no API key ever reaches the browser.
(() => {
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
    bubble: null,
    approvalId: null,
    rows: new Map(),
    files: new Map(),
    toastTimer: 0,
  };

  const fmtUsd = (n) => "$" + n.toFixed(4);
  const fmtIdr = (usd) =>
    "≈ Rp " +
    Math.round(usd * (state.cfg ? state.cfg.usd_idr : 17000)).toLocaleString(
      "id-ID",
    );

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

  function scrollFeed() {
    el.feed.scrollTop = el.feed.scrollHeight;
  }

  function addMsg(kind, text) {
    el.empty.classList.add("hidden");
    const d = document.createElement("div");
    d.className = "msg " + kind;
    d.textContent = text;
    el.feed.appendChild(d);
    scrollFeed();
    return d;
  }

  function setMeters(steps, cost) {
    const max = state.cfg ? state.cfg.max_steps : 0;
    el.steps.textContent = steps + " / " + max;
    const pct = max > 0 ? Math.min(100, (steps / max) * 100) : 0;
    el.stepsBar.style.width = pct + "%";
    el.stepsBar.classList.toggle("danger", pct >= 80);
    el.cost.textContent = fmtUsd(cost);
    el.costIdr.textContent = fmtIdr(cost);
  }

  function setBusy(busy) {
    el.send.classList.toggle("hidden", busy);
    el.stop.classList.toggle("hidden", !busy);
    el.input.disabled = busy;
  }

  function resetRun() {
    state.bubble = null;
    state.rows.clear();
    state.files.clear();
    el.stepList.replaceChildren();
    el.fileList.replaceChildren();
    el.previewWrap.classList.add("hidden");
    el.preview.removeAttribute("src");
    el.activity.classList.add("hidden");
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

  function openApproval(e) {
    state.approvalId = e.approval_id;
    el.sheetReason.textContent = (e.reason || "") + " (risiko " + e.risk + ")";
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
      const r = await fetch("/api/runs/" + state.runId + "/approval", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approval_id: approvalId, decision }),
      });
      if (!r.ok) toast("Jawaban tidak terkirim. Mungkin sudah kedaluwarsa.");
    } catch {
      toast("Gagal menghubungi server.");
    }
  }

  function handle(e) {
    switch (e.type) {
      case "run_started":
        el.model.textContent = e.model;
        setStatus("run", "Bekerja");
        break;
      case "text_delta":
        if (!state.bubble) state.bubble = addMsg("agent", "");
        state.bubble.textContent += e.text;
        scrollFeed();
        break;
      case "tool_call_started": {
        state.bubble = null;
        el.activity.classList.remove("hidden");
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
        el.stepList.parentElement.scrollTop =
          el.stepList.parentElement.scrollHeight;
        break;
      }
      case "tool_call_finished": {
        const r = state.rows.get(e.call_id);
        if (r) {
          r.mark.className = "mark " + (e.ok ? "ok" : "fail");
          r.mark.textContent = e.ok ? "✓" : "✗";
          r.sum.textContent = e.summary;
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
        addFile(e.path, e.op);
        break;
      case "usage":
        setMeters(e.totals.steps, e.totals.cost_usd);
        break;
      case "budget_warning":
        toast(
          "Batas " +
            (e.kind === "steps" ? "langkah" : "biaya") +
            " " +
            e.percent +
            "% tercapai",
        );
        break;
      case "error":
        if (!e.retryable) addMsg("note bad", e.message);
        break;
      case "run_finished": {
        closeApproval();
        setMeters(e.totals.steps, e.totals.cost_usd);
        if (!state.bubble && e.summary) addMsg("note", e.summary);
        const done = {
          completed: ["ok", "Selesai"],
          stopped: ["warn", "Dihentikan"],
          budget_exceeded: ["warn", "Batas tercapai"],
          error: ["err", "Error"],
        };
        const [kind, text] = done[e.status] || ["err", e.status];
        setStatus(kind, text);
        setBusy(false);
        if (state.source) state.source.close();
        state.source = null;
        el.input.focus();
        break;
      }
      default:
        break;
    }
  }

  function listen(runId) {
    const es = new EventSource("/api/runs/" + runId + "/events");
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
          /* ignore a malformed frame */
        }
      });
    }
    // EventSource reconnects by itself and resumes with Last-Event-ID; we only close on run_finished.
  }

  async function start(message) {
    resetRun();
    addMsg("user", message);
    setBusy(true);
    setStatus("run", "Memulai");
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
      if (!r.ok)
        throw new Error("Server menolak permintaan (" + r.status + ").");
      const data = await r.json();
      state.runId = data.run_id;
      listen(data.run_id);
    } catch (err) {
      setBusy(false);
      setStatus("err", "Gagal");
      addMsg(
        "note bad",
        err instanceof Error ? err.message : "Gagal menghubungi server.",
      );
    }
  }

  el.composer.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const text = el.input.value.trim();
    if (!text) return;
    el.input.value = "";
    el.input.style.height = "auto";
    void start(text);
  });

  el.input.addEventListener("input", () => {
    el.input.style.height = "auto";
    el.input.style.height = Math.min(el.input.scrollHeight, 140) + "px";
  });

  el.stop.addEventListener("click", async () => {
    if (!state.runId) return;
    try {
      await fetch("/api/runs/" + state.runId + "/stop", { method: "POST" });
      setStatus("warn", "Menghentikan…");
    } catch {
      toast("Gagal mengirim perintah henti.");
    }
  });

  el.allow.addEventListener("click", () => void answer("allow"));
  el.deny.addEventListener("click", () => void answer("deny"));

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
})();
