# Footy Credit — Claude Code Instructions

This folder contains `footy-credit.mjs`, a Node.js script for managing the Friday and
Monday 5-a-side football credit spreadsheets and emails.

## Setup

Place `footy-credit.mjs` somewhere accessible (e.g. `~/scripts/`). Requires Node 18+
(uses native fetch).

## "fri credit" or "mon credit" workflow

When John says "fri credit" or "mon credit", follow these steps:

### 1. Refresh the OAuth token
```bash
node footy-credit.mjs refresh-token
```

### 2. Get the player list from the spreadsheet
```bash
node footy-credit.mjs fri get-players    # or mon
```
This returns player names and their spreadsheet row numbers. Build a lookup table:
- Extract abbreviation in brackets → lowercased → maps to full name
- e.g. `Andy Rutter (AR)` → `ar` → row 10
- For entries without brackets, use first name lowercased (e.g. `ruban`, `waq`)
- **Known nickname:** "Guesty" = Neil Guest (fri spreadsheet row 39). Regular player, NOT a guest.

### 3. Search for the sign-up email thread
```bash
node footy-credit.mjs fri search-emails    # or mon
```
Look for the sign-up thread (subject like "Friday footy 10th April" or "Mondays list").
Ignore subjects containing "fri credit" or "mon credit" — those are financial emails.

### 4. Fetch the full thread
```bash
node footy-credit.mjs fri get-thread <threadId>    # or mon
```
Read through messages from most recent to oldest. Find the authoritative player list:
1. **Teams with colours** — e.g. "Colours js al michael / Whites mark rs dex"
2. **John's latest running tally** — e.g. "10 js alex al steve dex mark rs michael jh ruban"
3. **Individual replies** — build from positive replies if no tally exists

**Cap the list at 10.** Only 10 play per session. If the email thread lists more than
10 names and there are no explicit teams/colours from the organiser, take only the
first 10 on the list and ignore the rest. Do not write the 11th+ player into the
spreadsheet.

### 5. Match players to spreadsheet rows
Resolve each abbreviation to a row number using the lookup from step 2.

**Guest players:** If someone on the list is NOT found on the spreadsheet, they are a
guest player. Simply skip them — do NOT write anything for guests. John will update
guest charges manually later.

### 6. Run the spreadsheet update + email
```bash
node footy-credit.mjs fri read-headers
node footy-credit.mjs fri copy-columns
node footy-credit.mjs fri write-played 10:1,14:1,15:1,16:1,18:1,19:1,20:1,23:1,38:1,39:1
node footy-credit.mjs fri hide-old
node footy-credit.mjs fri read-sessions
node footy-credit.mjs fri build-email
node footy-credit.mjs fri send-preview
node footy-credit.mjs fri send-email
```

Or in one shot (after you know the rows):
```bash
node footy-credit.mjs fri run-all 10:1,14:1,15:1,16:1,18:1,19:1,20:1,23:1,38:1,39:1
```

The `write-played` format is `row:value` pairs. Use `1` for a regular player.
Use `2` if a regular is paying for a guest (but normally just skip guests).

### 7. Done
The script sends a preview to thejgs@gmail.com then the real email to the group
automatically. No confirmation needed.

## Spreadsheet details

**Friday:**
- Spreadsheet: `1maWZi_HTOjyTbeeM3uQ2ovkFlQTCUpIcLHkvTODUAXc`
- Group: `kkfrifooty@googlegroups.com`
- Player rows 10-41 in column A of the "Credit" tab (Slush Fund at row 42)
- **Guy Fisher is row 41** — a regular, added below the original 10-40 block. He
  is NOT a guest. The script ranges read through row 42 to include him.

**Monday:**
- Spreadsheet: `11pKmY3UITJ1faNxO_Hdb9XpVGXx63pfhjuEOc4pyw4s`
- Group: `symbionicsfooty@googlegroups.com`
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
No cleanup is needed after the copy.
