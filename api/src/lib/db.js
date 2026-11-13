const sql = require("mssql");
const D = require("./data");

let poolP = null;
function pool() {
  if (!poolP) {
    poolP = new sql.ConnectionPool({
      server: process.env.SQL_SERVER,
      database: process.env.SQL_DB,
      user: process.env.SQL_USER,
      password: process.env.SQL_PASSWORD,
      options: { encrypt: true, trustServerCertificate: false },
      pool: { max: 5, min: 0, idleTimeoutMillis: 30000 },
      connectionTimeout: 90000, // serverless free tier may be resuming from auto-pause
      requestTimeout: 90000
    }).connect().catch(e => { poolP = null; throw e; });
  }
  return poolP;
}

async function q(text, params = {}) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const p = await pool();
      const r = p.request();
      for (const [k, v] of Object.entries(params)) r.input(k, v);
      return await r.query(text);
    } catch (e) { lastErr = e; poolP = null; }
  }
  throw lastErr;
}

const SCHEMA = `
IF OBJECT_ID('dbo.Site') IS NULL CREATE TABLE dbo.Site(
  SiteId varchar(12) NOT NULL PRIMARY KEY, Name nvarchar(80) NOT NULL, FullName nvarchar(120) NOT NULL,
  City nvarchar(60) NOT NULL, Lat float NOT NULL, Lon float NOT NULL, Kind char(2) NOT NULL, IsHome bit NOT NULL DEFAULT 0);
IF OBJECT_ID('dbo.Slot') IS NULL CREATE TABLE dbo.Slot(
  SlotId int IDENTITY PRIMARY KEY, SiteId varchar(12) NOT NULL, Specialty varchar(40) NOT NULL,
  SlotStart datetime2(0) NOT NULL, IsBooked bit NOT NULL DEFAULT 0);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_Slot_Spec') CREATE INDEX IX_Slot_Spec ON dbo.Slot(Specialty, IsBooked, SlotStart) INCLUDE (SiteId);
IF OBJECT_ID('dbo.Consult') IS NULL CREATE TABLE dbo.Consult(
  ConsultId varchar(12) NOT NULL PRIMARY KEY, FirstName nvarchar(40) NOT NULL, LastName nvarchar(40) NOT NULL, MI char(1) NULL,
  Age int NOT NULL, Era nvarchar(20) NULL, City nvarchar(60) NOT NULL, HomeLat float NOT NULL, HomeLon float NOT NULL,
  Specialty varchar(40) NOT NULL, Reason nvarchar(120) NOT NULL, OrderedBy nvarchar(60) NOT NULL, Priority varchar(12) NOT NULL,
  ContactPref varchar(10) NOT NULL, ContactEmail nvarchar(120) NULL, ReceivedAt datetime2(0) NOT NULL,
  Status varchar(20) NOT NULL DEFAULT 'New', BookedSlotId int NULL, BookedSiteId varchar(12) NULL, ScheduledAt datetime2(0) NULL,
  HomeEarliestDays int NULL, BookedDays int NULL, BookedDrive int NULL, DeclineReason nvarchar(120) NULL, CallAttempts int NOT NULL DEFAULT 0,
  CallbackAssigned bit NOT NULL DEFAULT 0);
IF OBJECT_ID('dbo.Outreach') IS NULL CREATE TABLE dbo.Outreach(
  OutreachId int IDENTITY PRIMARY KEY, ConsultId varchar(12) NOT NULL, Token char(32) NOT NULL UNIQUE, SentAt datetime2(0) NOT NULL,
  Channel varchar(10) NOT NULL, OptionsJson nvarchar(max) NOT NULL, MessageText nvarchar(max) NULL, AiDrafted bit NOT NULL DEFAULT 0,
  RespondedAt datetime2(0) NULL, Response nvarchar(200) NULL, Escalated bit NOT NULL DEFAULT 0, EscalatedAt datetime2(0) NULL,
  AiSummary nvarchar(max) NULL, Live bit NOT NULL DEFAULT 0);
IF OBJECT_ID('dbo.ContactLog') IS NULL CREATE TABLE dbo.ContactLog(
  LogId int IDENTITY PRIMARY KEY, ConsultId varchar(12) NOT NULL, At datetime2(0) NOT NULL DEFAULT SYSUTCDATETIME(),
  Kind varchar(10) NOT NULL, Text nvarchar(400) NOT NULL);
IF OBJECT_ID('dbo.DriveTime') IS NULL CREATE TABLE dbo.DriveTime(
  ConsultId varchar(12) NOT NULL, SiteId varchar(12) NOT NULL, Minutes int NOT NULL, Source varchar(12) NOT NULL,
  CONSTRAINT PK_DriveTime PRIMARY KEY(ConsultId, SiteId));
`;

