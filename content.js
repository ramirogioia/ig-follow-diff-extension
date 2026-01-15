// content.js - IG Follow Diff (corre en instagram.com)
// FIXES:
// - Detecta contenedor scrolleable real (overflowY auto/scroll) en modal Following/Followers
// - Si NO hay overflow (listas chicas), parsea y sale
// - parseUsers soporta href relativos y absolutos
// - isVisible robusto (evita "reading 'display'")

let STOP = false;
let RUNNING = false;
let UNFOLLOW_RUNNING = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ============================================
// OVERLAY DE PROGRESO
// ============================================

let overlayElement = null;
const gifteraLogoSrc = (typeof chrome !== "undefined" && chrome.runtime?.getURL)
  ? chrome.runtime.getURL("icons/favicon_original.png")
  : "";
const gIconSrc = (typeof chrome !== "undefined" && chrome.runtime?.getURL)
  ? chrome.runtime.getURL("icons/icon48.png")
  : "";
let SELF_USERNAME = null;

function createOverlay() {
  if (overlayElement) return overlayElement;

  const overlay = document.createElement('div');
  overlay.id = 'igfd-overlay';
  overlay.innerHTML = `
    <div class="igfd-container">
      <div class="igfd-brand">
        <img src="${gifteraLogoSrc}" alt="Giftera" />
      </div>
      <div class="igfd-logo">
        <svg width="60" height="60" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10"/>
          <path d="M12 6v6l4 2"/>
        </svg>
      </div>
      <h1 class="igfd-title">G-Follow Inspector</h1>
      <p class="igfd-subtitle" id="igfd-phase">Starting...</p>
      
      <div class="igfd-progress-container">
        <div class="igfd-progress-bar">
          <div class="igfd-progress-fill" id="igfd-progress-fill"></div>
        </div>
        <div class="igfd-progress-text">
          <span id="igfd-percent">0%</span>
          <span id="igfd-count">0 / 0</span>
        </div>
      </div>
      
      <div class="igfd-stats">
        <div class="igfd-stat">
          <div class="igfd-stat-value" id="igfd-following">—</div>
          <div class="igfd-stat-label">Following</div>
        </div>
        <div class="igfd-stat">
          <div class="igfd-stat-value" id="igfd-followers">—</div>
          <div class="igfd-stat-label">Followers</div>
        </div>
      </div>
      
      <div class="igfd-tip" id="igfd-tip">
        <span class="igfd-tip-icon">⚠️</span>
        <span class="igfd-tip-text">Keep this window open while we work...</span>
        <span class="igfd-tip-icon">⚠️</span>
      </div>
      <div class="igfd-arrow-hint" id="igfd-arrow-hint" style="display:none;">
        <div class="igfd-popup-demo">
          <div class="igfd-popup-icon" style="background-image: url('${gIconSrc}');"></div>
          <div class="igfd-mouse-pointer"></div>
        </div>
        <div class="igfd-arrow-text">¡Check Extension to see the results!</div>
      </div>
      <button class="igfd-close-btn" id="igfd-close-btn" style="display:none;">Close worker window</button>
    </div>
  `;

  // Estilos
  const style = document.createElement('style');
  style.textContent = `
    #igfd-overlay {
      position: fixed;
      top: 0;
      left: 0;
      width: 100vw;
      height: 100vh;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      z-index: 999999;
      pointer-events: none;
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      color: white;
      animation: igfd-fade-in 0.3s ease;
    }
    
    @keyframes igfd-fade-in {
      from { opacity: 0; }
      to { opacity: 1; }
    }
    
    .igfd-container {
      text-align: center;
      max-width: 500px;
      padding: 40px;
      animation: igfd-slide-up 0.5s ease;
      pointer-events: auto;
    }
    
    @keyframes igfd-slide-up {
      from { 
        opacity: 0;
        transform: translateY(30px); 
      }
      to { 
        opacity: 1;
        transform: translateY(0); 
      }
    }
    
    .igfd-logo {
      width: 80px;
      height: 80px;
      margin: 0 auto 20px;
      background: rgba(255, 255, 255, 0.15);
      border-radius: 20px;
      display: flex;
      align-items: center;
      justify-content: center;
      animation: igfd-pulse 2s ease-in-out infinite;
    }

    .igfd-brand {
      width: 72px;
      height: 72px;
      margin: -20px auto 12px;
      display: flex;
      align-items: center;
      justify-content: center;
      animation: igfd-float 3s ease-in-out infinite;
    }

    .igfd-brand img {
      width: 72px;
      height: 72px;
      border-radius: 16px;
      box-shadow: 0 6px 14px rgba(0,0,0,0.2);
      object-fit: contain;
      background: rgba(255,255,255,0.08);
    }

    @keyframes igfd-float {
      0%, 100% { transform: translateY(0); }
      50% { transform: translateY(-6px); }
    }
    
    @keyframes igfd-pulse {
      0%, 100% { transform: scale(1); }
      50% { transform: scale(1.05); }
    }
    
    .igfd-logo svg {
      animation: igfd-spin 3s linear infinite;
    }
    
    @keyframes igfd-spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
    
    .igfd-title {
      font-size: 32px;
      font-weight: 700;
      margin: 0 0 10px;
      text-shadow: 0 2px 10px rgba(0,0,0,0.2);
    }
    
    .igfd-subtitle {
      font-size: 18px;
      margin: 0 0 40px;
      opacity: 0.9;
      font-weight: 500;
    }
    
    .igfd-progress-container {
      margin-bottom: 40px;
    }
    
    .igfd-progress-bar {
      width: 100%;
      height: 12px;
      background: rgba(255, 255, 255, 0.2);
      border-radius: 20px;
      overflow: hidden;
      margin-bottom: 12px;
      box-shadow: inset 0 2px 4px rgba(0,0,0,0.1);
    }
    
    .igfd-progress-fill {
      height: 100%;
      background: linear-gradient(90deg, #fff, rgba(255,255,255,0.8));
      border-radius: 20px;
      width: 0%;
      transition: width 0.3s ease;
      box-shadow: 0 0 10px rgba(255,255,255,0.5);
    }
    
    .igfd-progress-text {
      display: flex;
      justify-content: space-between;
      font-size: 14px;
      font-weight: 600;
      opacity: 0.9;
    }
    
    .igfd-stats {
      display: flex;
      gap: 30px;
      justify-content: center;
      margin-bottom: 30px;
    }
    
    .igfd-stat {
      background: rgba(255, 255, 255, 0.15);
      padding: 20px 30px;
      border-radius: 15px;
      backdrop-filter: blur(10px);
      min-width: 120px;
    }
    
    .igfd-stat-value {
      font-size: 32px;
      font-weight: 700;
      margin-bottom: 5px;
    }
    
    .igfd-stat-label {
      font-size: 13px;
      opacity: 0.8;
      text-transform: uppercase;
      letter-spacing: 1px;
      font-weight: 600;
    }
    
    .igfd-tip {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      justify-content: center;
      font-size: 16px;
      font-weight: 800;
      opacity: 0.9;
      padding: 6px 12px;
    }
    .igfd-tip-icon { font-size: 18px; }
    .igfd-tip-text { font-style: italic; }

    .igfd-close-btn {
      margin: 18px auto 0;
      padding: 10px 16px;
      background: #fff;
      color: #4c3fb3;
      border: none;
      border-radius: 12px;
      font-weight: 700;
      cursor: pointer;
      box-shadow: 0 6px 14px rgba(0,0,0,0.12);
      display: inline-block;
    }

    .igfd-close-btn:hover {
      filter: brightness(0.97);
    }

    .igfd-arrow-hint {
      margin-top: 12px;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 4px;
      color: rgba(255,255,255,0.9);
      font-weight: 700;
      animation: igfd-float 3s ease-in-out infinite;
    }

    .igfd-arrow-text {
      font-size: 13px;
      text-align: center;
      max-width: 260px;
    }

    .igfd-popup-demo {
      position: relative;
      width: 96px;
      height: 78px;
    }

    .igfd-popup-icon {
      width: 48px;
      height: 48px;
      background: #0b0b0b;
      border-radius: 12px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.22);
      background-size: 70%;
      background-position: center;
      background-repeat: no-repeat;
      margin: 0 auto;
      position: relative;
      top: 10px;
    }

    .igfd-mouse-pointer {
      position: absolute;
      width: 0;
      height: 0;
      border-left: 12px solid transparent;
      border-right: 12px solid transparent;
      border-top: 22px solid #ffffff;
      filter: drop-shadow(0 2px 6px rgba(0,0,0,0.18));
      left: 62px;
      top: 30px;
      transform-origin: top left;
      animation: igfd-mouse-click 1.3s ease-in-out infinite;
    }

    @keyframes igfd-mouse-click {
      0%, 100% { transform: translate(0, 0) scale(1); }
      50% { transform: translate(4px, 4px) scale(0.95); }
    }
  `;

  document.head.appendChild(style);
  document.body.appendChild(overlay);
  overlayElement = overlay;
  
  return overlay;
}

