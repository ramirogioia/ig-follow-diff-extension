// content.js - IG Follow Diff (corre en instagram.com)
// FIXES:
// - Detecta contenedor scrolleable real (overflowY auto/scroll) en modal Following/Followers
// - Si NO hay overflow (listas chicas), parsea y sale
// - parseUsers soporta href relativos y absolutos
// - isVisible robusto (evita "reading 'display'")

let STOP = false;
let RUNNING = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function nowISO() {
  return new Date().toISOString();
}

function sendLog(level, msg, data = {}) {
  try {
    chrome.runtime.sendMessage({
      type: "LOG",
      level,
      scope: "content",
      msg,
      data,
      ts: nowISO(),
    });
  } catch (_) {}
}

function sendProgress({ phase, loaded, total, percent, text }) {
  try {
    chrome.runtime.sendMessage({
      type: "PROGRESS",
      phase,
      loaded,
      total,
      percent,
      text,
      fromTab: undefined,
    });
  } catch (_) {}
}

function reactClick(el) {
  if (!el) throw new Error("Elemento no encontrado para click");
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
}

function dispatchWheel(el, deltaY) {
  if (!el) return;
  el.dispatchEvent(
    new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY,
      deltaMode: 0,
      view: window,
    })
  );
}

function dispatchHover(el) {
  if (!el) return;
  const rect = el.getBoundingClientRect();
  const x = rect.left + Math.min(20, rect.width / 2);
  const y = rect.top + Math.min(20, rect.height / 2);
  el.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, cancelable: true, clientX: x, clientY: y }));
  el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, cancelable: true, clientX: x, clientY: y }));
}

async function waitForDialog() {
  for (let i = 0; i < 60; i++) {
    const dialog = document.querySelector('div[role="dialog"]');
    if (dialog) return dialog;
    await sleep(250);
  }
  throw new Error("No se abrió el modal a tiempo.");
}

async function closeDialog() {
  const dialog = document.querySelector('div[role="dialog"]');
  if (!dialog) return;

  const closeBtn =
    dialog.querySelector('[aria-label="Close"]') ||
    dialog.querySelector('[aria-label="Cerrar"]') ||
    dialog.querySelector('button[aria-label="Close"]') ||
    dialog.querySelector('button[aria-label="Cerrar"]');

  if (closeBtn) {
    reactClick(closeBtn);
    await sleep(900);
  }
}

function isVisible(el) {
  if (!el || !(el instanceof Element)) return false;

  const r = el.getBoundingClientRect?.();
  if (!r || r.width === 0 || r.height === 0) return false;

  let s = null;
  try {
    s = window.getComputedStyle(el);
  } catch (_) {
    // si falla getComputedStyle, no crashear
    return true;
  }

  if (!s) return true;
  if (s.display === "none" || s.visibility === "hidden" || s.opacity === "0") return false;
  return true;
}

function getOverflowY(el) {
  try {
    return window.getComputedStyle(el).overflowY || "";
  } catch (_) {
    return "";
  }
}

function isScrollable(el) {
  const oy = getOverflowY(el);
  if (oy !== "auto" && oy !== "scroll") return false;
  return el.scrollHeight > el.clientHeight + 2;
}

/**
 * Encuentra el contenedor scrolleable - EXACTO como la versión que funcionaba
 */
function findScrollBox(dialog) {
  if (!dialog) return null;
  
  // Primero busca ._aano (como en la versión que funcionaba)
  const instagramClass = dialog.querySelector("._aano");
  if (instagramClass) {
    return instagramClass;
  }
  
  // Luego busca divs con overflowY auto/scroll Y scrollHeight > clientHeight
  // EXACTO como en la versión que funcionaba
  const candidate = Array.from(dialog.querySelectorAll("div")).find((d) => {
    const s = getComputedStyle(d);
    return (
      (s.overflowY === "auto" || s.overflowY === "scroll") &&
      d.scrollHeight > d.clientHeight
    );
  });
  
  return candidate || null;
}

