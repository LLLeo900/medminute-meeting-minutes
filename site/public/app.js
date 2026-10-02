/* MedMeet — the web UI on localhost:7777.
   MedMinute design system (Figma): tokens and components live in app.css, icons in /icons.
   Data comes only from our own server: jobs, minutes parts and summary queries from the local SQLite.
   No external requests — the site works with the network switched off. */
"use strict";

// ---------------------------------------------------------------- small helpers
// The native replaceChildren turns null into the text "null", and the markup passes optional parts as null.
const nativeReplaceChildren = Element.prototype.replaceChildren;
Element.prototype.replaceChildren = function (...kids) {
  return nativeReplaceChildren.apply(this, kids.flat(9).filter((k) => k != null && k !== false));
};
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "html") el.innerHTML = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat(9)) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}
const ICON = {
  audio: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/></svg>',
  doc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/></svg>',
  inbox: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 13l2.5-7h11L20 13v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z"/><path d="M4 13h4l1.5 2h5L16 13h4"/></svg>',
};
const FIGMA_ICONS = { upload: "ico-upload", list: "ico-list", check: "ico-check", people: "ico-people", play: "ico-play", alert: "ico-alert", arrow: "ico-arrow" };
const icon = (n) => FIGMA_ICONS[n]
  ? h("span", { class: `ico ${FIGMA_ICONS[n]}`, "aria-hidden": "true" })
  : h("span", { html: ICON[n], style: "display:inline-flex", "aria-hidden": "true" });

async function api(path, opts = {}) {
  const init = { ...opts };
  if (opts.json !== undefined) {
    init.method = init.method || "POST";
    init.headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
    init.body = JSON.stringify(opts.json);
  }
  const r = await fetch(path, init);
  if (!r.ok) {
    let msg = `${r.status}`;
    try { msg = (await r.json()).error || msg; } catch (e) { /* not json */ }
    throw new Error(msg);
  }
  return r.status === 204 ? null : r.json();
}
function toast(msg, kind) {
  const el = h("div", { class: "toast", role: kind === "error" ? "alert" : "status" },
    h("span", { class: `ico ${kind === "error" ? "ico-toast" : "ico-check"}` }), msg);
  document.body.append(el);
  setTimeout(() => el.remove(), 3000);
}
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmtMb = (b) => `${((b || 0) / 1048576).toFixed(1)} MB`;
const fmtDur = (s) => { s = Math.round(s || 0); const m = Math.floor(s / 60); return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min` : `${m}:${String(s % 60).padStart(2, "0")}`; };
const fmtWhen = (iso) => { if (!iso) return ""; const d = new Date(iso); return `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}.${d.getFullYear()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
const initials = (n) => (n || "?").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("");
// English plural: plural(n, "record", "records") → "1 record", "5 records".
const plural = (n, one, many) => `${n} ${Math.abs(n) === 1 ? one : many}`;
const card = (title, right, ...body) => h("section", { class: "card" }, h("div", { class: "card-head" }, h("h2", {}, title), right || null), ...body);
const empty = (msg) => h("div", { class: "empty" }, h("div", { html: ICON.inbox }), h("div", {}, msg));
const gap = (px) => h("div", { style: `height:${px}px` });
const sessionGet = (k, d) => { try { return sessionStorage.getItem(k) || d; } catch (e) { return d; } };
const sessionSet = (k, v) => { try { sessionStorage.setItem(k, v); } catch (e) { /* private mode */ } };

/** Mini-markdown for the minutes coming from the workflow: headings, lists, bold, tables. Text is escaped. */
function markdown(src) {
  const lines = String(src || "").replace(/\r/g, "").split("\n");
  const out = [];
  let list = null, table = null;
  const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/`(.+?)`/g, "<code>$1</code>");
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  const closeTable = () => { if (table) { out.push("</tbody></table>"); table = null; } };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const cells = /^\|(.+)\|\s*$/.exec(line);
    if (cells) {
      const parts = cells[1].split("|").map((c) => c.trim());
      if (parts.every((c) => /^:?-{2,}:?$/.test(c))) continue;
      if (!table) {
        closeList(); table = 1;
        out.push('<div class="scroll-x"><table class="table"><thead><tr>' + parts.map((c) => `<th>${inline(c)}</th>`).join("") + "</tr></thead><tbody>");
        continue;
      }
      out.push("<tr>" + parts.map((c) => `<td>${inline(c)}</td>`).join("") + "</tr>");
      continue;
    }
    closeTable();
    const hd = /^(#{1,6})\s+(.*)$/.exec(line);
    if (hd) { closeList(); const n = Math.min(4, hd[1].length + 1); out.push(`<h${n}>${inline(hd[2])}</h${n}>`); continue; }
    const li = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (li) { if (list !== "ul") { closeList(); list = "ul"; out.push("<ul>"); } out.push(`<li>${inline(li[1])}</li>`); continue; }
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ol) { if (list !== "ol") { closeList(); list = "ol"; out.push("<ol>"); } out.push(`<li>${inline(ol[1])}</li>`); continue; }
    if (/^\s*(---+|___+)\s*$/.test(line)) { closeList(); out.push("<hr>"); continue; }
    if (!line.trim()) { closeList(); continue; }
    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList(); closeTable();
  return out.join("\n");
}

/** Table from an array of objects. cols: [[key, label]] or null — then the keys of the first row are used.
    opts.actions(row) — nodes for the last column (for example the "Hide" button). */
function dataTable(rows, cols, opts = {}) {
  if (!rows || !rows.length) return empty(opts.emptyText || "Nothing here yet");
  const keys = cols || Object.keys(rows[0]).map((k) => [k, k]);
  return h("div", { class: "scroll-x" }, h("table", { class: "table" },
    h("thead", {}, h("tr", {}, keys.map(([, label]) => h("th", {}, label)),
      opts.actions ? h("th", {}, "") : null)),
    h("tbody", {}, rows.map((r) => h("tr", {
      class: [opts.onRow ? "clickable" : "", r.hidden ? "dim" : ""].filter(Boolean).join(" ") || null,
      onclick: opts.onRow ? () => opts.onRow(r) : null,
    },
      keys.map(([k]) => {
        const v = r[k];
        if (k === "timecode" || k === "Timecode") return h("td", { class: "mono nowrap" }, v || "");
        return h("td", { class: /^(n|#|meeting_date|job_date|Meeting date|deadline|Deadline)$/.test(k) ? "nowrap" : null },
          v == null || v === "" ? "—" : String(v));
      }),
      opts.actions
        ? h("td", { class: "nowrap", onclick: (e) => e.stopPropagation() }, opts.actions(r))
        : null)))));
}

/** "Hide"/"Restore" button: the record is not deleted, it just leaves the list. */
function hideBtn(hidden, send, onDone) {
  const btn = h("button", { class: "btn small ghost", type: "button" }, hidden ? "Restore" : "Hide");
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    try { await send(hidden ? 0 : 1); onDone(); } catch (e) { toast(`Failed: ${e.message}`, "error"); btn.disabled = false; }
  });
  return btn;
}

// ---------------------------------------------------------------- state and shell
const state = { meta: null, jobs: null, recorder: null, mode: sessionGet("mp.mode", "online") };
const view = () => document.getElementById("view");
let cleanup = null;

