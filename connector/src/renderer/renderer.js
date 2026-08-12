// Renderer — thin UI over the `connector` preload bridge. No Node, no Firebase,
// no credentials here; it only invokes the bridge and renders progress.
"use strict";

const $ = (id) => document.getElementById(id);

// --- Sign in ---------------------------------------------------------------
async function afterSignIn(user) {
  // A phone-only account has no email, so show whatever identifies them.
  $("who").textContent = (user && (user.label || user.email || user.phoneNumber)) || "";
  $("bootCard").classList.add("hidden");
  $("signinCard").classList.add("hidden");
  $("signOutBtn").classList.remove("hidden");
  $("syncCard").classList.remove("hidden");
  try { paintAuto(await window.connector.getAutoSync()); }
  catch (err) { console.info("[auto] state unavailable:", err); }
  await loadAssessees();
}

function showSignIn() {
  $("bootCard").classList.add("hidden");
  $("syncCard").classList.add("hidden");
  $("signOutBtn").classList.add("hidden");
  $("signinCard").classList.remove("hidden");
  $("who").textContent = "";
}

// On launch, try the device key in the OS keychain before showing anything. The
// whole point is that a returning user on the same machine never sees this
// screen — they stay signed in until they choose to sign out.
(async function boot() {
  try {
    const user = await window.connector.trySilentSignIn();
    if (user) { await afterSignIn(user); return; }
  } catch (err) {
    console.info("[auth] silent sign-in unavailable:", err);
  }
  showSignIn();
})();

$("signOutBtn").addEventListener("click", async () => {
  const btn = $("signOutBtn");
  btn.disabled = true;
  btn.textContent = "Signing out…";
  try {
    await window.connector.signOut();
    // Drop the previous user's assessees before showing sign-in — the next person
    // to sign in on this machine must not see them.
    JOBS = [];
    selected.clear();
    renderRows();
    syncSelectionUI();
    showSignIn();
  } catch (err) {
    alert(friendly(err));
  } finally {
    btn.disabled = false;
    btn.textContent = "Sign out";
  }
});

$("googleBtn").addEventListener("click", async () => {
  $("signinErr").textContent = "";
  $("googleBtn").disabled = true;
  $("googleBtn").textContent = "Opening your browser… finish sign-in there";
  try {
    const user = await window.connector.signInWithGoogle();
    await afterSignIn(user);
  } catch (err) {
    $("signinErr").textContent = friendly(err);
  } finally {
    $("googleBtn").disabled = false;
    $("googleBtn").textContent = "Sign in with Google";
  }
});

// --- OTP sign-in, by SMS or email (same flow as the web app) ---------------
//
// One field takes either. Which channel to use is detected from what was typed
// rather than made the user's problem — matching Login.jsx, so someone who signs
// in to the web app on their mobile signs in here the same way.
let otpChannel = "email";
let otpTarget = "";
let resendTimer = null;

// "@" anywhere → email; otherwise digits/spaces/dashes/+ → mobile.
function detectChannel(value) {
  const s = String(value || "").trim();
  if (!s) return null;
  if (s.includes("@")) return "email";
  if (/\d/.test(s) && /^[+\d\s-]+$/.test(s)) return "sms";
  return null;
}

// Mask a mobile in the "code sent to …" line; an email stays readable.
function maskTarget(channel, target) {
  if (channel !== "sms") return target;
  const d = String(target).replace(/\D/g, "");
  return d.length >= 4 ? `+91 ${d.slice(-10, -4).replace(/./g, "•")} ${d.slice(-4)}` : target;
}

function startResendCooldown(seconds) {
  clearInterval(resendTimer);
  let left = seconds || 30;
  const btn = $("resendBtn");
  const tick = () => {
    if (left <= 0) {
      clearInterval(resendTimer);
      btn.disabled = false;
      btn.textContent = "Resend code";
    } else {
      btn.disabled = true;
      btn.textContent = `Resend in ${left}s`;
      left -= 1;
    }
  };
  tick();
  resendTimer = setInterval(tick, 1000);
}

async function sendCode() {
  const value = $("identifier").value.trim();
  const channel = detectChannel(value);
  let target;
  if (channel === "email") {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      $("signinErr").textContent = "Enter a valid email address.";
      return;
    }
    target = value.toLowerCase();
  } else if (channel === "sms") {
    const ten = value.replace(/\D/g, "").slice(-10);
    if (!/^[6-9]\d{9}$/.test(ten)) {
      $("signinErr").textContent = "Enter a valid 10-digit Indian mobile number, or an email address.";
      return;
    }
    target = ten;
  } else {
    $("signinErr").textContent = "Enter your mobile number or email address.";
    return;
  }

  $("signinErr").textContent = "";
  $("sendCodeBtn").disabled = true;
  $("sendCodeBtn").textContent = "Sending…";
  try {
    const res = await window.connector.requestOtp(channel, target);
    otpChannel = channel;
    otpTarget = target;
    $("otpTarget").textContent = maskTarget(channel, target);
    $("otpRequest").classList.add("hidden");
    $("otpVerify").classList.remove("hidden");
    $("code").value = "";
    $("code").focus();
    startResendCooldown((res && res.cooldownSeconds) || 30);
  } catch (err) {
    $("signinErr").textContent = friendly(err);
  } finally {
    $("sendCodeBtn").disabled = false;
    $("sendCodeBtn").textContent = "Send me a code";
  }
}

