const { app } = require("@azure/functions");
const { q, ensure, log } = require("../lib/db");
const { ai, sendEmail } = require("../lib/services");

// Runs every minute. Any live outreach with no reply after ESCALATE_AFTER_SECONDS
// (3 days in production; a few minutes on the demo clock) is escalated to a supervisor.
app.timer("escalate", {
  schedule: "0 */1 * * * *",
  handler: async (timer, ctx) => {
    await ensure();
    const after = +(process.env.ESCALATE_AFTER_SECONDS || 259200);
    const due = (await q(`
      SELECT o.OutreachId, o.ConsultId, o.SentAt, o.OptionsJson, c.FirstName, c.LastName, c.Specialty, c.City, c.ContactPref
      FROM dbo.Outreach o JOIN dbo.Consult c ON c.ConsultId = o.ConsultId
      WHERE o.Live = 1 AND o.Escalated = 0 AND o.RespondedAt IS NULL AND c.Status = 'Sent'
        AND DATEDIFF(second, o.SentAt, SYSUTCDATETIME()) >= @after`, { after })).recordset;
    for (const d of due) {
      const logs = (await q("SELECT At, Text FROM dbo.ContactLog WHERE ConsultId=@c ORDER BY At", { c: d.ConsultId })).recordset;
      const summary = await ai(
        "You help a VA scheduling supervisor. In 2 or 3 short sentences: what happened, the likely reason the consult stalled, and the single best next action. Plain language. No medical details beyond the specialty name.",
        `Consult ${d.ConsultId}, ${d.Specialty}, Veteran lives in ${d.City}, prefers ${d.ContactPref}. Options offered: ${JSON.parse(d.OptionsJson).map(x => `${x.name} (${x.drive} min drive, ${x.days} days)`).join("; ")}. Contact log: ${logs.map(l => l.Text).join(" | ")}. No reply in 3 days.`
      ) || "No reply to the emailed options after 3 days. Call the Veteran directly and confirm transportation and preferred location before offering new times.";
      await q(`UPDATE dbo.Outreach SET Escalated=1, EscalatedAt=SYSUTCDATETIME(), AiSummary=@s WHERE OutreachId=@id;
               UPDATE dbo.Consult SET Status='Stalled' WHERE ConsultId=@c`, { s: summary, id: d.OutreachId, c: d.ConsultId });
      const clock = after < 86400 ? ` (demo clock: ${Math.round(after / 60)} min)` : "";
      await log(d.ConsultId, "esc", `Auto-escalated: no reply in 3 days${clock}. Supervisor notified.`);
      const url = (process.env.PUBLIC_URL || "").replace(/\/$/, "") + "/supervisor.html";
      await sendEmail(process.env.DEMO_INBOX, `Escalation: ${d.Specialty} consult stalled (demo)`,
        `A consult had no reply after 3 days${clock}.\n\nAI summary: ${summary}\n\nOpen the supervisor view: ${url}\n\n(Hackathon demo with synthetic data.)`,
        `<div style="font-family:Segoe UI,Arial,sans-serif;max-width:520px"><div style="background:#b42318;color:#fff;padding:12px 16px;border-radius:10px 10px 0 0;font-weight:700">Escalation · day 3, not day 30</div><div style="border:1px solid #f2b8b5;border-top:0;padding:16px;border-radius:0 0 10px 10px"><p><b>${d.Specialty}</b> consult ${d.ConsultId} had no reply after 3 days${clock}.</p><p style="background:#f4f6f9;padding:10px;border-radius:8px"><b>Azure OpenAI summary:</b> ${summary.replace(/</g, "&lt;")}</p><p><a href="${url}" style="background:#0b2545;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none;font-weight:700">Open supervisor view</a></p><p style="font-size:12px;color:#8a94a3">Hackathon demo with synthetic data.</p></div></div>`);
      ctx.log(`Escalated ${d.ConsultId}`);
    }
  }
});