async function refreshStatus() {
  const el = document.getElementById("status");
  const pill = (cls, text, title) => h("span", { class: `pill ${cls}`, title: title || "" }, h("span", { class: "dot" }), text);
  const [n8n, asr] = await Promise.all([
    api("/api/n8n-ping").catch(() => ({ ok: false })),
    api("/api/asr/health").catch(() => ({ ok: false })),
  ]);
  el.replaceChildren(
    h("span", { class: "pill secure", title: "Audio, database and reports stay on this machine" }, h("span", { class: "ico ico-shield" }), "local"),
    pill(n8n.ok ? "ok opt" : "bad", n8n.ok ? "n8n connected" : "n8n not responding", (n8n.hooks || {}).online || ""),
    pill(asr.ok ? "ok opt" : "warn opt",
      asr.ok ? `offline recognition${asr.voiceId?.loaded ? ` · ${asr.voiceId.loaded}` : ""}` : "offline service is off",
      asr.ok ? `voice: ${asr.voiceId?.loaded || "not loaded"} · recognition: ${asr.stt?.loaded ? "in memory" : "not loaded"}`
        : "offline mode needs asr/service.py on port 7778"),
  );
}

const NAV = [
  ["new", "#/new", "upload", "New meeting"],
  ["meetings", "#/meetings", "list", "Meetings"],
  ["decisions", "#/decisions", "check", "Decisions"],
  ["tasks", "#/tasks", "check", "Tasks"],
  ["patients", "#/patients", "list", "Patients"],
  ["voices", "#/voices", "people", "Voices"],
];
function renderNav() {
  const cur = location.hash.replace(/^#\/?/, "").split("/")[0] || "new";
  const at = { m: "meetings", job: "meetings" }[cur] || cur;
  document.getElementById("nav").replaceChildren(
    ...NAV.map(([key, href, ic, label]) => h("a", {
      class: `nav-item ${at === key ? "on" : ""}`, href, title: label, "aria-current": at === key ? "page" : null,
    }, icon(ic), h("span", { class: "lbl" }, label))),
    h("div", { class: "nav-sep" }),
    h("div", { class: "sidebar-foot" }, "MedMeet · on-premise", h("br"), "audio → n8n → minutes"),
  );
}

// ---------------------------------------------------------------- page: new meeting
const MODES = {
  online: { label: "Online", note: "Transcription in an external service: faster and more accurate. Needs internet and configured access." },
  offline: { label: "Offline", note: "Everything is computed on this machine: the recording goes nowhere. No internet needed." },
};
async function pageNew() {
  const meta = state.meta || (state.meta = await api("/api/meta"));
  const mb = meta.maxUploadMb;
  let file = null;

  const fileInput = h("input", { type: "file", accept: meta.extensions.join(","), style: "display:none" });
  const fileBox = h("div");
  const errBox = h("div");
  const submit = h("button", { class: "btn primary", disabled: true }, h("span", { class: "ico ico-play" }), "Send for processing");

  // ---- Dropzone from the design: normal state and error state (format / size)
  const dropIcon = h("span", { class: "ico ico-upload" });
  const dropTitle = h("strong", {}, "Drag the recording here");
  const subText = `or click to choose a file · ${meta.extensions.join(" ")} · up to ${mb} MB`;
  const dropText = h("div", { class: "muted" }, subText);
  const drop = h("div", { class: "drop", role: "button", tabindex: "0", onclick: () => fileInput.click(),
    onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); } } }, dropIcon, dropTitle, dropText);
  const dropReset = () => {
    drop.classList.remove("error"); dropIcon.className = "ico ico-upload";
    dropTitle.textContent = "Drag the recording here"; dropText.textContent = subText;
  };
  function dropError(msg) {
    drop.classList.add("error"); drop.hidden = false; fileBox.replaceChildren(); file = null;
    dropIcon.className = "ico ico-alert-lg"; dropTitle.textContent = "Something is wrong with the file"; dropText.textContent = msg;
    submit.disabled = true;
  }
  function setFile(f) {
    const ext = "." + (f.name.split(".").pop() || "").toLowerCase();
    if (!meta.extensions.includes(ext)) return dropError(`"${f.name}" — this format is not accepted. Allowed: ${meta.extensions.join(" ")}.`);
    if (f.size > mb * 1048576) return dropError(`"${f.name}" is ${fmtMb(f.size)}, and the limit is ${mb} MB.`);
    dropReset(); drop.hidden = true; file = f; submit.disabled = false; errBox.replaceChildren();
    const dur = h("span", { class: "muted" });
    const a = new Audio(); a.preload = "metadata"; a.src = URL.createObjectURL(f);
    a.onloadedmetadata = () => { if (isFinite(a.duration)) dur.textContent = ` · ${fmtDur(a.duration)}`; URL.revokeObjectURL(a.src); };
    fileBox.replaceChildren(h("div", { class: "file-row" }, h("span", { html: ICON.audio }),
      h("div", { style: "flex:1;min-width:0" },
        h("div", { style: "font-weight:600;overflow:hidden;text-overflow:ellipsis" }, f.name),
        h("div", { class: "muted" }, fmtMb(f.size), dur)),
      h("button", { class: "btn small", onclick: () => fileInput.click() }, "Another file")));
  }
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); if (e.dataTransfer.files[0]) setFile(e.dataTransfer.files[0]); });
  fileInput.addEventListener("change", () => { if (fileInput.files[0]) setFile(fileInput.files[0]); fileInput.value = ""; });

  // ---- processing mode
  const modeNote = h("div", { class: "hint" });
  const modeSeg = h("div", { class: "seg" });
  const drawMode = () => {
    modeSeg.replaceChildren(...Object.entries(MODES).map(([k, v]) => h("button", {
      type: "button", class: k === state.mode ? "on" : "",
      onclick: () => { state.mode = k; sessionSet("mp.mode", k); drawMode(); },
    }, v.label)));
    modeNote.textContent = MODES[state.mode].note;
  };
  drawMode();

  // ---- whom to send the minutes to: if a voice already has an address in the registry, the email goes out even without
  // this field; here the moderator enters addresses in advance — the minutes are sent automatically when ready.
  const mailInput = h("input", { type: "text", placeholder: "john@clinic.example, mary@clinic.example",
    value: sessionGet("mp.emailTo", ""), oninput: () => sessionSet("mp.emailTo", mailInput.value) });
  const mailField = h("div", { class: "field" }, h("span", { class: "label" }, "Send the minutes to"), mailInput,
    h("div", { class: "hint" }, "Comma-separated. Addresses of participants recognised by voice are added automatically."));

  async function send() {
    if (!file) return;
    submit.disabled = true;
    submit.replaceChildren(h("span", { class: "spin" }), "Uploading…");
    errBox.replaceChildren();
    try {
      const r = await fetch("/api/jobs", {
        method: "POST", body: file,
        headers: { "x-file-name": encodeURIComponent(file.name), "x-mode": state.mode,
          "x-email-to": encodeURIComponent(mailInput.value.trim()), "Content-Type": "application/octet-stream" },
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || r.status);
      location.hash = `#/job/${j.id}`;
      return;
    } catch (e) {
      errBox.replaceChildren(h("div", { class: "notice bad", role: "alert" }, h("span", { class: "ico ico-alert" }),
        h("div", { class: "nb" }, h("div", { class: "nt" }, "Could not send"), h("div", {}, e.message))));
    }
    submit.replaceChildren(h("span", { class: "ico ico-play" }), "Send for processing");
    submit.disabled = !file;
  }
  submit.addEventListener("click", send);

  // ---- input: file or recorder (the recorder lives above the pages and survives navigation)
  const recorder = typeof getRecorder === "function" ? getRecorder() : null;
  if (recorder) recorderTarget.onDone = (f) => { setFile(f); send(); };
  let input = sessionGet("mp.input", "upload");
  const uploadBox = h("div", { class: "grid", style: "gap:16px" }, drop, fileInput, fileBox);
  const attachLink = h("button", { class: "btn ghost", type: "button", style: "justify-self:start",
    onclick: () => { input = "upload"; sessionSet("mp.input", "upload"); drawInput(); } }, "Attach a ready file");
  const inputSeg = h("div", { class: "seg" });
  const actions = h("div", { class: "actions" }, submit,
    h("span", { class: "hint" }, "The recording goes to n8n via a webhook, and the minutes come back to this page."));
  const drawInput = () => {
    inputSeg.replaceChildren(...[["upload", "Upload a file"], ["record", "Start recording"]].map(([k, l]) =>
      h("button", { type: "button", class: k === input ? "on" : "", onclick: () => { input = k; sessionSet("mp.input", k); drawInput(); } }, l)));
    uploadBox.hidden = input !== "upload";
    if (recorder) recorder.el.hidden = input !== "record";
    attachLink.hidden = input !== "record";
    actions.hidden = input === "record";   // in recording mode processing is started by the "Stop" button itself
  };
  drawInput();

  view().replaceChildren(
    h("div", { class: "page-head" },
      h("div", {}, h("h1", {}, "New meeting"),
        h("p", {}, "Upload a recording or turn on the recorder — the minutes, decisions, tasks and prescriptions come back here.")),
      recorder ? inputSeg : null),
    h("div", { class: "grid" },
      errBox,
      h("section", { class: "card" },
        h("div", { class: "card-head" }, h("h2", {}, "Meeting recording")),
        h("div", { class: "card-pad grid" },
          uploadBox, recorder ? recorder.el : null, attachLink,
          h("div", { class: "field" }, h("span", { class: "label" }, "Processing mode"), modeSeg, modeNote),
          mailField, actions))),
  );
}

