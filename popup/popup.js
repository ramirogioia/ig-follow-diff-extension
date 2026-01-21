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

const copyBtn = $("copyBtn");
const downloadBtn = $("downloadBtn");
const clearBtn = $("clearBtn");

const closeWorkerBtn = $("closeWorkerBtn");
const workerWarning = $("workerWarning");
const workerWarningText = $("workerWarningText");
const cooldownWarning = $("cooldownWarning");
const cooldownCounter = $("cooldownCounter");
const cooldownText = $("cooldownText");

let currentState = null;
let currentListType = "noMeSiguen"; // noMeSiguen | noSigoYo
let cachedResults = { noMeSiguen: [], noSigoYo: [] };
let copyHintTimer = null;
let unfollowStatuses = {}; // { username: "working" | "done" | "error" }
let localUnfollowLock = false; // bloquea clicks mientras se dispara unfollow
const unfollowedLocally = new Set(); // usuarios removidos tras unfollow exitoso en esta sesión
let followStatuses = {}; // { username: "working" | "done" | "error" }
let localFollowLock = false;
const followedLocally = new Set(); // usuarios marcados como seguidos en esta sesión
let popupState = {
  tab: "noMeSiguen",
  scrolls: { noMeSiguen: 0, noSigoYo: 0 },
};

// Contador y cooldown de acciones
let actionCount = 0; // Contador de FOLLOW/UNFOLLOW
let cooldownActive = false;
let cooldownTimer = null;
let cooldownEndTime = null;
const ACTION_LIMIT = 17;
const COOLDOWN_DURATION_MS = (3 * 60 + 45) * 1000; // 3 minutos 45 segundos
const STORAGE_KEY_COOLDOWN = "IGFD_COOLDOWN_STATE";

const STORAGE_KEY_EXCLUDED = "IGFD_EXCLUDED_USERS";

async function saveExcludedUsers() {
  await chrome.storage.local.set({
    [STORAGE_KEY_EXCLUDED]: {
      unfollowed: Array.from(unfollowedLocally),
      followed: Array.from(followedLocally),
    }
  });
}

async function loadExcludedUsers() {
  const res = await new Promise((resolve) =>
    chrome.storage.local.get({ [STORAGE_KEY_EXCLUDED]: { unfollowed: [], followed: [] } }, (r) =>
      resolve(r[STORAGE_KEY_EXCLUDED] || { unfollowed: [], followed: [] })
    )
  );
  
  unfollowedLocally.clear();
  followedLocally.clear();
  
  if (Array.isArray(res.unfollowed)) {
    res.unfollowed.forEach((u) => unfollowedLocally.add(String(u).toLowerCase()));
  }
  if (Array.isArray(res.followed)) {
    res.followed.forEach((u) => followedLocally.add(String(u).toLowerCase()));
  }
}

async function clearExcludedUsers() {
  unfollowedLocally.clear();
  followedLocally.clear();
  await chrome.storage.local.remove(STORAGE_KEY_EXCLUDED);
}

function savePopupState(partial = {}) {
  popupState = {
    ...popupState,
    ...partial,
    scrolls: { ...popupState.scrolls, ...(partial.scrolls || {}) },
  };
  chrome.storage.local.set({ IGFD_POPUP_STATE: popupState });
}

async function loadPopupState() {
  const res = await new Promise((resolve) =>
    chrome.storage.local.get({ IGFD_POPUP_STATE: popupState }, (r) => resolve(r?.IGFD_POPUP_STATE || popupState))
  );
  popupState = {
    tab: res.tab || "noMeSiguen",
    scrolls: {
      noMeSiguen: res.scrolls?.noMeSiguen || 0,
      noSigoYo: res.scrolls?.noSigoYo || 0,
    },
  };
  currentListType = popupState.tab;
}

function applyScrollFromState() {
  if (!noMeSiguenList) return;
  const target = popupState.scrolls[currentListType] || 0;
  noMeSiguenList.scrollTop = target;
}

function fmtLine(l) {
  const d = l.data ? "  " + JSON.stringify(l.data) : "";
  return `${l.ts}  ${l.level.padEnd(5)}  ${String(l.scope || "").padEnd(8)}  ${l.msg}${d}`;
}