async function waitForBox(dialog, type) {
  // EXACTO como waitForScrollable en la versión que funcionaba
  for (let i = 0; i < 20; i++) {
    const box = findScrollBox(dialog);
    if (box) {
      sendLog("INFO", `ScrollBox listo (${type})`, {
        overflowY: getOverflowY(box),
        clientHeight: box.clientHeight,
        scrollHeight: box.scrollHeight,
      });
      return { box, scrollable: true };
    }

    sendLog("DEBUG", `Esperando box (${type})`, { i });
    await sleep(500); // 500ms como en la versión que funcionaba
  }

  throw new Error(`El contenedor del listado de ${type} no apareció a tiempo`);
}

function normalizeUserFromHref(href) {
  if (!href) return null;

  // soporta "/user/" y "https://www.instagram.com/user/"
  let h = href;

  try {
    if (h.startsWith("https://www.instagram.com/")) {
      h = h.replace("https://www.instagram.com", "");
    }
  } catch (_) {}

  // limpio query/hash
  h = h.split("?")[0].split("#")[0];

  if (!h.startsWith("/")) return null;
  const parts = h.split("/").filter(Boolean);
  if (!parts.length) return null;

  const u = parts[0];
  return u || null;
}

function parseUsersFromDialog(dialog) {
  const BLACK = new Set([
    "explore",
    "reels",
    "direct",
    "accounts",
    "notifications",
    "messages",
    "inbox",
    "tv",
    "p",
    "stories",
  ]);

  const anchors = Array.from(
    dialog.querySelectorAll('a[href^="/"], a[href^="https://www.instagram.com/"]')
  );

  const users = anchors
    .map((a) => normalizeUserFromHref(a.getAttribute("href")))
    .filter((u) => u && !BLACK.has(u));

  return Array.from(new Set(users));
}

function getCountFromProfileCounters(hrefPart) {
  const a = document.querySelector(`a[href$="${hrefPart}/"], a[href*="${hrefPart}"]`);
  if (!a) return null;

  const txt = a.innerText || "";
  const m = txt.replace(/\s/g, " ").match(/([\d.,]+)\s/);
  if (!m) return null;

  const raw = m[1];
  const normalized = raw.replace(/\./g, "").replace(/,/g, "");
  const n = parseInt(normalized, 10);
  return Number.isFinite(n) ? n : null;
}

async function kickstartScrollable(box) {
  try { box.focus?.(); } catch (_) {}
  dispatchHover(box);

  try {
    const rect = box.getBoundingClientRect();
    document.elementFromPoint(rect.left + 10, rect.top + 10)?.click?.();
  } catch (_) {}

  // Pre-scroll para "despertar" el componente (como en la versión que funcionaba)
  for (let k = 0; k < 5; k++) {
    box.scrollTop += 150 * (k % 2 === 0 ? 1 : -1);
    await sleep(250);
  }
}

async function openModal(type, hrefPart) {
  await closeDialog();

  // Esperar un poco para que la página se estabilice antes de buscar el botón
  await sleep(300);

  // Esperar a que el botón esté disponible y visible
  let btn = null;
  for (let i = 0; i < 20; i++) {
    btn = document.querySelector(`a[href*="${hrefPart}"]`);
    if (btn && btn.offsetParent !== null) break; // offsetParent !== null significa que es visible
    await sleep(200);
  }

  if (!btn || btn.offsetParent === null) {
    throw new Error(`No se encontró el enlace de ${type} o no está visible`);
  }

  sendLog("INFO", `Abriendo modal ${type}`, { hrefPart, url: location.href });
  reactClick(btn);

  const dialog = await waitForDialog();
  // Espera base más larga para que Instagram cargue el contenido inicial (como en la versión que funcionaba)
  sendLog("INFO", `Esperando carga inicial de ${type}...`, {});
  await sleep(4000);
  return dialog;
}

