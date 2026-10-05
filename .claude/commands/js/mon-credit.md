---
description: Monday footy credit — update the Credit spreadsheet from the "Mondays list" thread and send the "mon credit" email, using the local footy-credit.mjs script
---

Run the Monday credit workflow with `footy-credit.mjs` in this directory. Do not use
any browser or claude.ai method. Proceed end to end without asking for confirmation;
the script sends the preview and the real email itself.

Extra instruction from John (may be empty): $ARGUMENTS

Steps:

1. Refresh the token:
   ```
   node footy-credit.mjs refresh-token
   ```

2. Get the player rows:
   ```
   node footy-credit.mjs mon get-players
   ```
   Build a lookup from name/abbreviation to row (e.g. `Andy Rutter (AR)` → `ar` →
   row 10; no brackets → first name, e.g. `ruban`). John's shorthand in tallies:
   `js al dex rs ar cm mark steve luke greg hoss michael fin eugene`, plus
   `andy w`, `alex l`, `john h`. Fixed facts for Monday:
   - Michael Scott is row 17. He always pays for guest Bobby: if Bobby is on the
     list, write `17:2` and skip Bobby.

3. Find this week's sign-up thread:
   ```
   node footy-credit.mjs mon search-emails
   ```
   Subject is "Mondays list <date>". Ignore subjects containing "credit". The
   snippets usually hold the whole list; use
   `node footy-credit.mjs mon get-thread <threadId>` only if they don't, or if a
   late swap is suspected.

4. Decide who played, in this order of authority:
   1. The picker's teams message on the day (e.g. "Whites: … Darks: …"). John
      names the picker with "today's picker - xx".
   2. John's latest tally, including any "X out, Y in" swaps after it. Names after
      "reserves" did not play.
   3. Individual replies, if neither exists.
   Cap at 10. Anyone not on the spreadsheet is a guest: skip them, write nothing,
   unless a rule or John's instruction says a regular pays for them (value 2 on the
   payer's row).

5. Run everything in one shot:
   ```
   node footy-credit.mjs mon run-all <row:val,...>
   ```
   e.g. `node footy-credit.mjs mon run-all 12:1,33:1,22:1,27:1,28:1,26:1,11:1,17:1,16:1,29:1`
   This copies the template, writes Played, records the actual players in the
   `mon pick` trial ledger, hides old columns, builds the email, sends the preview
   to thejgs@gmail.com, sends to symbionicsfooty@googlegroups.com, and rebuilds
   and pushes the credit pages.

6. Report back: the session date, the players written (grouped by team if teams
   were posted), anyone skipped and why, which message you took the list from, and
   anything odd such as a swap posted after a previous credit run (check the
   previous week's column if so).
