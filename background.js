// background.js (MV3 service worker) - IG Follow Diff
// FIXES:
// - Dock bounds usando chrome.system.display.getInfo() (workArea real) + fallback si no hay permiso
// - Guardar originalBounds/originalWindowState ANTES de redimensionar (para restaurar bien)
// - Worker window focused:false (evita cosas raras y cierre agresivo del popup)

const STORAGE_KEY = "IGFD_STATE";

const DEFAULT_STATE = {
  status: "idle", // idle | running | error | done | unfollowing
  text: "",
  updatedAt: Date.now(),
  lastResult: null, // {following, followers, noMeSiguen, noSigoYo}
  workerWindowId: null,
  workerTabId: null,
  originalWindowId: null,
  originalBounds: null,
  originalWindowState: null,
  progress: { phase: "", loaded: 0, total: 0, percent: 0 },
  profileHref: null,
};

let state = { ...DEFAULT_STATE };

function nowISO() {
  return new Date().toISOString();
}

function log(level, msg, data = {}) {
  const line = { ts: nowISO(), level, scope: "bg", msg, data };

  // logs circular en storage
  try {
    chrome.storage.local.get({ IGFD_LOGS: [] }, (res) => {
      const logs = res.IGFD_LOGS || [];
      logs.push(line);
      while (logs.length > 800) logs.shift();
      chrome.storage.local.set({ IGFD_LOGS: logs });
    });
  } catch (_) {}

  // consola (no tires la extensión si falla console)
  try {
    const fn =
      level === "ERROR" ? console.error : level === "WARN" ? console.warn : console.log;
    fn(`[${level}] ${msg}`, data);
  } catch (_) {}
}

async function loadState() {
  const res = await chrome.storage.local.get(STORAGE_KEY);
  if (res && res[STORAGE_KEY]) state = { ...DEFAULT_STATE, ...res[STORAGE_KEY] };
}

async function saveState() {
  state.updatedAt = Date.now();
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
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
      log("WARN", "No pude restaurar ventana original", { err: String(err) });
    }
  }

  await setState({
    workerWindowId: null,
    workerTabId: null,
    originalWindowId: null,
    originalBounds: null,
    originalWindowState: null,
  });

  log("INFO", "Worker cerrado", { restore });
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

async function sendToTab(tabId, msg, retries = 8) {
  let lastErr = null;
  for (let i = 0; i < retries; i++) {
    try {
      return await chrome.tabs.sendMessage(tabId, msg);
    } catch (err) {
      lastErr = err;
      log("WARN", "sendMessage falló, reintentando...", { err: String(err), try: i + 1 });
      await new Promise((r) => setTimeout(r, 350 + i * 120));
    }
  }
  throw lastErr || new Error("sendMessage falló");
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
  // Requiere permiso: "system.display" en manifest
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

    const wa = disp.workArea; // sin taskbar/dock
    const totalW = wa.width;
    const totalH = wa.height;

    const workerW = Math.max(420, Math.round(totalW * 0.27));
    const mainW = totalW - workerW;

    return {
      main: { left: wa.left, top: wa.top, width: mainW, height: totalH },
      worker: { left: wa.left + mainW, top: wa.top, width: workerW, height: totalH },
    };
  } catch (err) {
    log("WARN", "computeDockBoundsFromDisplay falló, usando fallback", { err: String(err) });
    return computeDockBoundsFallback(fallbackBounds);
  }
}

