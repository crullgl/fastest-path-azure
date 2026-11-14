const { app } = require("@azure/functions");
const crypto = require("crypto");
const D = require("../lib/data");
const { q, ensure, seed, log } = require("../lib/db");
const { buildOptions, SITE } = require("../lib/rank");
const { ai, sendEmail, staticMap } = require("../lib/services");
const { escalateDue } = require("../lib/escalate");

const json = (body, status = 200) => ({ status, jsonBody: body, headers: { "cache-control": "no-store" } });
const fmtSlot = d => new Date(d).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" });
function principal(req) {
  try { return JSON.parse(Buffer.from(req.headers.get("x-ms-client-principal") || "", "base64").toString()) || {}; } catch { return {}; }
}
const who = req => principal(req).userDetails || "scheduler";
const userEmail = req => { const u = principal(req).userDetails || ""; return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(u) ? u : null; };
const isAdmin = req => { const e = (userEmail(req) || "").toLowerCase(); return !!e && (process.env.ADMIN_EMAILS || "").toLowerCase().split(/[,; ]+/).includes(e); };
const publicUrl = () => (process.env.PUBLIC_URL || "").replace(/\/$/, "");

function route(name, methods, path, fn) {
  app.http(name, {
    methods, route: path, authLevel: "anonymous",
    handler: async (req, ctx) => {
      try { await ensure(); if (["consults", "kpis", "supervisor"].includes(name)) await escalateDue(ctx).catch(e => ctx.error(e)); return await fn(req, ctx); }
      catch (e) { ctx.error(e); return json({ error: String(e.message || e) }, 500); }
    }
  });
}

async function getConsult(id) {
  const r = await q("SELECT * FROM dbo.Consult WHERE ConsultId=@id", { id });
  return r.recordset[0] || null;
}

// ---------- scheduler ----------
route("consults", ["GET"], "consults", async () => {
  const r = await q(`
    SELECT c.ConsultId, c.FirstName, c.LastName, c.City, c.Specialty, c.Priority, c.ContactPref, c.Status, c.CallbackAssigned,
           DATEDIFF(day, CAST(c.ReceivedAt AS date), CAST(COALESCE(c.ScheduledAt, SYSUTCDATETIME()) AS date)) AS AgeDays
    FROM dbo.Consult c`);
  return json(r.recordset);
});

route("consultDetail", ["GET"], "consults/{id}", async req => {
  const c = await getConsult(req.params.id);
  if (!c) return json({ error: "not found" }, 404);
  const [opts, logs, out] = await Promise.all([
    buildOptions(c),
    q("SELECT At, Kind, Text FROM dbo.ContactLog WHERE ConsultId=@id ORDER BY At DESC, LogId DESC", { id: c.ConsultId }),
    q("SELECT TOP 1 * FROM dbo.Outreach WHERE ConsultId=@id ORDER BY SentAt DESC", { id: c.ConsultId })
  ]);
  const age = (await q("SELECT DATEDIFF(day, CAST(@r AS date), CAST(COALESCE(@s, SYSUTCDATETIME()) AS date)) AS d", { r: c.ReceivedAt, s: c.ScheduledAt })).recordset[0].d;
  let booked = null;
  if (c.Status === "Scheduled") {
    const s = c.BookedSlotId ? (await q("SELECT SlotStart FROM dbo.Slot WHERE SlotId=@id", { id: c.BookedSlotId })).recordset[0] : null;
    booked = { siteId: c.BookedSiteId, name: SITE[c.BookedSiteId] && SITE[c.BookedSiteId].name, start: s && s.SlotStart, days: c.BookedDays, drive: c.BookedDrive, homeDays: c.HomeEarliestDays };
  }
  return json({ consult: { ...c, AgeDays: age }, ...opts, log: logs.recordset, outreach: out.recordset[0] || null, booked });
});

