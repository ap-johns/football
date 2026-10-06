---
description: Monday footy pick — rank this week's sign-ups by the trial selection rule (private, prints only). "report" compares the rule with who actually played.
---

This is a PRIVATE TRIAL of a selection rule for Monday footy. Print results for John
only. Never email anyone, never change the sign-up message, never put the rule on the
credit pages. John still picks and sends the tally himself.

Arguments (may be empty): $ARGUMENTS

If the arguments are `report`, run:
```
node footy-credit.mjs mon pick-report
```
and show the week-by-week comparison of the rule's 10 against who actually played.

Otherwise:

1. Refresh the token:
   ```
   node footy-credit.mjs refresh-token
   ```

2. Run the pick, passing through any `--cutoff "YYYY-MM-DD HH:MM"`, `--thread <id>`,
   `--no-save` or `--verbose` from the arguments:
   ```
   node footy-credit.mjs mon pick
   ```

3. Show John:
   - the ranked sign-ups with tier, reason and attendance, and the 10 / 11 line,
   - the "Could not interpret" lines, so he can check them by eye,
   - the "Tally to paste" lines,
   - the "Attendance bands" table, as a markdown table (band | players with
     last 8 / 26 / 52), plus the weeks of priority each band gets,
   - anyone under "Not on the sheet". If that person is really on the sheet, suggest the
     email or name alias to add to `players.mon.json`.

The rule being trialled: reply by 18:00 on the day the list goes out (Tuesday).
On-time replies rank (1) left out recently and not played since, (2) everyone else
by reply time. Being left out gives priority for 1-4 weeks depending on weighted
attendance: 60%+ 4 weeks, 50%+ 3, 30%+ 2, otherwise 1. The weighted rate covers the
last 104 sessions, each counting half as much per 26 sessions of age. Top 10 play, the rest are reserves. Late replies rank below all on-time
replies, first come first served. People who only offered to be reserve go last.
Each line shows the weighted rate plus counts over the last 8, 26 and 52 sessions
(signing up on time and being left out counts as attended); attendance only sets the
priority weeks, not the order. Settings live in the `PICK` object in `footy-credit.mjs`.