async function verifyCode() {
  const code = $("code").value.replace(/\D/g, "");
  if (code.length !== 6) {
    $("signinErr").textContent = "Enter the 6-digit code we sent you.";
    return;
  }
  $("signinErr").textContent = "";
  $("verifyBtn").disabled = true;
  $("verifyBtn").textContent = "Verifying…";
  try {
    const user = await window.connector.verifyOtp(otpChannel, otpTarget, code);
    clearInterval(resendTimer);
    await afterSignIn(user);
  } catch (err) {
    $("signinErr").textContent = friendly(err);
    $("code").value = "";
    $("code").focus();
  } finally {
    $("verifyBtn").disabled = false;
    $("verifyBtn").textContent = "Verify & sign in";
  }
}

$("sendCodeBtn").addEventListener("click", sendCode);
$("verifyBtn").addEventListener("click", verifyCode);
$("resendBtn").addEventListener("click", async () => {
  if ($("resendBtn").disabled) return;
  await sendCode();
});
$("changeTargetBtn").addEventListener("click", () => {
  clearInterval(resendTimer);
  $("otpVerify").classList.add("hidden");
  $("otpRequest").classList.remove("hidden");
  $("signinErr").textContent = "";
  $("identifier").focus();
});
$("identifier").addEventListener("keydown", (e) => { if (e.key === "Enter") sendCode(); });
$("code").addEventListener("keydown", (e) => { if (e.key === "Enter") verifyCode(); });
$("code").addEventListener("input", () => {
  if ($("code").value.replace(/\D/g, "").length === 6) verifyCode();
});

// --- Assessees + selection -------------------------------------------------
let JOBS = [];
const selected = new Set();

/* Per-row progress, kept OUTSIDE the DOM.
 *
 * Rows are destroyed and rebuilt whenever the search or a filter changes, so
 * progress painted straight onto the element would vanish the moment someone
 * typed in the search box mid-sync — and a row filtered out and back in would
 * come back reading "idle" while its PAN was still syncing. The map is the
 * truth; the DOM is a view of it. */
const STATE = new Map(); // assesseeId -> { level, pct, msg, title }

async function loadAssessees() {
  const list = await window.connector.listAssessees();
  // No `knowns` here on purpose: the renderer has no Firestore access, and this
  // used to send an empty object that silently disabled the whole incremental
  // diff. Each worker now reads its own PAN's knowns in the main process, in
  // parallel with the login (see portalWorker.js).
  JOBS = (list || []).map((a) => ({
    assesseeId: a.id,
    pan: a.pan || a.portalUserId,
    label: a.name || a.pan,
    group: a.group || "",
    staff: a.staff || "",
    // Date of birth / incorporation. Carried purely so the returns pass can
    // build the password CPC locks its intimation and s.154 order PDFs with —
    // PAN in lower case + DDMMYYYY. See pdfUnlock.js.
    dob: a.dob || "",
    lastSyncedAt: a.lastSyncedAt || "",
  }));
  selected.clear();
  STATE.clear();
  buildFilterOptions();
  renderRows();
  syncSelectionUI();
}