function showOverlay() {
  const overlay = createOverlay();
  overlay.style.display = 'flex';
  sendLog("INFO", "Overlay mostrado", {});
}

function hideOverlay() {
  if (overlayElement) {
    overlayElement.style.animation = 'igfd-fade-in 0.3s ease reverse';
    setTimeout(() => {
      overlayElement.style.display = 'none';
    }, 300);
    sendLog("INFO", "Overlay ocultado", {});
  }
}

function updateOverlay({ phase, loaded, total, percent, followingCount, followersCount, tipText }) {
  if (!overlayElement) return;
  
  const phaseEl = document.getElementById('igfd-phase');
  const fillEl = document.getElementById('igfd-progress-fill');
  const percentEl = document.getElementById('igfd-percent');
  const countEl = document.getElementById('igfd-count');
  const followingEl = document.getElementById('igfd-following');
  const followersEl = document.getElementById('igfd-followers');
  const tipEl = document.getElementById('igfd-tip');
  const closeBtn = document.getElementById('igfd-close-btn');
  const arrowHint = document.getElementById('igfd-arrow-hint');
  
  if (phaseEl && phase) {
    const phaseTexts = {
      'following': '📊 Collecting Following...',
      'followers': '📊 Collecting Followers...',
      'done': '✅ Done!',
    };
    phaseEl.textContent = phaseTexts[phase] || phase;
  }
  
  if (fillEl && typeof percent === 'number') {
    fillEl.style.width = `${Math.min(100, Math.max(0, percent))}%`;
  }
  
  if (percentEl && typeof percent === 'number') {
    percentEl.textContent = `${Math.round(percent)}%`;
  }
  
  if (countEl && typeof loaded === 'number' && typeof total === 'number') {
    countEl.textContent = `${loaded} / ${total}`;
  }
  
  if (followingEl && typeof followingCount === 'number') {
    followingEl.textContent = followingCount;
  }
  
  if (followersEl && typeof followersCount === 'number') {
    followersEl.textContent = followersCount;
  }

  if (tipEl && typeof tipText === 'string') {
    tipEl.textContent = tipText;
  }

  if (closeBtn) {
    closeBtn.style.display = phase === 'done' ? 'inline-block' : 'none';
  }

  if (arrowHint) {
    arrowHint.style.display = phase === 'done' ? 'flex' : 'none';
  }
}

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
  const safeLoaded = Number.isFinite(loaded) ? loaded : 0;
  const safeTotal = Number.isFinite(total) ? total : 0;
  const displayLoaded = safeTotal > 0 ? Math.min(safeLoaded, safeTotal) : safeLoaded;
  const displayTotal = safeTotal > 0 ? safeTotal : Math.max(safeTotal, displayLoaded);
  const displayPercent = safeTotal > 0 ? Math.min(100, Math.round((displayLoaded / safeTotal) * 100)) : percent;

  try {
    chrome.runtime.sendMessage({
      type: "PROGRESS",
      phase,
      loaded: displayLoaded,
      total: displayTotal,
      percent: displayPercent,
      text,
      fromTab: undefined,
    });
  } catch (_) {}
  
  // Actualizar overlay si existe
  updateOverlay({ phase, loaded: displayLoaded, total: displayTotal, percent: displayPercent });
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

