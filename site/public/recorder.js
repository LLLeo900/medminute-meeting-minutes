/* Meeting recorder: the moderator records the meeting right in the browser, and on "Stop"
   the recording goes into the normal upload → processing chain. The audio stays in this browser
   until it is sent to the hospital's server (same origin). Uses helpers from app.js. */
"use strict";

function pickMime() {
  const opts = [["audio/webm;codecs=opus", ".webm"], ["audio/webm", ".webm"],
    ["audio/mp4;codecs=mp4a.40.2", ".m4a"], ["audio/mp4", ".m4a"], ["audio/ogg;codecs=opus", ".ogg"]];
  for (const [m, ext] of opts) if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return { mime: m, ext };
  return null;
}

/** One recorder for the whole app: it survives page changes — a click in the menu must not
    cut off a meeting recording. The page that shows it sets recorderTarget.onDone(File). */
const recorderTarget = { onDone: null };
function getRecorder() {
  if (!state.recorder) state.recorder = buildRecorder((file) => recorderTarget.onDone && recorderTarget.onDone(file));
  return state.recorder;
}
function recPill(text, live) {
  const el = document.getElementById("recpill");
  if (!el) return;
  el.hidden = !text;
  el.className = `pill ${live ? "bad" : "warn"}`;
  el.replaceChildren(h("span", { class: "dot" }), text || "");
}

