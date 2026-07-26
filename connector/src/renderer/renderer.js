// Renderer — thin UI over the `connector` preload bridge. No Node, no Firebase,
// no credentials here; it only invokes the bridge and renders progress.
"use strict";

const $ = (id) => document.getElementById(id);

// --- Sign in ---------------------------------------------------------------
async function afterSignIn(user) {
  $("who").textContent = user.email;
  $("signinCard").classList.add("hidden");
  $("syncCard").classList.remove("hidden");
  await loadAssessees();
}

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

// --- Email OTP (passwordless, same flow as the web app) --------------------
let otpEmail = "";
let resendTimer = null;

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
  const email = $("email").value.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    $("signinErr").textContent = "Enter a valid email address.";
    return;
  }
  $("signinErr").textContent = "";
  $("sendCodeBtn").disabled = true;
  $("sendCodeBtn").textContent = "Sending…";
  try {
    const res = await window.connector.requestOtp(email);
    otpEmail = email;
    $("otpEmail").textContent = email;
    $("otpRequest").classList.add("hidden");
    $("otpVerify").classList.remove("hidden");
    $("code").value = "";
    $("code").focus();
    startResendCooldown((res && res.cooldownSeconds) || 30);
  } catch (err) {
    $("signinErr").textContent = friendly(err);
  } finally {
    $("sendCodeBtn").disabled = false;
    $("sendCodeBtn").textContent = "Email me a code";
  }
}

async function verifyCode() {
  const code = $("code").value.replace(/\D/g, "");
  if (code.length !== 6) {
    $("signinErr").textContent = "Enter the 6-digit code we emailed you.";
    return;
  }
  $("signinErr").textContent = "";
  $("verifyBtn").disabled = true;
  $("verifyBtn").textContent = "Verifying…";
  try {
    const user = await window.connector.verifyOtp(otpEmail, code);
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
$("changeEmailBtn").addEventListener("click", () => {
  clearInterval(resendTimer);
  $("otpVerify").classList.add("hidden");
  $("otpRequest").classList.remove("hidden");
  $("signinErr").textContent = "";
  $("email").focus();
});
$("email").addEventListener("keydown", (e) => { if (e.key === "Enter") sendCode(); });
$("code").addEventListener("keydown", (e) => { if (e.key === "Enter") verifyCode(); });
$("code").addEventListener("input", () => {
  if ($("code").value.replace(/\D/g, "").length === 6) verifyCode();
});

// --- Assessees + selection -------------------------------------------------
let JOBS = [];
const selected = new Set();

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
  }));
  selected.clear();
  renderRows();
  syncSelectionUI();
}

function renderRows() {
  const rows = $("rows");
  rows.innerHTML = "";
  if (JOBS.length === 0) {
    rows.innerHTML =
      `<div class="empty">No assessees with a saved portal login yet.<br>` +
      `Add portal credentials for an assessee in the ProHippo web app, then click Reload.</div>`;
    $("selAll").disabled = true;
    return;
  }
  $("selAll").disabled = false;
  for (const j of JOBS) {
    const el = document.createElement("div");
    el.className = "row";
    el.id = "row-" + j.assesseeId;
    el.innerHTML =
      `<label class="cbx"><input type="checkbox" data-id="${j.assesseeId}"></label>` +
      `<div class="nm"><div class="name"></div><div class="pan"></div></div>` +
      `<div class="prog"><div class="bar-out"><div class="bar-in"></div></div>` +
        `<div class="msg"><span class="pct">—</span> · <span class="txt">idle</span></div></div>` +
      `<span class="pill idle">idle</span>`;
    el.querySelector(".name").textContent = j.label;
    el.querySelector(".pan").textContent = j.pan || "";
    rows.appendChild(el);
  }
  // Wire per-row checkboxes.
  rows.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    cb.addEventListener("change", () => {
      const id = cb.dataset.id;
      if (cb.checked) selected.add(id);
      else selected.delete(id);
      $("row-" + id).classList.toggle("sel", cb.checked);
      syncSelectionUI();
    });
  });
}

function syncSelectionUI() {
  const n = selected.size;
  $("selCount").textContent = `${n} selected`;
  $("runBtn").disabled = n === 0;
  $("runBtn").textContent = n ? `Sync selected (${n})` : "Sync selected";
  const all = JOBS.length > 0 && n === JOBS.length;
  const some = n > 0 && n < JOBS.length;
  const selAll = $("selAll");
  selAll.checked = all;
  selAll.indeterminate = some;
}

$("selAll").addEventListener("change", () => {
  const on = $("selAll").checked;
  selected.clear();
  document.querySelectorAll('#rows input[type="checkbox"]').forEach((cb) => {
    cb.checked = on;
    $("row-" + cb.dataset.id).classList.toggle("sel", on);
    if (on) selected.add(cb.dataset.id);
  });
  syncSelectionUI();
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
    await window.connector.runSync(jobs, scope, headless);
  } catch (err) {
    alert(friendly(err));
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
    const el = $("row-" + evt.assesseeId);
    if (el) el.title = evt.message;
    console.info(`[sync timing] ${evt.pan || evt.assesseeId}: ${evt.message}`);
    return;
  }
  setRow(evt.assesseeId, { level: evt.level || "info", pct: evt.pct, msg: `${evt.message}` });
});

// Update one row's bar + pill + message. pct undefined → keep current width.
function setRow(assesseeId, { level, pct, msg }) {
  const el = $("row-" + assesseeId);
  if (!el) return;
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

  pill.className = "pill " + level;
  pill.textContent = { info: "running", success: "done", warn: "note", error: "error" }[level] || level;
  if (msg) txt.textContent = msg;
}

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