// ---------------------------------------------------------------- page: processing
const STEPS = [
  ["transcript", "Transcript"], ["mom", "Minutes"], ["decisions", "Decisions"],
  ["tasks", "Tasks"], ["patients", "Prescriptions"], ["files", "Reports"],
];
const STATUS_LABEL = { queued: "Queued", processing: "Processing", done: "Done", error: "Error" };
function pageJob(id) {
  const head = h("div", { class: "page-head" });
  const stepper = h("div", { class: "stepper" });
  const bar = h("div", { class: "bar" }, h("i", { style: "width:0%" }));
  const stats = h("div", { class: "grid grid-4" });
  const stageBox = h("div", { class: "notice info" });
  const tail = h("div");
  view().replaceChildren(head,
    h("section", { class: "card card-pad" }, stepper, bar, gap(16), stats, gap(16), stageBox),
    gap(16), tail);

  let job = null;
  const draw = () => {
    if (!job) return;
    head.replaceChildren(
      h("div", {}, h("h1", {}, job.title || "Processing the recording"), h("p", { class: "mono" }, `${id} · ${job.fileName || ""}`)),
      h("a", { class: "btn", href: "#/meetings" }, "All meetings"));
    const have = new Set(job.have || []);
    stepper.replaceChildren(...STEPS.map(([k, label], i) => {
      const done = have.has(k);
      const active = !done && job.status !== "error" && STEPS.slice(0, i).every(([p]) => have.has(p));
      return h("div", { class: `step ${done ? "done" : ""} ${active ? "active" : ""}` }, h("span", { class: "c" }, done ? "✓" : i + 1), label);
    }));
    const got = STEPS.filter(([k]) => have.has(k)).length;
    bar.firstChild.style.width = `${Math.round(100 * got / STEPS.length)}%`;
    const elapsed = (new Date(job.finishedAt || Date.now()) - new Date(job.createdAt)) / 1000;
    stats.replaceChildren(
      h("div", { class: "card kpi" }, h("div", { class: "v" }, fmtDur(elapsed)), h("div", { class: "k" }, "Time elapsed")),
      h("div", { class: "card kpi teal" }, h("div", { class: "v" }, MODES[job.mode]?.label || job.mode), h("div", { class: "k" }, "Mode")),
      h("div", { class: "card kpi" }, h("div", { class: "v" }, fmtMb(job.sizeBytes)), h("div", { class: "k" }, "Recording size")),
      h("div", { class: "card kpi" }, h("div", { class: "v" }, `${got}/${STEPS.length}`), h("div", { class: "k" }, "Parts ready")),
    );
    const bad = job.status === "error", ok = job.status === "done";
    stageBox.className = `notice ${bad ? "bad" : ok ? "ok" : "info"}`;
    stageBox.replaceChildren(
      h("span", { class: bad ? "ico ico-alert" : ok ? "ico ico-check" : "spin", style: "margin-top:3px" }),
      h("div", { class: "nb" }, h("div", { class: "nt" }, STATUS_LABEL[job.status] || job.status),
        h("div", {}, job.error || job.stage || "")));
    if (ok) tail.replaceChildren(h("a", { class: "btn primary", href: `#/m/${id}` }, icon("doc"), "Open the minutes"));
    else if (bad) tail.replaceChildren(h("a", { class: "btn", href: `#/m/${id}` }, "See what has arrived so far"));
    else tail.replaceChildren();
  };

  const es = new EventSource(`/api/jobs/${id}/events`);
  es.onmessage = (e) => {
    job = JSON.parse(e.data); draw();
    if (job.status === "done") { es.close(); setTimeout(() => { if (location.hash === `#/job/${id}`) location.hash = `#/m/${id}`; }, 1200); }
    if (job.status === "error") es.close();
  };
  es.onerror = () => {
    es.close();
    if (!job) tail.replaceChildren(h("div", { class: "notice warn" }, h("span", { class: "ico ico-alert" }),
      h("div", { class: "nb" }, h("div", { class: "nt" }, "No such job"), h("div", {}, "The database may have been cleared."))));
  };
  return () => es.close();
}