async function getState() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "GET_STATE" }, (res) => {
      if (chrome.runtime.lastError) {
        console.error("[IGFD] getState error:", chrome.runtime.lastError);
        // Si hay error, retornar estado vacío en lugar de null
        resolve({
          status: "idle",
          text: "",
          progress: { phase: "", loaded: 0, total: 0, percent: 0 },
          lastResult: null,
          workerAvailable: false,
          workerReason: "Service worker not available. Please reload the extension.",
        });
      } else {
        resolve(res?.state || null);
      }
    });
  });
}

async function getLogs() {
  // Intenta pedirle al service worker. Si falla (worker descargado),
  // hace fallback directo al storage local.
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      chrome.storage.local.get({ IGFD_LOGS: [] }, (res) => resolve(res.IGFD_LOGS || []));
    }, 1500);

    chrome.runtime.sendMessage({ type: "GET_LOGS" }, (res) => {
      if (done) return;
      clearTimeout(timer);
      done = true;
      resolve(res?.logs || []);
    });
  });
}

function setProgressUI(st) {
  const p = st?.progress || { phase: "", loaded: 0, total: 0, percent: 0 };
  const label = st?.text || "—";

  progressLabel.textContent = label;
  progressPct.textContent = `${p.percent || 0}%`;
  barFill.style.width = `${p.percent || 0}%`;
}

async function saveCooldownState() {
  await chrome.storage.local.set({
    [STORAGE_KEY_COOLDOWN]: {
      actionCount,
      cooldownActive,
      cooldownEndTime,
    }
  });
}

async function loadCooldownState() {
  const res = await new Promise((resolve) =>
    chrome.storage.local.get({ [STORAGE_KEY_COOLDOWN]: { actionCount: 0, cooldownActive: false, cooldownEndTime: null } }, (r) =>
      resolve(r[STORAGE_KEY_COOLDOWN] || { actionCount: 0, cooldownActive: false, cooldownEndTime: null })
    )
  );
  
  actionCount = res.actionCount || 0;
  cooldownEndTime = res.cooldownEndTime || null;
  
  // Verificar si el cooldown ya expiró
  if (cooldownEndTime && cooldownEndTime > Date.now()) {
    cooldownActive = true;
    // Restaurar cooldown activo
    if (cooldownWarning) {
      cooldownWarning.style.display = "flex";
    }
    updateCooldownCounter();
    cooldownTimer = setInterval(updateCooldownCounter, 1000);
    
    // Calcular tiempo restante y programar fin del cooldown
    const remaining = cooldownEndTime - Date.now();
    setTimeout(() => {
      endCooldown();
    }, remaining);
  } else {
    // El cooldown ya expiró, limpiar estado
    actionCount = 0;
    cooldownActive = false;
    cooldownEndTime = null;
    await saveCooldownState();
  }
}

function startCooldown() {
  if (cooldownActive) return;
  
  cooldownActive = true;
  cooldownEndTime = Date.now() + COOLDOWN_DURATION_MS;
  
  // Guardar estado en storage
  saveCooldownState();
  
  // Mostrar banner de cooldown
  if (cooldownWarning) {
    cooldownWarning.style.display = "flex";
  }
  
  // Actualizar contador cada segundo
  updateCooldownCounter();
  cooldownTimer = setInterval(updateCooldownCounter, 1000);
  
  // Desbloquear después del cooldown
  setTimeout(() => {
    endCooldown();
  }, COOLDOWN_DURATION_MS);
  
  // Forzar refresh para deshabilitar botones
  refreshAll();
}

function updateCooldownCounter() {
  if (!cooldownActive || !cooldownEndTime || !cooldownCounter) return;
  
  const now = Date.now();
  const remaining = Math.max(0, cooldownEndTime - now);
  
  if (remaining <= 0) {
    endCooldown();
    return;
  }
  
  const minutes = Math.floor(remaining / 60000);
  const seconds = Math.floor((remaining % 60000) / 1000);
  const formatted = `${minutes}:${seconds.toString().padStart(2, "0")}`;
  
  cooldownCounter.textContent = formatted;
}

async function endCooldown() {
  if (!cooldownActive) return;
  
  cooldownActive = false;
  actionCount = 0; // Resetear contador
  cooldownEndTime = null;
  
  // Guardar estado en storage
  await saveCooldownState();
  
  if (cooldownTimer) {
    clearInterval(cooldownTimer);
    cooldownTimer = null;
  }
  
  if (cooldownWarning) {
    cooldownWarning.style.display = "none";
  }
  
  // Forzar refresh para habilitar botones
  refreshAll();
}