async function bookSlot(c, slotId, via) {
  const opts = await buildOptions(c);
  const upd = await q("UPDATE dbo.Slot SET IsBooked=1 OUTPUT inserted.SiteId, inserted.SlotStart WHERE SlotId=@id AND IsBooked=0", { id: slotId });
  const s = upd.recordset[0];
  if (!s) throw new Error("That slot was just taken. Pick another.");
  const o = opts.options.find(x => x.siteId === s.SiteId);
  await q(`UPDATE dbo.Consult SET Status='Scheduled', BookedSlotId=@slot, BookedSiteId=@site, ScheduledAt=SYSUTCDATETIME(),
           HomeEarliestDays=@hd, BookedDays=@bd, BookedDrive=@dr, DeclineReason=NULL WHERE ConsultId=@id`,
    { slot: slotId, site: s.SiteId, hd: opts.home ? opts.home.days : null, bd: o ? o.days : null, dr: o ? o.drive : null, id: c.ConsultId });
  await log(c.ConsultId, "book", `Booked ${fmtSlot(s.SlotStart)} at ${SITE[s.SiteId].name} (${via})`);
  return { site: SITE[s.SiteId].name, start: s.SlotStart, days: o && o.days, homeDays: opts.home && opts.home.days };
}

route("outreach", ["POST"], "consults/{id}/outreach", async (req, ctx) => {
  const c = await getConsult(req.params.id);
  const body = await req.json().catch(() => ({}));
  const opts = await buildOptions(c);
  const keys = (body.keys && body.keys.length ? body.keys : opts.options.filter(o => o.selectable).slice(0, 3).map(o => o.siteId)).slice(0, 3);
  const chosen = keys.map(k => opts.options.find(o => o.siteId === k)).filter(Boolean);
  if (!chosen.length) return json({ error: "No options selected" }, 400);
  const token = crypto.randomBytes(16).toString("hex");
  const lines = chosen.map((o, i) => `${i + 1}) ${fmtSlot(o.slots[0].start)} at ${o.name}${o.type === "CC" ? " (community provider, VA covers it)" : ""}, about ${o.drive} minutes from home`);
  const link = `${publicUrl()}/choose.html?t=${token}`;
  const drafted = await ai(
    "You write short, warm, plain-language outreach messages from VA scheduling to a Veteran. Never mention diagnoses, the medical specialty, or any health details. Under 70 words. No subject line. Do not list the appointment options; they are added after your text. End with: VA Scheduling.",
    `Veteran first name: ${c.FirstName}. Their provider placed a referral and appointment options are ready. Ask them to tap the link below to pick a time; the page also has a "None of these work" and a "Call me" button. Do not ask them to reply to the email. Number of options: ${chosen.length}.`);
  const message = drafted || `Hi ${c.FirstName}, your provider placed a referral and we have appointment times ready for you. Tap the link below to pick the one that works best, or let us know if none of them do.\n\nVA Scheduling`;
  const text = `${message}\n\n${lines.join("\n")}\n\nChoose your time: ${link}\n\n(Hackathon demo with synthetic data. Not an official VA message.)`;
  const html = `<div style="font-family:Segoe UI,Arial,sans-serif;max-width:520px;color:#1b1f24">
    <div style="background:#0b2545;color:#fff;padding:14px 18px;border-radius:10px 10px 0 0;font-weight:700">Fastest Path · appointment options</div>
    <div style="border:1px solid #e2e6ec;border-top:0;padding:18px;border-radius:0 0 10px 10px">
    <p style="white-space:pre-wrap;margin-top:0">${message.replace(/</g, "&lt;")}</p>
    <ol style="padding-left:20px">${chosen.map(o => `<li style="margin:6px 0"><b>${fmtSlot(o.slots[0].start)}</b> at ${o.name}<br><span style="color:#5b6573">about ${o.drive} min from home${o.type === "CC" ? " · community provider" : ""}</span></li>`).join("")}</ol>
    <p><a href="${link}" style="display:inline-block;background:#157347;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:700">Choose your time</a></p>
    <p style="font-size:12px;color:#8a94a3">Hackathon demo with synthetic data. Not an official VA message.</p></div></div>`;
  // Demo: no sign-in needed. A signed-in tester gets the "Veteran" email themselves; a guest's email goes to the demo inbox.
  const me = userEmail(req);
  const guestInbox = (process.env.DEMO_INBOX || "").trim() || null;
  const sender = me || "guest";
  const recent = (await q("SELECT COUNT(*) AS n FROM dbo.Outreach WHERE SentBy=@u AND SentAt > DATEADD(hour,-1,SYSUTCDATETIME())", { u: sender })).recordset[0].n;
  const limit = +(process.env.EMAILS_PER_HOUR || 10);
  const to = recent < limit ? (me || guestInbox) : null;
  const res = to ? await sendEmail(to, "Your appointment options are ready (demo)", text, html)
    : { sent: false, reason: recent >= limit ? `demo limit of ${limit} emails per hour reached` : "no demo inbox is set" };
  await q(`INSERT INTO dbo.Outreach(ConsultId,Token,SentAt,Channel,OptionsJson,MessageText,AiDrafted,Live,SentBy) VALUES(@c,@t,SYSUTCDATETIME(),'Email',@o,@m,@ai,1,@by);
           UPDATE dbo.Consult SET Status='Sent', DeclineReason=NULL WHERE ConsultId=@c`,
    { c: c.ConsultId, t: token, o: JSON.stringify(chosen.map(o => ({ siteId: o.siteId, name: o.name, type: o.type, drive: o.drive, days: o.days, ll: o.ll, slots: o.slots }))), m: message, ai: drafted ? 1 : 0, by: sender });
  await log(c.ConsultId, "auto", res.sent
    ? `Email sent with ${chosen.length} options via Azure Communication Services${drafted ? " (message drafted by Azure OpenAI)" : ""}`
    : `Outreach created with ${chosen.length} options; email not sent (${res.reason || res.status})`);
  return json({ ok: true, emailed: res.sent, guest: !me, to: res.sent && me ? to.replace(/(.{2}).+(@.+)/, "$1***$2") : null, reason: res.sent ? null : res.reason, link, message, aiDrafted: !!drafted });
});