function centerPointerClick(el) {
  if (!el) return;
  const rect = el.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const target = document.elementFromPoint(x, y) || el;
  const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window };
  try { target.dispatchEvent(new PointerEvent("pointerdown", opts)); } catch (_) {}
  try { target.dispatchEvent(new MouseEvent("mousedown", opts)); } catch (_) {}
  try { target.dispatchEvent(new PointerEvent("pointerup", opts)); } catch (_) {}
  try { target.dispatchEvent(new MouseEvent("mouseup", opts)); } catch (_) {}
  try { target.dispatchEvent(new MouseEvent("click", opts)); } catch (_) {}
  if (typeof target.click === "function") {
    try { target.click(); } catch (_) {}
  }
}

function strongClick(el) {
  if (!el) return;
  try {
    el.scrollIntoView({ block: "center", inline: "center" });
  } catch (_) {}
  try {
    dispatchHover(el);
    centerPointerClick(el);
    const child = el.querySelector("button, div[role='button'], span");
    if (child) centerPointerClick(child);
    reactClick(el);
    try { el.focus?.(); } catch (_) {}
    try { el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true })); } catch (_) {}
    try { el.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", bubbles: true })); } catch (_) {}
    try { el.dispatchEvent(new KeyboardEvent("keydown", { key: " ", code: "Space", bubbles: true })); } catch (_) {}
    try { el.dispatchEvent(new KeyboardEvent("keyup", { key: " ", code: "Space", bubbles: true })); } catch (_) {}
    if (typeof el.click === "function") el.click();
  } catch (_) {}
}