function setStatusUI(st) {
  const s = st?.status || "idle";
  const txt = st?.text || (s === "idle" ? "Ready" : s);
  statusText.textContent = txt;

  const running = s === "running" || s === "unfollowing" || Boolean(st?.unfollow?.running);
  const workerOpen = Boolean(st?.workerWindowId);

  scanBtn.textContent = workerOpen ? "Close" : "Scan";
  scanBtn.dataset.mode = workerOpen ? "close" : "scan";

  stopBtn.disabled = !running;
}

function renderReport(st) {
  const r = st?.lastResult;
  const noMeSiguen = (r?.noMeSiguen || []).filter((u) => !unfollowedLocally.has(u.toLowerCase()));
  const noSigoYo = (r?.noSigoYo || []).filter((u) => !followedLocally.has(u.toLowerCase()));
  const unfollowState = st?.unfollow || { running: false, username: null };
  const followState = st?.follow || { running: false, username: null };
  const hint = $("hint");

  // Verificar estado del worker
  const workerAvailable = st?.workerAvailable !== false; // Por defecto true si no está definido
  const workerReason = st?.workerReason || null;

  if (hint) {
    hint.style.display = r ? "none" : "block";
  }

  // Mostrar/ocultar aviso del worker
  if (workerWarning && workerWarningText) {
    if (!workerAvailable && r) {
      workerWarning.style.display = "flex";
      workerWarningText.textContent = workerReason || "Worker window not available. Please run a scan or restore the worker window.";
    } else {
      workerWarning.style.display = "none";
    }
  }

  cachedResults = { noMeSiguen, noSigoYo };

  countNoMeSiguen.textContent = String(noMeSiguen.length);
  countNoSigoYo.textContent = String(noSigoYo.length);

  noMeSiguenList.innerHTML = "";

  const list = currentListType === "noSigoYo" ? noSigoYo : noMeSiguen;
  const titleText = currentListType === "noSigoYo" ? "I don’t follow" : "Don’t follow me";
  if (listTitle) listTitle.textContent = titleText;

  if (!list.length) {
    const empty = document.createElement("div");
    empty.className = "hint";
    empty.textContent = "No results to show. Click Scan to generate the report. Or you may already follow only people who follow you back.";
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

    const actionBtn = document.createElement("button");
    const isUnfollowMode = currentListType !== "noSigoYo";
    const statusMap = isUnfollowMode ? unfollowStatuses : followStatuses;
    const localLock = isUnfollowMode ? () => localUnfollowLock : () => localFollowLock;
    const setLocalLock = isUnfollowMode ? (v) => (localUnfollowLock = v) : (v) => (localFollowLock = v);
    actionBtn.className = "btn small " + (isUnfollowMode ? "danger" : "primary");
    const status = statusMap[u] || null;
    const isThisRunning = isUnfollowMode
      ? unfollowState.running && unfollowState.username === u
      : followState.running && followState.username === u;
    const globalRunning = (isUnfollowMode ? localUnfollowLock : localFollowLock) || Boolean(unfollowState.running || followState.running);
    const isWorking = status === "working" || isThisRunning;
    const isDone = status === "done";
    const isError = status === "error";
    const baseLabel = isUnfollowMode ? "Unfollow" : "Follow";
    const doneLabel = isUnfollowMode ? "Unfollowed" : "Followed";
    const workingLabel = isUnfollowMode ? "Working..." : "Following...";
    actionBtn.textContent = isDone ? doneLabel : isWorking ? workingLabel : isError ? "Error" : baseLabel;
    // Deshabilitar botón si el worker no está disponible, está en cooldown (además de las otras condiciones)
    actionBtn.disabled = isWorking || isDone || globalRunning || !workerAvailable || cooldownActive;
    actionBtn.addEventListener("click", async () => {
      console.log("[IGFD] Action click", { mode: isUnfollowMode ? "UNFOLLOW" : "FOLLOW", username: u });
      setLocalLock(true);
      statusMap[u] = "working";
      actionBtn.disabled = true;
      actionBtn.textContent = workingLabel;
      const type = isUnfollowMode ? "UNFOLLOW" : "FOLLOW";
      const res = await new Promise((resolve) =>
        chrome.runtime.sendMessage({ type, username: u }, (r) => resolve(r))
      );
      console.log("[IGFD] Action response", { username: u, mode: type, res });
      if (res?.ok) {
        statusMap[u] = "done";
        actionBtn.textContent = doneLabel;
        actionBtn.disabled = true;
        // Agregar a la lista de excluidos y persistir
        if (isUnfollowMode) {
          unfollowedLocally.add(u.toLowerCase());
        } else {
          followedLocally.add(u.toLowerCase());
        }
        await saveExcludedUsers(); // Persistir cambios inmediatamente
        
        // Incrementar contador de acciones y verificar si necesita cooldown
        actionCount++;
        await saveCooldownState(); // Guardar contador persistente
        if (actionCount >= ACTION_LIMIT && !cooldownActive) {
          startCooldown();
        }
      } else {
        statusMap[u] = "error";
        actionBtn.textContent = "Error";
        actionBtn.disabled = false; // permitir reintento
      }
      setLocalLock(false);
      await refreshAll();
    });

    const open = document.createElement("button");
    open.className = "btn small";
    open.textContent = "Open";
    open.addEventListener("click", () => {
      chrome.tabs.create({ url: `https://www.instagram.com/${u}/` });
    });

    right.appendChild(actionBtn);
    right.appendChild(open);

    row.appendChild(left);
    row.appendChild(right);
    noMeSiguenList.appendChild(row);
  }

  if (!noMeSiguenList.dataset.scrollHandler) {
    noMeSiguenList.addEventListener("scroll", () => {
      popupState.scrolls[currentListType] = noMeSiguenList.scrollTop;
      savePopupState({ scrolls: popupState.scrolls });
    });
    noMeSiguenList.dataset.scrollHandler = "1";
  }

  applyScrollFromState();
}