let ensured = null;
function ensure() {
  if (!ensured) ensured = (async () => {
    await q(SCHEMA);
    const r = await q("SELECT COUNT(*) AS n FROM dbo.Consult");
    if (r.recordset[0].n === 0) await seed();
  })().catch(e => { ensured = null; throw e; });
  return ensured;
}

const esc = v => v == null ? "NULL" : typeof v === "number" ? String(v) : "N'" + String(v).replace(/'/g, "''") + "'";
async function bulk(table, cols, rows) {
  for (let i = 0; i < rows.length; i += 400) {
    const chunk = rows.slice(i, i + 400);
    await q(`INSERT INTO dbo.${table}(${cols.join(",")}) VALUES ` + chunk.map(r => "(" + r.map(esc).join(",") + ")").join(","));
  }
}

function estDrive(a, b) { const dy = (a[0]-b[0])*69.17, dx = (a[1]-b[1])*61.1; return Math.round(Math.hypot(dx, dy)*1.3/50*60 + 6); }
const TIMES = ["08:00","08:45","09:30","10:15","11:00","13:00","13:45","14:30","15:15"];
function bizDate(daysAhead) {
  const d = new Date(); d.setUTCHours(0,0,0,0); d.setUTCDate(d.getUTCDate() + daysAhead);
  while ([0,6].includes(d.getUTCDay())) d.setUTCDate(d.getUTCDate() + 1);
  return d;
}
const iso = (d, t) => d.toISOString().slice(0,10) + " " + t + ":00";

async function seed() {
  const r = D.rng(20261113), pick = a => a[Math.floor(r() * a.length)], ri = (a, b) => a + Math.floor(r() * (b - a + 1));
  await q("DELETE FROM dbo.ContactLog; DELETE FROM dbo.Outreach; DELETE FROM dbo.DriveTime; DELETE FROM dbo.Consult; DELETE FROM dbo.Slot; DELETE FROM dbo.Site;");
  await bulk("Site", ["SiteId","Name","FullName","City","Lat","Lon","Kind","IsHome"],
    D.ALL_SITES.map(s => [s.id, s.name, s.full, s.city, s.ll[0], s.ll[1], s.id.startsWith("cc") ? "CC" : "VA", s.home ? 1 : 0]));
  // open slots: 15 per site/specialty starting at the earliest-available day
  const slots = [];
  for (const s of D.ALL_SITES) for (const [spec, first] of Object.entries(s.avail)) {
    let day = first;
    for (let k = 0; k < 15; k++) {
      const d = bizDate(day);
      slots.push([s.id, spec, iso(d, TIMES[(k * 4 + s.id.length) % TIMES.length])]);
      day += 1 + (k % 3);
    }
  }
  await bulk("Slot", ["SiteId","Specialty","SlotStart"], slots);

  const now = Date.now(), DAY = 86400000;
  const fmt = ms => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
  const consults = [], logs = [], outreach = [];
  const mk = o => { consults.push(o); logs.push([o.id, fmt(o.received), "auto", "Consult received from " + o.prov]); return o; };
  const show = [
    { id:"CN-24817", first:"Robert", last:"Alvarez", mi:"J", age:71, era:"Vietnam", city:"Brandon", spec:"Neurology", reason:"New-onset tremor, evaluate", prov:D.PROV[0], days:1, pref:"Email", prio:"Routine" },
    { id:"CN-24790", first:"Denise", last:"Washington", mi:"L", age:58, era:"Gulf War", city:"Lakeland", spec:"Mental Health", reason:"PTSD, start evidence-based therapy", prov:D.PROV[4], days:2, pref:"Email", prio:"Expedited" },
    { id:"CN-24802", first:"James", last:"Kowalski", mi:"R", age:66, era:"Post-Vietnam", city:"Spring Hill", spec:"Gastroenterology", reason:"Screening colonoscopy, positive FIT", prov:D.PROV[1], days:5, pref:"Phone", prio:"Routine" }
  ];
  for (const s of show) mk({ ...s, ll: D.CITY[s.city], received: now - s.days * DAY, status: "New" });
  const used = new Set(show.map(s => s.first + s.last));
  for (let i = 0; i < 147; i++) {
    let f, l; do { f = pick(D.FIRST); l = pick(D.LAST); } while (used.has(f + l)); used.add(f + l);
    const spec = pick(D.SPECS), city = pick(D.CITYPOOL), base = D.CITY[city], days = ri(0, 16);
    const c = mk({ id: "CN-" + (25000 + i * 7 + ri(0, 6)), first: f, last: l, mi: String.fromCharCode(65 + ri(0, 25)), age: ri(26, 86),
      era: pick(["Vietnam","Gulf War","OEF/OIF","Post-9/11","Korea","Peacetime"]), city, spec, reason: pick(D.REASONS[spec]),
      prov: spec === "Mental Health" ? D.PROV[4] : pick(D.PROV.filter((_, j) => j !== 4)), days,
      pref: r() < 0.8 ? "Email" : "Phone", prio: r() < 0.15 ? "Expedited" : "Routine",
      ll: [base[0] + (r() - .5) * .06, base[1] + (r() - .5) * .06], received: now - days * DAY, status: "New" });
    const roll = r();
    if (roll < 0.33 && days >= 2) {
      // already scheduled: book the best estimated option
      const std = D.STD(spec);
      const opts = D.ALL_SITES.filter(s => s.avail[spec] != null).map(s => ({ s, d: s.avail[spec], m: estDrive(c.ll, s.ll) }));
      const vaOk = opts.some(o => !o.s.id.startsWith("cc") && o.d <= std.wait && o.m <= std.drive);
      const best = opts.filter(o => !o.s.id.startsWith("cc") || !vaOk).filter(o => o.m <= 150)
        .sort((a, b) => (a.d + Math.max(0, a.m - std.drive) / 3) - (b.d + Math.max(0, b.m - std.drive) / 3))[0];
      const home = opts.find(o => o.s.id === "TPA");
      const sched = c.received + ri(1, Math.min(8, days)) * DAY;
      Object.assign(c, { status: "Scheduled", bookedSite: best.s.id, scheduledAt: sched, homeDays: home.d, bookedDays: best.d, bookedDrive: best.m });
      logs.push([c.id, fmt(sched), "book", `Booked at ${best.s.name} (seeded history)`]);
    } else if (roll < 0.55 && c.pref === "Email" && days >= 4) {
      const sent = c.received + DAY;
      Object.assign(c, { status: "Stalled" });
      outreach.push([c.id, require("crypto").randomBytes(16).toString("hex"), fmt(sent), "Email", "[]", null, 0, null, null, 1, fmt(sent + 3 * DAY), null, 0]);
      logs.push([c.id, fmt(sent), "auto", "Email sent with 3 options (seeded history)"]);
      logs.push([c.id, fmt(sent + 3 * DAY), "esc", "Auto-escalated: no reply after 3 days"]);
    }
  }
  await bulk("Consult", ["ConsultId","FirstName","LastName","MI","Age","Era","City","HomeLat","HomeLon","Specialty","Reason","OrderedBy","Priority","ContactPref","ReceivedAt","Status","BookedSiteId","ScheduledAt","HomeEarliestDays","BookedDays","BookedDrive"],
    consults.map(c => [c.id, c.first, c.last, c.mi, c.age, c.era, c.city, c.ll[0], c.ll[1], c.spec, c.reason, c.prov.split(" · ")[0], c.prio, c.pref,
      fmt(c.received), c.status, c.bookedSite || null, c.scheduledAt ? fmt(c.scheduledAt) : null, c.homeDays ?? null, c.bookedDays ?? null, c.bookedDrive ?? null]));
  if (outreach.length) await bulk("Outreach", ["ConsultId","Token","SentAt","Channel","OptionsJson","MessageText","AiDrafted","RespondedAt","Response","Escalated","EscalatedAt","AiSummary","Live"], outreach);
  await bulk("ContactLog", ["ConsultId","At","Kind","Text"], logs);
}

async function log(consultId, kind, text) {
  await q("INSERT INTO dbo.ContactLog(ConsultId,Kind,Text) VALUES(@c,@k,@t)", { c: consultId, k: kind, t: text.slice(0, 400) });
}

module.exports = { q, ensure, seed, log, estDrive, sql };