async function scrollCollect(type, hrefPart) {
  await sleep(4000);
  const dialog = await openModal(type, hrefPart);

  const totalGuess =
    getCountFromProfileCounters(hrefPart) ||
    parseInt(dialog.querySelector("h1,h2,h3")?.innerText || "", 10) ||
    null;

  const total = Number.isFinite(totalGuess) ? totalGuess : 0;

  sendProgress({ phase: type, loaded: 0, total, percent: 0, text: `Recolectando ${type}... 0%` });

  let { box, scrollable } = await waitForBox(dialog, type);

  // si no hay overflow, parsea y salí
  if (!scrollable) {
    const finalUsers = parseUsersFromDialog(dialog);
    sendLog("INFO", `Sin scroll (${type}) - lista completa`, { count: finalUsers.length, total });
    await closeDialog();
    await sleep(650);
    return finalUsers;
  }

  await kickstartScrollable(box);

  sendLog("INFO", `Scrolleando ${type}...`, {});
  let prevHeight = box.scrollHeight;
  let stable = 0;
  let lastLoaded = 0;
  let pauseLevel = 0;

  for (let i = 0; i < 420; i++) {
    if (STOP) throw new Error("STOP");

    if (!box.isConnected || box.clientHeight === 0) {
      sendLog("WARN", "box murió, re-buscando...", { isConnected: box.isConnected, clientHeight: box.clientHeight });
      const res = await waitForBox(dialog, type);

      // si el nuevo box ya no es scrolleable, parseá y cortá
      if (!res.scrollable) {
        const finalUsers = parseUsersFromDialog(dialog);
        sendLog("INFO", `Sin scroll (${type}) - lista completa (re-find)`, { count: finalUsers.length, total });
        await closeDialog();
        await sleep(650);
        return finalUsers;
      }

      // reemplazamos referencia y seguimos
      box = res.box;
      scrollable = res.scrollable;
      await kickstartScrollable(box);
      prevHeight = box.scrollHeight;
    }

    // Scroll directo al final (EXACTO como en la versión que funcionaba)
    box.scrollTop = box.scrollHeight;
    await sleep(900 + Math.random() * 600);

    // Contar con 'a[href^="/"] span' como en la versión que funcionaba
    const loaded = dialog.querySelectorAll('a[href^="/"] span').length;

    let percent = 0;
    if (total > 0) percent = Math.max(0, Math.min(100, Math.round((loaded / total) * 100)));

    sendLog("DEBUG", `${type}: ${loaded} cargados...`, { percent, i });
    sendProgress({ phase: type, loaded, total, percent, text: `Recolectando ${type}... ${percent}%` });

    const h = box.scrollHeight;
    if (h === prevHeight && loaded === lastLoaded) {
      stable++;
      pauseLevel++;

      if (pauseLevel === 3) {
        sendLog("INFO", "Pausa corta (10s)...", { type });
        await sleep(10000);
      } else if (pauseLevel >= 5) {
        sendLog("WARN", "Scroll congelado, simulando micro-scrolls...", { type, pauseLevel });
        for (let j = 0; j < 10; j++) {
          box.scrollTop -= 250;
          await sleep(300);
          box.scrollTop = box.scrollHeight;
          await sleep(300);
        }
        pauseLevel = 0;
      }

      if (stable >= 6 && loaded > 10) {
        sendLog("INFO", `Corte por stable>=6 (${type})`, { loaded, stable });
        break;
      }
    } else {
      stable = 0;
      pauseLevel = 0;
    }

    prevHeight = h;
    lastLoaded = loaded;
  }

  const finalUsers = parseUsersFromDialog(dialog);
  sendLog("INFO", `Usuarios parseados (${type})`, { count: finalUsers.length });

  await closeDialog();
  await sleep(650);
  return finalUsers;
}

