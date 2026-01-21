// background.js (MV3 service worker) - IG Follow Diff
// FIXES:
// - Dock bounds using chrome.system.display.getInfo() (real workArea) + fallback if no permission
// - Save originalBounds/originalWindowState BEFORE resizing (to restore correctly)
// - Worker window focused:false (avoids odd focus issues and aggressive popup closing)

const STORAGE_KEY = "IGFD_STATE";
const DEFAULT_UNFOLLOW_STATE = { running: false, username: null };
const DEFAULT_FOLLOW_STATE = { running: false, username: null };

const DEFAULT_STATE = {
  status: "idle", // idle | running | error | done | unfollowing | follow
  text: "",
  updatedAt: Date.now(),
  lastResult: null, // {following, followers, noMeSiguen, noSigoYo} keys stored
  lastResultTimestamp: null, // Timestamp de cuándo se generó el último resultado
  workerWindowId: null,
  workerTabId: null,
  workerWindowIds: [],
  originalWindowId: null,
  originalBounds: null,
  originalWindowState: null,
  progress: { phase: "", loaded: 0, total: 0, percent: 0 },
  profileHref: null,
  unfollow: { ...DEFAULT_UNFOLLOW_STATE },
  follow: { ...DEFAULT_FOLLOW_STATE },
};


// Tiempo de expiración de resultados en milisegundos (8 horas)
const RESULT_EXPIRATION_MS = 8 * 60 * 60 * 1000;

let state = { ...DEFAULT_STATE };

function nowISO() {
  return new Date().toISOString();
}

function log(level, msg, data = {}) {
  const line = { ts: nowISO(), level, scope: "bg", msg, data };

  // circular logs in storage
  try {
    chrome.storage.local.get({ IGFD_LOGS: [] }, (res) => {
      const logs = res.IGFD_LOGS || [];
      logs.push(line);
      while (logs.length > 800) logs.shift();
      chrome.storage.local.set({ IGFD_LOGS: logs });
    });
  } catch (_) {}

  // console (do not crash extension if console fails)
  try {
    const fn =
      level === "ERROR" ? console.error : level === "WARN" ? console.warn : console.log;
    fn(`[${level}] ${msg}`, data);
  } catch (_) {}
}

async function loadState() {
  const res = await chrome.storage.local.get(STORAGE_KEY);
  if (res && res[STORAGE_KEY]) {
    state = { ...DEFAULT_STATE, ...res[STORAGE_KEY] };
    // Limpiar resultados si son antiguos (más de 8 horas)
    await checkAndCleanExpiredResults();
  }
}

async function checkAndCleanExpiredResults() {
  if (!state.lastResult || !state.lastResultTimestamp) return;
  
  const now = Date.now();
  const age = now - state.lastResultTimestamp;
  
  if (age > RESULT_EXPIRATION_MS) {
    log("INFO", "Limpiando resultados expirados por tiempo", {
      ageHours: Math.round(age / (60 * 60 * 1000)),
      expirationHours: RESULT_EXPIRATION_MS / (60 * 60 * 1000),
    });
    await setState({
      lastResult: null,
      lastResultTimestamp: null,
      status: "idle",
      text: "",
    });
  }
}

async function saveState() {
  state.updatedAt = Date.now();
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
}

function uniq(arr = []) {
  return Array.from(new Set(arr));
}

function addWorkerWindowId(id) {
  if (!id) return;
  state.workerWindowIds = uniq([...(state.workerWindowIds || []), id]);
}

function dropWorkerWindowId(id) {
  if (!id) return;
  state.workerWindowIds = (state.workerWindowIds || []).filter((x) => x !== id);
}

async function setState(patch) {
  state = { ...state, ...patch };
  await saveState();
}

async function setProgress(p) {
  state.progress = { ...state.progress, ...p };
  state.updatedAt = Date.now();
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
}

