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
    pan: a.pan,
    label: a.name || a.pan,
    knowns: a.knowns || {},
  }));
  if (JOBS.length === 0) {
    // demo placeholders so the board isn't empty in the scaffold
    JOBS = [
      { assesseeId: "demo-1", pan: "ABCDE1234F", label: "Sample Assessee 1", knowns: {} },
      { assesseeId: "demo-2", pan: "PQRSX6789L", label: "Sample Assessee 2", knowns: {} },
    ];
  }
  renderBoard();
}

function renderBoard() {
  const board = $("board");
  board.innerHTML = "";
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