async function renderLogs() {
  // Logs ocultos
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
      if (id === "logs") {
        renderLogs();
      }
    });
  });
}

function setupChips() {
  const activate = (type) => {
    currentListType = type;
    if (chipNoMeSiguen) chipNoMeSiguen.classList.toggle("active", type === "noMeSiguen");
    if (chipNoSigoYo) chipNoSigoYo.classList.toggle("active", type === "noSigoYo");
    renderReport(currentState);
    savePopupState({ tab: currentListType, scrolls: popupState.scrolls });
  };
  if (chipNoMeSiguen) {
    chipNoMeSiguen.addEventListener("click", () => activate("noMeSiguen"));
  }
  if (chipNoSigoYo) {
    chipNoSigoYo.addEventListener("click", () => activate("noSigoYo"));
  }
  activate(popupState.tab || "noMeSiguen");
}

function xmlEscape(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function buildExcelXml() {
  const { noMeSiguen, noSigoYo } = cachedResults;

  const sheet = (name, values) => {
    const rows = [`<Row><Cell><Data ss:Type="String">username</Data></Cell></Row>`];
    for (const u of values) {
      rows.push(`<Row><Cell><Data ss:Type="String">${xmlEscape(u)}</Data></Cell></Row>`);
    }
    return `
      <Worksheet ss:Name="${xmlEscape(name)}">
        <Table>
          ${rows.join("")}
        </Table>
      </Worksheet>
    `;
  };

  return `<?xml version="1.0"?>
  <Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
            xmlns:o="urn:schemas-microsoft-com:office:office"
            xmlns:x="urn:schemas-microsoft-com:office:excel"
            xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
    ${sheet("They follow, I don’t", noSigoYo)}
    ${sheet("I follow, they don’t", noMeSiguen)}
  </Workbook>`;
}

function setupDownload() {
  if (!downloadBtn) return;
  downloadBtn.addEventListener("click", () => {
    const hasData = (cachedResults.noMeSiguen?.length || 0) > 0 || (cachedResults.noSigoYo?.length || 0) > 0;
    if (!hasData) return;
    const xls = buildExcelXml();
    const blob = new Blob([xls], { type: "application/vnd.ms-excel" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "g-follow-inspector.xls";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  });
}

scanBtn.addEventListener("click", async () => {
  const mode = scanBtn.dataset.mode || "scan";
  scanBtn.disabled = true;

  if (mode === "close") {
    await new Promise((resolve) => chrome.runtime.sendMessage({ type: "BG_CLEAR_WORKER" }, () => resolve(true)));
    await refreshAll();
    scanBtn.disabled = false;
    return;
  }

  statusText.textContent = "Starting...";
  chrome.runtime.sendMessage({ type: "BG_SCAN_START_DOCKED" }, async (res) => {
    if (chrome.runtime.lastError) {
      statusText.textContent = chrome.runtime.lastError.message || "Error starting scan";
      console.error("[IGFD] Scan error:", chrome.runtime.lastError);
    } else if (res?.error) {
      statusText.textContent = res.error;
    } else if (!res?.ok) {
      statusText.textContent = "Failed to start scan. Please try again.";
    }
    await refreshAll();
    scanBtn.disabled = false;
  });
});

stopBtn.addEventListener("click", async () => {
  await new Promise((resolve) => chrome.runtime.sendMessage({ type: "BG_STOP" }, () => resolve(true)));
  await refreshAll();
});

copyBtn.addEventListener("click", async () => {
  const originalText = copyBtn.textContent;
  const st = await getState();
  const r = st?.lastResult;
  const text = JSON.stringify(r || {}, null, 2);
  await navigator.clipboard.writeText(text);
  if (copyHintTimer) clearTimeout(copyHintTimer);
  copyBtn.textContent = "Copied";
  copyBtn.disabled = true;
  copyHintTimer = setTimeout(() => {
    copyBtn.textContent = originalText;
    copyBtn.disabled = false;
  }, 1200);
});

clearBtn.addEventListener("click", async () => {
  // limpia resultados y logs
  await chrome.storage.local.set({
    IGFD_STATE: {
      ...(currentState || {}),
      lastResult: null,
      lastResultTimestamp: null, // Limpiar también el timestamp
      text: "",
      status: "idle",
      progress: { phase: "", loaded: 0, total: 0, percent: 0 },
      unfollow: { running: false, username: null },
    }
  });
  unfollowStatuses = {};
  followStatuses = {};
  actionCount = 0; // Resetear contador de acciones
  if (cooldownActive) {
    await endCooldown(); // Terminar cooldown si está activo
  } else {
    await saveCooldownState(); // Guardar contador reseteado
  }
  await clearExcludedUsers(); // Limpiar también del storage
  await refreshAll();
});

closeWorkerBtn.addEventListener("click", async () => {
  await new Promise((resolve) => chrome.runtime.sendMessage({ type: "BG_CLEAR_WORKERS" }, () => resolve(true)));
  await refreshAll();
});

chrome.runtime.onMessage.addListener(async (msg) => {
  if (msg?.type === "UNFOLLOW_COOLDOWN") {
    const text = msg?.message || "Pause unfollows for a few minutes to avoid rate limits.";
    statusText.textContent = text;
  }
  if (msg?.type === "UNFOLLOW_DONE" && msg.ok && msg.username) {
    unfollowedLocally.add(String(msg.username).toLowerCase());
    await saveExcludedUsers(); // Persistir cambios
    
    // Incrementar contador de acciones y verificar si necesita cooldown
    actionCount++;
    await saveCooldownState(); // Guardar contador persistente
    if (actionCount >= ACTION_LIMIT && !cooldownActive) {
      startCooldown();
    }
    
    await refreshAll();
  }
  if (msg?.type === "FOLLOW_DONE" && msg.ok && msg.username) {
    followedLocally.add(String(msg.username).toLowerCase());
    await saveExcludedUsers(); // Persistir cambios
    
    // Incrementar contador de acciones y verificar si necesita cooldown
    actionCount++;
    await saveCooldownState(); // Guardar contador persistente
    if (actionCount >= ACTION_LIMIT && !cooldownActive) {
      startCooldown();
    }
    
    await refreshAll();
  }
  console.log("[IGFD] runtime message", msg);
});

(async () => {
  await loadPopupState();
  await loadExcludedUsers(); // Cargar usuarios excluidos del storage
  await loadCooldownState(); // Cargar estado del cooldown y contador persistente
  setupTabs();
  setupChips();
  setupDownload();
  await refreshAll();
  applyScrollFromState();
  // auto-refresh mientras está abierto
  setInterval(refreshAll, 900);
})();