// Populate the group/staff dropdowns from what's actually on the list, keeping
// the current choice if it still exists.
function buildFilterOptions() {
  for (const [id, key, allLabel] of [["fGroup", "group", "All groups"], ["fStaff", "staff", "All staff"]]) {
    const sel = $(id);
    const prev = sel.value;
    const values = [...new Set(JOBS.map((j) => j[key]).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    sel.innerHTML = `<option value="">${allLabel}</option>` +
      values.map((v) => `<option value="${escapeAttr(v)}">${escapeHtml(v)}</option>`).join("");
    sel.value = values.includes(prev) ? prev : "";
    sel.classList.toggle("hidden", values.length === 0);
  }
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const escapeAttr = escapeHtml;

function activeFilters() {
  return {
    q: ($("search").value || "").trim().toLowerCase(),
    group: $("fGroup").value,
    staff: $("fStaff").value,
    state: $("fState").value,
  };
}

function visibleJobs() {
  const f = activeFilters();
  return JOBS.filter((j) => {
    if (f.q && !`${j.label} ${j.pan}`.toLowerCase().includes(f.q)) return false;
    if (f.group && j.group !== f.group) return false;
    if (f.staff && j.staff !== f.staff) return false;
    if (f.state) {
      const level = (STATE.get(j.assesseeId) || {}).level;
      if (f.state === "pending" && level && level !== "info") return false;
      if (f.state === "success" && level !== "success") return false;
      if (f.state === "error" && level !== "error") return false;
      if (f.state === "never" && j.lastSyncedAt) return false;
    }
    return true;
  });
}

function renderRows() {
  const rows = $("rows");
  const list = visibleJobs();
  rows.innerHTML = "";

  if (JOBS.length === 0) {
    rows.innerHTML =
      `<div class="empty">No assessees with a saved portal login yet.<br>` +
      `Press <b>+ Add assessee</b> above to create one from the portal, or add portal credentials in the ProHippo web app and click Reload.</div>`;
    $("selAll").disabled = true;
    updateFilterUI(0);
    return;
  }
  if (list.length === 0) {
    rows.innerHTML = `<div class="empty">No assessee matches this search or filter.</div>`;
    $("selAll").disabled = true;
    updateFilterUI(0);
    return;
  }

  $("selAll").disabled = false;
  for (const j of list) {
    const el = document.createElement("div");
    el.className = "row";
    el.id = "row-" + j.assesseeId;
    el.innerHTML =
      `<label class="cbx"><input type="checkbox" data-id="${escapeAttr(j.assesseeId)}"></label>` +
      `<div class="nm"><div class="name"></div><div class="pan"></div><div class="last"></div></div>` +
      `<div class="prog"><div class="bar-out"><div class="bar-in"></div></div>` +
        `<div class="msg"><span class="pct">—</span> · <span class="txt">idle</span></div></div>` +
      `<span class="pill idle">idle</span>`;
    el.querySelector(".name").textContent = j.label;
    el.querySelector(".pan").textContent = [j.pan, j.group].filter(Boolean).join(" · ");
    paintLastSync(el, j.lastSyncedAt);
    const cb = el.querySelector('input[type="checkbox"]');
    cb.checked = selected.has(j.assesseeId);
    el.classList.toggle("sel", cb.checked);
    rows.appendChild(el);
    // Repaint whatever this row was last showing.
    const st = STATE.get(j.assesseeId);
    if (st) paintRow(el, st);
  }

  rows.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    cb.addEventListener("change", () => {
      const id = cb.dataset.id;
      if (cb.checked) selected.add(id);
      else selected.delete(id);
      $("row-" + id).classList.toggle("sel", cb.checked);
      syncSelectionUI();
    });
  });
  updateFilterUI(list.length);
}

/* "Last sync" on a row, in the words somebody would use.
 *
 * The day is named, not just the date: on a list that syncs by itself, "Tue,
 * 12 Aug, 4:30 pm" answers "did it run overnight?" at a glance, where
 * "12/08/2026 16:30" makes you work it out. Today and yesterday are said
 * outright, because those are the two answers that matter most. */
function lastSyncText(iso) {
  const t = Date.parse(iso || "");
  if (!Number.isFinite(t)) return { text: "Never synced", never: true };
  const d = new Date(t);
  const time = d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  const dayMs = 86400000;
  if (t >= midnight.getTime()) return { text: `Last sync: today, ${time}` };
  if (t >= midnight.getTime() - dayMs) return { text: `Last sync: yesterday, ${time}` };
  const day = d.toLocaleDateString("en-IN", { weekday: "short", day: "2-digit", month: "short" });
  const year = d.getFullYear() === new Date().getFullYear() ? "" : ` ${d.getFullYear()}`;
  return { text: `Last sync: ${day}${year}, ${time}` };
}

function paintLastSync(el, iso) {
  const node = el.querySelector(".last");
  if (!node) return;
  const { text, never } = lastSyncText(iso);
  node.textContent = text;
  node.classList.toggle("never", Boolean(never));
}

function updateFilterUI(shown) {
  const f = activeFilters();
  const filtering = Boolean(f.q || f.group || f.staff || f.state);
  $("clearFilters").classList.toggle("hidden", !filtering);
  $("filterCount").textContent = filtering ? `${shown} of ${JOBS.length} shown` : "";
}

function syncSelectionUI() {
  const n = selected.size;
  const vis = visibleJobs();
  const visIds = new Set(vis.map((j) => j.assesseeId));
  // Selections survive filtering, so say plainly when the button would sync
  // rows that are not on screen — otherwise "Sync selected (12)" over a list of
  // 3 looks like a bug.
  const hidden = [...selected].filter((id) => !visIds.has(id)).length;
  $("selCount").innerHTML = hidden
    ? `${n} selected <span class="filter-note">· ${hidden} hidden by filter</span>`
    : `${n} selected`;
  $("runBtn").disabled = n === 0;
  $("runBtn").textContent = n ? `Sync selected (${n})` : "Sync selected";

  const visSelected = vis.filter((j) => selected.has(j.assesseeId)).length;
  const selAll = $("selAll");
  selAll.checked = vis.length > 0 && visSelected === vis.length;
  selAll.indeterminate = visSelected > 0 && visSelected < vis.length;
}

// Select-all applies to what is on screen — ticking it while a search is active
// must not quietly queue every PAN in the practice.
$("selAll").addEventListener("change", () => {
  const on = $("selAll").checked;
  for (const j of visibleJobs()) {
    if (on) selected.add(j.assesseeId);
    else selected.delete(j.assesseeId);
    const el = $("row-" + j.assesseeId);
    if (el) {
      el.querySelector('input[type="checkbox"]').checked = on;
      el.classList.toggle("sel", on);
    }
  }
  syncSelectionUI();
});

const onFilterChange = () => { renderRows(); syncSelectionUI(); };
$("search").addEventListener("input", onFilterChange);
["fGroup", "fStaff", "fState"].forEach((id) => $(id).addEventListener("change", onFilterChange));
$("clearFilters").addEventListener("click", () => {
  $("search").value = "";
  $("fGroup").value = "";
  $("fStaff").value = "";
  $("fState").value = "";
  onFilterChange();
});

$("reloadBtn").addEventListener("click", async () => {
  $("reloadBtn").disabled = true;
  try { await loadAssessees(); }
  catch (err) { alert(friendly(err)); }
  finally { $("reloadBtn").disabled = false; }
});

// --- Run sync --------------------------------------------------------------
$("runBtn").addEventListener("click", async () => {
  const scope = $("scope").value;
  const headless = $("headless").checked;
  const jobs = JOBS.filter((j) => selected.has(j.assesseeId));
  if (!jobs.length) return;
  setControlsDisabled(true);
  for (const j of jobs) setRow(j.assesseeId, { level: "info", pct: 0, msg: "queued" });
  try {
    const results = await window.connector.runSync(jobs, scope, headless);
    showSyncDone(results, jobs);
  } catch (err) {
    // The whole run failed (no Chrome, signed out mid-run) rather than one PAN.
    showSyncDone(jobs.map((j) => ({ assesseeId: j.assesseeId, ok: false, error: friendly(err) })), jobs);
  } finally {
    setControlsDisabled(false);
  }
});

function setControlsDisabled(on) {
  $("runBtn").disabled = on || selected.size === 0;
  $("reloadBtn").disabled = on;
  // The add form opens its own portal session. Starting one during a sync would
  // put a sixth session on the residential IP, past the cap the whole app is
  // paced around — so the two are mutually exclusive, in both directions.
  $("addBtn").disabled = on;
  $("selAll").disabled = on;
  $("scope").disabled = on;
  document.querySelectorAll('#rows input[type="checkbox"]').forEach((cb) => (cb.disabled = on));
}

// Live per-PAN events from the pool.
window.connector.onSyncEvent((evt) => {
  /* The pool stamps the sync time server-side and tells us what it wrote, so
     the row can say "today, 4:30 pm" the moment it finishes rather than after
     the next Reload. */
  if (evt.phase === "synced") {
    const job = JOBS.find((j) => j.assesseeId === evt.assesseeId);
    if (job) job.lastSyncedAt = evt.message;
    const row = $("row-" + evt.assesseeId);
    if (row) paintLastSync(row, evt.message);
    return;
  }
  // The per-phase timing breakdown isn't a status line — it would be overwritten
  // by "Done" a moment later. Park it on the row as a tooltip and log it, so a
  // slow sync can be diagnosed from a screenshot or the console.
  if (evt.phase === "timing") {
    const st = STATE.get(evt.assesseeId) || {};
    st.title = evt.message;
    STATE.set(evt.assesseeId, st);
    const el = $("row-" + evt.assesseeId);
    if (el) el.title = evt.message;
    console.info(`[sync timing] ${evt.pan || evt.assesseeId}: ${evt.message}`);
    return;
  }
  setRow(evt.assesseeId, { level: evt.level || "info", pct: evt.pct, msg: `${evt.message}` });
});

/* Record a row's progress and paint it if it is on screen. Writing to STATE
   first is what lets a filtered-out row keep its progress. */
function setRow(assesseeId, { level, pct, msg }) {
  const st = STATE.get(assesseeId) || {};
  if (level) st.level = level;
  if (typeof pct === "number") st.pct = pct;
  if (msg) st.msg = msg;
  STATE.set(assesseeId, st);

  const el = $("row-" + assesseeId);
  if (el) paintRow(el, st);
  // A row can be hidden by the "status" filter and then belong in a different
  // bucket a moment later, so the visible set has to be re-evaluated.
  if ($("fState").value) { renderRows(); syncSelectionUI(); }
}

// Paint one row from its recorded state. pct undefined → leave the bar alone.
function paintRow(el, { level, pct, msg, title }) {
  const bar = el.querySelector(".bar-in");
  const pill = el.querySelector(".pill");
  const txt = el.querySelector(".txt");
  const pctEl = el.querySelector(".pct");

  if (typeof pct === "number") {
    bar.style.width = Math.max(0, Math.min(100, pct)) + "%";
    pctEl.textContent = Math.round(pct) + "%";
  }
  bar.classList.toggle("ok", level === "success");
  bar.classList.toggle("err", level === "error");
  if (level === "error") { bar.style.width = "100%"; pctEl.textContent = "—"; }

  if (level) {
    pill.className = "pill " + level;
    pill.textContent = { info: "running", success: "done", warn: "note", error: "error" }[level] || level;
  }
  if (msg) txt.textContent = msg;
  if (title) el.title = title;
}

// --- Sync finished card ----------------------------------------------------
// A run started with "Run hidden" on has no visible browser, and the window is
// usually behind something else by the time it ends. Without this the run just
// stops, and a finished sync is indistinguishable from a stalled one.
let lastFailedIds = [];

function showSyncDone(results, jobs) {
  const byId = new Map(jobs.map((j) => [j.assesseeId, j]));
  const rows = (results || []).map((r) => ({
    ok: r.ok !== false,
    name: (byId.get(r.assesseeId) || {}).label || r.assesseeId,
    error: r.error || "",
  }));
  const failed = rows.filter((r) => !r.ok);
  lastFailedIds = (results || []).filter((r) => r.ok === false).map((r) => r.assesseeId);

  const icon = $("doneIcon");
  icon.className = "doneicon" + (failed.length === rows.length && rows.length ? " err" : failed.length ? " warn" : "");
  icon.textContent = failed.length ? "!" : "✓";

  $("doneTitle").textContent = failed.length ? "Sync finished with problems" : "Sync finished";
  $("doneSub").textContent = failed.length
    ? `${failed.length} of ${rows.length} couldn't be synced. The rest are up to date.`
    : `All ${rows.length} ${rows.length === 1 ? "assessee is" : "assessees are"} up to date.`;

  $("doneStats").innerHTML =
    `<div class="st ok"><div class="n">${rows.length - failed.length}</div><div class="k">Synced</div></div>` +
    (failed.length ? `<div class="st err"><div class="n">${failed.length}</div><div class="k">Failed</div></div>` : "");

  // List the failures only — a wall of green tells nobody anything, and the
  // rows themselves already show each success.
  $("doneList").innerHTML = failed
    .map((r) => `<div class="dl bad"><span class="dot"></span><div class="nm2"><b>${escapeHtml(r.name)}</b><span>${escapeHtml(r.error || "Sync failed")}</span></div></div>`)
    .join("");

  $("doneRetryBtn").classList.toggle("hidden", failed.length === 0);
  $("doneOverlay").classList.remove("hidden");
}

function hideSyncDone() { $("doneOverlay").classList.add("hidden"); }

$("doneCloseBtn").addEventListener("click", hideSyncDone);
$("doneOverlay").addEventListener("click", (e) => { if (e.target === $("doneOverlay")) hideSyncDone(); });
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("doneOverlay").classList.contains("hidden")) hideSyncDone();
});
$("doneRetryBtn").addEventListener("click", () => {
  selected.clear();
  lastFailedIds.forEach((id) => selected.add(id));
  hideSyncDone();
  renderRows();
  syncSelectionUI();
});

