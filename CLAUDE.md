# Footy Credit — Claude Code Instructions

This folder contains `footy-credit.mjs`, a Node.js script for managing the Friday and
Monday 5-a-side football credit spreadsheets and emails. Requires Node 18+.

## Commands

The workflows live in `.claude/commands/js/` and run as slash commands:

| John says / types                     | Follow                              |
|---------------------------------------|-------------------------------------|
| `/js:fri-credit` or "fri credit"      | `.claude/commands/js/fri-credit.md` |
| `/js:mon-credit` or "mon credit"      | `.claude/commands/js/mon-credit.md` |
| `/js:mon-pick` or "mon pick"          | `.claude/commands/js/mon-pick.md`   |
| `/js:mon-pick report` or "mon pick report" | same file, report branch       |

When John types the plain phrase, follow the matching command file. Always use the
local script, never a browser or the claude.ai versions of these skills.

Anything John adds (e.g. "fri credit. charge andy r for mark r") is an instruction
for the player list: value 2 on that player's row.

One-shot form of the credit workflow, once the rows are known:
```bash
node footy-credit.mjs refresh-token
node footy-credit.mjs fri run-all 10:1,14:1,15:1,16:1,18:1,19:1,20:1,23:1,38:1,39:1
```
`row:value` pairs; `1` for a regular, `2` for a regular paying for a guest. The script
sends the preview to thejgs@gmail.com and then the real email. No confirmation needed.

## Player facts

- **Guests** are anyone on the list who is not on the spreadsheet. Skip them; write
  nothing. John charges guests manually, except:
- **Bobby:** guest on both days, and Michael Scott always pays for him. When Bobby is
  on the list, write `2` for Michael (fri row 20, mon row 17) and skip Bobby.
- **"Guesty"** = Neil Guest (fri row 39). Regular player, NOT a guest.
- **Guy Fisher** is fri row 41, a regular added below the original 10-40 block. The
  script ranges read through row 42 to include him.
- **Cap the list at 10.** Only 10 play. If a thread lists more with no explicit
  teams, take the first 10. Names after "reserves" did not play.

## Spreadsheet details

**Friday:**
- Spreadsheet: `1maWZi_HTOjyTbeeM3uQ2ovkFlQTCUpIcLHkvTODUAXc`
- Group: `kkfrifooty@googlegroups.com`; organiser Paul Buggs
- Player rows 10-41 in column A of the "Credit" tab (Slush Fund at row 42)

**Monday:**
- Spreadsheet: `11pKmY3UITJ1faNxO_Hdb9XpVGXx63pfhjuEOc4pyw4s`
- Group: `symbionicsfooty@googlegroups.com`; organiser John
- Player rows 10-40 in column A of the "Credit" tab

## How the spreadsheet works

The Credit tab has a repeating 3-column group per session:
- Row 7: Date (e.g. "21 Mar 26")
- Row 8: Player count (SUM formula) / 47.00 / 4.75
- Row 9: "Played" / "Collected" / "Credit"
- Row 10+: Player data — write 1 in the Played column for players who played

The Credit column uses a formula — never overwrite it. Only write into Played.

`copy-columns` copies the blank template BEFORE data is written, so destination is
blank too. `PASTE_NORMAL` carries over all formatting and conditional formatting rules.

## Monday pick trial (private)

John is trialling a written selection rule for Monday via `mon pick`. Nothing about it
goes to the group. Details and the rule text are in `.claude/commands/js/mon-pick.md`.
Supporting files: `players.mon.json` (sender emails and nicknames mapped to sheet
rows) and `data/mon-picks.json` (the trial ledger; `mon credit` fills in the actual
players automatically).
