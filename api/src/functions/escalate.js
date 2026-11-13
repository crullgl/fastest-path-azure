const { app } = require("@azure/functions");
const { ensure } = require("../lib/db");
const { escalateDue } = require("../lib/escalate");

// Runs every minute; the same check also runs when the scheduler or supervisor screens refresh.
app.timer("escalate", {
  schedule: "0 */1 * * * *",
  handler: async (timer, ctx) => { await ensure(); const n = await escalateDue(ctx, true); if (n) ctx.log(`Escalated ${n} consult(s)`); }
});