async function navToOwnProfile() {
  const BLACKLIST = new Set([
    "explore",
    "reels",
    "direct",
    "accounts",
    "notifications",
    "messages",
    "inbox",
    "tv",
    "p",
    "stories",
  ]);

  // 1) link "/usuario/" con <img> (avatar)
  const avatarLink = Array.from(document.querySelectorAll('a[href^="/"]')).find((a) => {
    const h = a.getAttribute("href") || "";
    if (!/^\/[A-Za-z0-9._]+\/$/.test(h)) return false;
    const u = h.split("/").filter(Boolean)[0];
    if (!u || BLACKLIST.has(u)) return false;
    return !!a.querySelector("img");
  });

  if (avatarLink) {
    const href = avatarLink.getAttribute("href");
    sendLog("INFO", "Navegando a tu perfil (avatar link)", { href });
    reactClick(avatarLink);

    const start = Date.now();
    while (Date.now() - start < 20000) {
      if (STOP) throw new Error("STOP");
      const hasFollowers = !!document.querySelector('a[href*="/followers"]');
      const hasFollowing = !!document.querySelector('a[href*="/following"]');
      if (hasFollowers && hasFollowing) {
        sendLog("INFO", "NAV_TO_OWN_PROFILE listo", { url: location.href });
        return true;
      }
      await sleep(350);
    }

    throw new Error("No llegué a tu perfil a tiempo. Abrí tu perfil manualmente y reintentá.");
  }

  // 2) fallback por links de 1 segmento (filtrando blacklist)
  const candidates = Array.from(document.querySelectorAll('a[href^="/"][role="link"], a[href^="/"]'))
    .map((a) => a.getAttribute("href"))
    .filter(Boolean);

  const likely = candidates.find((h) => {
    if (!h.startsWith("/")) return false;
    const parts = h.split("/").filter(Boolean);
    if (parts.length !== 1) return false;
    const u = parts[0];
    if (!u || u.length < 2) return false;
    if (BLACKLIST.has(u)) return false;
    return true;
  });

  if (!likely) throw new Error("Entrá a tu perfil (donde aparecen Followers/Following) y reintentá.");

  sendLog("INFO", "Navegando a tu perfil (fallback)", { href: likely });

  const a = document.querySelector(`a[href="${likely}"]`) || document.querySelector(`a[href="${likely}/"]`);
  if (!a) throw new Error("No pude clickear el link a tu perfil.");

  reactClick(a);

  const start = Date.now();
  while (Date.now() - start < 20000) {
    if (STOP) throw new Error("STOP");
    const hasFollowers = !!document.querySelector('a[href*="/followers"]');
    const hasFollowing = !!document.querySelector('a[href*="/following"]');
    if (hasFollowers && hasFollowing) {
      sendLog("INFO", "NAV_TO_OWN_PROFILE listo", { url: location.href });
      return true;
    }
    await sleep(350);
  }

  throw new Error("No llegué a tu perfil a tiempo. Abrí tu perfil manualmente y reintentá.");
}

async function runScan() {
  if (RUNNING) {
    sendLog("WARN", "runScan() ignorado (ya corriendo)", { url: location.href });
    return;
  }
  RUNNING = true;
  STOP = false;

  try {
    sendLog("INFO", "Iniciando runScan()", { url: location.href });

    const okProfile =
      !!document.querySelector('a[href*="/followers"]') &&
      !!document.querySelector('a[href*="/following"]');

    if (!okProfile) {
      await navToOwnProfile();
      // Esperar más tiempo para que el perfil se cargue completamente
      await sleep(1500);
    }

    const following = await scrollCollect("following", "/following");
    await sleep(1300);

    const followers = await scrollCollect("followers", "/followers");

    const noMeSiguen = following.filter((u) => !followers.includes(u)).sort();
    const noSigoYo = followers.filter((u) => !following.includes(u)).sort();

    sendLog("INFO", "Scan finalizado", {
      following: following.length,
      followers: followers.length,
      noMeSiguen: noMeSiguen.length,
      noSigoYo: noSigoYo.length,
    });

    chrome.runtime.sendMessage({
      type: "RESULT",
      result: { following, followers, noMeSiguen, noSigoYo },
    });
  } catch (err) {
    const msg = String(err?.message || err);
    if (msg === "STOP") {
      sendLog("WARN", "STOP recibido durante scan", {});
      chrome.runtime.sendMessage({ type: "ERROR", message: "Detenido." });
    } else {
      sendLog("ERROR", "Excepción en content", { message: msg });
      chrome.runtime.sendMessage({ type: "ERROR", message: msg });
    }
  } finally {
    RUNNING = false;
  }
}