route("book", ["POST"], "consults/{id}/book", async req => {
  const c = await getConsult(req.params.id);
  const { slotId } = await req.json();
  const r = await bookSlot(c, slotId, "booked by " + who(req));
  await q("UPDATE dbo.Outreach SET RespondedAt=COALESCE(RespondedAt,SYSUTCDATETIME()), Response=COALESCE(Response,'Booked by scheduler') WHERE ConsultId=@c AND RespondedAt IS NULL", { c: c.ConsultId });
  return json({ ok: true, ...r });
});

route("call", ["POST"], "consults/{id}/call", async req => {
  const c = await getConsult(req.params.id);
  const { outcome } = await req.json().catch(() => ({ outcome: "no answer" }));
  const n = c.CallAttempts + 1;
  await q("UPDATE dbo.Consult SET CallAttempts=@n WHERE ConsultId=@c", { n, c: c.ConsultId });
  await log(c.ConsultId, "manual", `Call attempt ${n}: ${outcome || "no answer"} (logged by ${who(req)})`);
  if (n >= 2 && c.Status !== "Scheduled") {
    await q("UPDATE dbo.Consult SET Status='Stalled' WHERE ConsultId=@c", { c: c.ConsultId });
    await log(c.ConsultId, "esc", "Escalated to supervisor: 2 unanswered calls");
  }
  return json({ ok: true, attempts: n });
});

route("assign", ["POST"], "consults/{id}/assign", async req => {
  await q("UPDATE dbo.Consult SET CallbackAssigned=1 WHERE ConsultId=@c", { c: req.params.id });
  await log(req.params.id, "esc", `Supervisor callback assigned by ${who(req)}`);
  return json({ ok: true });
});

route("kpis", ["GET"], "kpis", async () => {
  const r = (await q(`
    SELECT
      SUM(CASE WHEN Status<>'Scheduled' THEN 1 ELSE 0 END) AS OpenCount,
      SUM(CASE WHEN Status<>'Scheduled' AND DATEDIFF(day, CAST(ReceivedAt AS date), CAST(SYSUTCDATETIME() AS date))>7 THEN 1 ELSE 0 END) AS PastStandard,
      SUM(CASE WHEN Status='Scheduled' THEN 1 ELSE 0 END) AS Scheduled,
      AVG(CASE WHEN Status='Scheduled' THEN CAST(DATEDIFF(day, CAST(ReceivedAt AS date), CAST(ScheduledAt AS date)) AS float) END) AS AvgDays,
      SUM(CASE WHEN Status='Scheduled' AND DATEDIFF(day, CAST(ReceivedAt AS date), CAST(ScheduledAt AS date))<=7 THEN 1 ELSE 0 END) AS Within7,
      SUM(CASE WHEN Status IN ('Stalled','NeedsOptions','CallRequested') THEN 1 ELSE 0 END) AS Stalled,
      SUM(CASE WHEN Status='Scheduled' AND HomeEarliestDays>BookedDays THEN HomeEarliestDays-BookedDays ELSE 0 END) AS DaysSaved
    FROM dbo.Consult`)).recordset[0];
  return json(r);
});