async function clearWorker(restore = true) {
  const { workerWindowId, originalWindowId, originalBounds, originalWindowState } = state;

  if (workerWindowId) {
    try {
      await chrome.windows.remove(workerWindowId);
    } catch (_) {}
    dropWorkerWindowId(workerWindowId);
  }

  if (restore && originalWindowId && originalBounds) {
    try {
      await chrome.windows.update(originalWindowId, { state: "normal" });
      await chrome.windows.update(originalWindowId, {
        left: originalBounds.left,
        top: originalBounds.top,
        width: originalBounds.width,
        height: originalBounds.height,
      });

      if (originalWindowState === "maximized") {
        await chrome.windows.update(originalWindowId, { state: "maximized" });
      }
    } catch (err) {
      log("WARN", "Could not restore original window", { err: String(err) });
    }
  }

  await setState({
    workerWindowId: null,
    workerTabId: null,
    originalWindowId: null,
    originalBounds: null,
    originalWindowState: null,
    workerWindowIds: state.workerWindowIds,
  });

  log("INFO", "Worker closed", { restore });
}

async function ensureContentReady(tabId, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await chrome.tabs.sendMessage(tabId, { type: "PING" });
      if (res && res.ok) return true;
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

async function ensureWorkerForAction() {
  await loadState();
  
  // Verificar si el worker existe y está disponible
  if (state.workerWindowId && state.workerTabId) {
    try {
      const workerWindow = await chrome.windows.get(state.workerWindowId);
      
      if (workerWindow.state === "minimized") {
        // Restaurar ventana minimizada
        await chrome.windows.update(state.workerWindowId, { state: "normal" });
      }

      try {
        const tab = await chrome.tabs.get(state.workerTabId);
        if (tab && tab.url && tab.url.includes("instagram.com")) {
          // Worker existe y está bien
          return { available: true };
        }
      } catch (err) {
        // Tab no existe, continuar para crear uno nuevo
      }
    } catch (err) {
      // Window no existe, continuar para crear uno nuevo
    }
  }

  // Si no hay worker disponible pero hay resultados del scan, crear uno nuevo
  if (!state.lastResult) {
    return { available: false, reason: "Worker window not found. Please run a scan first." };
  }

  // Crear un nuevo worker para FOLLOW/UNFOLLOW
  log("INFO", "Creating new worker for FOLLOW/UNFOLLOW", {});
  
  try {
    // Limpiar worker anterior si existe
    await clearWorker(false);

    // Buscar una tab de Instagram para usar como referencia
    const instagramTabs = await chrome.tabs.query({ url: "https://www.instagram.com/*" });
    const activeTab = instagramTabs.length > 0 ? instagramTabs[0] : null;
    
    if (!activeTab) {
      return { available: false, reason: "Please open Instagram in a tab first." };
    }

    const origWin = await chrome.windows.get(activeTab.windowId);
    const origBounds = {
      left: origWin.left ?? 0,
      top: origWin.top ?? 0,
      width: origWin.width ?? 1920,
      height: origWin.height ?? 900,
    };

    // Usar el profileHref guardado o detectar de la tab activa
    let workerUrl = "https://www.instagram.com/";
    const href = state.profileHref;
    if (href) {
      workerUrl = href.startsWith("https://") ? href : `https://www.instagram.com${href}`;
    } else if (activeTab.url && activeTab.url.startsWith("https://www.instagram.com/")) {
      workerUrl = activeTab.url;
    }

    // Crear worker window (más pequeño, solo para FOLLOW/UNFOLLOW)
    const workerWin = await chrome.windows.create({
      url: workerUrl,
      type: "normal",
      focused: false,
      width: 400,
      height: 600,
      left: (origBounds.left ?? 0) + (origBounds.width ?? 1920) - 400,
      top: origBounds.top ?? 0,
    });

    const workerTabId = workerWin.tabs?.[0]?.id;
    if (!workerTabId) {
      await chrome.windows.remove(workerWin.id);
      return { available: false, reason: "Could not create worker tab." };
    }

    addWorkerWindowId(workerWin.id);

    await setState({
      workerWindowId: workerWin.id,
      workerTabId,
      workerWindowIds: state.workerWindowIds,
    });

    // Esperar a que el contenido esté listo
    const ready = await ensureContentReady(workerTabId, 20000);
    if (!ready) {
      await chrome.windows.remove(workerWin.id);
      await setState({ workerWindowId: null, workerTabId: null });
      return { available: false, reason: "Worker window is not responding. Please try again." };
    }

    // Esperar un poco para que Instagram cargue
    await new Promise((r) => setTimeout(r, 1000));

    log("INFO", "Worker created for FOLLOW/UNFOLLOW", { workerTabId, workerWindowId: workerWin.id });
    return { available: true };
  } catch (err) {
    log("ERROR", "Failed to create worker for FOLLOW/UNFOLLOW", { err: String(err) });
    return { available: false, reason: `Failed to create worker: ${String(err)}` };
  }
}

async function checkWorkerAvailable() {
  await loadState();
  
  if (!state.workerWindowId || !state.workerTabId) {
    return { available: false, reason: "Worker window not found. Please run a scan first." };
  }

  try {
    // Verificar si la ventana existe y no está minimizada
    const workerWindow = await chrome.windows.get(state.workerWindowId);
    
    if (workerWindow.state === "minimized") {
      return { available: false, reason: "Worker window is minimized. Please restore it to continue." };
    }

    // Verificar si el tab existe y está en Instagram
    try {
      const tab = await chrome.tabs.get(state.workerTabId);
      if (!tab || tab.url === "chrome://newtab/" || !tab.url.includes("instagram.com")) {
        return { available: false, reason: "Worker tab is not available. Please run a scan again." };
      }
    } catch (err) {
      return { available: false, reason: "Worker tab not found. Please run a scan again." };
    }

    // No verificar si el contenido está listo aquí - dejar que el intento de acción se encargue
    // Esto evita falsos negativos cuando el tab está dormido pero puede despertarse
    // El código de UNFOLLOW/FOLLOW ya tiene manejo de reintentos si el tab no responde
    return { available: true };
  } catch (err) {
    log("WARN", "Worker check failed", { err: String(err) });
    return { available: false, reason: "Worker window not found. Please run a scan again." };
  }
}

async function sendToTab(tabId, msg, retries = 8) {
  let lastErr = null;
  for (let i = 0; i < retries; i++) {
    try {
      return await chrome.tabs.sendMessage(tabId, msg);
    } catch (err) {
      lastErr = err;
      log("WARN", "sendMessage failed, retrying...", { err: String(err), try: i + 1 });
      await new Promise((r) => setTimeout(r, 350 + i * 120));
    }
  }
  throw lastErr || new Error("sendMessage failed");
}

function computeDockBoundsFallback(origBounds) {
  const totalW = origBounds.width || 1920;
  const totalH = origBounds.height || 900;

  const workerW = Math.max(360, Math.round(totalW * 0.27));
  const mainW = totalW - workerW;

  return {
    main: {
      left: origBounds.left ?? 0,
      top: origBounds.top ?? 0,
      width: mainW,
      height: totalH,
    },
    worker: {
      left: (origBounds.left ?? 0) + mainW,
      top: origBounds.top ?? 0,
      width: workerW,
      height: totalH,
    },
  };
}

async function computeDockBoundsFromDisplay(windowId, fallbackBounds) {
  // Requires permission: "system.display" in manifest
  try {
    const win = await chrome.windows.get(windowId);
    const displays = await chrome.system.display.getInfo();

    const cx = (win.left ?? 0) + Math.round((win.width ?? 0) / 2);
    const cy = (win.top ?? 0) + Math.round((win.height ?? 0) / 2);

    const disp =
      displays.find((d) => {
        const b = d.bounds;
        return (
          cx >= b.left &&
          cx <= b.left + b.width &&
          cy >= b.top &&
          cy <= b.top + b.height
        );
      }) || displays[0];

    const wa = disp.workArea; // without taskbar/dock
    const totalW = wa.width;
    const totalH = wa.height;

    const workerW = Math.max(420, Math.round(totalW * 0.27));
    const mainW = totalW - workerW;

    return {
      main: { left: wa.left, top: wa.top, width: mainW, height: totalH },
      worker: { left: wa.left + mainW, top: wa.top, width: workerW, height: totalH },
    };
  } catch (err) {
    log("WARN", "computeDockBoundsFromDisplay failed, using fallback", { err: String(err) });
    return computeDockBoundsFallback(fallbackBounds);
  }
}

async function startScanDocked() {
  log("INFO", "startScanDocked()", {});
  await loadState();

  // Prevent multiple workers: if an existing worker window is still open, block start
  if (state.workerWindowId) {
    try {
      const existing = await chrome.windows.get(state.workerWindowId);
      if (existing) {
        throw new Error("Worker already open. Close it first.");
      }
    } catch (err) {
      // if window not found, continue (stale id)
    }
  }

  // close previous worker (stale) without restoring (will recalc)
  await clearWorker(false);

  const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!activeTab) throw new Error("Could not detect the active tab.");

  const origWin = await chrome.windows.get(activeTab.windowId);

  const origBounds = {
    left: origWin.left ?? 0,
    top: origWin.top ?? 0,
    width: origWin.width ?? 1920,
    height: origWin.height ?? 900,
  };

  // store original bounds to restore later
  await setState({
    originalWindowId: origWin.id,
    originalBounds: origBounds,
    originalWindowState: origWin.state,
  });

  const dock = await computeDockBoundsFromDisplay(origWin.id, origBounds);

  // normalize before setting bounds
  try {
    await chrome.windows.update(origWin.id, { state: "normal" });
  } catch (_) {}

  // main window on the left
  await chrome.windows.update(origWin.id, {
    left: dock.main.left,
    top: dock.main.top,
    width: dock.main.width,
    height: dock.main.height,
  });

  // worker on the right
  // detect current profile from active tab (first non-blacklisted segment)
  let detectedProfile = null;
  if (activeTab.url && activeTab.url.startsWith("https://www.instagram.com/")) {
    try {
      const u = new URL(activeTab.url);
      const parts = u.pathname.split("/").filter(Boolean);
      const first = parts[0];
      const BLACK = new Set(["accounts", "explore", "reels", "direct", "notifications", "stories", "p", "tv"]);
      if (first && !BLACK.has(first.toLowerCase())) {
        detectedProfile = `/${first}/`;
      }
    } catch (_) {}
  }
  if (detectedProfile) {
    await setState({ profileHref: detectedProfile });
  }

  let workerUrl = "https://www.instagram.com/";
  const href = state.profileHref || detectedProfile;
  if (href) {
    workerUrl = href.startsWith("https://") ? href : `https://www.instagram.com${href}`;
  } else if (activeTab.url && activeTab.url.startsWith("https://www.instagram.com/")) {
    workerUrl = activeTab.url;
  }

  const workerWin = await chrome.windows.create({
    url: workerUrl,
    type: "normal",
    focused: false,
    left: dock.worker.left,
    top: dock.worker.top,
    width: dock.worker.width,
    height: dock.worker.height,
  });

  const workerTabId = workerWin.tabs?.[0]?.id;
  if (!workerTabId) throw new Error("Could not obtain worker tabId.");

  addWorkerWindowId(workerWin.id);

  await setState({
    workerWindowId: workerWin.id,
    workerTabId,
    workerWindowIds: state.workerWindowIds,
  });

  log("INFO", "Worker docked", {
    originalBounds: dock.main,
    originalWindowId: origWin.id,
    originalWindowState: origWin.state,
    workerTabId,
    workerWindowId: workerWin.id,
  });

  const ready = await ensureContentReady(workerTabId, 25000);
  if (!ready) throw new Error("Could not communicate with the worker tab content script.");

  // Wait a bit for Instagram to load fully
  await new Promise((r) => setTimeout(r, 1000));

  await setState({
    status: "running",
    text: "Starting...",
    progress: { phase: "", loaded: 0, total: 0, percent: 0 },
    unfollow: { ...DEFAULT_UNFOLLOW_STATE },
  });

  await sendToTab(workerTabId, { type: "SCAN_START" });

  try {
    await chrome.windows.update(origWin.id, { focused: true });
  } catch (_) {}
}