async function waitForDialog() {
  for (let i = 0; i < 60; i++) {
    const dialogs = Array.from(document.querySelectorAll('div[role="dialog"]'));
    if (dialogs.length) return dialogs[dialogs.length - 1]; // último abierto
    await sleep(250);
  }
  throw new Error("The modal did not open in time.");
}

async function waitForDialogContent(dialog, type) {
  for (let i = 0; i < 30; i++) { // ~9s
    const anchors = dialog.querySelectorAll('a[href]');
    const lis = dialog.querySelectorAll('li');
    const txt = (dialog.innerText || "").trim();
    if (anchors.length > 0 || lis.length > 0 || txt.length > 40) {
      if (i > 0) {
        sendLog("INFO", `Dialog content ready (${type})`, {
          anchors: anchors.length,
          lis: lis.length,
          textLen: txt.length,
          tries: i,
        });
      }
      return;
    }
    await sleep(300);
  }
  sendLog("WARN", `Dialog still empty (${type})`, {});
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
  
  if (candidate) return candidate;
  
  // Fallback: a veces Instagram renderiza la lista sin overflow (listas chicas)
  // usamos el <ul> o el propio dialog para parsear sin scroll
  const ul = dialog.querySelector("ul");
  if (ul) return ul;
  
  return null;
}

async function waitForBox(dialog, type) {
  // EXACTO como waitForScrollable en la versión que funcionaba
  for (let i = 0; i < 20; i++) {
    const box = findScrollBox(dialog);
    if (box) {
      const scrollable = isScrollable(box);
      sendLog("INFO", `ScrollBox listo (${type})`, {
        overflowY: getOverflowY(box),
        clientHeight: box.clientHeight,
        scrollHeight: box.scrollHeight,
        scrollable,
      });
      return { box, scrollable };
    }

    sendLog("DEBUG", `Waiting for box (${type})`, { i });
    await sleep(500); // 500ms como en la versión que funcionaba
  }

  // Fallback sin scroll: usar el dialog completo para parsear
  sendLog("WARN", `Scrollable container not found (${type}), using full dialog`, {});
  return { box: dialog, scrollable: false, fallback: true };
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

function parseUsersFromDialog(dialog, opts = { allowTextFallback: true }) {
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
    "instagram",
  ]);
  if (SELF_USERNAME) BLACK.add(SELF_USERNAME.toLowerCase());

  const anchors = Array.from(
    dialog.querySelectorAll('a[href^="/"], a[href^="https://www.instagram.com/"]')
  );

  const seen = new Set();
  const ordered = [];

  for (const a of anchors) {
    const u = normalizeUserFromHref(a.getAttribute("href"));
    if (!u) continue;
    const ul = u.toLowerCase();
    if (BLACK.has(ul)) continue;
    if (seen.has(ul)) continue;
    seen.add(ul);
    ordered.push(u);
  }

  // Fallback textual parsing cuando no hay anchors (listas cortas sin links)
  if (opts.allowTextFallback && ordered.length === 0 && anchors.length === 0) {
  const text = (dialog.innerText || "").split(/\s+/);
    for (const t of text) {
      const cleaned = t.replace(/^@/, "").replace(/[^A-Za-z0-9._]/g, "");
      if (!cleaned) continue;
      if (cleaned.length < 2 || cleaned.length > 32) continue;
      const cl = cleaned.toLowerCase();
      if (BLACK.has(cl)) continue;
      if (seen.has(cl)) continue;
      seen.add(cl);
      ordered.push(cleaned);
      if (ordered.length > 200) break; // evitar ruido
    }
    if (ordered.length > 0) {
      sendLog("INFO", "Usuarios detectados por fallback textual", { count: ordered.length });
    }
  }

  return ordered;
}

