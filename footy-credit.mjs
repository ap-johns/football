#!/usr/bin/env node
/**
 * footy-credit.mjs — Friday & Monday 5-a-side credit workflow
 *
 * Usage:
 *   node footy-credit.mjs <fri|mon> <command> [args...]
 *
 * Commands:
 *   refresh-token                  Refresh OAuth token (run first)
 *   update-page                    Build docs/index.html (fri + mon) + git push
 *   get-players                    List player names + rows from spreadsheet col A
 *   search-emails                  Search recent group emails
 *   get-thread <threadId>          Fetch full email thread
 *   read-headers                   Find column positions for sessions
 *   copy-columns                   Copy blank template columns for next week
 *   write-played <row:val,...>     Write played values (e.g. "10:1,14:1,39:2")
 *   hide-old                       Hide the oldest visible session
 *   read-sessions                  Read back 2 most recent sessions for email
 *   build-email                    Build HTML email table from session data
 *   send-preview                   Send preview email to thejgs@gmail.com
 *   send-email                     Send credit email to the group
 *   run-all <row:val,...>          Run copy-columns → write-played → hide-old → read-sessions → build-email → send-preview → send-email
 */

// ─── Config ────────────────────────────────────────────────────────────────────

import fs from 'fs';
import os from 'os';
import path from 'path';

const CRED_PATH = process.env.FOOTY_CREDIT_CREDENTIALS
  ?? path.join(os.homedir(), '.config', 'footy-credit', 'credentials.json');

function loadCredentials() {
  try {
    return JSON.parse(fs.readFileSync(CRED_PATH, 'utf8'));
  } catch (e) {
    throw new Error(
      `Cannot read credentials at ${CRED_PATH}: ${e.message}\n` +
      `Create it with refresh_token, client_id, client_secret (chmod 600).`
    );
  }
}

const CONFIG = {
  fri: {
    spreadsheetId: '1maWZi_HTOjyTbeeM3uQ2ovkFlQTCUpIcLHkvTODUAXc',
    groupEmail: 'kkfrifooty@googlegroups.com',
    emailSubject: 'fri credit',
    title: 'Fri Credit',
    searchQuery: 'to:kkfrifooty@googlegroups.com newer_than:7d',
  },
  mon: {
    spreadsheetId: '11pKmY3UITJ1faNxO_Hdb9XpVGXx63pfhjuEOc4pyw4s',
    groupEmail: 'symbionicsfooty@googlegroups.com',
    emailSubject: 'mon credit',
    title: 'Mon Credit',
    searchQuery: 'to:symbionicsfooty@googlegroups.com newer_than:7d',
  },
  credentials: loadCredentials(),
  previewEmail: 'thejgs@gmail.com',
};

// ─── State (persisted in /tmp between commands if needed) ──────────────────────

const STATE_FILE = '/tmp/footy-credit-state.json';

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function saveState(s) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function colIdx2Letter(idx) {
  let s = ''; idx++;
  while (idx > 0) {
    s = String.fromCharCode(64 + (idx % 26 || 26)) + s;
    idx = Math.floor((idx - (idx % 26 || 26)) / 26);
  }
  return s;
}

async function gFetch(url, opts = {}) {
  const state = loadState();
  if (!state.access_token) throw new Error('No access token. Run refresh-token first.');
  const headers = { Authorization: `Bearer ${state.access_token}`, ...opts.headers };
  const resp = await fetch(url, { ...opts, headers });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`HTTP ${resp.status}: ${text}`);
  }
  return resp.json();
}

function base64Encode(str) {
  return Buffer.from(str, 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeBase64Url(str) {
  if (!str) return '';
  const padded = str.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(padded, 'base64').toString('utf8');
}

function getBody(part) {
  let text = '';
  if (part.mimeType === 'text/plain' && part.body?.data) text += decodeBase64Url(part.body.data);
  if (part.parts) part.parts.forEach(p => { text += getBody(p); });
  return text;
}

// ─── Commands ──────────────────────────────────────────────────────────────────

async function refreshToken() {
  const { refresh_token, client_id, client_secret } = CONFIG.credentials;
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ refresh_token, client_id, client_secret, grant_type: 'refresh_token' }),
  });
  const data = await resp.json();
  if (!data.access_token) throw new Error('Token refresh failed: ' + JSON.stringify(data));
  const state = loadState();
  state.access_token = data.access_token;
  saveState(state);
  console.log('Token refreshed OK');
}