// ---------------------------------------------------------------- page: meetings
const STATUS_BADGE = {
  done: ["badge ok", "done"], error: ["badge overdue", "error"],
  processing: ["tag draft", "in progress"], queued: ["badge none", "queued"],
};
async function pageMeetings() {
  const showHidden = sessionGet("mp.hidden", "0") === "1";
  const [{ jobs }, ov] = await Promise.all([
    api(`/api/jobs${showHidden ? "?hidden=1" : ""}`), api("/api/db/overview").catch(() => null)]);
  state.jobs = jobs;
  const running = jobs.filter((j) => j.status === "queued" || j.status === "processing");
  const kpi = (v, k, cls) => h("div", { class: `card kpi ${cls || ""}` }, h("div", { class: "v" }, v), h("div", { class: "k" }, k));
  view().replaceChildren(
    h("div", { class: "page-head" },
      h("div", {}, h("h1", {}, "Meetings"), h("p", {}, "Everything that went through this site. The data lives in a local SQLite database.")),
      h("a", { class: "btn primary", href: "#/new" }, icon("upload"), "New meeting")),
    // Hidden records stay in the database — the list does not turn into a mess, yet nothing is lost
    h("div", { class: "toolbar" },
      h("button", {
        class: `btn small ${showHidden ? "primary" : ""}`,
        onclick: () => { sessionSet("mp.hidden", showHidden ? "0" : "1"); route(); },
      }, showHidden ? "Hidden are shown" : "Show hidden"),
      ov?.jobs?.hidden ? h("span", { class: "muted" }, `hidden: ${ov.jobs.hidden}`) : null),
    ov ? h("div", { class: "grid grid-4", style: "margin-bottom:24px" },
      kpi(ov.jobs.total || 0, "Meetings", "teal"),
      kpi(ov.decisions || 0, "Decisions"),
      kpi(ov.tasks || 0, "Tasks"),
      kpi(ov.medications || 0, "Prescriptions")) : null,
    running.length ? h("div", { class: "grid", style: "margin-bottom:16px" }, running.map((j) =>
      h("a", { class: "card card-pad", href: `#/job/${j.id}`, style: "display:flex;gap:10px 14px;align-items:center;flex-wrap:wrap;color:inherit" },
        h("span", { class: "spin", style: "color:var(--teal)" }), h("strong", {}, "Processing"),
        h("span", { class: "tag draft" }, MODES[j.mode]?.label || j.mode),
        h("span", { class: "muted" }, j.stage || ""),
        h("div", { class: "bar", style: "flex:1;min-width:120px" },
          h("i", { style: `width:${Math.round(100 * STEPS.filter(([k]) => (j.have || []).includes(k)).length / STEPS.length)}%` }))))) : null,
    h("section", { class: "card scroll-x" }, jobs.length ? h("table", { class: "table" },
      h("thead", {}, h("tr", {}, ["When", "Recording", "Mode", "Decisions", "Tasks", "Prescriptions", "Status", ""].map((c) => h("th", {}, c)))),
      h("tbody", {}, jobs.map((j) => h("tr", {
        class: `clickable${j.hidden ? " dim" : ""}`,
        onclick: () => { location.hash = ["processing", "queued"].includes(j.status) ? `#/job/${j.id}` : `#/m/${j.id}`; },
      },
        h("td", { class: "nowrap" }, fmtWhen(j.createdAt)),
        h("td", {}, h("div", { style: "font-weight:600" }, j.title || j.fileName || j.id), h("div", { class: "mono muted" }, j.id)),
        h("td", {}, h("span", { class: "tag Medical" }, MODES[j.mode]?.label || j.mode)),
        h("td", { class: "nowrap" }, j.counts.decisions || "—"),
        h("td", { class: "nowrap" }, j.counts.tasks || "—"),
        h("td", { class: "nowrap" }, j.counts.patients || "—"),
        h("td", {}, h("span", { class: (STATUS_BADGE[j.status] || ["badge none"])[0] }, (STATUS_BADGE[j.status] || [0, j.status])[1])),
        h("td", { class: "nowrap", onclick: (e) => e.stopPropagation() },
          hideBtn(j.hidden, (v) => api(`/api/jobs/${j.id}/hide`, { json: { hidden: v } }), route)))))
    ) : empty("No recordings yet — start with \"New meeting\"")),
  );
}

// ---------------------------------------------------------------- page: minutes of one meeting
const LANGS = [["ru", "Russian"], ["ro", "Romanian"], ["en", "English"]];

/** The voice print is computed by a local model — transcription is not run for it.
    Needed because online recognition gives only "Participant 1/2" labels, without a voice vector. */
function voiceIdBtn(id, existing) {
  const btn = h("button", { class: "btn small", type: "button" },
    existing ? "Recompute voice prints" : "Take voice prints");
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    btn.replaceChildren(h("span", { class: "spin" }), "Computing locally…");
    try {
      const r = await api(`/api/jobs/${id}/voiceid`, { method: "POST" });
      toast(`Voice prints taken: ${r.prints} (${r.model}, ${r.dim} numbers)`);
      route();
    } catch (e) {
      toast(`Failed: ${e.message}`, "error");
      btn.replaceChildren("Take voice prints");
      btn.disabled = false;
    }
  });
  return btn;
}
/** Sending the minutes to the participants. Addresses are filled in automatically: first those linked to
    the participants' voices, then those entered at upload. The email is built by a separate n8n workflow:
    online sends via SMTP, offline is the same node but disabled. */
function emailCard(job, r) {
  const last = r.email?.last;
  const to = h("input", {
    type: "text", id: "mail-to", value: (last?.to || job.recipients || []).join(", "),
    placeholder: "j.smith@clinic.example, a.doe@clinic.example",
  });
  const langSel = h("select", { id: "mail-lang" }, LANGS.map(([k, l]) => h("option", { value: k }, l)));
  const wanted = last?.lang || sessionGet("mp.lang", "ru");
  langSel.value = LANGS.some(([k]) => k === wanted) ? wanted : "ru";   // "Original" is not a minutes language
  const note = h("textarea", { id: "mail-note", rows: "2", placeholder: "For example: please confirm the tasks by Friday" });
  const btn = h("button", { class: "btn primary" }, "Send to participants");
  const status = h("div", { class: "hint" }, last
    ? `Last sent: ${fmtWhen(last.at)} → ${last.to.join(", ")} (${last.fileName})`
    : "The report goes as an attachment plus the email body.");
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    btn.replaceChildren(h("span", { class: "spin" }), "Sending…");
    try {
      const res = await api(`/api/jobs/${job.id}/email`, {
        json: { to: to.value, lang: langSel.value, note: note.value },
      });
      toast(`Sent: ${res.to.join(", ")}`);
      status.textContent = `Sent ${fmtWhen(new Date().toISOString())} → ${res.to.join(", ")}`;
    } catch (e) {
      status.textContent = `Not sent: ${e.message}`;
      toast("Sending failed", "error");
    }
    btn.replaceChildren("Send to participants");
    btn.disabled = false;
  });
  return card("Send the minutes to participants",
    h("span", { class: "tag draft" }, job.mode === "offline" ? "offline: SMTP disabled" : "online: SMTP"),
    h("div", { class: "card-pad grid", style: "gap:14px" },
      job.mode === "offline" ? h("div", { class: "notice warn" }, h("span", { class: "ico ico-alert" }),
        h("div", { class: "nb" }, h("div", { class: "nt" }, "Mail is not configured in the offline setup"),
          h("div", {}, "The sending path is ready: the same webhook, but the SMTP node in the workflow is disabled — "
            + "there is no local mail server on the network. Enable it and set the SMTP credential when one appears."))) : null,
      h("div", { class: "field" }, h("label", { for: "mail-to" }, "To (comma-separated)"), to,
        h("div", { class: "hint" }, job.emailSentAt
          ? `The minutes were already sent automatically ${fmtWhen(job.emailSentAt)}.`
          : (job.recipients || []).length
            ? `Participant addresses filled in: ${job.recipients.join(", ")}`
            : "None of the participants has an address in the voice registry — enter them manually.")),
      h("div", { class: "row-2" },
        h("div", { class: "field" }, h("label", { for: "mail-lang" }, "Minutes language"), langSel),
        h("div", { class: "field" }, h("label", { for: "mail-note" }, "Note in the email"), note)),
      h("div", { style: "display:flex;gap:10px;align-items:center;flex-wrap:wrap" }, btn, status)));
}

