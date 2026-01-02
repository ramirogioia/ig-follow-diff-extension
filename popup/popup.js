const $ = (id) => document.getElementById(id);

const statusText = $("statusText");
const scanBtn = $("scanBtn");
const stopBtn = $("stopBtn");

const progressLabel = $("progressLabel");
const progressPct = $("progressPct");
const barFill = $("barFill");

const countNoMeSiguen = $("countNoMeSiguen");
const countNoSigoYo = $("countNoSigoYo");
const noMeSiguenList = $("noMeSiguenList");
const listTitle = $("listTitle");
const chipNoMeSiguen = $("chip-noMeSiguen");
const chipNoSigoYo = $("chip-noSigoYo");

const refreshBtn = $("refreshBtn");
const copyBtn = $("copyBtn");
const clearBtn = $("clearBtn");

const logsBox = $("logsBox");
const logsCopyBtn = $("logsCopyBtn");
const logsClearBtn = $("logsClearBtn");

const closeWorkerBtn = $("closeWorkerBtn");

let currentState = null;
let currentListType = "noMeSiguen"; // noMeSiguen | noSigoYo

function fmtLine(l) {
  const d = l.data ? "  " + JSON.stringify(l.data) : "";
  return `${l.ts}  ${l.level.padEnd(5)}  ${String(l.scope || "").padEnd(8)}  ${l.msg}${d}`;
}

async function getState() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "GET_STATE" }, (res) => resolve(res?.state || null));
  });
}

async function getLogs() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "GET_LOGS" }, (res) => resolve(res?.logs || []));
  });
}

function setProgressUI(st) {
  const p = st?.progress || { phase: "", loaded: 0, total: 0, percent: 0 };
  const label = st?.text || "—";

  progressLabel.textContent = label;
  progressPct.textContent = `${p.percent || 0}%`;
  barFill.style.width = `${p.percent || 0}%`;
}

function setStatusUI(st) {
  const s = st?.status || "idle";
  const txt = st?.text || (s === "idle" ? "Ready" : s);
  statusText.textContent = txt;

  const running = s === "running";

  scanBtn.disabled = running;
  stopBtn.disabled = !running;
}

function renderReport(st) {
  const r = st?.lastResult;
  const noMeSiguen = r?.noMeSiguen || [];
  const noSigoYo = r?.noSigoYo || [];
  const hint = $("hint");

  if (hint) {
    hint.style.display = r ? "none" : "block";
  }

  countNoMeSiguen.textContent = String(noMeSiguen.length);
  countNoSigoYo.textContent = String(noSigoYo.length);

  noMeSiguenList.innerHTML = "";

  const list = currentListType === "noSigoYo" ? noSigoYo : noMeSiguen;
  const titleText = currentListType === "noSigoYo" ? "They follow, I don’t" : "They don’t follow me";
  if (listTitle) listTitle.textContent = titleText;

  if (!list.length) {
    const empty = document.createElement("div");
    empty.className = "hint";
    empty.textContent = "No results yet. Click Scan. The report is shown here in the popup.";
    noMeSiguenList.appendChild(empty);
    return;
  }

  for (const u of list) {
    const row = document.createElement("div");
    row.className = "item";

    const left = document.createElement("div");
    left.className = "user";
    const uname = document.createElement("div");
    uname.className = "u";
    uname.textContent = `@${u}`;
    const link = document.createElement("div");
    link.className = "link";
    link.textContent = `instagram.com/${u}`;
    left.appendChild(uname);
    left.appendChild(link);

    const right = document.createElement("div");
    right.className = "right";

    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = "Ready";

    const open = document.createElement("button");
    open.className = "btn small";
    open.textContent = "Open";
    open.addEventListener("click", () => {
      chrome.tabs.create({ url: `https://www.instagram.com/${u}/` });
    });

    right.appendChild(badge);
    right.appendChild(open);

    row.appendChild(left);
    row.appendChild(right);
    noMeSiguenList.appendChild(row);
  }
}

async function renderLogs() {
  const logs = await getLogs();
  logsBox.textContent = logs.map(fmtLine).join("\n");
}

async function refreshAll() {
  const st = await getState();
  currentState = st;
  setStatusUI(st);
  setProgressUI(st);
  renderReport(st);
  await renderLogs();
}

function setupTabs() {
  const tabs = document.querySelectorAll(".tab");
  tabs.forEach((t) => {
    t.addEventListener("click", () => {
      tabs.forEach((x) => x.classList.remove("active"));
      t.classList.add("active");
      const id = t.dataset.tab;
      document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
      document.getElementById(id).classList.add("active");
    });
  });
}

function setupChips() {
  const activate = (type) => {
    currentListType = type;
    if (chipNoMeSiguen) chipNoMeSiguen.classList.toggle("active", type === "noMeSiguen");
    if (chipNoSigoYo) chipNoSigoYo.classList.toggle("active", type === "noSigoYo");
    renderReport(currentState);
  };
  if (chipNoMeSiguen) {
    chipNoMeSiguen.addEventListener("click", () => activate("noMeSiguen"));
  }
  if (chipNoSigoYo) {
    chipNoSigoYo.addEventListener("click", () => activate("noSigoYo"));
  }
  activate("noMeSiguen");
}

scanBtn.addEventListener("click", async () => {
  await new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: "BG_SCAN_START_DOCKED" }, (res) => {
      if (res?.ok) resolve(true);
      else reject(new Error(res?.error || "Error"));
    });
  });
  // popup se cerrará si cambia el foco: aceptado por vos.
});

stopBtn.addEventListener("click", async () => {
  await new Promise((resolve) => chrome.runtime.sendMessage({ type: "BG_STOP" }, () => resolve(true)));
  await refreshAll();
});

refreshBtn.addEventListener("click", refreshAll);

copyBtn.addEventListener("click", async () => {
  const st = await getState();
  const r = st?.lastResult;
  const text = JSON.stringify(r || {}, null, 2);
  await navigator.clipboard.writeText(text);
});

clearBtn.addEventListener("click", async () => {
  // limpia resultados y logs
  await chrome.storage.local.set({
    IGFD_STATE: { ...(currentState || {}), lastResult: null, text: "", status: "idle" }
  });
  await refreshAll();
});

logsCopyBtn.addEventListener("click", async () => {
  const logs = await getLogs();
  await navigator.clipboard.writeText(logs.map(fmtLine).join("\n"));
});

logsClearBtn.addEventListener("click", async () => {
  await new Promise((resolve) => chrome.runtime.sendMessage({ type: "CLEAR_LOGS" }, () => resolve(true)));
  await renderLogs();
});

closeWorkerBtn.addEventListener("click", async () => {
  await new Promise((resolve) => chrome.runtime.sendMessage({ type: "BG_CLEAR_WORKER" }, () => resolve(true)));
  await refreshAll();
});

setupTabs();
setupChips();
refreshAll();

// auto-refresh mientras está abierto
setInterval(refreshAll, 900);