// --- Add assessee ----------------------------------------------------------
//
// The whole point of this form: a new practitioner installs the connector, has
// no Chrome extension, and their list is empty. The web app can only create an
// assessee through the extension, so without this there is nothing they can do
// here but sign out. We already drive a real portal login for the sync — this
// borrows it for one PAN, reads the profile, and lets them review it before it
// becomes a record.
//
// The password lives in the form field and in the two invoke() calls. It is
// never written to STATE, never logged, and the field is cleared when the form
// closes.

const ADD_PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const ADD_FIELDS = ["aPan", "aPassword", "aName", "aStatus", "aDob", "aGroup", "aStaff", "aMobile", "aEmail", "aAddress"];
let addBusy = false;      // a portal fetch or a save is in flight
let addCreated = false;   // the record exists; the form is now only reporting
/* The fetched jurisdiction / Assessing Officer block. Held in a variable rather
   than an input because it is the one fetched value with no field of its own —
   it is shown read-only and saved as it came. */
let currentJurisdiction = null;

const addPan = () => $("aPan").value.trim().toUpperCase();

function setFetchMsg(text, kind) {
  const el = $("aFetchMsg");
  el.textContent = text || "";
  el.className = "fetchmsg" + (kind ? " " + kind : "");
}

function syncAddUI() {
  const panOk = ADD_PAN_RE.test(addPan());
  const hasPwd = Boolean($("aPassword").value.trim());
  const consent = $("aConsent").checked;
  $("aFetchBtn").disabled = addBusy || addCreated || !panOk || !hasPwd || !consent;
  $("aFetchBtn").title = addBusy ? "Working…"
    : !panOk ? "Enter a valid PAN first"
      : !hasPwd ? "Enter the e-filing password to fetch"
        : !consent ? "Tick the authorisation box above before signing in to the portal"
          : "Sign in to the portal and read this PAN's details";
  $("aSaveBtn").disabled = addBusy || addCreated || !panOk || !$("aName").value.trim();
  // The label follows the entity type, exactly as the web app's form does — a
  // company has no date of birth.
  $("aDobLabel").textContent = $("aStatus").value === "Individual" ? "Date of birth" : "Date of incorporation";
}