/** Returns {el, stop}. onDone(File) is called after "Stop and process". */
function buildRecorder(onDone) {
  const fmt = pickMime();
  const box = h("div", { class: "rec" });
  if (!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder && fmt)) {
    box.append(h("div", { class: "notice warn" }, h("span", { class: "ico ico-alert" }),
      h("div", { class: "nb" }, h("div", { class: "nt" }, "Recording is not available here"),
        h("div", {}, "Requires localhost or HTTPS and a modern browser. Upload a ready file instead."))));
    return { el: box, stop: () => {} };
  }

  let stream = null, rec = null, chunks = [], ctx = null, raf = 0;
  let startedAt = 0, pausedMs = 0, pauseStart = 0, quietSince = 0, timer = 0;

  const micSel = h("select", { "aria-label": "Microphone" }, h("option", { value: "" }, "Default microphone"));
  const clock = h("div", { class: "rec-clock" }, "00:00:00");
  const meter = h("div", { class: "rec-meter", title: "Signal level" }, h("i"));
  const status = h("div", { class: "rec-status" });
  const warn = h("div", { class: "muted", style: "font-size:12.5px;min-height:18px" });
  const startBtn = h("button", { class: "btn rec-btn", type: "button" }, h("span", { class: "rec-dot" }), "Start recording");
  const pauseBtn = h("button", { class: "btn", type: "button", hidden: true }, "Pause");
  const stopBtn = h("button", { class: "btn primary", type: "button", hidden: true }, "Stop and process");
  const discardBtn = h("button", { class: "btn ghost", type: "button", hidden: true }, "Cancel");
  const backup = h("div");

  async function listMics() {
    try {
      const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput");
      const cur = micSel.value;
      micSel.replaceChildren(...devs.map((d, i) => h("option", { value: d.deviceId, selected: d.deviceId === cur },
        d.label || `Microphone ${i + 1}`)));
    } catch (e) { /* keep the default option */ }
  }
  const elapsed = () => (rec ? Date.now() - startedAt - pausedMs - (rec.state === "paused" ? Date.now() - pauseStart : 0) : 0);
  const tick = () => {
    const s = Math.floor(elapsed() / 1000);
    clock.textContent = [s / 3600, (s % 3600) / 60, s % 60].map((x) => String(Math.floor(x)).padStart(2, "0")).join(":");
    if (rec && rec.state !== "inactive") recPill(`Recording ${clock.textContent}`, rec.state === "recording");
  };
  const guard = (e) => { e.preventDefault(); e.returnValue = "Recording in progress. Really leave the page?"; return e.returnValue; };

  function meterLoop(analyser) {
    const buf = new Float32Array(analyser.fftSize);
    const step = () => {
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      const level = Math.min(1, Math.sqrt(sum / buf.length) * 6);
      meter.firstChild.style.width = `${Math.round(level * 100)}%`;
      if (rec?.state === "recording") {
        quietSince = level < 0.02 ? (quietSince || Date.now()) : 0;
        warn.textContent = quietSince && Date.now() - quietSince > 8000 ? "Silence — check the microphone" : "";
      }
      raf = requestAnimationFrame(step);
    };
    step();
  }
  function release() {
    cancelAnimationFrame(raf); clearInterval(timer);
    stream?.getTracks().forEach((tr) => tr.stop()); stream = null;
    ctx?.close().catch(() => {}); ctx = null;
    window.removeEventListener("beforeunload", guard);
    meter.firstChild.style.width = "0%";
    recPill("");
  }
  function setUi(mode) {
    startBtn.hidden = mode !== "idle";
    micSel.disabled = mode !== "idle";
    pauseBtn.hidden = stopBtn.hidden = discardBtn.hidden = mode === "idle";
    pauseBtn.textContent = mode === "paused" ? "Resume" : "Pause";
    box.classList.toggle("live", mode === "recording");
    status.replaceChildren(
      mode === "recording" ? h("span", { class: "badge overdue" }, h("span", { class: "rec-dot small" }), "Recording")
        : mode === "paused" ? h("span", { class: "badge soon" }, "Paused") : "");
  }

  startBtn.addEventListener("click", async () => {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: {
        deviceId: micSel.value ? { exact: micSel.value } : undefined, channelCount: 1,
        echoCancellation: false, noiseSuppression: false, autoGainControl: true } });
    } catch (e) {
      box.prepend(h("div", { class: "notice bad", style: "margin-bottom:10px" }, h("span", { class: "ico ico-alert" }),
        h("div", { class: "nb" }, h("div", { class: "nt" }, "Microphone unavailable"),
          h("div", {}, "Allow the microphone for this page in the browser settings."))));
      return;
    }
    await listMics();
    ctx = new AudioContext();
    const an = ctx.createAnalyser();
    an.fftSize = 2048;
    ctx.createMediaStreamSource(stream).connect(an);
    meterLoop(an);
    chunks = []; pausedMs = 0; quietSince = 0;
    rec = new MediaRecorder(stream, { mimeType: fmt.mime, audioBitsPerSecond: 64000 });
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    rec.start(5000);                       // a chunk every 5 s: on a crash only the last few seconds are lost
    startedAt = Date.now();
    timer = setInterval(tick, 500);
    window.addEventListener("beforeunload", guard);
    setUi("recording");
  });
  pauseBtn.addEventListener("click", () => {
    if (rec.state === "recording") { rec.pause(); pauseStart = Date.now(); setUi("paused"); }
    else { rec.resume(); pausedMs += Date.now() - pauseStart; setUi("recording"); }
  });
  const finish = () => new Promise((res) => {
    rec.onstop = res;
    if (rec.state === "paused") pausedMs += Date.now() - pauseStart;
    rec.stop();
  });
  stopBtn.addEventListener("click", async () => {
    stopBtn.disabled = true;
    await finish(); tick(); release();
    const now = new Date();
    const stamp = new Date(now - now.getTimezoneOffset() * 60000).toISOString().slice(0, 16).replace(/[:T]/g, "-");
    const file = new File(chunks, `meeting-${stamp}${fmt.ext}`, { type: fmt.mime.split(";")[0] });
    backup.replaceChildren(h("a", { href: URL.createObjectURL(file), download: file.name, class: "btn ghost small" },
      "Download a copy of the recording"));
    rec = null; setUi("idle"); stopBtn.disabled = false;   // ready for the next meeting; the link to the copy stays
    onDone(file);
  });
  discardBtn.addEventListener("click", async () => {
    if (!confirm("Delete the current recording?")) return;
    await finish(); release();
    chunks = []; rec = null; clock.textContent = "00:00:00";
    setUi("idle");
  });

  listMics();
  setUi("idle");
  box.append(
    h("div", { class: "rec-panel" }, clock, status),
    h("div", { class: "field" }, h("span", { class: "label" }, "Signal level"), meter, warn),
    h("div", { class: "field" }, h("label", {}, "Microphone"), micSel),
    h("div", { class: "rec-actions" }, startBtn, pauseBtn, stopBtn, discardBtn),
    h("div", { class: "muted", style: "font-size:12.5px" },
      "Start it at the beginning of the meeting. After stopping, the recording is sent for processing to this server automatically."),
    backup);
  return { el: box, stop: () => { if (rec && rec.state !== "inactive") { try { rec.stop(); } catch (e) { /* already stopped */ } } release(); } };
}