async function getPlayers(mode) {
  const { spreadsheetId } = CONFIG[mode];
  const data = await gFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/Credit!A10:A40`
  );
  const players = (data.values || []).map((row, i) => ({
    row: i + 10,
    name: row[0] || '',
  })).filter(p => p.name.trim() && p.name.trim() !== 'Slush Fund');
  console.log(JSON.stringify(players, null, 2));
  return players;
}

async function searchEmails(mode) {
  const { searchQuery } = CONFIG[mode];
  const q = encodeURIComponent(searchQuery);
  const data = await gFetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${q}&maxResults=20`
  );
  const ids = (data.messages || []).map(m => m.id);

  // Fetch metadata for each
  const results = [];
  for (const id of ids.slice(0, 20)) {
    const msg = await gFetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`
    );
    const hdr = (name) => msg.payload?.headers?.find(h => h.name === name)?.value || '';
    results.push({ id, threadId: msg.threadId, subject: hdr('Subject'), from: hdr('From'), date: hdr('Date'), snippet: msg.snippet });
  }
  console.log(JSON.stringify(results, null, 2));
  return results;
}

async function getThread(threadId) {
  const data = await gFetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/threads/${threadId}?format=full`
  );
  const messages = (data.messages || []).map(msg => ({
    from: msg.payload?.headers?.find(h => h.name === 'From')?.value || '',
    date: msg.payload?.headers?.find(h => h.name === 'Date')?.value || '',
    body: getBody(msg.payload).slice(0, 800),
  }));
  console.log(JSON.stringify(messages, null, 2));
  return messages;
}

async function readHeaders(mode) {
  const { spreadsheetId } = CONFIG[mode];
  const data = await gFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets(properties,data(columnMetadata(hiddenByUser),rowData(values(formattedValue))))&ranges=Credit!A7:ZZ9&includeGridData=true`
  );
  const sheetData = data.sheets?.[0]?.data?.[0];
  const rows = sheetData?.rowData || [];
  const colMeta = sheetData?.columnMetadata || [];
  const numericSheetId = data.sheets?.[0]?.properties?.sheetId;

  const colMap = [];
  rows.forEach((row, rowIdx) => {
    (row.values || []).forEach((cell, colIdx) => {
      if (cell.formattedValue) colMap.push({
        row: rowIdx + 7, col: colIdx, value: cell.formattedValue,
        hidden: colMeta[colIdx]?.hiddenByUser || false,
      });
    });
  });

  const r8map = {};
  colMap.filter(c => c.row === 8).forEach(c => r8map[c.col] = c.value || '');

  const filledDates = colMap
    .filter(c => c.row === 7 && !c.hidden && /^\d+ \w+ \d+/.test(c.value))
    .filter(c => { const cnt = r8map[c.col]?.trim() || ''; return cnt && !cnt.startsWith('-'); })
    .sort((a, b) => b.col - a.col);

  const result = {
    numericSheetId,
    sess2Col: filledDates[0]?.col,
    sess2Date: filledDates[0]?.value || '',
    sess1Col: filledDates[1]?.col,
    sess1Date: filledDates[1]?.value || '',
  };

  // Save to state for subsequent commands
  const state = loadState();
  state[mode] = { ...state[mode], ...result };
  saveState(state);

  console.log(JSON.stringify(result, null, 2));
  return result;
}

async function copyColumns(mode) {
  const { spreadsheetId } = CONFIG[mode];
  const state = loadState();
  const { numericSheetId, sess2Col } = state[mode] || {};
  if (sess2Col === undefined) throw new Error('Run read-headers first');

  const data = await gFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: [{
          copyPaste: {
            source: { sheetId: numericSheetId, startRowIndex: 0, endRowIndex: 256, startColumnIndex: sess2Col, endColumnIndex: sess2Col + 3 },
            destination: { sheetId: numericSheetId, startRowIndex: 0, endRowIndex: 256, startColumnIndex: sess2Col + 3, endColumnIndex: sess2Col + 6 },
            pasteType: 'PASTE_NORMAL', pasteOrientation: 'NORMAL',
          },
        }],
      }),
    }
  );
  console.log('Columns copied OK (template for next week)');
}

async function writePlayed(mode, rowVals) {
  const { spreadsheetId } = CONFIG[mode];
  const state = loadState();
  const { sess2Col } = state[mode] || {};
  if (sess2Col === undefined) throw new Error('Run read-headers first');

  const colLetter = colIdx2Letter(sess2Col);
  const updates = rowVals.map(rv => {
    const [row, val] = rv.split(':');
    return { range: `Credit!${colLetter}${row}`, values: [[Number(val)]] };
  });

  const data = await gFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values:batchUpdate`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data: updates }),
    }
  );
  console.log(`Wrote ${updates.length} played values to column ${colLetter}`);
}