function openAdd() {
  addCreated = false;
  currentJurisdiction = null;
  ADD_FIELDS.forEach((id) => { $(id).value = ""; });
  $("aStatus").value = "Individual";
  $("aConsent").checked = false;
  $("aErr").textContent = "";
  $("aCancelBtn").textContent = "Cancel";
  $("aJurisdiction").classList.add("hidden");
  $("aJurisdiction").textContent = "";
  document.querySelectorAll(".fld.from-portal").forEach((el) => el.classList.remove("from-portal"));
  setFetchMsg("");
  $("addOverlay").classList.remove("hidden");
  syncAddUI();
  $("aPan").focus();
}

function closeAdd() {
  if (addBusy) return; // a portal session is open — closing would orphan it
  $("aPassword").value = "";
  $("addOverlay").classList.add("hidden");
}

function setAddBusy(on, label) {
  addBusy = on;
  $("aFetchBtn").textContent = on && label === "fetch" ? "Fetching…" : "Fetch from portal";
  $("aSaveBtn").textContent = on && label === "save" ? "Saving…" : "Add assessee";
  ADD_FIELDS.forEach((id) => { $(id).disabled = on; });
  $("aConsent").disabled = on;
  $("aCancelBtn").disabled = on;
  $("addCloseBtn").disabled = on;
  // ...and the other direction: no sync may start while this form holds a
  // portal session of its own.
  setControlsDisabled(on);
  syncAddUI();
}

// Fill the form from a fetched profile. Everything stays editable — the portal
// is the starting point, not the last word.
function applyMaster(record, filled) {
  const map = { name: "aName", dob: "aDob", address: "aAddress", email: "aEmail", mobile: "aMobile", status: "aStatus" };
  for (const [key, id] of Object.entries(map)) {
    const v = record[key];
    if (!v) continue;
    $(id).value = v;
    // `status` is derived from the PAN's 4th character rather than fetched, so
    // it never gets the "from portal" tag.
    if (filled.includes(key)) $(id).closest(".fld").classList.add("from-portal");
  }

  const j = record.jurisdiction;
  currentJurisdiction = j && (j.ward || j.aoEmail) ? j : null;
  const box = $("aJurisdiction");
  if (j && (j.ward || j.aoEmail)) {
    const line = [j.ward, j.building, j.area].filter(Boolean).join(" · ");
    box.innerHTML =
      `<b>Jurisdiction / Assessing Officer</b><br>${escapeHtml(line || "—")}` +
      (j.aoEmail ? `<br>AO email: ${escapeHtml(j.aoEmail)}` : "");
    box.classList.remove("hidden");
  } else {
    box.classList.add("hidden");
    box.textContent = "";
  }
  syncAddUI();
}