async function stopAll() {
  await loadState();
  const targets = new Set();
  if (state.workerTabId) targets.add(state.workerTabId);

  try {
    const workerWin = state.workerWindowId
      ? await chrome.windows.get(state.workerWindowId, { populate: true }).catch(() => null)
      : null;
    const candidateTabs = [];
    if (workerWin?.tabs) candidateTabs.push(...workerWin.tabs);
    const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (activeTab) candidateTabs.push(activeTab);
    for (const t of candidateTabs) {
      if (t.id && t.url && t.url.startsWith("https://www.instagram.com/")) {
        targets.add(t.id);
      }
    }
  } catch (_) {}

  for (const tabId of targets) {
    try {
      await sendToTab(tabId, { type: "STOP" }, 2);
    } catch (_) {}
  }

  await setState({
    status: "idle",
    text: "Stopped.",
    progress: { phase: "", loaded: 0, total: 0, percent: 0 },
    workerWindowId: null,
    workerTabId: null,
    workerWindowIds: state.workerWindowIds,
    unfollow: { ...DEFAULT_UNFOLLOW_STATE },
    follow: { ...DEFAULT_FOLLOW_STATE },
  });
}

async function clearAllWorkers() {
  await stopAll();
  const ids = uniq(state.workerWindowIds || []);
  for (const wid of ids) {
    try {
      await chrome.windows.remove(wid);
    } catch (_) {}
    dropWorkerWindowId(wid);
  }
  await clearWorker(true);
  await setState({
    status: "idle",
    text: "",
    workerWindowIds: [],
    unfollow: { ...DEFAULT_UNFOLLOW_STATE },
    follow: { ...DEFAULT_FOLLOW_STATE },
  });
}