// --- UNFOLLOW ---
async function waitForProfileHeader(username, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (STOP) throw new Error("STOP");
    if (location.pathname.toLowerCase().includes(`/${username.toLowerCase()}`)) return true;
    await sleep(250);
  }
  return false;
}

function findFollowButton() {
  const buttons = Array.from(document.querySelectorAll("button"));
  for (const b of buttons) {
    const t = (b.innerText || "").trim().toLowerCase();
    if (!t) continue;
    if (t === "following" || t === "siguiendo") return b;
    if (t.includes("following") || t.includes("siguiendo")) return b;
  }
  return null;
}

async function unfollowOne(username) {
  sendLog("INFO", "unfollowOne()", { username });
  sendProgress({ phase: "unfollow", loaded: 0, total: 0, percent: 0, text: `Buscando @${username}...` });

  location.href = `https://www.instagram.com/${username}`;

  const ok = await waitForProfileHeader(username, 20000);
  if (!ok) throw new Error(`No pude abrir el perfil de @${username}.`);

  await sleep(2500);

  let btn = null;
  for (let i = 0; i < 25; i++) {
    if (STOP) throw new Error("STOP");
    btn = findFollowButton();
    if (btn && btn.offsetParent !== null) break;
    await sleep(350);
  }

  if (!btn) throw new Error("No encontré el botón Siguiendo/Following.");

  reactClick(btn);
  await sleep(800);

  const start = Date.now();
  while (Date.now() - start < 12000) {
    if (STOP) throw new Error("STOP");

    const dialog = document.querySelector('div[role="dialog"]');
    if (dialog) {
      const options = Array.from(dialog.querySelectorAll("button"));
      const target = options.find((b) => {
        const t = (b.innerText || "").trim().toLowerCase();
        return t === "unfollow" || t === "dejar de seguir";
      });

      if (target) {
        reactClick(target);
        await sleep(900);
        await closeDialog();
        chrome.runtime.sendMessage({ type: "UNFOLLOW_DONE", username });
        return;
      }
    }

    await sleep(250);
  }

  throw new Error("No encontré la confirmación Unfollow/Dejar de seguir.");
}

// Mensajería
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (!msg?.type) return;

      if (msg.type === "PING") {
        sendResponse({ ok: true });
        return;
      }

      if (msg.type === "STOP") {
        STOP = true;
        sendLog("WARN", "STOP recibido", {});
        sendResponse({ ok: true });
        return;
      }

      if (msg.type === "SCAN_START") {
        STOP = false;
        sendLog("INFO", "SCAN_START recibido", { url: location.href });
        runScan();
        sendResponse({ ok: true });
        return;
      }

      if (msg.type === "UNFOLLOW_ONE") {
        STOP = false;
        await unfollowOne(msg.username);
        sendResponse({ ok: true });
        return;
      }
    } catch (err) {
      const message = String(err?.message || err);
      sendLog("ERROR", "Excepción en content", { message });
      chrome.runtime.sendMessage({ type: "ERROR", message });
      sendResponse({ ok: false, error: message });
    }
  })();

  return true;
});

sendLog("INFO", "content.js cargado", { url: location.href });
