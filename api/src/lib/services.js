// Thin wrappers around Azure Maps, Azure OpenAI and Azure Communication Services.
// Each one degrades gracefully so the demo keeps working if a service is missing.
const { estDrive } = require("./db");

const MAPS_KEY = () => process.env.MAPS_KEY;

// Azure Maps Route Matrix (sync): one origin, many destinations. Returns minutes per destination.
async function driveMinutes(origin, dests) {
  if (MAPS_KEY() && dests.length) {
    try {
      const url = `https://atlas.microsoft.com/route/matrix/sync/json?api-version=1.0&routeType=fastest&travelMode=car&subscription-key=${encodeURIComponent(MAPS_KEY())}`;
      const body = {
        origins: { type: "MultiPoint", coordinates: [[origin[1], origin[0]]] },
        destinations: { type: "MultiPoint", coordinates: dests.map(d => [d[1], d[0]]) }
      };
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (r.ok) {
        const j = await r.json();
        const row = (j.matrix && j.matrix[0]) || [];
        const out = dests.map((d, i) => {
          const s = row[i] && row[i].response && row[i].response.routeSummary;
          return s ? { minutes: Math.max(5, Math.round(s.travelTimeInSeconds / 60)), source: "azure-maps" } : { minutes: estDrive(origin, d), source: "estimate" };
        });
        return out;
      }
    } catch (e) { /* fall through to estimate */ }
  }
  return dests.map(d => ({ minutes: estDrive(origin, d), source: "estimate" }));
}

// Azure Maps static image with numbered pins. Returns { buf, type } or null.
async function staticMap(home, pins) {
  if (!MAPS_KEY()) return null;
  const all = [home, ...pins];
  const lats = all.map(p => p[0]), lons = all.map(p => p[1]);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats), minLon = Math.min(...lons), maxLon = Math.max(...lons);
  const center = [(minLon + maxLon) / 2, (minLat + maxLat) / 2];
  const W = 640, H = 320;
  const spanLon = Math.max(0.05, (maxLon - minLon) * 1.35), spanLat = Math.max(0.05, (maxLat - minLat) * 1.35);
  const zoom = Math.max(5, Math.min(12, Math.floor(Math.min(Math.log2(W * 360 / (256 * spanLon)), Math.log2(H * 170 / (256 * spanLat))))));
  const colors = ["157347", "1d5fbf", "7a4fd6"];
  const pinVals = [`default|co0b2545|lcFFFFFF||'H'${home[1]} ${home[0]}`]
    .concat(pins.map((p, i) => `default|co${colors[i % 3]}|lcFFFFFF||'${i + 1}'${p[1]} ${p[0]}`));
  const url = `https://atlas.microsoft.com/map/static?api-version=2024-04-01&tilesetId=microsoft.base.road&width=${W}&height=${H}` +
    `&center=${center[0].toFixed(4)},${center[1].toFixed(4)}&zoom=${zoom}` + pinVals.map(v => "&pins=" + encodeURIComponent(v)).join("") +
    `&subscription-key=${encodeURIComponent(MAPS_KEY())}`;
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    return { buf: Buffer.from(await r.arrayBuffer()), type: r.headers.get("content-type") || "image/png" };
  } catch { return null; }
}

// Azure OpenAI chat completion. Returns text or null.
async function ai(system, user, maxTokens = 220) {
  const ep = process.env.AOAI_ENDPOINT, key = process.env.AOAI_KEY, dep = process.env.AOAI_DEPLOYMENT;
  if (!ep || !key || !dep) return null;
  try {
    const r = await fetch(`${ep.replace(/\/$/, "")}/openai/deployments/${dep}/chat/completions?api-version=2024-10-21`, {
      method: "POST", headers: { "content-type": "application/json", "api-key": key },
      body: JSON.stringify({ messages: [{ role: "system", content: system }, { role: "user", content: user }], max_tokens: maxTokens, temperature: 0.4 })
    });
    if (!r.ok) return null;
    const j = await r.json();
    return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content || "").trim() || null;
  } catch { return null; }
}

// Azure Communication Services email.
async function sendEmail(to, subject, text, html) {
  const conn = process.env.ACS_CONNECTION, from = process.env.ACS_SENDER;
  if (!conn || !from || !to) return { sent: false, reason: "email not configured" };
  try {
    const { EmailClient } = require("@azure/communication-email");
    const client = new EmailClient(conn);
    const poller = await client.beginSend({ senderAddress: from, recipients: { to: [{ address: to }] }, content: { subject, plainText: text, html } });
    const res = await poller.pollUntilDone();
    return { sent: res.status === "Succeeded", id: res.id, status: res.status };
  } catch (e) { return { sent: false, reason: String(e.message || e).slice(0, 200) }; }
}

module.exports = { driveMinutes, staticMap, ai, sendEmail };