async function ensureUnfollowTab(username) {
  await loadState();

  const profileUrl = `https://www.instagram.com/${encodeURIComponent(username)}/`;

  // If we already have a worker tab, check if it's responsive
  if (state.workerTabId) {
    const ready = await ensureContentReady(state.workerTabId, 8000);
    if (ready) return state.workerTabId;
  }

  // Create a fresh background tab for this unfollow
  const tab = await chrome.tabs.create({ url: profileUrl, active: false });
  const tabId = tab.id;
  const windowId = tab.windowId;
  if (windowId) addWorkerWindowId(windowId);

  await setState({
    workerTabId: tabId,
    workerWindowId: windowId || null,
    workerWindowIds: state.workerWindowIds,
    profileHref: `/${username}/`,
  });

  const ready = await ensureContentReady(tabId, 25000);
  if (!ready) throw new Error("Could not communicate with the unfollow tab.");

  return tabId;
}

// Listener para detectar cuando se cierra la última ventana de Chrome
chrome.windows.onRemoved.addListener(async (windowId) => {
  try {
    // Verificar si esa era la última ventana de Chrome
    const allWindows = await chrome.windows.getAll();
    
    // Si no quedan ventanas abiertas, limpiar los resultados
    if (allWindows.length === 0) {
      await loadState();
      if (state.lastResult) {
        log("INFO", "Limpiando resultados al cerrar Chrome", {
          hadResults: Boolean(state.lastResult),
        });
        await setState({
          lastResult: null,
          lastResultTimestamp: null,
          status: "idle",
          text: "",
        });
      }
    }
  } catch (err) {
    log("WARN", "Error al verificar cierre de ventana", { err: String(err) });
  }
});