$("addBtn").addEventListener("click", openAdd);
$("addCloseBtn").addEventListener("click", closeAdd);
$("aCancelBtn").addEventListener("click", closeAdd);
["aPan", "aPassword", "aName"].forEach((id) => $(id).addEventListener("input", syncAddUI));
$("aConsent").addEventListener("change", syncAddUI);
$("aStatus").addEventListener("change", syncAddUI);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("addOverlay").classList.contains("hidden")) closeAdd();
});

// Live progress from the login state machine, so a fetch that takes fifteen
// seconds says which step it is on rather than sitting on "Fetching…".
window.connector.onAssesseeEvent((evt) => {
  if (!addBusy) return;
  setFetchMsg(evt.message, evt.level === "error" ? "bad" : evt.level === "warn" ? "warn" : "");
});

$("aFetchBtn").addEventListener("click", async () => {
  const pan = addPan();
  $("aPan").value = pan;
  $("aErr").textContent = "";
  setAddBusy(true, "fetch");
  setFetchMsg("Starting Chrome…");
  try {
    const { record, filled } = await window.connector.fetchAssesseeMaster({
      pan,
      portalUserId: pan,
      portalPassword: $("aPassword").value,
      // Same choice the sync toolbar offers: someone debugging a login wants to
      // watch it happen.
      headless: $("headless").checked,
    });
    applyMaster(record, filled || []);
    setFetchMsg(
      filled && filled.length
        ? `Filled ${filled.length} field${filled.length === 1 ? "" : "s"} from the portal — review and save.`
        : "Signed in, but the portal returned no profile for this PAN — fill the details in by hand.",
      filled && filled.length ? "ok" : "warn"
    );
  } catch (err) {
    setFetchMsg(friendly(err), "bad");
  } finally {
    setAddBusy(false);
  }
});

$("aSaveBtn").addEventListener("click", async () => {
  const pan = addPan();
  $("aErr").textContent = "";
  setAddBusy(true, "save");
  try {
    const res = await window.connector.createAssessee({
      form: {
        pan,
        portalUserId: pan,
        name: $("aName").value,
        status: $("aStatus").value,
        dob: $("aDob").value,
        group: $("aGroup").value,
        staff: $("aStaff").value,
        mobile: $("aMobile").value,
        email: $("aEmail").value,
        address: $("aAddress").value,
        jurisdiction: currentJurisdiction,
      },
      portalPassword: $("aPassword").value,
      // No password typed, or consent not given, means no stored login. Saving
      // one either way would store a credential nobody authorised.
      saveLogin: $("aConsent").checked && Boolean($("aPassword").value.trim()),
    });

    /* The record is saved by this point, so a list refresh that fails must not
       be reported as a failed save — it is reported as itself, and Reload fixes
       it. */
    let listed = true;
    try { await loadAssessees(); }
    catch { listed = false; }

    if (!res.credSaved) {
      /* The record exists but has no login, so it is NOT in the list this
         window shows (that list is "assessees with a stored portal login").
         Saying "added" and showing nothing would look like a bug, so the form
         stays open and says exactly what happened and what is left to do. */
      addCreated = true;
      setAddBusy(false);
      $("aCancelBtn").textContent = "Close";
      $("aErr").textContent = $("aPassword").value.trim()
        ? `"${res.name}" was created, but its portal login could not be stored (${res.credError || "unknown error"}). It will not appear in this list until a login is saved — add it from the ProHippo web app.`
        : `"${res.name}" was created without a portal login, so it will not appear in this list. Add the login here or in the web app to sync it.`;
      return;
    }

    // Released before closing: closeAdd() refuses to shut a form with a portal
    // session still attributed to it.
    setAddBusy(false);
    // Pre-select it: someone who just added an assessee almost always wants to
    // sync it, and finding it again in a list of hundreds is its own chore.
    if (listed) {
      selected.add(res.id);
      renderRows();
      syncSelectionUI();
    }
    closeAdd();
    toast(
      listed
        ? `${res.name} added — its login is stored, so it can be synced now.`
        : `${res.name} added, but the list couldn't be refreshed just now. Press Reload.`,
      listed ? "ok" : "warn"
    );
  } catch (err) {
    $("aErr").textContent = friendly(err);
  } finally {
    if (!addCreated) setAddBusy(false);
  }
});

// --- Toast -----------------------------------------------------------------
let toastTimer = null;
function toast(message, kind) {
  const el = $("toast");
  el.textContent = message;
  el.className = "toast" + (kind ? " " + kind : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 6000);
}

// --- Automatic sync --------------------------------------------------------
//
// Three switches and a status line. The main process owns the schedule
// (scheduler.js); this only shows what it says and sends changes back.

let autoState = {};

// "in 4h 12m" — a duration reads better than a clock time here, because the
// question is "how long until it looks again", not "at what o'clock".
function untilText(iso) {
  const t = Date.parse(iso || "");
  if (!Number.isFinite(t)) return "";
  const mins = Math.max(0, Math.round((t - Date.now()) / 60000));
  if (mins < 1) return "any moment";
  if (mins < 60) return `in ${mins} min`;
  const h = Math.floor(mins / 60), m = mins % 60;
  return m ? `in ${h}h ${m}m` : `in ${h}h`;
}

const hourLabel = (h) => new Date(2026, 0, 1, Number(h) || 0).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });

