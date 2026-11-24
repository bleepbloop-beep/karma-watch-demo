# Local scanner

Runs the Karma Watch pipeline from your own machine and writes to the database the dashboard reads. Requires Node 18 or newer. There is nothing to install.

## Setup

1. Create a dedicated secret key in your Supabase project's API settings. It bypasses row level security, so keep it on your machine.
2. Copy the example config and fill in the two Supabase values:

   ```shell
   cp config.example.json config.json
   ```

   `config.json` is ignored by git. `ANTHROPIC_API_KEY` is optional; without it, intent tagging uses rules. Set `USER_ID` if more than one account owns monitors.
3. Create at least one monitor in the dashboard.

## Run

```shell
node scan.js
```

Re-running is safe, because duplicates are skipped. A monitor's "last scanned" time moves forward only if every one of its sources succeeded.

## Keyword discovery (optional)

`discover-keywords.js` looks for new subreddits and phrasing using the `last30days` Claude Code skill, and saves the results to a separate monitor for review. It needs Python 3 and that skill at `~/.claude/skills/last30days`. Edit `QUERIES` in the script to match your topic.

## Scheduling

Use cron, launchd, or any scheduler with the full path to the script, for example `node /path/to/karma-watch/scanner/scan.js`. Every 15 minutes is a reasonable pace; please don't go much faster against free archives.
