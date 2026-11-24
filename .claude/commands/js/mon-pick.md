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
     email or name alias to add to `players.mon.json`,
   - at the end, the "Rules summary" below, verbatim, as a reminder. It's the
     wording John may one day attach to the sign-up email; not published yet.

The rule being trialled: reply by 18:00 on the day the list goes out (Tuesday).
On-time replies rank (1) missed out within their priority weeks, (2) everyone else
by reply time, with head starts: 1 hour for regulars (weighted attendance 60%+) and
1 hour for anyone who missed out within their priority weeks but has already used
the priority (they add up, so 2 hours at most). Missed out = on the reserves line of John's last list in that week's
thread and didn't play. The priority is used up by the next game played; unused,
it lasts 1-4 weeks depending on weighted attendance: 60%+ 4 weeks, 50%+ 3, 30%+ 2,
otherwise 1.
The weighted rate covers the last 104 sessions, each counting half as much per 26
sessions of age. Top 10 play, the rest are reserves. Late replies rank below all
on-time replies, first come first served. People who only offered to be reserve go
last. Each line shows the weighted rate plus counts over the last 8, 26 and 52
sessions (missing out counts as attended); attendance sets the priority weeks and
the regulars' head start, nothing else. Settings live in the `PICK` object in
`footy-credit.mjs`; if they change, update the summary below to match.

## Rules summary

**How Monday places are picked**

1. **Reply by 6pm on Tuesday**, the day the list goes out. Replies after that go to the back, in the order they arrive.
2. **If you missed out, you get priority.** Missing out means you were a reserve on the final list and didn't play. Next time you reply on time, you go to the top. The priority is used up once you play. If you don't sign up straight away, it keeps for a while:
   - 4 weeks if you play 60%+ of the time
   - 3 weeks at 50%+
   - 2 weeks at 30%+
   - otherwise 1 week
3. **Everyone else is ranked by reply time, with head starts:**
   - **Regulars** (60%+ attendance): your reply counts as 1 hour earlier.
   - **Recently missed out:** if you've already used your priority but are still within your priority weeks, your reply counts as another hour earlier.
   - The two add together, so the biggest head start is 2 hours.
4. **The top 10 play.** The rest are reserves in order. If someone drops out, the next reserve takes the place.
5. **If you only offer to be a reserve**, you go after everyone else.

**Attendance** is the share of Mondays you've played over roughly the last two years, with recent weeks counting more. Weeks you missed out count as played, so being bumped never hurts your attendance.

In unusual cases I may still make the call myself.