chrome.runtime.onInstalled.addListener(async () => {
  await loadState();
  await checkAndCleanExpiredResults();
  await saveState();
  log("INFO", "Service worker started", { state });
});

chrome.runtime.onStartup.addListener(async () => {
  await loadState();
  await checkAndCleanExpiredResults();
  await saveState();
  log("INFO", "Service worker started (startup)", { state });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (!msg || !msg.type) return;

      if (msg.type === "BG_SCAN_START_DOCKED") {
        try {
          await startScanDocked();
          sendResponse({ ok: true });
        } catch (err) {
          const errorMsg = String(err?.message || err);
          log("ERROR", "BG_SCAN_START_DOCKED failed", { error: errorMsg });
          sendResponse({ ok: false, error: errorMsg });
        }
        return;
      }

      if (msg.type === "BG_STOP") {
        await stopAll();
        sendResponse({ ok: true });
        return;
      }

      if (msg.type === "BG_CLEAR_WORKER") {
        await clearWorker(true);
        await setState({
          status: "idle",
          text: "",
          unfollow: { ...DEFAULT_UNFOLLOW_STATE },
          follow: { ...DEFAULT_FOLLOW_STATE },
        });
        sendResponse({ ok: true });
        return;
      }

      if (msg.type === "BG_CLEAR_WORKERS") {
        await clearAllWorkers();
        sendResponse({ ok: true });
        return;
      }

      if (msg.type === "UNFOLLOW") {
        await loadState();
        const username = (msg.username || "").trim();

        if (!username) {
          sendResponse({ ok: false, error: "Username missing" });
          return;
        }

        // Verificar si el worker está disponible, y crearlo si es necesario
        const workerCheck = await ensureWorkerForAction();
        if (!workerCheck.available) {
          log("ERROR", "UNFOLLOW_WORKER_NOT_AVAILABLE", { username, reason: workerCheck.reason });
          sendResponse({ ok: false, error: workerCheck.reason });
          return;
        }

        const tabId = state.workerTabId;

        await setState({
          status: "unfollowing",
          text: `Unfollowing @${username}...`,
          unfollow: { running: true, username },
        });

        try {
          let res = null;
          try {
            log("INFO", "UNFOLLOW_SEND", { tabId, username });
            res = await sendToTab(tabId, { type: "UNFOLLOW", username });
          } catch (err) {
            // Reintento simple en el mismo tab por si estaba dormido
            const ready = await ensureContentReady(tabId, 8000);
            if (!ready) {
              log("ERROR", "UNFOLLOW_SEND_RETRY_READY_FAIL", { username, err: String(err) });
              throw err;
            }
            log("WARN", "UNFOLLOW_SEND_RETRYING", { username, err: String(err) });
            res = await sendToTab(tabId, { type: "UNFOLLOW", username });
          }
          const message = res?.message || `Unfollowed @${username}`;
          const isSuccess = res?.ok === true || message.toLowerCase().includes("already not following");
          
          await setState({
            status: isSuccess ? "done" : "error",
            text: message,
            unfollow: { ...DEFAULT_UNFOLLOW_STATE },
          });
          log(isSuccess ? "INFO" : "ERROR", "UNFOLLOW_DONE_BG", { username, ok: isSuccess, message });
          sendResponse({ ok: isSuccess, result: res, message });
        } catch (err) {
          const message = String(err);
          await setState({
            status: "error",
            text: message,
            unfollow: { ...DEFAULT_UNFOLLOW_STATE },
          });
          log("ERROR", "UNFOLLOW_FAILED_BG", { username, message });
          sendResponse({ ok: false, error: message });
        }
        return;
      }

      if (msg.type === "FOLLOW") {
        await loadState();
        const username = (msg.username || "").trim();

        if (!username) {
          sendResponse({ ok: false, error: "Username missing" });
          return;
        }

        // Verificar si el worker está disponible, y crearlo si es necesario
        const workerCheck = await ensureWorkerForAction();
        if (!workerCheck.available) {
          log("ERROR", "FOLLOW_WORKER_NOT_AVAILABLE", { username, reason: workerCheck.reason });
          sendResponse({ ok: false, error: workerCheck.reason });
          return;
        }

        const tabId = state.workerTabId;

        await setState({
          status: "follow",
          text: `Following @${username}...`,
          follow: { running: true, username },
        });

        try {
          let res = null;
          try {
            log("INFO", "FOLLOW_SEND", { tabId, username });
            res = await sendToTab(tabId, { type: "FOLLOW", username });
          } catch (err) {
            const ready = await ensureContentReady(tabId, 8000);
            if (!ready) {
              log("ERROR", "FOLLOW_SEND_RETRY_READY_FAIL", { username, err: String(err) });
              throw err;
            }
            log("WARN", "FOLLOW_SEND_RETRYING", { username, err: String(err) });
            res = await sendToTab(tabId, { type: "FOLLOW", username });
          }
          const message = res?.message || `Followed @${username}`;
          const isSuccess = res?.ok === true || message.toLowerCase().includes("already following");
          
          await setState({
            status: isSuccess ? "done" : "error",
            text: message,
            follow: { ...DEFAULT_FOLLOW_STATE },
          });
          log(isSuccess ? "INFO" : "ERROR", "FOLLOW_DONE_BG", { username, ok: isSuccess, message });
          sendResponse({ ok: isSuccess, result: res, message });
        } catch (err) {
          const message = String(err);
          await setState({
            status: "error",
            text: message,
            follow: { ...DEFAULT_FOLLOW_STATE },
          });
          log("ERROR", "FOLLOW_FAILED_BG", { username, message });
          sendResponse({ ok: false, error: message });
        }
        return;
      }

      if (msg.type === "PROFILE_HREF") {
        await setState({ profileHref: msg.href || null });
        sendResponse({ ok: true });
        return;
      }

      // Messages from content
      if (msg.type === "LOG") {
        const level = msg.level || "INFO";
        const data = msg.data || {};

        chrome.storage.local.get({ IGFD_LOGS: [] }, (res) => {
          const logs = res.IGFD_LOGS || [];
          logs.push({
            ts: msg.ts || nowISO(),
            level,
            scope: msg.scope || "content",
            msg: msg.msg,
            data,
          });
          while (logs.length > 800) logs.shift();
          chrome.storage.local.set({ IGFD_LOGS: logs });
        });

        sendResponse({ ok: true });
        return;
      }

      if (msg.type === "PROGRESS") {
        const { phase, loaded, total, percent, text, fromTab } = msg;

        await setProgress({
          phase: phase || state.progress.phase,
          loaded: Number.isFinite(loaded) ? loaded : state.progress.loaded,
          total: Number.isFinite(total) ? total : state.progress.total,
          percent: Number.isFinite(percent) ? percent : state.progress.percent,
        });

        await setState({ text: text || state.text });

        log("DEBUG", "PROGRESS", { fromTab, phase, loaded, total, percent, text });
        sendResponse({ ok: true });
        return;
      }

      if (msg.type === "RESULT") {
        await setState({
          status: "done",
          text: "Done.",
          lastResult: msg.result || null,
          lastResultTimestamp: Date.now(), // Guardar timestamp cuando se generan los resultados
          unfollow: { ...DEFAULT_UNFOLLOW_STATE },
        });

        log("INFO", "RESULT received", {
          following: msg.result?.following?.length,
          followers: msg.result?.followers?.length,
          noMeSiguen: msg.result?.noMeSiguen?.length,
          timestamp: Date.now(),
        });

        sendResponse({ ok: true });
        return;
      }

      if (msg.type === "UNFOLLOW_DONE") {
        const username = msg.username || null;
        const ok = Boolean(msg.ok);
        const message = msg.message || (ok ? `Unfollowed ${username || ""}`.trim() : "Unfollow failed");
        await setState({
          status: ok ? "done" : "error",
          text: message,
          unfollow: { ...DEFAULT_UNFOLLOW_STATE },
        });
        log(ok ? "INFO" : "ERROR", "UNFOLLOW_DONE", { username, message });
        sendResponse({ ok: true });
        return;
      }

      if (msg.type === "ERROR") {
        await setState({
          status: "error",
          text: msg.message || "Error",
          unfollow: { ...DEFAULT_UNFOLLOW_STATE },
        });

        log("ERROR", "ERROR from content", { message: msg.message, tabId: sender?.tab?.id });
        sendResponse({ ok: true });
        return;
      }

      if (msg.type === "GET_STATE") {
        try {
          await loadState();
          await checkAndCleanExpiredResults();
          
          // Agregar información del estado del worker al estado
          let workerCheck = { available: false, reason: "Unknown error" };
          try {
            workerCheck = await checkWorkerAvailable();
          } catch (err) {
            log("WARN", "checkWorkerAvailable failed in GET_STATE", { err: String(err) });
            workerCheck = { available: false, reason: "Worker check failed" };
          }
          
          const stateWithWorker = {
            ...state,
            workerAvailable: workerCheck.available,
            workerReason: workerCheck.reason || null,
          };
          
          sendResponse({ ok: true, state: stateWithWorker });
        } catch (err) {
          log("ERROR", "GET_STATE failed", { err: String(err) });
          sendResponse({ ok: false, error: String(err), state: { ...DEFAULT_STATE } });
        }
        return;
      }

      if (msg.type === "GET_LOGS") {
        const res = await chrome.storage.local.get({ IGFD_LOGS: [] });
        sendResponse({ ok: true, logs: res.IGFD_LOGS || [] });
        return;
      }

      if (msg.type === "CLEAR_LOGS") {
        await chrome.storage.local.set({ IGFD_LOGS: [] });
        sendResponse({ ok: true });
        return;
      }
    } catch (err) {
      log("ERROR", "Exception in onMessage", { message: String(err), msg });
      await setState({ status: "error", text: String(err) });
      sendResponse({ ok: false, error: String(err) });
    }
  })();

  return true; // async
});