async function hideOld(mode) {
  const { spreadsheetId } = CONFIG[mode];
  const state = loadState();
  const { numericSheetId, sess1Col } = state[mode] || {};
  if (sess1Col === undefined) throw new Error('Run read-headers first');

  // Hide the session before sess1 (3 columns earlier)
  const oldCol = sess1Col - 3;
  if (oldCol < 1) { console.log('No older session to hide'); return; }

  await gFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: [{
          updateDimensionProperties: {
            range: { sheetId: numericSheetId, dimension: 'COLUMNS', startIndex: oldCol, endIndex: oldCol + 3 },
            properties: { hiddenByUser: true }, fields: 'hiddenByUser',
          },
        }],
      }),
    }
  );
  console.log(`Hidden columns ${oldCol}-${oldCol + 2}`);
}

async function readSessions(mode) {
  const { spreadsheetId } = CONFIG[mode];
  const state = loadState();
  const { sess1Col, sess2Col, sess1Date, sess2Date } = state[mode] || {};
  if (sess2Col === undefined) throw new Error('Run read-headers first');

  const ranges = [
    'Credit!A7:A40',
    `Credit!${colIdx2Letter(sess1Col)}7:${colIdx2Letter(sess1Col + 2)}40`,
    `Credit!${colIdx2Letter(sess2Col)}7:${colIdx2Letter(sess2Col + 2)}40`,
  ].map(r => 'ranges=' + encodeURIComponent(r)).join('&');

  const { valueRanges } = await gFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values:batchGet?${ranges}&valueRenderOption=UNFORMATTED_VALUE`
  );
  const [colA, s1, s2] = valueRanges;

  const sess = {
    date1: sess1Date,
    date2: sess2Date,
    count1: String(s1.values?.[1]?.[0] || '').trim(),
    count2: String(s2.values?.[1]?.[0] || '').trim(),
    rows: (colA.values || []).slice(3).map((nameCell, i) => ({
      name: String(nameCell[0] || ''),
      s1: s1.values?.[i + 3] || [],
      s2: s2.values?.[i + 3] || [],
    })),
  };

  // Save for build-email
  state[mode] = { ...state[mode], sess };
  saveState(state);

  console.log(`Sessions: "${sess.date1}" (${sess.count1} players) / "${sess.date2}" (${sess.count2} players), ${sess.rows.length} player rows`);
  return sess;
}

function buildEmail(mode) {
  const state = loadState();
  const s = state[mode]?.sess;
  if (!s) throw new Error('Run read-sessions first');

  const { title } = CONFIG[mode];
  const GREEN = '#a8d5b0', PINK = '#f4b8b5';
  const td = (content, style) => `<td style="padding:5px 8px;border:1px solid #ddd;font-family:Arial,sans-serif;font-size:13px;${style || ''}">${content}</td>`;

  const titleStyle = 'background:#2a5db0;color:white;padding:8px 10px;border:1px solid #1a4da0;font-family:Arial,sans-serif;font-size:15px;font-weight:bold;text-align:center;letter-spacing:1px;';
  const hdrStyle = 'background:#4a86e8;color:white;padding:6px 10px;border:1px solid #3a76d8;font-family:Arial,sans-serif;font-size:13px;text-align:center;';
  const countStyle = 'background:#3a76d8;color:white;padding:3px 8px;border:1px solid #2a66c8;font-family:Arial,sans-serif;font-size:12px;text-align:center;font-style:italic;';
  const subStyle = 'background:#e8f0fe;padding:5px 8px;border:1px solid #ddd;font-family:Arial,sans-serif;font-size:13px;font-weight:bold;text-align:center;';
  const playerStyle = 'background:#4a86e8;color:white;padding:6px 10px;border:1px solid #3a76d8;font-family:Arial,sans-serif;font-size:13px;vertical-align:middle;text-align:center;';

  const fmtCredit = v => {
    if (v === '' || v === undefined || v === null) return { txt: '', bg: '#fff' };
    const n = parseFloat(v);
    if (isNaN(n)) return { txt: String(v), bg: '#fff' };
    if (n < 0) return { txt: `£${n.toFixed(2)}`, bg: PINK };
    return { txt: `£${n.toFixed(2)}`, bg: GREEN };
  };

  let tableRows = '';
  let rowIdx = 0;

  for (const r of s.rows) {
    if (!r.name.trim() || r.name.trim() === 'Slush Fund') continue;
    const displayName = r.name.replace(/\s*\([^)]*\)\s*$/, '').trim();
    const bg = rowIdx % 2 === 0 ? '#fff' : '#f9f9f9';
    const pl1 = r.s1[0], col1 = r.s1[1], cr1 = r.s1[2];
    const pl2 = r.s2[0], col2 = r.s2[1], cr2 = r.s2[2];
    const c1r = fmtCredit(cr1), c2r = fmtCredit(cr2);
    const colTxt1 = (col1 === '' || col1 === undefined || col1 === 0) ? '' : '£' + parseFloat(col1).toFixed(2);
    const colTxt2 = (col2 === '' || col2 === undefined || col2 === 0) ? '' : '£' + parseFloat(col2).toFixed(2);
    tableRows += `<tr>${td(displayName, `background:${bg}`)}${td(pl1 == 1 ? '1' : (pl1 > 1 ? String(pl1) : ''), `background:${pl1 >= 1 ? GREEN : bg};text-align:center`)}${td(colTxt1, `background:${bg};text-align:right`)}${td(c1r.txt, `background:${c1r.bg};text-align:right`)}${td(pl2 == 1 ? '1' : (pl2 > 1 ? String(pl2) : ''), `background:${pl2 >= 1 ? GREEN : bg};text-align:center`)}${td(colTxt2, `background:${bg};text-align:right`)}${td(c2r.txt, `background:${c2r.bg};text-align:right`)}</tr>`;
    rowIdx++;
  }

  const html =
    `<table style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:13px;">` +
    `<tr><th colspan="7" style="${titleStyle}">${title}</th></tr>` +
    `<tr><th rowspan="3" style="${playerStyle}">Player</th><th colspan="3" style="${hdrStyle}">${s.date1}</th><th colspan="3" style="${hdrStyle}">${s.date2}</th></tr>` +
    `<tr><th colspan="3" style="${countStyle}">${s.count1 ? s.count1 + ' players' : ''}</th><th colspan="3" style="${countStyle}">${s.count2 ? s.count2 + ' players' : ''}</th></tr>` +
    `<tr>${['Pl', 'Collected', 'Credit', 'Pl', 'Collected', 'Credit'].map(h => `<th style="${subStyle}">${h}</th>`).join('')}</tr>` +
    tableRows + `</table>`;

  state[mode] = { ...state[mode], emailHtml: html };
  saveState(state);

  console.log(`Email HTML built: ${html.length} chars, ${rowIdx} player rows`);
  return html;
}