function paintAuto(st) {
  autoState = st || {};
  $("autoLaunch").checked = Boolean(autoState.autoLaunch);
  $("autoOnLaunch").checked = Boolean(autoState.syncOnLaunch);
  $("autoEvery").checked = Boolean(autoState.enabled);
  $("autoInterval").value = String(autoState.intervalHours || 6);
  $("autoInterval").disabled = !autoState.enabled;
  // Linux has no supported login-item API, so the switch is hidden rather than
  // shown doing nothing.
  $("autoLaunchWrap").classList.toggle("hidden", autoState.autoLaunchSupported === false);

  const sub = $("autoStatus");
  const last = autoState.lastRunAt ? lastSyncText(autoState.lastRunAt).text.replace("Last sync: ", "") : "";
  const r = autoState.lastResult;
  const outcome = r
    ? (r.error ? ` · last run failed: ${r.error}` : r.failed ? ` · ${r.ok} synced, ${r.failed} failed` : ` · ${r.ok} synced`)
    : "";

  /* WHAT THIS LINE DOES NOT SAY.
   *
   * How the schedule is built — the randomised interval, its spread, the
   * shuffled order, the delay before the first run — is deliberately absent.
   * It is the part of this app that took the most thought to get right, it is
   * on screen in every screenshot a practitioner ever shares, and a competitor
   * reading "about every 6 hours ± 15%, randomised" has been handed the design
   * for free. The user is told what they need: whether it is on, when it last
   * ran, when it will run again.
   */
  if (autoState.running) {
    sub.className = "auto-sub run";
    sub.textContent = "Syncing now — every assessee with a saved portal login.";
  } else if (autoState.launchStartsAt) {
    // The first run is waiting out its start-up delay; saying so beats looking
    // like nothing happened.
    sub.className = "auto-sub on";
    sub.textContent = `Starting the first sync ${untilText(autoState.launchStartsAt)}.`;
  } else if (autoState.enabled) {
    sub.className = "auto-sub on";
    /* The window IS the app on Windows and Linux: closing it quits, and a quit
       app keeps no schedule. Said here rather than left to be discovered by a
       practice that finds nothing synced for a week. */
    const keepOpen = autoState.platform === "darwin" ? "" : " · leave this window open, or the schedule stops with it";
    /* The overnight pause is mentioned only while it is actually in force —
       otherwise "next in 2h 40m" at 3am reads as a schedule ignoring itself. */
    const paused = autoState.inQuietHours ? ` · paused overnight, resuming after ${hourLabel(autoState.quietTo)}` : "";
    sub.textContent = `On · next ${untilText(autoState.nextRunAt)}`
      + paused + (last ? ` · last ran ${last}` : " · not run yet") + outcome + keepOpen;
  } else if (autoState.syncOnLaunch || autoState.autoLaunch) {
    sub.className = "auto-sub";
    sub.textContent = (autoState.autoLaunch ? "Starts with this computer. " : "")
      + (autoState.syncOnLaunch ? "Syncs once when it starts." : "Syncing runs only when you press Sync selected.")
      + (last ? ` Last ran ${last}.` : "");
  } else {
    sub.className = "auto-sub";
    sub.textContent = "Off — syncing runs only when you press Sync selected.";
  }
}

async function pushAuto(patch) {
  try {
    paintAuto(await window.connector.setAutoSync(patch));
  } catch (err) {
    alert(friendly(err));
    // Put the switches back to what is actually true.
    try { paintAuto(await window.connector.getAutoSync()); } catch { /* nothing more to try */ }
  }
}

$("autoLaunch").addEventListener("change", () => pushAuto({ autoLaunch: $("autoLaunch").checked }));
$("autoOnLaunch").addEventListener("change", () => pushAuto({ syncOnLaunch: $("autoOnLaunch").checked }));
$("autoEvery").addEventListener("change", () => pushAuto({ autoSyncEnabled: $("autoEvery").checked }));
$("autoInterval").addEventListener("change", () => pushAuto({ intervalHours: Number($("autoInterval").value) }));

$("autoRunNow").addEventListener("click", async () => {
  $("autoRunNow").disabled = true;
  try { await window.connector.runAllNow(); }
  catch (err) { alert(friendly(err)); }
  finally { $("autoRunNow").disabled = false; }
});

window.connector.onAutoState(paintAuto);

/* --- the practice's OTHER computers -------------------------------------
 *
 * A firm runs this on a laptop and on the server in the corner. Both signed in,
 * both scheduled. When one is syncing, the other must not start — the lock that
 * enforces that lives in Firestore (syncLock.js); this is how the person in
 * front of the second machine finds out why the buttons are asleep. */
let elsewhere = null;

window.connector.onSyncElsewhere((holder) => {
  elsewhere = holder;
  const bar = $("elsewhere");
  if (!holder) {
    bar.classList.add("hidden");
    setControlsDisabled(false);
    // Whatever the other machine just finished, this list should now show.
    refreshRowsAfterRun();
    return;
  }
  bar.textContent = `${holder.text} — this computer will wait, and its own schedule will catch up afterwards.`;
  bar.classList.remove("hidden");
  setControlsDisabled(true);
});

/* Last-sync times, live from Firestore. A run finishing on the server updates
   the partner's laptop without anybody pressing Reload — which is the whole
   point of the times being stored per assessee rather than per machine. */
window.connector.onAssesseesSynced((rows) => {
  let changed = false;
  for (const r of rows || []) {
    const job = JOBS.find((j) => j.assesseeId === r.id);
    if (!job || job.lastSyncedAt === r.lastSyncedAt) continue;
    job.lastSyncedAt = r.lastSyncedAt;
    changed = true;
    const el = $("row-" + r.id);
    if (el) paintLastSync(el, r.lastSyncedAt);
  }
  // A row can be hidden by the "never synced" filter and stop belonging there
  // the moment another machine syncs it.
  if (changed && $("fState").value) { renderRows(); syncSelectionUI(); }
});