function debugDialogSnapshot(container, type) {
  try {
    const anchors = Array.from(container.querySelectorAll("a[href]")).slice(0, 8).map((a) => a.getAttribute("href"));
    const txt = (container.innerText || "").slice(0, 400);
    sendLog("INFO", `Dialog snapshot (${type})`, {
      anchorsSample: anchors,
      anchorsCount: container.querySelectorAll("a[href]").length,
      textSample: txt,
    });
    return {
      anchorsCount: container.querySelectorAll("a[href]").length,
      textLen: (container.innerText || "").length,
    };
  } catch (_) {}
  return { anchorsCount: 0, textLen: 0 };
}

async function waitForUsers(container, minCount = 1, type = "", maxMs = 12000, allowTextFallback = true) {
  let lastUsers = [];
  const tries = Math.max(4, Math.ceil(maxMs / 300));
  for (let i = 0; i < tries; i++) { // configurable máximo
    lastUsers = parseUsersFromDialog(container, { allowTextFallback });
    if (lastUsers.length >= minCount) {
      if (i > 0) {
        sendLog("INFO", `Usuarios listos tras esperar (${type})`, { tries: i, count: lastUsers.length });
      }
      return lastUsers;
    }
    await sleep(300);
  }
  // logear anclas visibles para debug
  const anchors = Array.from(container.querySelectorAll('a[href]'))
    .slice(0, 8)
    .map((a) => a.getAttribute("href"));
  sendLog("WARN", `Usuarios no llegaron al mínimo (${type})`, { minCount, got: lastUsers.length, anchorsSample: anchors });
  debugDialogSnapshot(container, type);
  return lastUsers;
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

  sendLog("INFO", `Opening modal ${type}`, { hrefPart, url: location.href });
  reactClick(btn);

  const dialog = await waitForDialog();
  // Espera base más larga para que Instagram cargue el contenido inicial (como en la versión que funcionaba)
  sendLog("INFO", `Waiting initial load of ${type}...`, {});
  await sleep(1500);
  await waitForDialogContent(dialog, type);
  return dialog;
}