async function sendPreview(mode) {
  const state = loadState();
  const html = state[mode]?.emailHtml;
  if (!html) throw new Error('Run build-email first');

  const { emailSubject } = CONFIG[mode];
  const raw = [
    `To: ${CONFIG.previewEmail}`,
    `Subject: ${emailSubject} PREVIEW`,
    'Content-Type: text/html; charset=UTF-8',
    '',
    html,
  ].join('\r\n');

  const result = await gFetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: base64Encode(raw) }),
  });
  console.log(`Preview sent to ${CONFIG.previewEmail} — Message ID: ${result.id}`);
}

async function sendEmail(mode) {
  const state = loadState();
  const html = state[mode]?.emailHtml;
  if (!html) throw new Error('Run build-email first');

  const { groupEmail, emailSubject } = CONFIG[mode];
  const raw = [
    `To: ${groupEmail}`,
    `Subject: ${emailSubject}`,
    'Content-Type: text/html; charset=UTF-8',
    '',
    html,
  ].join('\r\n');

  const result = await gFetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: base64Encode(raw) }),
  });
  console.log(`Sent to ${groupEmail} — Message ID: ${result.id}`);
}

async function updatePage() {
  // Build both fri + mon tables, wrap in HTML doc, write docs/index.html, commit + push.
  async function tryBuild(m) {
    try {
      await readHeaders(m); await readSessions(m); buildEmail(m);
      return loadState()[m]?.emailHtml || null;
    } catch (e) {
      console.error(`${m}: ${e.message} — skipping`);
      return null;
    }
  }
  const friHtml = await tryBuild('fri') || `<p><em>No Friday session data.</em></p>`;
  const monHtml = await tryBuild('mon') || `<p><em>No Monday session data.</em></p>`;

  const updated = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  const doc = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Footy Credit</title>
<style>
  body { font-family: Arial, sans-serif; margin: 16px; background: #fafafa; color: #222; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .updated { color: #666; font-size: 12px; margin-bottom: 18px; }
  section { margin-bottom: 28px; overflow-x: auto; }
</style>
</head>
<body>
<h1>Footy Credit</h1>
<p class="updated">Updated ${updated}</p>
<section>${friHtml}</section>
<section>${monHtml}</section>
</body>
</html>
`;

  const docsDir = path.join(process.cwd(), 'docs');
  fs.mkdirSync(docsDir, { recursive: true });
  const outPath = path.join(docsDir, 'index.html');
  fs.writeFileSync(outPath, doc);
  // .nojekyll so GitHub Pages serves as-is.
  fs.writeFileSync(path.join(docsDir, '.nojekyll'), '');
  console.log(`Wrote ${outPath} (${doc.length} bytes)`);

  const { execSync } = await import('node:child_process');
  const sh = (cmd) => execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  try {
    sh('git add docs/index.html docs/.nojekyll');
    const staged = sh('git diff --cached --name-only');
    if (!staged) { console.log('No page changes to commit.'); return; }
    sh(`git commit -m "Update credit page ${updated}"`);
    sh('git push');
    console.log('Page committed + pushed.');
  } catch (e) {
    console.error('Git step failed:', e.stderr?.toString() || e.message);
  }
}

async function runAll(mode, rowVals) {
  console.log(`\n=== Running full ${mode}-credit workflow ===\n`);
  await readHeaders(mode);
  await copyColumns(mode);
  await writePlayed(mode, rowVals);
  await hideOld(mode);
  await readSessions(mode);
  buildEmail(mode);
  await sendPreview(mode);
  await sendEmail(mode);
  try { await updatePage(); } catch (e) { console.error('update-page failed:', e.message); }
  console.log('\n=== Done! ===');
}

// ─── CLI ───────────────────────────────────────────────────────────────────────

const [,, mode, command, ...args] = process.argv;

// Mode-less commands handled first.
if (mode === 'refresh-token') {
  await refreshToken();
  process.exit(0);
}
if (mode === 'update-page') {
  await updatePage();
  process.exit(0);
}

if (!mode || !command) {
  console.log('Usage: node footy-credit.mjs <fri|mon> <command> [args...]');
  console.log('       node footy-credit.mjs refresh-token');
  console.log('       node footy-credit.mjs update-page');
  console.log('\nCommands: refresh-token, update-page, get-players, search-emails,');
  console.log('          get-thread <id>, read-headers, copy-columns,');
  console.log('          write-played <r:v,...>, hide-old, read-sessions,');
  console.log('          build-email, send-preview, send-email, run-all <r:v,...>');
  process.exit(1);
}

if (!['fri', 'mon'].includes(mode)) {
  console.error(`Unknown mode "${mode}". Use "fri" or "mon".`);
  process.exit(1);
}

try {
  switch (command) {
    case 'refresh-token': await refreshToken(); break;
    case 'get-players': await getPlayers(mode); break;
    case 'search-emails': await searchEmails(mode); break;
    case 'get-thread': await getThread(args[0]); break;
    case 'read-headers': await readHeaders(mode); break;
    case 'copy-columns': await copyColumns(mode); break;
    case 'write-played': await writePlayed(mode, args[0].split(',')); break;
    case 'hide-old': await hideOld(mode); break;
    case 'read-sessions': await readSessions(mode); break;
    case 'build-email': buildEmail(mode); break;
    case 'send-preview': await sendPreview(mode); break;
    case 'send-email': await sendEmail(mode); break;
    case 'run-all': await runAll(mode, args[0].split(',')); break;
    default: console.error(`Unknown command: ${command}`); process.exit(1);
  }
} catch (e) {
  console.error('Error:', e.message);
  process.exit(1);
}