// ---------- supervisor ----------
route("supervisor", ["GET"], "supervisor", async () => {
  const esc = (await q(`
    SELECT c.ConsultId, c.FirstName, c.LastName, c.City, c.Specialty, c.ContactPref, c.Status, c.DeclineReason, c.CallAttempts, c.CallbackAssigned,
           DATEDIFF(day, CAST(c.ReceivedAt AS date), CAST(SYSUTCDATETIME() AS date)) AS AgeDays, o.AiSummary, o.EscalatedAt, o.SentAt
    FROM dbo.Consult c
    OUTER APPLY (SELECT TOP 1 AiSummary, EscalatedAt, SentAt FROM dbo.Outreach WHERE ConsultId=c.ConsultId ORDER BY SentAt DESC) o
    WHERE c.Status IN ('Stalled','NeedsOptions','CallRequested')
    ORDER BY COALESCE(o.EscalatedAt, c.ReceivedAt) DESC`)).recordset;
  const aging = (await q(`
    SELECT SUM(CASE WHEN a<=3 THEN 1 ELSE 0 END) AS b0, SUM(CASE WHEN a BETWEEN 4 AND 7 THEN 1 ELSE 0 END) AS b1,
           SUM(CASE WHEN a BETWEEN 8 AND 14 THEN 1 ELSE 0 END) AS b2, SUM(CASE WHEN a>14 THEN 1 ELSE 0 END) AS b3
    FROM (SELECT DATEDIFF(day, CAST(ReceivedAt AS date), CAST(SYSUTCDATETIME() AS date)) a FROM dbo.Consult WHERE Status<>'Scheduled') x`)).recordset[0];
  const cap = (await q(`
    SELECT Specialty, SiteId, MIN(DATEDIFF(day, CAST(SYSUTCDATETIME() AS date), CAST(SlotStart AS date))) AS Days
    FROM dbo.Slot WHERE IsBooked=0 AND SlotStart>=CAST(SYSUTCDATETIME() AS date) GROUP BY Specialty, SiteId`)).recordset;
  const capacity = D.SPECS.map(sp => {
    const rows = cap.filter(r => r.Specialty === sp);
    const tpa = rows.find(r => r.SiteId === "TPA");
    const va = rows.filter(r => !r.SiteId.startsWith("cc") && r.SiteId !== "TPA").sort((a, b) => a.Days - b.Days)[0];
    const cc = rows.filter(r => r.SiteId.startsWith("cc")).sort((a, b) => a.Days - b.Days)[0];
    return { specialty: sp, tampa: tpa && tpa.Days, bestVa: va && va.Days, bestVaName: va && SITE[va.SiteId].name, bestCc: cc && cc.Days };
  });
  return json({ escalations: esc, aging, capacity, escalateAfterSeconds: +(process.env.ESCALATE_AFTER_SECONDS || 259200) });
});

route("me", ["GET"], "me", async req => json({ user: who(req), email: userEmail(req), admin: isAdmin(req) }));

route("reset", ["POST"], "demo/reset", async (req, ctx) => {
  if (!isAdmin(req)) return json({ error: "Only the demo owner can reset the data." }, 403);
  await seed();
  ctx.log("Demo data reset by " + who(req));
  return json({ ok: true });
});

route("health", ["GET"], "health", async () => {
  const sqlOk = (await q("SELECT 1 AS ok")).recordset[0].ok === 1;
  const live = (await q("SELECT COUNT(*) AS n FROM dbo.DriveTime WHERE Source='azure-maps'")).recordset[0].n;
  return json({
    sql: sqlOk, maps: !!process.env.MAPS_KEY, mapsLiveRoutes: live, openai: !!(process.env.AOAI_ENDPOINT && process.env.AOAI_KEY),
    email: !!process.env.ACS_CONNECTION, appInsights: !!process.env.APPLICATIONINSIGHTS_CONNECTION_STRING,
    escalateAfterSeconds: +(process.env.ESCALATE_AFTER_SECONDS || 259200)
  });
});

