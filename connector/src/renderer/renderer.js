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
      `Add portal credentials for an assessee in the ProHippo web app, then click Reload.</div>`;
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
      `<div class="nm"><div class="name"></div><div class="pan"></div></div>` +
      `<div class="prog"><div class="bar-out"><div class="bar-in"></div></div>` +
        `<div class="msg"><span class="pct">—</span> · <span class="txt">idle</span></div></div>` +
      `<span class="pill idle">idle</span>`;
    el.querySelector(".name").textContent = j.label;
    el.querySelector(".pan").textContent = [j.pan, j.group].filter(Boolean).join(" · ");
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
  $("selAll").disabled = on;
  $("scope").disabled = on;
  document.querySelectorAll('#rows input[type="checkbox"]').forEach((cb) => (cb.disabled = on));
}

// Live per-PAN events from the pool.
window.connector.onSyncEvent((evt) => {
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

// --- Update notice ------------------------------------------------------------
// Driven by the main process (see updater.js). Windows downloads in the
// background and installs on quit; macOS can't self-update unsigned, so there
// the button just opens the .dmg download.
window.connector.onUpdateState((evt) => {
  const bar = $("updateBar");
  const msg = $("updateMsg");
  const btn = $("updateBtn");
  const version = evt.version ? ` (${evt.version})` : "";

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

$("updateBtn").addEventListener("click", async () => {
  $("updateBtn").disabled = true;
  try { await window.connector.installUpdate(); }
  catch { await window.connector.openDownloadPage().catch(() => {}); }
  finally { $("updateBtn").disabled = false; }
});

function friendly(err) {
  const m = String((err && err.message) || err);
  if (m.includes("network")) return "Network error — check your connection.";
  // The OTP Cloud Functions already return user-friendly messages (expired
  // code, too many attempts, etc.) — surface them as-is, just trimmed.
  return m.replace(/^Error:\s*/, "").replace(/^FirebaseError:\s*/, "");
}
