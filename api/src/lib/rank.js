const D = require("./data");
const { q } = require("./db");
const { driveMinutes } = require("./services");

const SITE = Object.fromEntries(D.ALL_SITES.map(s => [s.id, s]));

// Every option for one consult: open slots from SQL, drive times from Azure Maps (cached), ranked against the access standard.
async function buildOptions(c) {
  const std = D.STD(c.Specialty);
  const slots = (await q(`
    SELECT x.SiteId, x.SlotId, x.SlotStart,
           DATEDIFF(day, CAST(SYSUTCDATETIME() AS date), CAST(x.SlotStart AS date)) AS Days
    FROM (SELECT SiteId, SlotId, SlotStart,
                 ROW_NUMBER() OVER (PARTITION BY SiteId ORDER BY SlotStart) AS rn
          FROM dbo.Slot
          WHERE Specialty = @s AND IsBooked = 0 AND SlotStart >= CAST(SYSUTCDATETIME() AS date)) x
    WHERE x.rn <= 3
    ORDER BY x.SiteId, x.SlotStart`, { s: c.Specialty })).recordset;

  const bySite = {};
  for (const r of slots) (bySite[r.SiteId] = bySite[r.SiteId] || []).push(r);
  const siteIds = Object.keys(bySite);

  const cached = Object.fromEntries((await q("SELECT SiteId, Minutes, Source FROM dbo.DriveTime WHERE ConsultId=@c", { c: c.ConsultId })).recordset.map(r => [r.SiteId, r]));
  const missing = siteIds.filter(id => !cached[id]);
  if (missing.length) {
    const home = [c.HomeLat, c.HomeLon];
    const res = await driveMinutes(home, missing.map(id => SITE[id].ll));
    for (let i = 0; i < missing.length; i++) {
      cached[missing[i]] = { SiteId: missing[i], Minutes: res[i].minutes, Source: res[i].source };
      try { await q("INSERT INTO dbo.DriveTime(ConsultId,SiteId,Minutes,Source) VALUES(@c,@s,@m,@src)", { c: c.ConsultId, s: missing[i], m: res[i].minutes, src: res[i].source }); } catch { /* concurrent insert */ }
    }
  }

  let opts = siteIds.map(id => {
    const s = SITE[id], sl = bySite[id], dt = cached[id];
    return { siteId: id, type: id.startsWith("cc") ? "CC" : "VA", name: s.name, full: s.full, place: s.city, ll: s.ll, home: !!s.home,
      days: sl[0].Days, drive: dt.Minutes, driveSource: dt.Source,
      slots: sl.map(x => ({ slotId: x.SlotId, start: x.SlotStart })) };
  }).filter(o => o.home || (o.type === "VA" ? o.drive <= 150 : o.drive <= 120));

  const vaMeets = opts.filter(o => o.type === "VA" && o.days <= std.wait && o.drive <= std.drive);
  const ccEligible = vaMeets.length === 0;
  for (const o of opts) {
    o.waitOk = o.days <= std.wait; o.driveOk = o.drive <= std.drive;
    o.selectable = o.type === "VA" || ccEligible;
    o.score = o.days + Math.max(0, o.drive - std.drive) / 3;
  }
  opts.sort((a, b) => (b.selectable - a.selectable) || (a.score - b.score));
  const home = opts.find(o => o.home) || null;
  const best = opts.find(o => o.selectable) || null;
  return { std, ccEligible, vaMeets: vaMeets.map(o => ({ name: o.name, days: o.days, drive: o.drive })), options: opts, home, best,
    mapsLive: opts.some(o => o.driveSource === "azure-maps") };
}

module.exports = { buildOptions, SITE };