async function scrollCollect(type, hrefPart, retrying = false) {
  await sleep(1500);
  const dialog = await openModal(type, hrefPart);

  const totalGuess =
    getCountFromProfileCounters(hrefPart) ||
    parseInt(dialog.querySelector("h1,h2,h3")?.innerText || "", 10) ||
    null;

  const total = Number.isFinite(totalGuess) ? totalGuess : 0;

  sendProgress({ phase: type, loaded: 0, total, percent: 0, text: `Collecting ${type}... 0%` });

  let { box, scrollable } = await waitForBox(dialog, type);

  // si no hay overflow, parsea y salí
  if (!scrollable) {
    // micro-scroll para despertar virtualized lists aunque no sean scrolleables
    try {
      await kickstartScrollable(box);
    } catch (_) {}
    const snap = debugDialogSnapshot(box, type);
    if (!retrying && snap && snap.anchorsCount === 0 && snap.textLen < 20 && total > 0) {
    sendLog("WARN", `Snapshot empty, reopening modal (${type})`, { total });
      await closeDialog();
      await sleep(600);
      return await scrollCollect(type, hrefPart, true);
    }
    // asegurar que el DOM cargó los anchors aunque no haya scroll
    const waitMs = total > 0 && total <= 50 ? 4000 : 12000;
    let finalUsers = await waitForUsers(box, total > 0 ? 1 : 0, type, waitMs, true);
    if (total > 0 && finalUsers.length > total) {
      sendLog("WARN", "Trimming followers to expected total (no-scroll)", { got: finalUsers.length, total });
      finalUsers = finalUsers.slice(0, total);
    }
    if (finalUsers.length === 0 && total > 0 && !retrying) {
      sendLog("WARN", `Retrying modal (${type}) because 0 users`, { total });
      await closeDialog();
      await sleep(800);
      return await scrollCollect(type, hrefPart, true);
    }
    sendLog("INFO", `No scroll (${type}) - full list`, { count: finalUsers.length, total });
    await closeDialog();
    await sleep(650);
    return finalUsers;
  }

  await kickstartScrollable(box);

  sendLog("INFO", `Scrolling ${type}...`, {});
  let prevHeight = box.scrollHeight;
  let stable = 0;
  let lastLoaded = 0;
  let pauseLevel = 0;

  for (let i = 0; i < 420; i++) {
    if (STOP) throw new Error("STOP");

    if (!box.isConnected || box.clientHeight === 0) {
    sendLog("WARN", "Scroll box disappeared, searching again...", { isConnected: box.isConnected, clientHeight: box.clientHeight });
      const res = await waitForBox(dialog, type);

      // si el nuevo box ya no es scrolleable, parseá y cortá
      if (!res.scrollable) {
        const finalUsers = parseUsersFromDialog(dialog);
        sendLog("INFO", `No scroll (${type}) - full list (re-find)`, { count: finalUsers.length, total });
        await closeDialog();
        await sleep(600);
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

    sendLog("DEBUG", `${type}: ${loaded} loaded...`, { percent, i });
    sendProgress({ phase: type, loaded, total, percent, text: `Collecting ${type}... ${percent}%` });

    // Salida rápida: si ya cargamos todo lo esperado, evitamos micro-scrolls
    if (total > 0 && loaded >= total) {
      sendLog("INFO", `Fin anticipado por total alcanzado (${type})`, { loaded, total });
      break;
    }

    const h = box.scrollHeight;
    if (h === prevHeight && loaded === lastLoaded) {
      stable++;
      pauseLevel++;

      const smallList = total > 0 && total <= 50;

      if (!smallList && pauseLevel === 3) {
        sendLog("INFO", "Short pause (10s)...", { type });
        await sleep(10000);
      } else if (!smallList && pauseLevel >= 5) {
        sendLog("WARN", "Scroll stalled, simulating micro-scrolls...", { type, pauseLevel });
        for (let j = 0; j < 10; j++) {
          box.scrollTop -= 250;
          await sleep(300);
          box.scrollTop = box.scrollHeight;
          await sleep(300);
        }
        pauseLevel = 0;
      }

      if (stable >= (smallList ? 2 : 6) && loaded >= Math.min(total || 0, 10)) {
        sendLog("INFO", `Stop due to stable (${type})`, { loaded, stable, smallList });
        break;
      }
    } else {
      stable = 0;
      pauseLevel = 0;
    }

    prevHeight = h;
    lastLoaded = loaded;
  }

  let finalUsers = parseUsersFromDialog(dialog, { allowTextFallback: false });
  if (total > 0 && finalUsers.length > total) {
    sendLog("WARN", "Trimming followers to expected total", { got: finalUsers.length, total });
    finalUsers = finalUsers.slice(0, total);
  }
  sendLog("INFO", `Users parsed (${type})`, { count: finalUsers.length });

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
    try {
      const u = href.split("/").filter(Boolean)[0];
      if (u) SELF_USERNAME = u.toLowerCase();
    } catch (_) {}
    sendLog("INFO", "Navigating to your profile (avatar link)", { href });
    reactClick(avatarLink);

    const start = Date.now();
    while (Date.now() - start < 20000) {
      if (STOP) throw new Error("STOP");
      const hasFollowers = !!document.querySelector('a[href*="/followers"]');
      const hasFollowing = !!document.querySelector('a[href*="/following"]');
      if (hasFollowers && hasFollowing) {
        sendLog("INFO", "NAV_TO_OWN_PROFILE listo", { url: location.href });
        try {
          chrome.runtime.sendMessage({ type: "PROFILE_HREF", href });
        } catch (_) {}
        try {
          const u = location.pathname.split("/").filter(Boolean)[0];
          if (u) SELF_USERNAME = u.toLowerCase();
        } catch (_) {}
        return true;
      }
      await sleep(350);
    }

    throw new Error("Did not reach your profile in time. Open it manually and retry.");
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

  if (!likely) throw new Error("Open your profile (where Followers/Following appear) and retry.");

  sendLog("INFO", "Navigating to your profile (fallback)", { href: likely });

  const a = document.querySelector(`a[href="${likely}"]`) || document.querySelector(`a[href="${likely}/"]`);
  if (!a) throw new Error("Could not click the link to your profile.");

  reactClick(a);

  const start = Date.now();
  while (Date.now() - start < 20000) {
    if (STOP) throw new Error("STOP");
    const hasFollowers = !!document.querySelector('a[href*="/followers"]');
    const hasFollowing = !!document.querySelector('a[href*="/following"]');
    if (hasFollowers && hasFollowing) {
      sendLog("INFO", "NAV_TO_OWN_PROFILE listo (fallback)", { url: location.href });
      return true;
    }
    await sleep(350);
  }

  throw new Error("Did not reach your profile in time. Open it manually and retry.");
}

// ============================================
// UNFOLLOW FLOW
// ============================================

function normalizeText(value) {
  return (typeof value === "string" ? value : (value?.innerText || value?.textContent || ""))
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

async function waitFor(fn, timeout = 12000, interval = 300) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const res = await fn();
    if (res) return res;
    await sleep(interval);
  }
  return null;
}

function findFollowButtonCandidate() {
  const buttons = Array.from(document.querySelectorAll('button, div[role="button"]')).filter(isVisible);
  const matchText = (btn) => {
    const t = normalizeText(btn);
    return (
      t.includes("following") ||
      t.includes("siguiendo") ||
      t.includes("requested") ||
      t.includes("solicitado")
    );
  };

  const textBtn = buttons.find(matchText);
  if (textBtn) return textBtn;

  const labelBtn = buttons.find((btn) => {
    const label = normalizeText(btn.getAttribute("aria-label") || "");
    return label.includes("following") || label.includes("siguiendo");
  });
  if (labelBtn) return labelBtn;

  // Fallback: first button that contains a child with text "Following"
  const deepBtn = buttons.find((btn) => {
    const txt = normalizeText(btn.innerText || btn.textContent || "");
    return txt.includes("following") || txt.includes("siguiendo");
  });
  return deepBtn || null;
}

async function waitForFollowButton(timeout = 15000) {
  return waitFor(() => findFollowButtonCandidate(), timeout, 300);
}

async function waitForUnfollowConfirm(timeout = 7000) {
  return waitFor(() => {
    const buttons = Array.from(document.querySelectorAll('button, div[role="button"]'));
    return (
      buttons.find((b) => {
        const t = normalizeText(b);
        return t.includes("unfollow") || t.includes("dejar de seguir");
      }) || null
    );
  }, timeout, 200);
}

async function ensureOnProfile(username) {
  const clean = username.toLowerCase();
  const targetPath = `/${clean}/`;
  if (!location.pathname.toLowerCase().includes(targetPath)) {
    location.href = `https://www.instagram.com${targetPath}`;
    const ok = await waitFor(
      () => location.pathname.toLowerCase().includes(targetPath),
      15000,
      400
    );
    if (!ok) throw new Error("Could not open the profile page.");
    await sleep(900);
  }
  return true;
}

async function waitForProfileReady(timeout = 15000) {
  return waitFor(() => {
    const header = document.querySelector("header");
    const hasFollow = findFollowButtonCandidate();
    const hasCounters = document.querySelector('a[href*="/followers"]') && document.querySelector('a[href*="/following"]');
    return header && (hasFollow || hasCounters);
  }, timeout, 300);
}

async function unfollowUser(username) {
  const clean = String(username || "").replace(/^@/, "").trim();
  if (!clean) throw new Error("Username missing");
  if (UNFOLLOW_RUNNING) throw new Error("Another unfollow is already running.");

  UNFOLLOW_RUNNING = true;
  try {
    await ensureOnProfile(clean);
    await waitForProfileReady(15000);
    await sleep(400);

    const btn = await waitForFollowButton(15000);
    if (!btn) throw new Error("Follow/Following button not found.");

    const btnText = normalizeText(btn);
    sendLog("INFO", "UNFOLLOW_BTN", { text: btnText, username: clean });

    if (btnText.includes("follow") || btnText.includes("seguir")) {
      return { ok: true, message: `Already not following @${clean}` };
    }

    // Intentar abrir el menú (Following) con reintentos cortos
    let confirm = null;
    for (let i = 0; i < 3; i++) {
      strongClick(btn);
      await sleep(600 + i * 200);
      confirm = await waitForUnfollowConfirm(1800 + i * 600);
      if (confirm) break;
    }
    if (!confirm) throw new Error("Unfollow confirmation not found.");

    // Click en Unfollow con reintentos
    let confirmed = false;
    for (let i = 0; i < 3; i++) {
      strongClick(confirm);
      await sleep(700 + i * 200);
      const backToFollow = await waitFor(() => {
        const candidate = findFollowButtonCandidate();
        if (!candidate) return null;
        const t = normalizeText(candidate);
        return t.includes("follow") || t.includes("seguir") ? candidate : null;
      }, 2000, 250);
      if (backToFollow) {
        confirmed = true;
        break;
      }
    }

    const finalState = confirmed
      ? true
      : await waitFor(() => {
          const candidate = findFollowButtonCandidate();
          if (!candidate) return null;
          const t = normalizeText(candidate);
          return t.includes("follow") || t.includes("seguir") ? candidate : null;
        }, 10000, 300);

    const ok = Boolean(finalState);
    const message = ok
      ? `Unfollowed @${clean}`
      : `Unfollowed @${clean} (could not confirm state)`;
    sendLog("INFO", "UNFOLLOW_DONE_LOCAL", { username: clean, ok, message });
    return { ok, message };
  } finally {
    UNFOLLOW_RUNNING = false;
  }
}

async function runScan() {
  if (RUNNING) {
    sendLog("WARN", "runScan() ignorado (ya corriendo)", { url: location.href });
    return;
  }
  RUNNING = true;
  STOP = false;

  try {
    if (!location.hostname.includes("instagram.com")) {
      throw new Error("Open instagram.com and run the scan again.");
    }
    const loginForm = document.querySelector('form[action="/accounts/login/"], form[action="/accounts/login/ajax/"]');
    if (loginForm) {
      throw new Error("You must be logged in to Instagram to run the scan.");
    }

    sendLog("INFO", "Starting runScan()", { url: location.href });
    
    // Mostrar overlay de progreso
    showOverlay();
    updateOverlay({ 
      phase: 'starting', 
      loaded: 0, 
      total: 0, 
      percent: 0 
    });

    const okProfile =
      !!document.querySelector('a[href*="/followers"]') &&
      !!document.querySelector('a[href*="/following"]');

    if (!okProfile) {
      await navToOwnProfile();
      // Extra wait to let the profile load completely
      await sleep(1200);
    } else {
      try {
        const href = location.pathname.endsWith("/") ? location.pathname : `${location.pathname}/`;
        chrome.runtime.sendMessage({ type: "PROFILE_HREF", href });
      const u = location.pathname.split("/").filter(Boolean)[0];
      if (u) SELF_USERNAME = u.toLowerCase();
      } catch (_) {}
    }

    const following = await scrollCollect("following", "/following");
    
    // Actualizar contador de following
    updateOverlay({ followingCount: following.length });
    
    await sleep(1300);

    const followers = await scrollCollect("followers", "/followers");
    
    // Actualizar contador de followers
    updateOverlay({ followersCount: followers.length });

    const noMeSiguen = following.filter((u) => !followers.includes(u)).sort();
    const noSigoYo = followers.filter((u) => !following.includes(u)).sort();

    sendLog("INFO", "Scan finalizado", {
      following: following.length,
      followers: followers.length,
      noMeSiguen: noMeSiguen.length,
      noSigoYo: noSigoYo.length,
    });
    
    // Mostrar completado y mantener overlay visible
    updateOverlay({ 
      phase: 'done', 
      percent: 100,
      followingCount: following.length,
      followersCount: followers.length,
      tipText: 'Finished. Close this window and review the report in the popup.'
    });

    chrome.runtime.sendMessage({
      type: "RESULT",
      result: { following, followers, noMeSiguen, noSigoYo },
    });
  } catch (err) {
    const msg = String(err?.message || err);
    
    if (msg === "STOP") {
      // Mantener overlay visible con mensaje de stop
      showOverlay();
      updateOverlay({
        phase: "done",
        percent: 0,
        tipText: "Stopped. You can close this window and check the popup.",
      });
      sendLog("WARN", "STOP received during scan", {});
      chrome.runtime.sendMessage({ type: "ERROR", message: "Stopped." });
    } else {
      // Ocultar overlay en caso de error
      hideOverlay();
      sendLog("ERROR", "Exception in content", { message: msg });
      chrome.runtime.sendMessage({ type: "ERROR", message: msg });
    }
  } finally {
    RUNNING = false;
  }
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

      if (msg.type === "UNFOLLOW") {
        const username = msg.username || "";
        try {
          const res = await unfollowUser(username);
          try {
            chrome.runtime.sendMessage({ type: "UNFOLLOW_DONE", ok: true, username, message: res?.message });
          } catch (_) {}
          sendResponse({ ok: true, message: res?.message || "", result: res });
        } catch (err) {
          const message = String(err?.message || err);
          sendLog("ERROR", "UNFOLLOW_FAILED", { username, message });
          try {
            chrome.runtime.sendMessage({ type: "UNFOLLOW_DONE", ok: false, username, message });
          } catch (_) {}
          sendResponse({ ok: false, error: message });
        }
        return;
      }

      if (msg.type === "SCAN_START") {
        STOP = false;
        sendLog("INFO", "SCAN_START recibido", { url: location.href });
        runScan();
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

// Botón cerrar worker desde overlay
document.addEventListener("click", (ev) => {
  const target = ev.target;
  if (target && target.id === "igfd-close-btn") {
    try {
      chrome.runtime.sendMessage({ type: "BG_CLEAR_WORKER" });
    } catch (_) {}
  }
});

sendLog("INFO", "content.js loaded", { url: location.href });
