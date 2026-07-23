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

$("signinBtn").addEventListener("click", async () => {
  const email = $("email").value.trim();
  const password = $("password").value;
  $("signinErr").textContent = "";
  $("signinBtn").disabled = true;
  try {
    const user = await window.connector.signIn(email, password);
    await afterSignIn(user);
  } catch (err) {
    $("signinErr").textContent = friendly(err);
  } finally {
    $("signinBtn").disabled = false;
  }
});

// --- Assessees + selection -------------------------------------------------
let JOBS = [];
const selected = new Set();

async function loadAssessees() {
  const list = await window.connector.listAssessees();
  JOBS = (list || []).map((a) => ({
    assesseeId: a.id,
    pan: a.pan || a.portalUserId,
    label: a.name || a.pan,
    knowns: a.knowns || {},
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

function friendly(err) {
  const m = String((err && err.message) || err);
  if (m.includes("auth/invalid-credential") || m.includes("auth/wrong-password"))
    return "Wrong email or password. If you use Google to sign in to ProHippo, use the “Sign in with Google” button above.";
  if (m.includes("auth/user-not-found")) return "No such account. If you sign in with Google, use the Google button above.";
  if (m.includes("network")) return "Network error — check your connection.";
  return m.replace(/^Error:\s*/, "");
}