// ---------- Veteran (anonymous, token-based) ----------
async function outreachByToken(t) {
  if (!/^[a-f0-9]{32}$/.test(t || "")) return null;
  return (await q("SELECT TOP 1 o.*, c.FirstName, c.HomeLat, c.HomeLon, c.Status AS ConsultStatus FROM dbo.Outreach o JOIN dbo.Consult c ON c.ConsultId=o.ConsultId WHERE o.Token=@t", { t })).recordset[0] || null;
}

route("chooseGet", ["GET"], "choose/{token}", async req => {
  const o = await outreachByToken(req.params.token);
  if (!o) return json({ error: "This link isn't valid." }, 404);
  const opts = JSON.parse(o.OptionsJson);
  const ids = opts.flatMap(x => x.slots.map(s => s.slotId));
  const open = new Set(ids.length ? (await q(`SELECT SlotId FROM dbo.Slot WHERE IsBooked=0 AND SlotId IN (${ids.map(Number).join(",")})`)).recordset.map(r => r.SlotId) : []);
  return json({
    firstName: o.FirstName, status: o.ConsultStatus, response: o.Response,
    options: opts.map(x => ({ siteId: x.siteId, name: x.name, type: x.type, drive: x.drive, slots: x.slots.filter(s => open.has(s.slotId)).map(s => ({ slotId: s.slotId, label: fmtSlot(s.start) })) }))
  });
});

route("choosePost", ["POST"], "choose/{token}", async req => {
  const o = await outreachByToken(req.params.token);
  if (!o) return json({ error: "This link isn't valid." }, 404);
  const b = await req.json().catch(() => ({}));
  const c = await getConsult(o.ConsultId);
  if (c.Status === "Scheduled") return json({ error: "This appointment is already booked." }, 409);
  if (b.action === "book") {
    const opts = JSON.parse(o.OptionsJson);
    if (!opts.some(x => x.slots.some(s => s.slotId === b.slotId))) return json({ error: "That time isn't one of your options." }, 400);
    const r = await bookSlot(c, b.slotId, "Veteran chose online from email link");
    await q("UPDATE dbo.Outreach SET RespondedAt=SYSUTCDATETIME(), Response=@r WHERE OutreachId=@id", { r: "Booked " + r.site, id: o.OutreachId });
    return json({ ok: true, booked: { site: r.site, label: fmtSlot(r.start) } });
  }
  const reason = b.action === "call" ? "Asked for a call" : String(b.reason || "None of these work").slice(0, 100);
  const status = b.action === "call" ? "CallRequested" : "NeedsOptions";
  await q("UPDATE dbo.Consult SET Status=@s, DeclineReason=@r WHERE ConsultId=@c; UPDATE dbo.Outreach SET RespondedAt=SYSUTCDATETIME(), Response=@r WHERE OutreachId=@id",
    { s: status, r: reason, c: c.ConsultId, id: o.OutreachId });
  await log(c.ConsultId, "esc", b.action === "call" ? "Veteran tapped Call me on the online screen" : `Veteran declined all options online: "${reason}". Routed for new options.`);
  const summary = await ai("You help a VA scheduling supervisor. In 2 short sentences, suggest the best next step. Plain language. No medical details.",
    `A Veteran declined appointment options. Reason given: "${reason}". Options offered: ${JSON.parse(o.OptionsJson).map(x => `${x.name} (${x.drive} min drive)`).join("; ")}.`);
  if (summary) await q("UPDATE dbo.Outreach SET AiSummary=@s, Escalated=1, EscalatedAt=SYSUTCDATETIME() WHERE OutreachId=@id", { s: summary, id: o.OutreachId });
  return json({ ok: true });
});

app.http("mapImage", {
  methods: ["GET"], route: "map/{token}", authLevel: "anonymous",
  handler: async (req, ctx) => {
    try {
      await ensure();
      const o = await outreachByToken(req.params.token);
      if (!o) return { status: 404 };
      const pins = JSON.parse(o.OptionsJson).map(x => x.ll).filter(Boolean);
      const img = await staticMap([o.HomeLat, o.HomeLon], pins);
      if (!img) return { status: 204 };
      return { status: 200, body: img.buf, headers: { "content-type": img.type, "cache-control": "private, max-age=600" } };
    } catch (e) { ctx.error(e); return { status: 500 }; }
  }
});
