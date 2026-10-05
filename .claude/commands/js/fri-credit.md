---
description: Friday footy credit — update the Credit spreadsheet from the sign-up thread and send the "fri credit" email, using the local footy-credit.mjs script
---

Run the Friday credit workflow with `footy-credit.mjs` in this directory. Do not use
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
   node footy-credit.mjs fri get-players
   ```
   Build a lookup from name/abbreviation to row. Fixed facts for Friday:
   - "Guesty" = Neil Guest, row 39. A regular, not a guest.
   - Guy Fisher is row 41. A regular.
   - Michael Scott is row 20. He always pays for guest Bobby: if Bobby is on the
     list, write `20:2` and skip Bobby.

3. Find this week's sign-up thread:
   ```
   node footy-credit.mjs fri search-emails
   ```
   Subjects look like "Kelsey Kerridge Friday 25th Sept - 10". Ignore subjects
   containing "credit". The snippets usually hold the whole list; use
   `node footy-credit.mjs fri get-thread <threadId>` only if they don't.

4. Decide who played, in this order of authority:
   1. A teams-with-colours message posted on the day.
   2. Paul Buggs' latest tally ("10 + 1: …", "Add X to make 10", "Still on 9").
      Names after "Reserves" did not play.
   3. Individual replies, if neither exists.
   Cap at 10. Anyone not on the spreadsheet is a guest: skip them, write nothing,
   unless a rule or John's instruction says a regular pays for them (value 2 on the
   payer's row). If `$ARGUMENTS` says e.g. "charge andy r for mark r", give Andy
   Rutter value 2.

5. Run everything in one shot:
   ```
   node footy-credit.mjs fri run-all <row:val,...>
   ```
   e.g. `node footy-credit.mjs fri run-all 15:1,19:1,39:1,10:1,16:1,23:1,12:2,13:1,38:1`
   This copies the template, writes Played, hides old columns, builds the email,
   sends the preview to thejgs@gmail.com, sends to kkfrifooty@googlegroups.com,
   and rebuilds and pushes the credit pages.

6. Report back: the session date, the players written (grouped by team if teams
   were posted), anyone skipped and why, which message you took the list from, and
   anything odd such as a player count that isn't 10 or a swap posted after a
   previous credit run.
