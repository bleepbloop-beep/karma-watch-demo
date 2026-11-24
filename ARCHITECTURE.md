# Architecture

Five stages: **Trigger → Brain → Store → Gate → Door**.

## Trigger

A scheduler POSTs to the `scan-reddit` function every 15 minutes. A signed-in user can also press "Scan now", which covers only their own monitors. `scanner/scan.js` is a local alternative.

## Brain

**Fetch.** Each monitor either reads a fixed list of subreddits or searches by keyword (`search_mode`). Both try PullPush first, then Arctic Shift. At most four requests run at once within a 100-second budget. Monitors that don't fit wait for the next run, and the order of subreddits rotates so the same ones aren't always last.

**Match.** The local scanner matches whole words, so "gas" does not match "Las Vegas". The cloud scanner still uses simple substring matching.

**Classify.** The cloud scanner fills nine fields per thread. It tries OpenAI, then Anthropic, then rules, so a failed AI call never blocks a scan. Threads are sent in batches of 20.

## Store

Postgres on Supabase: `profiles`, `monitors`, `threads`, and `alert_log`. A unique constraint on monitor and post makes re-scanning safe.

## Gate

| Layer | Rule |
|---|---|
| Function | The scheduler needs a shared secret. A user needs a valid session and can scan only their own monitors. |
| Database | Row level security limits rows to their owner. Column grants limit what a user can change: thread status, for example, but not their plan. |
| Content | Posts flagged over-18 and a few noisy subreddits are dropped. |
| Dashboard | Out-of-market countries are hidden. All post text is escaped, and only https reddit.com links open. |
| Build | Refuses any key that isn't a publishable key. |

## Door

A location-first inbox. Each card leads with geography, then the recommended action, then the finer tags. Alert delivery is the next door to build.

## Trade-offs

- **One HTML file, no framework.** Easy to deploy and read; it would be worth splitting up as it grows.
- **Subreddit as a location signal (local scanner).** Cheap and predictable, but blind to someone in Houston posting in a national subreddit.
- **Rules behind the AI.** Less accurate, but the inbox keeps working without an AI provider.
- **Third-party archives.** No credentials needed, at the cost of freshness and reliability. A commercial version would need an approved source.
- **"Brand tolerance" is an AI estimate.** A person should read a community's rules before replying.