async function pageReport(id) {
  const job = await api(`/api/jobs/${id}`);
  const r = job.result || {};
  const mom = r.mom || {};
  let lang = sessionGet("mp.lang", "ru");

  const momBody = h("div", { class: "card-pad" });
  const langSeg = h("div", { class: "seg" });
  const pdfBtn = h("button", { class: "btn small", type: "button" }, "Export PDF");
  pdfBtn.addEventListener("click", async () => {
    pdfBtn.disabled = true;
    pdfBtn.replaceChildren(h("span", { class: "spin" }), "Building…");
    try {
      const res = await buildPdf(lang);
      window.open(`/api/reports/${encodeURIComponent(res.fileName)}`, "_blank", "noopener");
    } catch (e) { toast(`PDF build failed: ${e.message}`, "error"); }
    pdfBtn.replaceChildren("Export PDF");
    pdfBtn.disabled = false;
  });
  // Sending right from here. The email language is chosen separately from the one open on screen:
  // some participants get the Russian minutes, others the English ones, each with their own PDF.
  // The detailed card with a note and the sending history is further down the page.
  const mailTo = h("input", {
    type: "text", id: "mail-quick", style: "min-width:210px",
    placeholder: "j.smith@clinic.example, a.doe@clinic.example",
    value: (job.recipients || []).join(", "),
  });
  const mailLang = h("select", { id: "mail-quick-lang", title: "Which language the minutes are sent in" },
    LANGS.map(([k, l]) => h("option", { value: k }, l)));
  // Share: the system "Share" sheet, and where there is none — the minutes text with a link
  // goes to the clipboard, to paste into a messenger or an email by hand.
  const shareBtn = h("button", { class: "btn small", type: "button" }, "Share");
  shareBtn.addEventListener("click", async () => {
    const title = `${mom.title || job.title || "Minutes"} · ${mom.meetingDate || job.meetingDate || ""}`.trim();
    const url = `${location.origin}/#/m/${id}`;
    const text = `${title}\n\n${plainText(protocolPart(mom[lang] || ""))}\n\nMeeting on the site: ${url}`;
    try {
      if (navigator.share) { await navigator.share({ title, text, url }); return; }
      await navigator.clipboard.writeText(text);
      toast("Minutes and link copied to the clipboard");
    } catch (e) {
      if (e.name !== "AbortError") toast(`Could not share: ${e.message}`, "error");
    }
  });
  const mailBtn = h("button", { class: "btn small primary", type: "button" }, "Send");
  mailBtn.addEventListener("click", async () => {
    const to = mailTo.value.trim();
    if (!to) { toast("Enter at least one address", "error"); mailTo.focus(); return; }
    mailBtn.disabled = true;
    mailBtn.replaceChildren(h("span", { class: "spin" }), "Sending…");
    try {
      // Build the PDF before sending: the email picks up the ready file from disk and attaches
      // it. Without it, markdown would be sent instead.
      await buildPdf(mailLang.value);
      const res = await api(`/api/jobs/${id}/email`, { json: { to, lang: mailLang.value } });
      toast(`Sent (${res.attached === "pdf" ? "PDF" : res.attached}): ${res.to.join(", ")}`);
    } catch (e) {
      toast(`Not sent: ${e.message}`, "error");
    }
    mailBtn.replaceChildren("Send");
    mailBtn.disabled = false;
  });
  const drawMom = () => {
    // Next to the languages — a tab with the full recording: nothing translated or shortened.
    langSeg.replaceChildren(...[...LANGS, ["orig", "Original"]].map(([k, l]) => h("button", {
      type: "button", class: k === lang ? "on" : "",
      onclick: () => { lang = k; sessionSet("mp.lang", k); drawMom(); },
    }, l)));
    // Whatever minutes language is open is also the default for sending.
    if (lang !== "orig") mailLang.value = lang;
    // PDF and "Share" take the minutes themselves; the "Original" tab has none — it holds the raw transcript.
    pdfBtn.hidden = shareBtn.hidden = lang === "orig" || !mom[lang];
    momBody.replaceChildren(lang === "orig" ? origBody()
      : mom[lang] ? h("div", { html: markdown(mom[lang]) }) : empty("No minutes in this language"));
  };

  /** "Share" sends only the minutes: without the letter on top and without the transcript below.
   *  Split on the "---" line (headings are translated, the separator is the same) and take the part
   *  right after the letter — the last one may be the "Original recording". */
  const protocolPart = (md) => {
    const parts = String(md || "").replace(/\r/g, "").split(/^---\s*$/m);
    return (parts.length > 1 ? parts[1] : parts[0]).trim();
  };
  /** Markup → plain text: in a messenger or an email, asterisks and hashes only get in the way. */
  const plainText = (md) => String(md || "").replace(/\r/g, "")
    .replace(/^#{1,6}\s+/gm, "").replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1").replace(/^\s*[-*]\s+/gm, "• ")
    .replace(/\n{3,}/g, "\n\n").trim();
  /** The PDF is printed by the server (headless Chrome) and stored next to the report — the mailing
   *  picks it up from there later. The layout is server-side too: the automatic mailing also needs the PDF
   *  when nobody has opened the page. */
  const buildPdf = async (l) => {
    if (!mom[l]) throw new Error(`there are no minutes in this language`);
    return api(`/api/jobs/${id}/pdf`, { json: { lang: l } });
  };

  // Transcript "as spoken": time from the start of the recording, speaker, utterance in its own language.
  // Labelled not by the recognition label but by the cross-meeting voice print: "Participant 1 — V-001".
  // "Participant N" labels come from speaker separation, which often splits one person into
  // two clusters. The print fixes that: two labels with the same V-00N mean one person,
  // and their utterances go together under one label.
  const vidOf = Object.fromEntries((job.speakers || []).map((s) => [s.label, s.voice_id || ""]));
  const firstLabel = {};   // V-001 → the label under which this voice appeared first
  const parsed = String(r.transcript?.text || "").split("\n").filter((s) => s.trim()).map((line) => {
    const m = /^\[(\d{1,2}:\d{2}(?::\d{2})?)\]\s*([^:]{0,40}?):\s*(.*)$/.exec(line);
    if (!m) return { raw: line };
    const who = m[2].trim();
    const label = /\((Participant\s*\d+)\)/.exec(who)?.[1] || who;
    const vid = vidOf[label] || "";
    if (vid && !firstLabel[vid]) firstLabel[vid] = label;
    return { tc: m[1], label, vid, key: vid || label, said: m[3] };
  });
  // Merge only adjacent utterances of the same voice and no longer than half a minute: on a recording
  // where one person talks, the whole transcript would otherwise stick into one paragraph.
  const secs = (t) => { const p = t.split(":").map(Number); return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1]; };
  const tlines = parsed.reduce((out, p) => {
    const last = out[out.length - 1];
    if (!p.raw && last && !last.raw && last.key === p.key && secs(p.tc) - secs(last.tc) < 30) last.said += ` ${p.said}`;
    else out.push({ ...p });
    return out;
  }, []).map((p) => (p.raw
    ? h("div", { class: "ln" }, h("span", {}), h("span", {}, p.raw))
    : h("div", { class: "ln" }, h("span", { class: "mono muted" }, p.tc),
      h("span", {}, h("b", {}, `${p.vid ? firstLabel[p.vid] : p.label}${p.vid ? ` — ${p.vid}` : ""}: `), p.said))));
  // If "Three languages" returned per-language markup — show it, otherwise the raw transcript.
  const origLines = () => String(mom.original || "").split("\n").filter(Boolean).map((l) => {
    const m = /^`((?:RU|RO|EN)(?:\+(?:RU|RO|EN))?)`\s*(?:\[([\d:]+)\]\s*)?(.*)$/.exec(l) || [];
    return h("div", { class: "tline" },
      h("span", { class: "badge none" }, m[1] || "—"),
      h("span", { class: "mono" }, m[2] || ""),
      h("span", {}, m[3] ?? l));
  });
  // "Original" is the recording as is. No voice prints here: who said what is shown
  // in its own card; here only the text and the utterance language matter.
  const rawLines = () => parsed.map((p) => (p.raw
    ? h("div", { class: "ln" }, h("span", {}), h("span", {}, p.raw))
    : h("div", { class: "ln" }, h("span", { class: "mono muted" }, p.tc),
      h("span", {}, h("b", {}, `${p.label}: `), p.said))));
  const origBody = () => {
    const body = mom.original ? origLines() : rawLines();
    if (!body.length) return empty("No transcript");
    return h("div", { class: "grid", style: "gap:12px" },
      h("div", { class: "notice info" }, h("span", { class: "ico ico-shield" }),
        h("div", { class: "nb" }, h("div", { class: "nt" }, "Full recording, nothing translated or shortened"),
          h("div", {}, mom.original
            ? `Languages in the recording: ${mom.langLine || "—"}. The tag at the start of a line is the utterance language, next to it — time from the start.`
            : `Utterances: ${body.length}. Each line starts with the time from the start of the recording.`))),
      h("div", { class: "transcript" }, body));
  };
  drawMom();

  const fileRows = (r.files?.rows || []).map((f) => h("div", { class: "file-row" }, h("span", { html: ICON.doc }),
    h("div", { style: "flex:1;min-width:0" },
      h("div", { style: "font-weight:600;overflow:hidden;text-overflow:ellipsis" }, f.fileName),
      h("div", { class: "mono muted", style: "overflow:hidden;text-overflow:ellipsis" }, f.path || "")),
    h("a", { class: "btn small", href: `/api/reports/${encodeURIComponent(f.fileName)}`, target: "_blank", rel: "noopener" }, "Open")));

  const speakers = r.transcript?.evidence || [];
  const byLabel = Object.fromEntries((job.speakers || []).map((s) => [s.label, s]));
  const conf = (v) => h("span", { class: `badge ${/high/i.test(v || "") ? "ok" : /medium/i.test(v || "") ? "soon" : "none"}` }, v || "—");

  view().replaceChildren(
    h("div", { class: "page-head" },
      h("div", {},
        h("h1", {}, mom.title || job.title || "Minutes"),
        h("p", {}, [mom.meetingDate || job.meetingDate, job.fileName, MODES[job.mode]?.label].filter(Boolean).join(" · ")),
        h("div", { class: "meta-row" },
          h("span", {}, "Recorded: ", h("b", {}, fmtWhen(job.createdAt))),
          job.finishedAt ? h("span", {}, "Processed in ", h("b", {}, fmtDur((new Date(job.finishedAt) - new Date(job.createdAt)) / 1000))) : null,
          h("span", { class: "mono" }, job.id))),
      h("a", { class: "btn", href: "#/meetings" }, "All meetings")),

    job.status === "error" ? h("div", { class: "notice bad", style: "margin-bottom:16px" }, h("span", { class: "ico ico-alert" }),
      h("div", { class: "nb" }, h("div", { class: "nt" }, "Processing ended with an error"), h("div", {}, job.error || ""))) : null,

    h("div", { class: "grid" },
      // Next to a participant — their cross-meeting voice print: "Participant 1 · V-001". It is the same
      // in all meetings, so the person is recognised by it even without a name. The minutes write
      // a participant either as a label ("Participant 1") or as a name with the label in brackets ("Andrei (Participant 1)") —
      // the label is taken from the brackets. Not everyone has a print: speaker separation does not bring every
      // label into the registry, and then the chip simply has nothing to add.
      mom.participants?.length ? card("Participants", null, h("div", { class: "card-pad chips" },
        mom.participants.map((p) => {
          const label = /\((Participant\s*\d+)\)/.exec(p)?.[1] || p.trim();
          const vid = byLabel[label]?.voice_id || "";
          return h("span", { class: "chip" },
            h("span", { class: "avatar", style: "width:22px;height:22px;font-size:10px" }, initials(p)), p,
            vid ? h("a", { class: "tag draft mono", style: "margin-left:6px", href: "#/voices", title: "Cross-meeting voice ID — the same in all meetings" }, vid) : null);
        }))) : null,

      card("Minutes", h("div", { style: "display:flex;gap:8px;align-items:center;flex-wrap:wrap" },
        langSeg, shareBtn, pdfBtn,
        ...(fileRows.length ? [mailTo, mailLang, mailBtn] : [])), momBody),

      mom.mentioned?.length ? card("People mentioned", null, dataTable(
        mom.mentioned.map((x) => ({ ...x, name: x.name || "name not mentioned" })), [
        ["name", "Who"], ["kind", "Relation"], ["bed", "Bed / ward"],
        ["about", "What was said"], ["evidence", "Where in the recording"],
      ], { emptyText: "Nobody was mentioned" })) : null,

      card(`Decisions${r.decisions?.rows?.length ? ` · ${r.decisions.rows.length}` : ""}`, null,
        dataTable(r.decisions?.rows, null, { emptyText: "No decisions recorded" })),

      card(`Tasks${r.tasks?.rows?.length ? ` · ${r.tasks.rows.length}` : ""}`, null,
        dataTable(r.tasks?.rows, null, { emptyText: "No tasks recorded" })),

      card(`Patients and prescriptions${r.patients?.rows?.length ? ` · ${r.patients.rows.length}` : ""}`, null,
        dataTable(r.patients?.rows, null, { emptyText: "No prescriptions recorded" })),

      card("Who spoke", voiceIdBtn(id, r.voiceid),
        h("div", { class: "card-pad grid", style: "gap:12px" },
          r.voiceid ? h("div", { class: "notice info" }, h("span", { class: "ico ico-shield" }),
            h("div", { class: "nb" }, h("div", { class: "nt" }, `Voice prints taken locally · ${r.voiceid.voiceIdModel || r.voiceid.method}`),
              h("div", {}, `${Object.keys(r.voiceid.stats || {}).length} voices, a vector of ${r.voiceid.dim} numbers. `
                + (Object.keys(r.voiceid.names || {}).length
                  ? `Recognised from references: ${Object.values(r.voiceid.names).join(", ")}.`
                  : "No matches with references — add reference recordings in the \"Voices\" section."))))
            : null,
          speakers.length ? h("div", { class: "voices" }, speakers.map((s) => {
            const vi = r.voiceid?.stats?.[s.speaker];
            const sp = byLabel[s.speaker] || {};
            const vid = sp.voice_id || r.voiceid?.ids?.[s.speaker]?.voiceId || "";
            const vscore = sp.voice_score ?? r.voiceid?.ids?.[s.speaker]?.score;
            return h("div", { class: "voice" },
              h("div", { class: "vh" }, h("span", { class: "vdot", style: "background:var(--teal)" }),
                sp.voice_name || sp.name || r.voiceid?.names?.[s.speaker] || s.name || s.speaker,
                vid ? h("a", { class: "tag draft mono", style: "margin-left:6px", href: "#/voices", title: "Cross-meeting voice ID — the same in all meetings" }, vid) : null),
              s.role ? h("div", { class: "muted" }, s.role) : null,
              h("div", { class: "sugg" }, "confidence: ", conf(s.confidence)),
              vi || sp.seconds ? h("div", { class: "muted", style: "font-size:12.5px" },
                `print: ${fmtDur(vi?.seconds ?? sp.seconds)} of speech, ${vi?.lines ?? sp.lines} utterances`
                + (vscore ? ` · similarity to registry ${vscore}` : "")
                + (sp.matched_name ? ` · reference ${sp.matched_name} (${sp.match_score})` : "")) : null,
              s.evidence ? h("div", { class: "muted", style: "font-size:12.5px" }, s.evidence) : null);
          })) : empty("Speakers not identified"))),

      fileRows.length ? emailCard(job, r) : null,

      fileRows.length ? card("Report files", null, h("div", { class: "card-pad grid", style: "gap:10px" }, fileRows)) : null,

      // Who said what — separate from the minutes. Speaker labels are not mixed
      // into the minutes: the model got confused by them and distorted the text.
      tlines.length ? h("details", { class: "card fold" },
        h("summary", { class: "card-head" }, h("h2", {}, "Who said what"), h("span", { class: "ico ico-chevron" })),
        h("div", { class: "transcript" }, tlines)) : null,
    ),
  );
}