async function startScanDocked() {
  log("INFO", "startScanDocked()", {});
  await loadState();

  // cerrar worker previo sin restaurar (lo vamos a recalcular)
  await clearWorker(false);

  const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!activeTab) throw new Error("No pude detectar la pestaña activa.");

  const origWin = await chrome.windows.get(activeTab.windowId);

  const origBounds = {
    left: origWin.left ?? 0,
    top: origWin.top ?? 0,
    width: origWin.width ?? 1920,
    height: origWin.height ?? 900,
  };

  // guardar para restaurar
  await setState({
    originalWindowId: origWin.id,
    originalBounds: origBounds,
    originalWindowState: origWin.state,
  });

  const dock = await computeDockBoundsFromDisplay(origWin.id, origBounds);

  // normalizar para setear bounds
  try {
    await chrome.windows.update(origWin.id, { state: "normal" });
  } catch (_) {}

  // ventana usuario a la izquierda
  await chrome.windows.update(origWin.id, {
    left: dock.main.left,
    top: dock.main.top,
    width: dock.main.width,
    height: dock.main.height,
  });

  // worker a la derecha
  // detectar perfil actual desde la pestaña activa (primer segmento no blacklist)
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
  if (!workerTabId) throw new Error("No pude obtener tabId del worker.");

  await setState({
    workerWindowId: workerWin.id,
    workerTabId,
  });

  log("INFO", "Worker docked", {
    originalBounds: dock.main,
    originalWindowId: origWin.id,
    originalWindowState: origWin.state,
    workerTabId,
    workerWindowId: workerWin.id,
  });

  const ready = await ensureContentReady(workerTabId, 25000);
  if (!ready) throw new Error("No pude comunicarme con el content script del tab worker.");

  // Esperar para que Instagram cargue completamente
  await new Promise((r) => setTimeout(r, 1000));

  await setState({
    status: "running",
    text: "Iniciando...",
    progress: { phase: "", loaded: 0, total: 0, percent: 0 },
    unfollow: { running: false, username: null },
  });

  await sendToTab(workerTabId, { type: "SCAN_START" });

  try {
    await chrome.windows.update(origWin.id, { focused: true });
  } catch (_) {}
}

async function stopAll() {
  await loadState();
  if (state.workerTabId) {
    try {
      await sendToTab(state.workerTabId, { type: "STOP" }, 3);
    } catch (_) {}
  }
  await setState({ status: "idle", text: "Detenido." });
}

chrome.runtime.onInstalled.addListener(async () => {
  await loadState();
  await saveState();
  log("INFO", "Service worker iniciado", { state });
});

chrome.runtime.onStartup.addListener(async () => {
  await loadState();
  await saveState();
  log("INFO", "Service worker iniciado (startup)", { state });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (!msg || !msg.type) return;

      if (msg.type === "BG_SCAN_START_DOCKED") {
        await startScanDocked();
        sendResponse({ ok: true });
        return;
      }

      if (msg.type === "BG_STOP") {
        await stopAll();
        sendResponse({ ok: true });
        return;
      }

      if (msg.type === "BG_CLEAR_WORKER") {
        await clearWorker(true);
        await setState({ status: "idle", text: "" });
        sendResponse({ ok: true });
        return;
      }

      if (msg.type === "PROFILE_HREF") {
        await setState({ profileHref: msg.href || null });
        sendResponse({ ok: true });
        return;
      }

      // Mensajes desde content
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
          text: "Listo.",
          lastResult: msg.result || null,
        });

        log("INFO", "RESULT recibido", {
          following: msg.result?.following?.length,
          followers: msg.result?.followers?.length,
          noMeSiguen: msg.result?.noMeSiguen?.length,
        });

        sendResponse({ ok: true });
        return;
      }

      if (msg.type === "UNFOLLOW_DONE") {
        // Unfollow flow removed in this version
        sendResponse({ ok: true });
        return;
      }

      if (msg.type === "ERROR") {
        await setState({
          status: "error",
          text: msg.message || "Error",
        });

        log("ERROR", "ERROR desde content", { message: msg.message, tabId: sender?.tab?.id });
        sendResponse({ ok: true });
        return;
      }

      if (msg.type === "GET_STATE") {
        await loadState();
        sendResponse({ ok: true, state });
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
      log("ERROR", "Excepción en onMessage", { message: String(err), msg });
      await setState({ status: "error", text: String(err) });
      sendResponse({ ok: false, error: String(err) });
    }
  })();

  return true; // async
});
