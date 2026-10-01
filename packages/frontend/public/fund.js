// ============================================================================
// murmur · fund — the standalone onramp page logic (W8-1b).
// ----------------------------------------------------------------------------
// One job: collect a destination address, ask OUR worker to mint a short-lived
// Circle hosted-onramp session (POST /api/onramp/session — the key never
// touches the browser), and hand the session to the hosted widget in a popup
// (https://onramp.arc.io/?sessionToken=…).
//
// HONEST CONTRACT: every failure has a named, localized reason and the page
// says plainly that nothing was charged. The popup window is opened
// SYNCHRONOUSLY on the click (the only popup-blocker-safe pattern) and is
// either pointed at the widget or closed again — never left blank.
// i18n shares the site dictionary (i18n.js → i18n-ui.js, fund.* keys ×7).
// ============================================================================

import { t as T, currentLang, getLang, setLang, applyDom, SUPPORTED, ENDONYMS, RTL } from "./i18n.js?v=76";

const $ = (id) => document.getElementById(id);

// Same API base contract as app.js: same-origin "/api" by default, overridable
// for local rehearsal via ?api= / the saved murmur-api key (the :3000 showcase
// proxies /api to the live worker).
const params = new URLSearchParams(location.search);
const API = params.get("api") || (() => { try { return localStorage.getItem("murmur-api") || "/api"; } catch { return "/api"; } })();

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

// ---------- theme (mirror of app.js initTheme, minus the palette hooks) ----------
function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem("murmur-theme"); } catch { /* private mode */ }
  if (saved === "dark" || saved === "light") document.documentElement.dataset.theme = saved;
  const meta = document.querySelector('meta[name="theme-color"]');
  const dark = document.documentElement.dataset.theme === "dark";
  if (meta) meta.content = dark ? "#1a191e" : "#f2eee6";
  const btn = $("fund-theme");
  if (btn) btn.textContent = dark ? "\u2600" : "\u263e";
}
$("fund-theme").addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem("murmur-theme", next); } catch { /* ignore */ }
  initTheme();
});

// ---------- language (shared dictionary, own selector) ----------
function buildLangSelect() {
  const sel = $("fund-lang");
  sel.innerHTML = "";
  for (const code of SUPPORTED) {
    const opt = document.createElement("option");
    opt.value = code;
    opt.textContent = ENDONYMS[code] ?? code;
    sel.appendChild(opt);
  }
  sel.value = currentLang();
  sel.addEventListener("change", () => {
    setLang(sel.value);
    applyI18n();
  });
}
function applyI18n() {
  const lang = currentLang();
  document.documentElement.lang = lang;
  document.documentElement.dir = RTL.has(lang) ? "rtl" : "ltr";
  applyDom(document);
  document.title = "murmur · " + T("fund.title");
  validate(); // re-render the live validation copy in the new language
}

// ---------- address validation + buy ----------
let lastStatusKey = null;
function status(text, ok = false) {
  const el = $("fund-status");
  el.textContent = text || "";
  el.classList.toggle("is-ok", ok);
}
function validate() {
  const addr = ($("fund-address").value || "").trim();
  const ok = ADDRESS_RE.test(addr);
  $("fund-buy").disabled = !ok || lastStatusKey === "buying";
  if (lastStatusKey === "buying") return;
  if (addr.length === 0) status("");
  else if (!ok) status(T("fund.errAddress"));
  else status("", true);
}

const ERR_KEY = {
  bad_request: "fund.errAddress",
  not_configured: "fund.errNotConfigured",
  rate_limited: "fund.errRate",
  circle_auth_failed: "fund.errAuth",
  circle_forbidden: "fund.errForbidden",
  upstream_rejected: "fund.errUpstream",
  upstream_error: "fund.errUpstream",
};

$("fund-buy").addEventListener("click", async () => {
  const addr = ($("fund-address").value || "").trim();
  if (!ADDRESS_RE.test(addr)) { status(T("fund.errAddress")); return; }

  // Open the popup SYNCHRONOUSLY (a window opened after an await is popup-blocked),
  // then aim it at the widget — or close it again on any failure. Never left blank.
  // NOTE: deliberately NOT "noopener" — per spec that makes window.open return null
  // (the window opens but nobody can navigate it). app-kit's own popup mode keeps
  // the opener handle for its postMessage handshake; we do the same and simply
  // point the window at the origin-pinned URL our own worker returned.
  const win = window.open("", "_blank");
  if (!win) { status(T("fund.window")); return; }

  lastStatusKey = "buying";
  $("fund-buy").disabled = true;
  status(T("fund.buying"), true);

  let session = null;
  try {
    const resp = await fetch(API + "/onramp/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ destinationAddress: addr }),
    });
    const out = await resp.json().catch(() => null);
    if (out && out.ok && typeof out.widgetUrl === "string") session = out;
    else status(T(ERR_KEY[out?.reason] ?? "fund.errUpstream"));
  } catch {
    status(T("fund.errUpstream"));
  }

  if (session) {
    $("fund-sandbox").hidden = !session.sandbox;   // honest: sandbox sessions say so, loudly
    win.location.href = session.widgetUrl;         // sessionToken ONLY — never the address (app-kit contract)
    status("", true);
  } else {
    win.close();
  }
  lastStatusKey = null;
  validate();
});

// ---------- boot ----------
$("fund-address").addEventListener("input", validate);
initTheme();
buildLangSelect();
// ?address=0x… prefill (validated — a bad query param is ignored, never autofilled blindly)
const prefill = (params.get("address") || "").trim();
if (ADDRESS_RE.test(prefill)) $("fund-address").value = prefill;
applyI18n();
validate();