/* A sync the WINDOW did not start — the scheduler's — still owns the browser
   and the portal sessions, so the controls have to reflect it. Without this the
   buttons sat enabled through an unattended run and a press produced only "A
   sync is already running." */
window.connector.onSyncBusy((evt) => {
  // ...but never re-enable them while another of the practice's computers is
  // still syncing.
  setControlsDisabled(Boolean(evt.running) || Boolean(elsewhere));
  if (!evt.running) refreshRowsAfterRun();
});

/* An unattended run finished: bring the list's own "last sync" values back from
   Firestore. Selection is preserved — someone may have been part-way through
   picking rows for a manual run when the schedule fired. */
async function refreshRowsAfterRun() {
  const keep = new Set(selected);
  try {
    await loadAssessees();
    keep.forEach((id) => { if (JOBS.some((j) => j.assesseeId === id)) selected.add(id); });
    renderRows();
    syncSelectionUI();
  } catch { /* the list is still readable; Reload will fix it */ }
}

// The status line counts down, so a panel left open does not sit on a stale
// "in 6h" for the rest of the afternoon.
setInterval(() => { if (autoState.enabled && !autoState.running) paintAuto(autoState); }, 60000);

// --- Version + update notice --------------------------------------------------
// Driven by the main process (see updater.js). Windows downloads in the
// background and installs on quit; macOS can't self-update unsigned, so there
// the button just opens the .dmg download.

// The build this device is running. Shown in the header from the moment the
// window opens: a practitioner comparing two machines, or reporting something
// that goes wrong, should not have to hunt for it.
(async () => {
  try {
    const info = await window.connector.appVersion();
    $("appVer").textContent = `v${info.version}`;
    // In dev, or on a build without the updater, the check button would only
    // ever say "unavailable" — so it isn't offered.
    if (!info.packaged) $("checkUpdateBtn").classList.add("hidden");
  } catch {
    $("appVer").classList.add("hidden");
  }
})();

$("checkUpdateBtn").addEventListener("click", async () => {
  $("checkUpdateBtn").disabled = true;
  try { await window.connector.checkForUpdates(); }
  catch { /* the state event says what happened; a thrown invoke is not extra news */ }
  // Left disabled until a state event answers, so the button cannot be pressed
  // twice while a check is in flight. Every path below re-enables it.
});

// The state the bar is currently showing — read by the button handler below,
// because "Restart now" and "Download" are the same button.
let updateState = "idle";

window.connector.onUpdateState((evt) => {
  const bar = $("updateBar");
  const msg = $("updateMsg");
  const btn = $("updateBtn");
  const check = $("checkUpdateBtn");
  const version = evt.version ? ` (${evt.version})` : "";
  updateState = evt.state;

  // Anything other than "checking" is an answer, so the button comes back.
  check.disabled = evt.state === "checking";

  if (evt.state === "checking") {
    msg.textContent = "Checking for a newer version…";
    btn.classList.add("hidden");
    bar.classList.remove("hidden");
    return;
  }
  if (evt.state === "current") {
    msg.textContent = `You're on the latest version${version}.`;
    btn.classList.add("hidden");
    bar.classList.remove("hidden");
    // An answer nobody needs to act on shouldn't sit on screen for the rest of
    // the session.
    setTimeout(() => { if (msg.textContent.startsWith("You're on the latest")) bar.classList.add("hidden"); }, 6000);
    return;
  }
  if (evt.state === "checkFailed" || evt.state === "unavailable") {
    msg.textContent = evt.reason === "dev"
      ? "Updates apply to the installed app, not a development build."
      : "Couldn't check for updates just now. Your sync is unaffected — try again later.";
    btn.textContent = "Open downloads";
    btn.classList.remove("hidden");
    bar.classList.remove("hidden");
    return;
  }
  if (evt.state === "manual") {
    msg.textContent = `A newer version of the Connector is available${version}.`;
    btn.textContent = "Download";
    btn.classList.remove("hidden");
    bar.classList.remove("hidden");
    return;
  }
  if (evt.state === "downloading") {
    const pct = typeof evt.percent === "number" ? ` — ${evt.percent}%` : "";
    msg.textContent = `Downloading update${version}${pct}… you can keep working.`;
    btn.classList.add("hidden");
    bar.classList.remove("hidden");
    return;
  }
  if (evt.state === "ready") {
    msg.textContent = `Update${version} ready — it will install when you quit.`;
    btn.textContent = "Restart now";
    btn.classList.remove("hidden");
    bar.classList.remove("hidden");
    return;
  }
  bar.classList.add("hidden"); // "idle" — already current, or the check failed
});

/* What the bar's button does depends on which state put it there, and only ONE
   state means "an update is downloaded and waiting". Calling install in any of
   the others asks electron-updater to quit and replace the app with a file it
   never downloaded — on Windows that closes the Connector mid-sync and installs
   nothing. Everything except "ready" therefore opens the download page. */
$("updateBtn").addEventListener("click", async () => {
  const btn = $("updateBtn");
  btn.disabled = true;
  try {
    if (updateState === "ready") await window.connector.installUpdate();
    else await window.connector.openDownloadPage();
  } catch { await window.connector.openDownloadPage().catch(() => {}); }
  finally { btn.disabled = false; }
});

function friendly(err) {
  const m = String((err && err.message) || err);
  if (m.includes("network")) return "Network error — check your connection.";
  // The OTP Cloud Functions already return user-friendly messages (expired
  // code, too many attempts, etc.) — surface them as-is, just trimmed.
  return m.replace(/^Error:\s*/, "").replace(/^FirebaseError:\s*/, "");
}