// ---------------------------------------------------------------- summary pages from SQL
const SQL_VIEWS = {
  decisions: {
    title: "Decisions", sub: "All decisions across all meetings — straight from the local database.",
    cols: [["n", "#"], ["job_date", "Date"], ["patient", "Patient"], ["decision", "Decision"],
      ["proposed_by", "Proposed by"], ["approved_by", "Approved by"], ["timecode", "Timecode"], ["job_title", "Meeting"]],
    placeholder: "patient, decision, proposed by…",
  },
  tasks: {
    title: "Tasks", sub: "Who has to do what — across all meetings.",
    cols: [["n", "#"], ["job_date", "Date"], ["patient", "Patient"], ["task", "Task"],
      ["owner", "Owner"], ["deadline", "Deadline"], ["status", "Status"], ["timecode", "Timecode"]],
    placeholder: "task, owner, deadline…",
  },
  patients: {
    title: "Patients and prescriptions", sub: "What was said about each patient: drug, dose, route, who prescribed.",
    cols: [["job_date", "Date"], ["patient", "Patient"], ["bed", "Bed"], ["condition", "Condition"],
      ["drug", "Drug"], ["drug_normalized", "Probably"], ["dose", "Dose"], ["route", "Route"],
      ["action", "Action"], ["by_whom", "Prescribed by"], ["timecode", "Timecode"], ["confidence", "Confidence"]],
    placeholder: "patient, drug, dose…",
  },
};
async function pageSql(kind) {
  const cfg = SQL_VIEWS[kind];
  let q = "", timer = 0;
  // Anonymous rows (it is unknown who they are about) are useless for work — one toggle removes them
  let named = sessionGet(`mp.named.${kind}`, "0") === "1";
  let hidden = sessionGet("mp.hidden", "0") === "1";
  const body = h("section", { class: "card" }, h("div", { class: "empty" }, h("span", { class: "spin" })));
  const total = h("span", { class: "muted" });
  const extra = h("div");
  const search = h("input", { type: "text", placeholder: cfg.placeholder, style: "min-width:260px;flex:1" });
  const namedBtn = h("button", { class: "btn small" });
  const hiddenBtn = h("button", { class: "btn small" });

  async function load() {
    namedBtn.className = `btn small ${named ? "primary" : ""}`;
    namedBtn.textContent = named ? "Only with a patient" : "All, including anonymous";
    hiddenBtn.className = `btn small ${hidden ? "primary" : ""}`;
    hiddenBtn.textContent = hidden ? "Hidden are shown" : "Show hidden";
    try {
      const r = await api(`/api/db/${kind}?limit=1000&q=${encodeURIComponent(q)}`
        + `${named ? "&named=1" : ""}${hidden ? "&hidden=1" : ""}`);
      total.textContent = plural(r.total, "record", "records");
      body.replaceChildren(dataTable(r.rows, cfg.cols, {
        emptyText: q ? `Nothing found for "${q}"` : "Nothing here yet — process the first meeting",
        onRow: (row) => { location.hash = `#/m/${row.job_id}`; },
        actions: (row) => hideBtn(row.hidden,
          (v) => api(`/api/db/${kind}/hide`, { json: { rowid: row.rowid, hidden: v } }), load),
      }));
    } catch (e) {
      body.replaceChildren(h("div", { class: "notice bad" }, h("span", { class: "ico ico-alert" }), e.message));
    }
  }
  search.addEventListener("input", () => { q = search.value.trim(); clearTimeout(timer); timer = setTimeout(load, 250); });
  namedBtn.addEventListener("click", () => { named = !named; sessionSet(`mp.named.${kind}`, named ? "1" : "0"); load(); });
  hiddenBtn.addEventListener("click", () => { hidden = !hidden; sessionSet("mp.hidden", hidden ? "1" : "0"); load(); });

  view().replaceChildren(
    h("div", { class: "page-head" }, h("div", {}, h("h1", {}, cfg.title), h("p", {}, cfg.sub))),
    h("div", { class: "toolbar" }, search, namedBtn, hiddenBtn,
      h("button", { class: "btn small", onclick: load }, "Refresh"), total),
    body, extra,
  );
  await load();
  if (kind === "patients") {
    const s = await api("/api/db/patients/summary").catch(() => ({ rows: [] }));
    if (s.rows.length) {
      extra.replaceChildren(gap(24), card("Patient summary", null, dataTable(s.rows, [
        ["patient", "Patient"], ["bed", "Bed"], ["records", "Records"], ["meetings", "Meetings"],
      ], { onRow: (row) => { location.hash = `#/m/${row.last_job}`; } })));
    }
  }
  return () => clearTimeout(timer);
}

