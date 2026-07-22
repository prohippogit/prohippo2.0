// Renderer — thin UI over the `connector` preload bridge. No Node, no Firebase,
// no credentials here; it only invokes the bridge and renders progress.
"use strict";

const $ = (id) => document.getElementById(id);

// --- Sign in ---------------------------------------------------------------
$("signinBtn").addEventListener("click", async () => {
  const email = $("email").value.trim();
  const password = $("password").value;
  $("signinErr").textContent = "";
  $("signinBtn").disabled = true;
  try {
    const user = await window.connector.signIn(email, password);
    $("who").textContent = user.email;
    $("signinCard").classList.add("hidden");
    $("syncCard").classList.remove("hidden");
    await loadAssessees();
  } catch (err) {
    $("signinErr").textContent = friendly(err);
  } finally {
    $("signinBtn").disabled = false;
  }
});

// --- Load PANs -------------------------------------------------------------
// Placeholder cards until assessees:list is wired to the backend.
let JOBS = [];
async function loadAssessees() {
  const list = await window.connector.listAssessees();
  JOBS = (list || []).map((a) => ({
    assesseeId: a.id,
    pan: a.pan || a.portalUserId,
    label: a.name || a.pan,
    knowns: a.knowns || {},
  }));
  renderBoard();
}

function renderBoard() {
  const board = $("board");
  board.innerHTML = "";
  if (JOBS.length === 0) {
    board.innerHTML =
      `<div class="empty">No assessees with a saved portal login yet. ` +
      `Add portal credentials for an assessee in the ProHippo web app, then reload.</div>`;
    $("runBtn").disabled = true;
    return;
  }
  $("runBtn").disabled = false;
  for (const j of JOBS) {
    const el = document.createElement("div");
    el.className = "pan";
    el.id = "pan-" + j.assesseeId;
    el.innerHTML =
      `<div class="h"><span class="name"></span><span class="pill info">idle</span></div>` +
      `<div class="msg"></div>`;
    el.querySelector(".name").textContent = j.label;
    board.appendChild(el);
  }
}

$("reloadBtn").addEventListener("click", async () => {
  $("reloadBtn").disabled = true;
  try {
    await loadAssessees();
  } catch (err) {
    alert(friendly(err));
  } finally {
    $("reloadBtn").disabled = false;
  }
});

// --- Run sync --------------------------------------------------------------
$("runBtn").addEventListener("click", async () => {
  const scope = $("scope").value;
  const headless = $("headless").checked;
  $("runBtn").disabled = true;
  try {
    // Reset board state.
    for (const j of JOBS) setPan(j.assesseeId, "info", "queued", true);
    await window.connector.runSync(JOBS, scope, headless);
  } catch (err) {
    alert(friendly(err));
  } finally {
    $("runBtn").disabled = false;
  }
});

// Live per-PAN events from the pool.
window.connector.onSyncEvent((evt) => {
  const level = evt.level || "info";
  setPan(evt.assesseeId, level, `${evt.phase}: ${evt.message}`);
});

function setPan(assesseeId, level, message, replace) {
  const el = $("pan-" + assesseeId);
  if (!el) return;
  const pill = el.querySelector(".pill");
  pill.className = "pill " + level;
  pill.textContent = { info: "running", success: "done", warn: "todo", error: "error" }[level] || level;
  const msg = el.querySelector(".msg");
  const line = document.createElement("div");
  line.textContent = message;
  if (replace) msg.innerHTML = "";
  msg.appendChild(line);
  msg.scrollTop = msg.scrollHeight;
}

function friendly(err) {
  const m = String((err && err.message) || err);
  if (m.includes("auth/invalid-credential") || m.includes("auth/wrong-password"))
    return "Wrong email or password.";
  if (m.includes("auth/user-not-found")) return "No such account.";
  if (m.includes("network")) return "Network error — check your connection.";
  return m.replace(/^Error:\s*/, "");
}
