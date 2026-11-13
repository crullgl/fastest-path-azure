# Fastest Path · Azure hackathon demo

**Every open appointment. One screen. The Veteran picks.**

A working demo for the VA health care hackathon (access timeliness track). It gives a scheduler every VA site and every eligible community provider for a consult, ranked by who can see the Veteran first. It emails the Veteran a link to choose, and escalates anything that stalls on day 3 instead of day 30.

> Hackathon prototype. **All data is synthetic.** Facility names appear for realism only; all availability is invented. Not an official VA system, and it connects to no VA system.

## Why
- VA OIG Report 25-01014-139 (June 2026): schedulers can't see availability across VA facilities within wait-time and drive-time standards.
- VA OIG Report 25-03623-147 (Aug 2026): community care scheduling delays driven by phone calls and postal mail; Veterans waited 56 days on average when the 30-day metric was missed.

## Azure services and what each one does
| Service | Role |
|---|---|
| Azure SQL Database (serverless, free offer) | Consults, open slots, sites, outreach, contact log, drive-time cache |
| Azure Maps | Route Matrix gives real drive times from the Veteran's home to every site; static map on the Veteran's screen |
| Azure Functions (Node 20) | Ranking and access-standard rules API; timer trigger runs the day-3 escalation |
| Azure OpenAI | Drafts the plain-language outreach message and the supervisor's stall summary |
| Azure Communication Services (email) | Sends the options email to the Veteran and escalation email to the supervisor |
| Azure Static Web Apps (Standard) | Front end, Microsoft Entra sign-in, linked API backend, role-based routes |
| Azure Key Vault | Secrets referenced from Function app settings via managed identity |
| Application Insights + Log Analytics | Telemetry for every request and escalation |

Access standards checked: 20 days / 30 minutes for mental health, 28 days / 60 minutes for specialty care. Community care unlocks only when no VA site meets both.

## Deploy (Azure Cloud Shell, Bash)
```bash
git clone https://github.com/crullgl/fastest-path-azure && cd fastest-path-azure
bash infra/deploy.sh you@example.com      # the demo inbox for Veteran and supervisor emails
```
`ESC_SECONDS=180` (default) makes "3 days" equal 3 minutes so the escalation fires live on stage.

Cleanup: `az group delete -n rg-fastestpath --yes`

## Demo script
1. Sign in. Open **Robert Alvarez, Neurology**: home clinic 74 days; Fastest Path finds another VA site inside the standard with a real Azure Maps drive time.
2. **Email 3 options**. Azure OpenAI drafts the message; Communication Services delivers it to the demo inbox.
3. Open the email on your phone, tap **Choose your time**, pick a slot. The scheduler screen updates by itself.
4. Send options to another Veteran and don't answer. About 3 minutes later the timer escalates it, Azure OpenAI writes the summary, and the supervisor gets an email.
5. Supervisor view: escalations, aging, and the capacity gap by specialty.

## Layout
```
api/    Azure Functions (HTTP API + escalation timer)
web/    Static Web App (scheduler, supervisor, Veteran choose page)
infra/  deploy.sh (Azure CLI)
```