// ---------------------------------------------------------------- page: voices
async function pageVoices() {
  const [spk, people, asr] = await Promise.all([
    api("/api/db/voices").catch(() => ({ rows: [], prints: [] })),
    api("/api/db/people").catch(() => ({ rows: [] })),
    api("/api/asr/health").catch(() => ({ ok: false })),   // health returns both the status and the list of references at once
  ]);

  // ---- reference voice: the site stores the recording, the ASR service on 7778 computes the vector
  const nameInput = h("input", { type: "text", placeholder: "Full name", id: "v-name" });
  const status = h("div", { class: "hint" });
  const fileInput = h("input", { type: "file", accept: "audio/*", style: "display:none" });
  const enrollBtn = h("button", { class: "btn", disabled: true }, "Attach a voice recording");
  nameInput.addEventListener("input", () => { enrollBtn.disabled = !nameInput.value.trim(); });
  enrollBtn.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", async () => {
    const f = fileInput.files[0];
    fileInput.value = "";
    if (!f) return;
    const who = nameInput.value.trim();
    enrollBtn.disabled = true;
    enrollBtn.replaceChildren(h("span", { class: "spin" }), "Computing the print…");
    try {
      const r = await fetch(`/api/asr/voices/enroll?name=${encodeURIComponent(who)}`, {
        method: "POST", body: f,
        headers: { "x-file-name": encodeURIComponent(f.name), "Content-Type": "application/octet-stream" },
      });
      const j = await r.json();
      if (!r.ok || j.error) throw new Error(j.error || r.status);
      toast(`Voice "${who}" saved as a reference`);
      route();
      return;
    } catch (e) {
      status.textContent = `Failed: ${e.message}`;
      toast("Could not save the reference", "error");
    }
    enrollBtn.replaceChildren("Attach a voice recording");
    enrollBtn.disabled = false;
  });

  const refs = Object.entries(asr.voices || {}).map(([name, n]) => h("span", { class: "chip" },
    h("span", { class: "avatar", style: "width:22px;height:22px;font-size:10px" }, initials(name)),
    name, h("span", { class: "muted" }, ` · ${n}`)));

  view().replaceChildren(
    h("div", { class: "page-head" }, h("div", {}, h("h1", {}, "Voices"),
      h("p", {}, "The system tells speakers apart by voice print. Provide a reference recording — and a name appears instead of \"Participant 1\"."))),
    h("div", { class: "grid" },
      card("Reference voices",
        asr.ok ? h("span", { class: "pill ok" }, h("span", { class: "dot" }), asr.voiceId?.loaded || "service ready")
          : h("span", { class: "pill warn" }, h("span", { class: "dot" }), "service is off"),
        h("div", { class: "card-pad grid", style: "gap:16px" },
          asr.ok ? null : h("div", { class: "notice warn" }, h("span", { class: "ico ico-alert" }),
            h("div", { class: "nb" }, h("div", { class: "nt" }, "The offline recognition service is not running"),
              h("div", {}, "Start it with bash tools/restart-asr.sh — it keeps the recognition and voice models in memory on port 7778."))),
          refs.length ? h("div", { class: "field" }, h("span", { class: "label" }, "Existing references"), h("div", { class: "chips" }, refs)) : null,
          h("div", { class: "row-2" },
            h("div", { class: "field" }, h("label", { for: "v-name" }, "Whose voice"), nameInput,
              h("div", { class: "hint" }, "20–30 seconds of clean speech from one person is enough.")),
            h("div", { class: "field" }, h("span", { class: "label" }, "Recording"), enrollBtn, status)),
          fileInput)),

      // Cross-meeting registry: one person has the same voice_id in all meetings,
      // because the vector is compared with already known voices (cosine ≥ threshold).
      card("Voice registry (voice ID)",
        h("button", {
          class: "btn small", title: "Rebuild from already captured prints — audio is not touched",
          onclick: async (e) => {
            e.target.disabled = true;
            try { const r = await api("/api/db/voiceprints/reindex", { json: {} }); toast(`Voices linked: ${r.linked} → ${r.prints} people`); route(); }
            catch (err) { toast(`Failed: ${err.message}`, "error"); e.target.disabled = false; }
          },
        }, "Rebuild"),
        h("div", { class: "card-pad grid", style: "gap:12px" },
          h("div", { class: "notice info" }, h("span", { class: "ico ico-shield" }),
            h("div", { class: "nb" }, h("div", { class: "nt" }, "One person = one voice ID in all meetings"),
              h("div", {}, "The voice vector (192 numbers) is computed on this machine and compared "
                + "with the known ones. Enter a name once — it is filled into all recordings of this voice."))),
          dataTable((spk.prints || []).map((p) => ({
            ...p, heard: `${plural(p.samples, "recording", "recordings")} · ${fmtDur(p.seconds)}`,
            last_seen: fmtWhen(p.last_seen),
          })), [
            ["voice_id", "Voice ID"], ["name", "Name"], ["email", "E-mail"], ["meetings", "Meetings"],
            ["heard", "Heard"], ["dim", "Vector size"], ["model", "Model"], ["last_seen", "Last seen"],
          ], {
            emptyText: "The registry is empty — take voice prints on a meeting page",
            actions: (p) => {
              const inp = h("input", { type: "text", value: p.name || "", placeholder: "Who is this", style: "min-width:150px" });
              // An address linked to the voice: the minutes of any meeting with this person are sent here automatically.
              const mail = h("input", { type: "text", value: p.email || "", placeholder: "email", style: "min-width:170px" });
              const btn = h("button", { class: "btn small", type: "button" }, "Name");
              btn.addEventListener("click", async () => {
                const name = inp.value.trim();
                if (!name) return;
                btn.disabled = true;
                try {
                  const r = await api(`/api/db/voiceprints/${p.voice_id}/name`, { json: { name, email: mail.value.trim() } });
                  toast(`${p.voice_id} is ${name} (records updated: ${r.updated})`);
                  route();
                } catch (e) { toast(`Failed: ${e.message}`, "error"); btn.disabled = false; }
              });
              return h("div", { style: "display:flex;gap:6px" }, inp, mail, btn);
            },
          }))),

      card("Recognised in meetings", null, dataTable(people.rows, [
        ["name", "Name"], ["role", "Role"], ["meetings", "Meetings"],
        ["prints", "Prints"], ["confidence", "Confidence"],
      ], { emptyText: "Nobody could be named yet" })),

      card("All voices by meeting",
        h("span", { class: "muted" }, `${spk.rows.filter((r) => r.has_print).length} of ${spk.rows.length} with a print`),
        dataTable(spk.rows.map((r) => ({
          ...r,
          who: r.voice_name || r.name || "",
          print: r.has_print ? `${r.voice_model} · ${fmtDur(r.seconds)} · ${r.lines} utterances` : "none",
          matched: r.matched_name ? `${r.matched_name} (${r.match_score})` : "",
        })), [
          ["job_date", "Date"], ["label", "Label"], ["voice_id", "Voice ID"], ["who", "Name"],
          ["print", "Voice print"], ["matched", "Matched a reference"], ["job_mode", "Mode"],
        ], { emptyText: "No transcripts yet", onRow: (row) => { location.hash = `#/m/${row.job_id}`; } })),
    ),
  );
}

// ---------------------------------------------------------------- routing
async function route() {
  if (cleanup) { try { cleanup(); } catch (e) { /* already closed */ } cleanup = null; }
  const [page, arg] = location.hash.replace(/^#\/?/, "").split("/");
  renderNav();
  try {
    if (page === "meetings") await pageMeetings();
    else if (page === "job" && arg) cleanup = pageJob(arg);
    else if (page === "m" && arg) await pageReport(arg);
    else if (SQL_VIEWS[page]) cleanup = await pageSql(page);
    else if (page === "voices") await pageVoices();
    else await pageNew();
  } catch (e) {
    view().replaceChildren(h("div", { class: "notice bad" }, h("span", { class: "ico ico-alert" }),
      h("div", { class: "nb" }, h("div", { class: "nt" }, "The page failed to load"), h("div", {}, e.message))));
  }
}

window.addEventListener("hashchange", route);
refreshStatus();
setInterval(refreshStatus, 30_000);
if (!location.hash) location.hash = "#/new";
route();
