// Shared helpers for the scheduler and supervisor pages.
const $ = s => document.querySelector(s);
const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
async function api(path, opts = {}) {
  const r = await fetch("/api/" + path, { ...opts, headers: { "content-type": "application/json", ...(opts.headers || {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || ("Request failed (" + r.status + ")"));
  return j;
}
let toastT;
function toast(m) { const t = $("#toast"); t.textContent = m; t.classList.add("show"); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("show"), 3200); }
const fmtSlot = d => new Date(d).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" });
const fmtShort = d => new Date(d).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" });
const fmtWhen = d => new Date(d).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const STATUS_LABEL = { New: "New", Sent: "Options sent", Stalled: "Stalled", NeedsOptions: "Needs new options", CallRequested: "Call requested", Scheduled: "Scheduled" };

async function loadUser() {
  try {
    const r = await fetch("/.auth/me"); const j = await r.json();
    const p = j.clientPrincipal;
    $("#user").innerHTML = p ? `Signed in as <b>${esc(p.userDetails)}</b> (${p.identityProvider === "github" ? "GitHub" : "Microsoft"}) · <a href="/.auth/logout?post_logout_redirect_uri=/login.html">Sign out</a>` : `<a href="/login.html">Sign in</a>`;
  } catch { /* local preview */ }
}

async function loadHealth() {
  try {
    const h = await api("health");
    const svc = [["Azure SQL", h.sql], ["Azure Maps" + (h.mapsLiveRoutes ? ` · ${h.mapsLiveRoutes} live routes` : ""), h.maps], ["Azure OpenAI", h.openai],
      ["Communication Services email", h.email], ["Application Insights", h.appInsights], ["Static Web Apps + Entra sign-in", true], ["Functions", true]];
    $("#azure").innerHTML = `<b>Running live on Azure:</b>` + svc.map(([n, on]) => `<span class="svc ${on ? "on" : ""}"><i></i>${esc(n)}</span>`).join("");
    window.__health = h;
  } catch (e) { $("#azure").innerHTML = `<span class="svc"><i></i>API unreachable: ${esc(e.message)}</span>`; }
}

async function loadKpis() {
  const k = await api("kpis");
  const within = k.Scheduled ? Math.round(100 * k.Within7 / k.Scheduled) : 0;
  const avg = k.AvgDays == null ? 0 : k.AvgDays;
  $("#kpis").innerHTML = `
   <div class="kpi"><div class="l">Open consults</div><div class="v">${k.OpenCount}</div><div class="s">${k.PastStandard} past the 7-day scheduling standard</div></div>
   <div class="kpi ${avg <= 7 ? "good" : "bad"}"><div class="l">Avg days, consult to scheduled</div><div class="v">${avg.toFixed(1)}</div><div class="s">${k.Scheduled} scheduled</div></div>
   <div class="kpi ${within >= 80 ? "good" : "bad"}"><div class="l">Scheduled within 7 days</div><div class="v">${within}%</div><div class="s">Standard: 7 days</div></div>
   <div class="kpi ${k.Stalled ? "bad" : "good"}"><div class="l">Stalled, needs action</div><div class="v">${k.Stalled}</div><div class="s">Auto-escalated on day 3</div></div>
   <div class="kpi hero"><div class="l">Days of waiting saved</div><div class="v">${(k.DaysSaved || 0).toLocaleString()}</div><div class="s">vs. booking the home clinic only</div></div>`;
}
