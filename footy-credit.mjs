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
 *   copy-columns                   Copy template columns for next week (auto-clears stale Played/Collected)
 *   clear-week                     Clear Played + Collected for current week's column (rows 10-42)
 *   write-played <row:val,...>     Write played values (e.g. "10:1,14:1,39:2")
 *   hide-old                       Hide the oldest visible session
 *   read-sessions                  Read back 2 most recent sessions for email
 *   build-email                    Build HTML email table from session data
 *   send-preview                   Send preview email to thejgs@gmail.com
 *   send-email                     Send credit email to the group
 *   pick [--cutoff "YYYY-MM-DD HH:MM"] [--thread <id>] [--no-save] [--verbose]
 *                                  (mon) Rank this week's sign-ups by the trial selection rule; prints only
 *   pick-report                    (mon) Compare the rule's picks with who actually played
 *   run-all <row:val,...>          Run copy-columns → write-played → hide-old → read-sessions → build-email → send-preview → send-email
 */

// ─── Config ────────────────────────────────────────────────────────────────────

import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';

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

// One-time interactive flow to mint a brand-new refresh_token via the browser.
// Needed when Google revokes/expires the stored refresh_token (e.g. the 7-day
// expiry that applies while the OAuth app is in "Testing" publishing status).
// Run it yourself so the browser opens on your machine: `! node footy-credit.mjs authorize`
async function authorize() {
  const { client_id, client_secret } = CONFIG.credentials;
  const port = Number(process.env.FOOTY_CREDIT_OAUTH_PORT) || 53682;
  const redirectUri = `http://localhost:${port}/`;
  const scopes = [
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/gmail.readonly',
  ];
  const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: scopes.join(' '),
    access_type: 'offline',
    prompt: 'consent', // force Google to return a fresh refresh_token
  });

  const code = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, redirectUri);
      const c = url.searchParams.get('code');
      const err = url.searchParams.get('error');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<h2>${c ? 'Authorized — return to the terminal, you can close this tab.' : 'Authorization failed: ' + (err || 'no code')}</h2>`);
      server.close();
      c ? resolve(c) : reject(new Error(err || 'No authorization code received'));
    });
    server.listen(port, () => {
      console.log('\nOpen this URL in your browser, sign in, and approve access:\n');
      console.log(authUrl + '\n');
      console.log(`Waiting for the redirect to ${redirectUri} ...`);
      console.log('(If you get "redirect_uri_mismatch", add this redirect URI to the OAuth client in Google Cloud Console.)');
    });
  });

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code, client_id, client_secret, redirect_uri: redirectUri, grant_type: 'authorization_code',
    }),
  });
  const data = await resp.json();
  if (!data.refresh_token) throw new Error('No refresh_token returned: ' + JSON.stringify(data));

  const creds = JSON.parse(fs.readFileSync(CRED_PATH, 'utf8'));
  creds.refresh_token = data.refresh_token;
  fs.writeFileSync(CRED_PATH, JSON.stringify(creds, null, 2));
  fs.chmodSync(CRED_PATH, 0o600);

  const state = loadState();
  state.access_token = data.access_token;
  saveState(state);

  console.log(`\nNew refresh_token saved to ${CRED_PATH}`);
  console.log('Access token cached — you can run the workflow now.');
}

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
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/Credit!A10:A42`
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
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets(properties,data(columnMetadata(hiddenByUser),rowData(values(formattedValue))))&ranges=Credit!7:9&includeGridData=true`
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

  // PASTE_NORMAL also copies values, so the new week starts with last week's
  // Played + Collected. Refresh state pointers and clear stale data so the
  // new column is ready for write-played. Credit column has a formula —
  // leave it; it'll recompute from the now-blank Played/Collected.
  await readHeaders(mode);
  await clearWeek(mode);
}

async function clearWeek(mode) {
  const { spreadsheetId } = CONFIG[mode];
  const state = loadState();
  const { sess2Col } = state[mode] || {};
  if (sess2Col === undefined) throw new Error('Run read-headers first');

  // Slush Fund row holds a formula in Played + Collected — must not be cleared.
  // Find it dynamically so the script is resilient to row reordering.
  const namesResp = await gFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/Credit!A10:A42`
  );
  const slushIdx = (namesResp.values || []).findIndex(r => /slush fund/i.test(r[0] || ''));
  const slushRow = slushIdx >= 0 ? slushIdx + 10 : null;

  // Build row ranges 10..42, splitting around Slush Fund row if present.
  const rowRanges = slushRow
    ? [[10, slushRow - 1], [slushRow + 1, 42]].filter(([a, b]) => a <= b)
    : [[10, 42]];

  const playedCol = colIdx2Letter(sess2Col);
  const collectedCol = colIdx2Letter(sess2Col + 1);
  const ranges = [];
  for (const [a, b] of rowRanges) {
    ranges.push(`Credit!${playedCol}${a}:${playedCol}${b}`);
    ranges.push(`Credit!${collectedCol}${a}:${collectedCol}${b}`);
  }

  await gFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values:batchClear`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ranges }),
    }
  );
  console.log(
    `Cleared Played(${playedCol}) + Collected(${collectedCol}) rows 10-42` +
    (slushRow ? ` (skipped Slush Fund row ${slushRow})` : '')
  );
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
    'Credit!A7:A42',
    `Credit!${colIdx2Letter(sess1Col)}7:${colIdx2Letter(sess1Col + 2)}42`,
    `Credit!${colIdx2Letter(sess2Col)}7:${colIdx2Letter(sess2Col + 2)}42`,
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
    price1: s1.values?.[1]?.[2],
    price2: s2.values?.[1]?.[2],
    rows: (colA.values || []).slice(3).map((nameCell, i) => ({
      name: String(nameCell[0] || ''),
      s1: s1.values?.[i + 3] || [],
      s2: s2.values?.[i + 3] || [],
    })),
  };

  // Order output alphabetically by first name. Non-player rows (blank cells,
  // Slush Fund) are skipped by the renderers regardless, so push them to the end.
  const firstName = (r) =>
    String(r.name || '')
      .replace(/\s*\([^)]*\)\s*$/, '')
      .trim()
      .split(/\s+/)[0]
      .toLowerCase();
  const isPlayer = (r) => {
    const n = String(r.name || '').trim();
    return n && n !== 'Slush Fund';
  };
  sess.rows.sort((a, b) => {
    const pa = isPlayer(a), pb = isPlayer(b);
    if (pa !== pb) return pa ? -1 : 1;
    return firstName(a).localeCompare(firstName(b));
  });

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
  const html = buildEmailTable(s, title);

  state[mode] = { ...state[mode], emailHtml: html };
  saveState(state);

  console.log(`Email HTML built: ${html.length} chars`);
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

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fmtMoney(v) {
  if (v === '' || v === undefined || v === null) return null;
  const n = parseFloat(v);
  if (isNaN(n)) return null;
  return { n, txt: `£${n.toFixed(2)}` };
}

function buildPageTable(sess) {
  let rows = '';
  for (const r of sess.rows) {
    const name = String(r.name || '').trim();
    if (!name || name === 'Slush Fund') continue;
    const display = esc(name.replace(/\s*\([^)]*\)\s*$/, '').trim());

    const s1 = r.s1, s2 = r.s2;
    const plCell = (pl, extraClass = '') => {
      const txt = (pl === 1 || pl === '1') ? '1' : (pl > 1 ? String(pl) : '');
      const cls = (pl >= 1 ? 'pl played' : 'pl') + (extraClass ? ' ' + extraClass : '');
      return `<td class="${cls}">${txt}</td>`;
    };
    const collCell = (v) => {
      const m = fmtMoney(v);
      return `<td class="num mobile-hide">${m && m.n !== 0 ? m.txt : ''}</td>`;
    };
    const crCell = (v) => {
      const m = fmtMoney(v);
      if (!m) return `<td class="num"></td>`;
      return `<td class="num ${m.n < 0 ? 'neg' : 'pos'}">${m.txt}</td>`;
    };

    // Tag session-1 cells with mobile-hide-s1 so phones only show latest session.
    rows +=
      `<tr>` +
      `<td class="player">${display}</td>` +
      `<td class="${(s1[0] >= 1 ? 'pl played' : 'pl')} mobile-hide-s1">${(s1[0] === 1 || s1[0] === '1') ? '1' : (s1[0] > 1 ? String(s1[0]) : '')}</td>` +
      `<td class="num mobile-hide">${(() => { const m = fmtMoney(s1[1]); return m && m.n !== 0 ? m.txt : ''; })()}</td>` +
      (() => { const m = fmtMoney(s1[2]); if (!m) return `<td class="num mobile-hide-s1"></td>`; return `<td class="num mobile-hide-s1 ${m.n < 0 ? 'neg' : 'pos'}">${m.txt}</td>`; })() +
      plCell(s2[0], 'sep') + collCell(s2[1]) + crCell(s2[2]) +
      `</tr>`;
  }

  return `<table class="credit-table">
  <thead>
    <tr class="session-row">
      <th></th>
      <th colspan="3" class="mobile-hide-s1">${esc(sess.date1)}<span class="count">${esc(sess.count1 || '')} players</span></th>
      <th colspan="3" class="sep">${esc(sess.date2)}<span class="count">${esc(sess.count2 || '')} players</span></th>
    </tr>
    <tr class="col-row">
      <th class="player-h">Player</th>
      <th class="pl-h mobile-hide-s1">Pl</th><th class="mobile-hide">Collected</th><th class="mobile-hide-s1">Credit</th>
      <th class="pl-h sep">Pl</th><th class="mobile-hide">Collected</th><th>Credit</th>
    </tr>
  </thead>
  <tbody>${rows}</tbody>
</table>`;
}

// Inline-styled table for email clients (most strip <link>/<style>).
// Colours match the dark theme used on the public pages.
function buildEmailTable(sess, title) {
  const C = {
    bg: '#1a1d22',
    surface: '#252830',
    surfaceRaised: '#2d3038',
    line: '#2d3038',
    lineSoft: '#25282f',
    ink: '#e8e6e0',
    inkSoft: '#a8a59c',
    inkFaint: '#6e6c63',
    pos: '#a3c89a',
    neg: '#e0a78c',
    playedBg: '#1f3a2c',
    accent: '#d4a866',
    sans: "'Helvetica Neue', Arial, sans-serif",
  };

  const sepBorder = `border-left:1px solid ${C.line};`;
  const sessionThBase = `background:${C.surfaceRaised};color:${C.ink};font-weight:600;font-size:13px;padding:8px 6px;border-bottom:1px solid ${C.line};text-align:center;font-family:${C.sans};`;
  const sessionTh = `style="${sessionThBase}"`;
  const sessionThSep = `style="${sessionThBase}${sepBorder}"`;
  const countSpan = `style="display:block;font-size:10px;font-weight:500;color:${C.inkSoft};margin-top:2px;letter-spacing:0.06em;text-transform:uppercase;font-family:${C.sans};"`;
  const colThBase = `background:${C.surfaceRaised};color:${C.inkFaint};font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:0.06em;padding:6px 6px;border-bottom:1px solid ${C.line};font-family:${C.sans};`;
  const colTh = `style="${colThBase}text-align:right;"`;
  const colThPlayer = `style="${colThBase}text-align:left;"`;
  const colThPl = `style="${colThBase}text-align:center;"`;
  const colThPlSep = `style="${colThBase}text-align:center;${sepBorder}"`;

  const tdBase = `padding:6px 6px;border-bottom:1px solid ${C.lineSoft};font-family:${C.sans};font-size:13px;`;
  const tdPlayer = `${tdBase}color:${C.ink};font-weight:500;text-align:left;`;
  const tdPlBase = `${tdBase}text-align:center;color:${C.ink};`;
  const tdPlPlayed = `${tdBase}text-align:center;color:${C.pos};font-weight:600;background:${C.playedBg};`;
  const tdNum = `${tdBase}color:${C.inkSoft};text-align:right;`;
  const tdNumPos = `${tdBase}color:${C.pos};text-align:right;`;
  const tdNumNeg = `${tdBase}color:${C.neg};text-align:right;`;

  let rows = '';
  for (const r of sess.rows) {
    const name = String(r.name || '').trim();
    if (!name || name === 'Slush Fund') continue;
    const display = esc(name.replace(/\s*\([^)]*\)\s*$/, '').trim());

    const plCell = (pl, sep = false) => {
      const txt = (pl === 1 || pl === '1') ? '1' : (pl > 1 ? String(pl) : '');
      const style = (pl >= 1 ? tdPlPlayed : tdPlBase) + (sep ? sepBorder : '');
      return `<td style="${style}">${txt}</td>`;
    };
    const collCell = (v) => {
      const m = fmtMoney(v);
      const txt = m && m.n !== 0 ? m.txt : '';
      return `<td style="${tdNum}">${txt}</td>`;
    };
    const crCell = (v) => {
      const m = fmtMoney(v);
      if (!m) return `<td style="${tdNum}"></td>`;
      const style = m.n < 0 ? tdNumNeg : tdNumPos;
      return `<td style="${style}">${m.txt}</td>`;
    };

    rows +=
      `<tr>` +
      `<td style="${tdPlayer}">${display}</td>` +
      plCell(r.s1[0]) + collCell(r.s1[1]) + crCell(r.s1[2]) +
      plCell(r.s2[0], true) + collCell(r.s2[1]) + crCell(r.s2[2]) +
      `</tr>`;
  }

  const titleBar = `<div style="background:${C.bg};color:${C.ink};font-family:${C.sans};padding:18px 16px 8px;">` +
    `<div style="font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:${C.accent};font-weight:600;margin-bottom:4px;">Footy Credit</div>` +
    `<div style="font-size:22px;font-weight:600;letter-spacing:-0.01em;">${esc(title)}</div>` +
    `</div>`;

  const table =
    `<table cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;width:100%;background:${C.surface};">` +
    `<thead>` +
      `<tr>` +
        `<th ${sessionTh}></th>` +
        `<th colspan="3" ${sessionTh}>${esc(sess.date1)}<span ${countSpan}>${esc(sess.count1 || '')} players${fmtMoney(sess.price1) ? ` · ${fmtMoney(sess.price1).txt} each` : ''}</span></th>` +
        `<th colspan="3" ${sessionThSep}>${esc(sess.date2)}<span ${countSpan}>${esc(sess.count2 || '')} players${fmtMoney(sess.price2) ? ` · ${fmtMoney(sess.price2).txt} each` : ''}</span></th>` +
      `</tr>` +
      `<tr>` +
        `<th ${colThPlayer}>Player</th>` +
        `<th ${colThPl}>Pl</th><th ${colTh}>Coll</th><th ${colTh}>Credit</th>` +
        `<th ${colThPlSep}>Pl</th><th ${colTh}>Coll</th><th ${colTh}>Credit</th>` +
      `</tr>` +
    `</thead>` +
    `<tbody>${rows}</tbody>` +
    `</table>`;

  return `<div style="background:${C.bg};padding:0 0 18px;">` +
    `<div style="max-width:520px;margin:0 auto;">${titleBar}${table}</div>` +
    `</div>`;
}

async function updatePage() {
  // Build per-day pages (docs/fri/, docs/mon/) + a landing index. Commit + push.
  async function tryFetch(m) {
    try {
      await readHeaders(m); await readSessions(m);
      return loadState()[m]?.sess || null;
    } catch (e) {
      console.error(`${m}: ${e.message} — skipping`);
      return null;
    }
  }
  const friSess = await tryFetch('fri');
  const monSess = await tryFetch('mon');

  const updated = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

  const dayPage = (mode, title, sess) => {
    const stylesPath = '../styles.css';
    const friActive = mode === 'fri' ? ' class="active"' : '';
    const monActive = mode === 'mon' ? ' class="active"' : '';
    const body = sess
      ? buildPageTable(sess)
      : `<div class="empty">No session data yet.</div>`;
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${esc(title)}</title>
<link rel="stylesheet" href="${stylesPath}">
</head>
<body>
<header class="site-header">
  <div class="site-header-inner">
    <a class="site-title" href="../">Footy Credit</a>
    <nav class="site-nav">
      <a href="../mon/"${monActive}>Monday</a>
      <a href="../fri/"${friActive}>Friday</a>
    </nav>
  </div>
</header>
<main>
  <div class="hero">
    <h1>${esc(title)}</h1>
    <p class="tagline">Credit standings — last two sessions.</p>
  </div>
  ${body}
</main>
<footer class="site-footer">Updated ${esc(updated)}</footer>
</body>
</html>
`;
  };

  const indexDoc = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Footy Credit</title>
<link rel="stylesheet" href="styles.css">
</head>
<body>
<header class="site-header">
  <div class="site-header-inner">
    <a class="site-title" href="./">Footy Credit</a>
    <nav class="site-nav">
      <a href="mon/">Monday</a>
      <a href="fri/">Friday</a>
    </nav>
  </div>
</header>
<main>
  <div class="hero">
    <h1>Footy Credit</h1>
    <p class="tagline">Running credit for the Friday and Monday 5-a-side groups.</p>
  </div>
  <div class="day-grid">
    <a class="day-card" href="mon/">
      <span class="day-label">MON</span>
      <span class="day-title">Monday</span>
      <span class="day-arrow">&rarr;</span>
    </a>
    <a class="day-card" href="fri/">
      <span class="day-label">FRI</span>
      <span class="day-title">Friday</span>
      <span class="day-arrow">&rarr;</span>
    </a>
  </div>
</main>
<footer class="site-footer">Updated ${esc(updated)}</footer>
</body>
</html>
`;

  const docsDir = path.join(process.cwd(), 'docs');
  fs.mkdirSync(path.join(docsDir, 'fri'), { recursive: true });
  fs.mkdirSync(path.join(docsDir, 'mon'), { recursive: true });
  fs.writeFileSync(path.join(docsDir, 'index.html'), indexDoc);
  fs.writeFileSync(path.join(docsDir, 'fri', 'index.html'), dayPage('fri', 'Friday', friSess));
  fs.writeFileSync(path.join(docsDir, 'mon', 'index.html'), dayPage('mon', 'Monday', monSess));
  fs.writeFileSync(path.join(docsDir, '.nojekyll'), '');
  console.log(`Wrote docs/index.html, docs/fri/index.html, docs/mon/index.html`);

  const { execSync } = await import('node:child_process');
  const sh = (cmd) => execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  try {
    sh('git add docs');
    if (fs.existsSync(path.join(process.cwd(), 'data'))) sh('git add data');
    const staged = sh('git diff --cached --name-only');
    if (!staged) { console.log('No page changes to commit.'); return; }
    sh(`git commit -m "Update credit pages ${updated}"`);
    sh('git push');
    console.log('Pages committed + pushed.');
  } catch (e) {
    console.error('Git step failed:', e.stderr?.toString() || e.message);
  }
}

async function runAll(mode, rowVals) {
  console.log(`\n=== Running full ${mode}-credit workflow ===\n`);
  await readHeaders(mode);
  await copyColumns(mode);
  await writePlayed(mode, rowVals);
  recordActual(mode, rowVals);
  await hideOld(mode);
  await readSessions(mode);
  buildEmail(mode);
  await sendPreview(mode);
  await sendEmail(mode);
  try { await updatePage(); } catch (e) { console.error('update-page failed:', e.message); }
  console.log('\n=== Done! ===');
}

// ─── Pick: Monday selection rule (private trial) ───────────────────────────────
//
// Rule under trial (not published to the group):
//   Reply by 18:00 on the day the list goes out (normally Tuesday). Everyone who
//   replies by then is ranked: (1) left out recently and not played since, (2)
//   everyone else, by reply time. How long being left out keeps priority depends on
//   attendance: see PICK.priorityWeeks. Top 10 play; the rest are reserves in order. Replies after
//   the cut-off rank below every on-time reply. People who only offered to be a
//   reserve go last. Attendance over the last 8, 26 and 52 sessions is shown for
//   information only (signing up on time and being left out counts as attended).

const PICK = {
  cutoffHour: 18,
  windows: [8, 26, 52],
  // Weeks of priority after being left out, by best attendance over the windows.
  priorityWeeks: [[0.75, 4], [0.5, 3], [0.25, 2], [0, 1]],
  organiserEmail: 'thejgs@gmail.com',
  playerRows: [10, 40],
};

function playersPath(mode) { return path.join(process.cwd(), `players.${mode}.json`); }
function ledgerPath(mode) { return path.join(process.cwd(), 'data', `${mode}-picks.json`); }

function loadPlayers(mode) {
  try { return JSON.parse(fs.readFileSync(playersPath(mode), 'utf8')); }
  catch (e) { throw new Error(`Cannot read ${playersPath(mode)}: ${e.message}`); }
}
function loadLedger(mode) {
  try { return JSON.parse(fs.readFileSync(ledgerPath(mode), 'utf8')); } catch { return {}; }
}
function saveLedger(mode, ledger) {
  fs.mkdirSync(path.dirname(ledgerPath(mode)), { recursive: true });
  fs.writeFileSync(ledgerPath(mode), JSON.stringify(ledger, null, 2) + '\n');
}

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function fmtSheetDate(d) { return `${d.getDate()} ${MONTHS[d.getMonth()]} ${String(d.getFullYear()).slice(-2)}`; }
function parseSheetDate(s) {
  const m = /^(\d+) (\w{3}) (\d{2})$/.exec(String(s).trim());
  if (!m) return null;
  return new Date(2000 + Number(m[3]), MONTHS.indexOf(m[2]), Number(m[1]));
}
function nextMonday(from) {
  const d = new Date(from); d.setHours(0, 0, 0, 0);
  const add = ((8 - d.getDay()) % 7) || 7;
  d.setDate(d.getDate() + add);
  return d;
}
function fmtTime(d) {
  return d.toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function parseFrom(from) {
  const m = /^(.*?)\s*<([^>]+)>\s*$/.exec(from || '');
  const name = (m ? m[1] : '').replace(/^["']|["']$/g, '').replace(/^'|'\s+via\s+.*$/i, '').trim();
  const email = (m ? m[2] : from || '').trim().toLowerCase();
  return { name, email };
}

function htmlToText(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|li|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"');
}
function getBodyAny(payload) {
  const plain = getBody(payload);
  if (plain.trim()) return plain;
  const html = (function walk(p) {
    let t = '';
    if (p.mimeType === 'text/html' && p.body?.data) t += decodeBase64Url(p.body.data);
    (p.parts || []).forEach(x => { t += walk(x); });
    return t;
  })(payload);
  return htmlToText(html);
}

// Keep only the new content of a reply: stop at quoted text or signatures.
function contentLines(text) {
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/​|﻿/g, '').trim();
    if (!line) continue;
    if (line.startsWith('>')) break;
    if (/^(on .+ wrote:?$|from:|sent from|sent:|-{2,}$|_{5,}|am \d{2}\.\d{2}\.\d{4} um)/i.test(line)) break;
    if (/^(yahoo mail:|regards|best regards|cheers|thanks!?$|thank you$)/i.test(line)) break;
    out.push(line);
  }
  return out;
}

function findPlayer(players, { email, name }) {
  const e = (email || '').toLowerCase();
  const n = (name || '').toLowerCase().trim();
  return players.find(p => p.aliases.includes(e))
      || players.find(p => n && p.aliases.includes(n))
      || players.find(p => n && p.name.toLowerCase() === n)
      || null;
}
function findByToken(players, token) {
  const t = token.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!t) return null;
  return players.find(p => p.aliases.includes(t) || p.short === t)
      || players.find(p => p.name.toLowerCase().split(' ')[0] === t)
      || null;
}

function classifyReply(lines) {
  const s = lines.slice(0, 3).join(' ').toLowerCase();
  if (!s.trim()) return 'empty';
  if (/reacted via gmail/.test(s)) return 'ignore';
  if (/\b(sorry|drop|pull(ing)? out|can'?t|cannot|unable|away|sit this one out|not available|have to miss)\b/.test(s)) return 'drop';
  if (/\b(reserve|bench|waiting list|if (you are|you're) short|if short|standby|sub if needed)\b/.test(s)) return 'reserve';
  if (/(\byes\b|\byep\b|\byeah\b|\bin please\b|\bi'?m in\b|\bcount me in\b|\+1|\bavailable\b|love to play|\bplease\b|^in\b|\bin\b.*\bfor\b)/.test(s)) return 'yes';
  return 'unknown';
}

async function findSignupThread(mode) {
  const { groupEmail } = CONFIG[mode];
  const q = encodeURIComponent(`to:${groupEmail} subject:"mondays list" newer_than:14d`);
  const data = await gFetch(`https://gmail.googleapis.com/gmail/v1/users/me/threads?q=${q}&maxResults=10`);
  const candidates = [];
  for (const t of data.threads || []) {
    const th = await gFetch(`https://gmail.googleapis.com/gmail/v1/users/me/threads/${t.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=Date`);
    const first = th.messages?.[0];
    const hdr = (n) => first?.payload?.headers?.find(h => h.name === n)?.value || '';
    const subject = hdr('Subject');
    if (!/mondays list/i.test(subject) || /credit/i.test(subject)) continue;
    candidates.push({ threadId: t.id, subject, date: new Date(hdr('Date')), count: th.messages.length });
  }
  candidates.sort((a, b) => b.date - a.date);
  if (!candidates.length) throw new Error('No "Mondays list" thread found in the last 14 days');
  return candidates[0];
}

async function fetchThreadMessages(threadId) {
  const data = await gFetch(`https://gmail.googleapis.com/gmail/v1/users/me/threads/${threadId}?format=full`);
  return (data.messages || []).map(msg => {
    const hdr = (n) => msg.payload?.headers?.find(h => h.name === n)?.value || '';
    const { name, email } = parseFrom(hdr('From'));
    return { id: msg.id, fromName: name, fromEmail: email, date: new Date(hdr('Date')), lines: contentLines(getBodyAny(msg.payload)) };
  }).sort((a, b) => a.date - b.date);
}

// Walk the thread in time order and build the sign-up list.
function parseSignups(messages, players) {
  const signups = new Map();   // row -> { at, reserveOnly, via }
  const guests = [];           // { name, email, at }
  const notes = [];            // human-readable log of what was understood
  const unknown = [];          // messages the parser could not interpret

  const signUp = (p, at, via, reserveOnly = false) => {
    const cur = signups.get(p.row);
    if (cur && !cur.dropped) { if (cur.reserveOnly && !reserveOnly) cur.reserveOnly = false; return; }
    signups.set(p.row, { at, via, reserveOnly, dropped: false });
    notes.push(`${fmtTime(at)}  + ${p.name}${reserveOnly ? ' (reserve only)' : ''}  [${via}]`);
  };
  const dropOut = (p, at, via) => {
    const cur = signups.get(p.row);
    if (!cur || cur.dropped) return;
    cur.dropped = true; cur.droppedAt = at;
    notes.push(`${fmtTime(at)}  - ${p.name}  [${via}]`);
  };

  messages.forEach((m, idx) => {
    const isOrganiser = m.fromEmail === PICK.organiserEmail;
    const player = findPlayer(players, { email: m.fromEmail, name: m.fromName });

    if (isOrganiser) {
      if (idx === 0 && player) signUp(player, m.date, 'organiser');
      for (const line of m.lines) {
        const swap = /^(.+?)\s+out\s*,\s*(.+?)\s+in\b/i.exec(line);
        const onlyOut = /^(.+?)\s+out\s*$/i.exec(line);
        const onlyIn = /^(.+?)\s+in\s*$/i.exec(line);
        const apply = (tok, fn) => {
          const p = findByToken(players, tok);
          if (p) fn(p, m.date, 'organiser'); else unknown.push(`${fmtTime(m.date)}  organiser named "${tok}" — not matched to a player`);
        };
        if (swap) { apply(swap[1], dropOut); apply(swap[2], signUp); }
        else if (onlyOut) apply(onlyOut[1], dropOut);
        else if (onlyIn) apply(onlyIn[1], signUp);
      }
      return;
    }

    const kind = classifyReply(m.lines);
    const who = player ? player.name : `${m.fromName || m.fromEmail} (not on sheet)`;
    if (kind === 'ignore') return;
    if (!player) {
      if (kind === 'yes' || kind === 'empty' || kind === 'reserve') guests.push({ name: m.fromName, email: m.fromEmail, at: m.date, kind });
      else if (kind !== 'drop') unknown.push(`${fmtTime(m.date)}  ${who}: "${m.lines[0] || ''}"`);
      return;
    }
    if (kind === 'yes' || kind === 'empty') signUp(player, m.date, kind === 'empty' ? 'reply (no text)' : 'reply');
    else if (kind === 'reserve') signUp(player, m.date, 'reply', true);
    else if (kind === 'drop') dropOut(player, m.date, 'reply');
    else {
      const cur = signups.get(player.row);
      unknown.push(`${fmtTime(m.date)}  ${who}${cur && !cur.dropped ? ' (already signed up)' : ''}: "${(m.lines[0] || '').slice(0, 80)}"`);
    }
  });

  return { signups, guests, notes, unknown };
}

// All filled session columns (hidden or not), newest first. Excludes the blank template.
async function sessionColumns(mode) {
  const { spreadsheetId } = CONFIG[mode];
  const data = await gFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets(data(rowData(values(formattedValue))))&ranges=Credit!7:8&includeGridData=true`
  );
  const rows = data.sheets?.[0]?.data?.[0]?.rowData || [];
  const r7 = rows[0]?.values || [], r8 = rows[1]?.values || [];
  const cols = [];
  r7.forEach((cell, col) => {
    const date = cell?.formattedValue || '';
    const cnt = (r8[col]?.formattedValue || '').trim();
    if (/^\d+ \w+ \d+$/.test(date) && cnt && !cnt.startsWith('-') && Number(cnt) > 0) cols.push({ col, date, count: Number(cnt) });
  });
  return cols.sort((a, b) => b.col - a.col);
}

// Map row -> array of 0/1 for the given session columns (same order as cols).
async function attendance(mode, cols) {
  const { spreadsheetId } = CONFIG[mode];
  const [r0, r1] = PICK.playerRows;
  const ranges = cols.map(c => 'ranges=' + encodeURIComponent(`Credit!${colIdx2Letter(c.col)}${r0}:${colIdx2Letter(c.col)}${r1}`)).join('&');
  const { valueRanges } = await gFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values:batchGet?${ranges}&valueRenderOption=UNFORMATTED_VALUE`
  );
  const byRow = new Map();
  for (let row = r0; row <= r1; row++) {
    byRow.set(row, valueRanges.map(vr => (Number(vr.values?.[row - r0]?.[0]) > 0 ? 1 : 0)));
  }
  return byRow;
}

function bestRate(played) {
  const wins = PICK.windows.map(n => played.slice(0, n)).filter(w => w.length);
  return Math.max(0, ...wins.map(w => w.reduce((a, b) => a + b, 0) / w.length));
}

function priorityWeeks(played) {
  const rate = bestRate(played);
  return PICK.priorityWeeks.find(([min]) => rate >= min)[1];
}

function attendanceText(played) {
  const wins = PICK.windows.map(n => {
    const slice = played.slice(0, n);
    return { n: slice.length, c: slice.reduce((a, b) => a + b, 0) };
  }).filter(w => w.n > 0);
  const best = wins.reduce((b, w) => (!b || w.c / w.n > b.c / b.n ? w : b), null);
  const text = wins.map(w => `${w.c}/${w.n}`).join(', ') + (best ? ` (best ${Math.floor(100 * best.c / best.n)}%)` : '');
  return text;
}

// On-time sign-ups for a ledger week, excluding reserve-only offers.
function onTime(e) {
  return (e.signups || []).filter(r => !/^reserve-only|\(late\)/.test(e.reasons?.[r] || ''));
}

function parseCutoff(str, fallback) {
  if (!str) return fallback;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/.exec(str);
  if (!m) throw new Error('--cutoff must be "YYYY-MM-DD HH:MM"');
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
}

async function pick(mode, args) {
  if (mode !== 'mon') throw new Error('pick is only set up for Monday');
  const save = !args.includes('--no-save');
  const verbose = args.includes('--verbose');
  const cutoffArg = args[args.indexOf('--cutoff') + 1];
  const players = loadPlayers(mode);
  const byRow = new Map(players.map(p => [p.row, p]));

  const threadArg = args.includes('--thread') ? args[args.indexOf('--thread') + 1] : null;
  const thread = threadArg ? { threadId: threadArg, subject: '(given thread)' } : await findSignupThread(mode);
  const messages = await fetchThreadMessages(thread.threadId);
  const sent = messages[0].date;
  const sessionDate = fmtSheetDate(nextMonday(sent));
  const cutoff = parseCutoff(args.includes('--cutoff') ? cutoffArg : null,
    new Date(sent.getFullYear(), sent.getMonth(), sent.getDate(), PICK.cutoffHour, 0));

  console.log(`\nThread: "${thread.subject}" — ${messages.length} messages, sent ${fmtTime(sent)}`);
  console.log(`Session: ${sessionDate}    Cut-off: ${fmtTime(cutoff)}\n`);

  const { signups, guests, notes, unknown } = parseSignups(messages, players);

  // Attendance up to (not including) this session.
  const allCols = await sessionColumns(mode);
  const cols = allCols.filter(c => parseSheetDate(c.date) < parseSheetDate(sessionDate)).slice(0, Math.max(...PICK.windows));
  const att = await attendance(mode, cols);
  const played = new Map([...att].map(([r, a]) => [r, [...a]]));  // before left-out credit
  // Signing up on time and being left out counts as attended, so a keen newcomer
  // isn't stuck alternating between owed and bumped.
  const ledger = loadLedger(mode);
  cols.forEach((c, i) => {
    const e = ledger[c.date];
    if (!e?.signups) return;
    onTime(e).forEach(r => {
      const a = att.get(r);
      if (a && !a[i]) a[i] = 1;
    });
  });
  // If this session is already on the sheet (backfill), take the actual 10 from it.
  const thisCol = allCols.find(c => c.date === sessionDate);
  const actualRows = thisCol ? [...(await attendance(mode, [thisCol])).entries()].filter(([, v]) => v[0]).map(([r]) => r) : null;

  // Owed: left out within their priority weeks and not played since. Prefer the
  // actual outcome; fall back to the rule's own reserves if the credit run hasn't
  // recorded actuals.
  const weekMs = 7 * 24 * 3600 * 1000;
  const owedFrom = new Map();  // row -> { date, weeks }
  Object.keys(ledger)
    .filter(k => parseSheetDate(k) && parseSheetDate(k) < parseSheetDate(sessionDate))
    .sort((a, b) => parseSheetDate(b) - parseSheetDate(a))
    .forEach(k => {
      const e = ledger[k];
      const leftOut = onTime(e).filter(r => e.actual ? !e.actual.includes(r) : (e.suggested?.reserves || []).includes(r));
      const ago = Math.round((parseSheetDate(sessionDate) - parseSheetDate(k)) / weekMs);
      leftOut.forEach(r => {
        if (owedFrom.has(r)) return;  // most recent left-out week wins
        const since = cols.findIndex(c => parseSheetDate(c.date) <= parseSheetDate(k));
        const playedSince = (played.get(r) || []).slice(0, since < 0 ? cols.length : since).some(Boolean);
        const weeks = priorityWeeks(att.get(r) || []);
        if (!playedSince && ago <= weeks) owedFrom.set(r, { date: k, weeks });
      });
    });

  const entries = [...signups.entries()].filter(([, s]) => !s.dropped).map(([row, s]) => {
    const p = byRow.get(row);
    const text = attendanceText(att.get(row) || []);
    const owed = owedFrom.get(row);
    const late = s.at > cutoff;
    const tier = s.reserveOnly ? 4 : owed ? 1 : 2;
    const reason = s.reserveOnly ? 'offered reserve only'
      : (owed ? `missed out ${owed.date} (priority ${owed.weeks} wk${owed.weeks > 1 ? 's' : ''}), ` : '') + text;
    return { row, p, s, tier, late, reason };
  });
  entries.sort((a, b) =>
    (a.s.reserveOnly - b.s.reserveOnly) || (a.late - b.late)
    || (a.late ? 0 : (a.tier - b.tier)) || (a.s.at - b.s.at));

  const picked = entries.slice(0, 10), reserves = entries.slice(10);
  const tierName = { 1: 'owed', 2: 'on time', 4: 'reserve-only' };

  console.log('Sign-ups in rank order:');
  entries.forEach((e, i) => {
    const marker = i === 10 ? '  ---------- 10 / 11 ----------\n' : '';
    const flag = e.late ? '  LATE' : '';
    console.log(`${marker}  ${String(i + 1).padStart(2)}. ${e.p.name.padEnd(20)} ${(e.late && e.tier !== 4 ? 'late' : tierName[e.tier]).padEnd(12)} ${fmtTime(e.s.at)}${flag}   ${e.reason}`);
  });
  if (verbose) {
    console.log('\nParse log:');
    notes.forEach(n => console.log(`  ${n}`));
  }
  if (guests.length) {
    console.log('\nNot on the sheet (guests):');
    guests.forEach(g => console.log(`  ${g.name || g.email}  ${fmtTime(g.at)}  ${g.kind}`));
  }
  if (unknown.length) {
    console.log('\nCould not interpret (check by eye):');
    unknown.forEach(u => console.log(`  ${u}`));
  }
  console.log('\nTally to paste:');
  console.log(`  ${picked.map(e => e.p.short).join(' ')}`);
  if (reserves.length) console.log(`  reserves ${reserves.map(e => e.p.short).join(' ')}`);
  console.log(`\nAttendance window: ${cols.length} sessions (${cols[cols.length - 1]?.date} → ${cols[0]?.date})`);
  console.log('\nAttendance bands (best of last 8 / 26 / 52, left out counts as attended):');
  const rated = players.map(p => ({ p, a: att.get(p.row) || [] })).filter(x => x.a.some(Boolean))
    .map(x => ({ ...x, rate: bestRate(x.a) })).sort((x, y) => y.rate - x.rate);
  for (let b = 9; b >= 0; b--) {
    const inBand = rated.filter(x => Math.min(9, Math.floor(x.rate * 10)) === b);
    const label = `${b * 10}-${b === 9 ? 100 : b * 10 + 9}%`.padStart(8);
    console.log(`  ${label}  ${inBand.map(x => `${x.p.name} ${attendanceText(x.a).replace(/ \(best (\d+%)\)/, ' ($1)')}`).join(' · ') || '-'}`);
  }
  if (actualRows) console.log(`Actual players already on sheet for ${sessionDate}: ${actualRows.map(r => byRow.get(r)?.short || r).join(' ')}`);

  if (save) {
    ledger[sessionDate] = {
      ...(ledger[sessionDate] || {}),
      thread: thread.threadId,
      cutoff: cutoff.toISOString(),
      signups: entries.map(e => e.row),
      suggested: { picked: picked.map(e => e.row), reserves: reserves.map(e => e.row) },
      reasons: Object.fromEntries(entries.map(e => [e.row, `${tierName[e.tier]}${e.late ? ' (late)' : ''}: ${e.reason}`])),
      guests: guests.map(g => g.name || g.email),
      log: notes,
      ...(actualRows ? { actual: actualRows } : {}),
    };
    saveLedger(mode, ledger);
    console.log(`Saved suggestion to ${path.relative(process.cwd(), ledgerPath(mode))} under "${sessionDate}"`);
  } else {
    console.log('Not saved (--no-save)');
  }
  return { picked, reserves };
}

// Called from run-all so the trial ledger records who actually played.
function recordActual(mode, rowVals) {
  if (mode !== 'mon') return;
  const { sess2Date } = loadState()[mode] || {};
  if (!sess2Date) return;
  const ledger = loadLedger(mode);
  const rows = rowVals.map(rv => Number(rv.split(':')[0])).filter(Boolean);
  ledger[sess2Date] = { ...(ledger[sess2Date] || {}), actual: rows };
  saveLedger(mode, ledger);
  console.log(`Recorded actual players for ${sess2Date} in trial ledger`);
}

function pickReport(mode) {
  const players = loadPlayers(mode);
  const byRow = new Map(players.map(p => [p.row, p]));
  const short = (r) => byRow.get(r)?.short || `row${r}`;
  const ledger = loadLedger(mode);
  const keys = Object.keys(ledger).filter(parseSheetDate).sort((a, b) => parseSheetDate(a) - parseSheetDate(b));
  if (!keys.length) { console.log('Trial ledger is empty.'); return; }

  let sessions = 0, matches = 0;
  for (const k of keys) {
    const e = ledger[k];
    console.log(`\n${k}`);
    if (e.suggested) console.log(`  rule:    ${e.suggested.picked.map(short).join(' ')}${e.suggested.reserves.length ? `   | reserves ${e.suggested.reserves.map(short).join(' ')}` : ''}`);
    else console.log('  rule:    (pick not run)');
    if (e.actual) console.log(`  actual:  ${e.actual.map(short).join(' ')}`);
    else console.log('  actual:  (credit not run yet)');
    if (e.suggested && e.actual) {
      sessions++;
      const ruleOnly = e.suggested.picked.filter(r => !e.actual.includes(r));
      const actualOnly = e.actual.filter(r => !e.suggested.picked.includes(r));
      if (!ruleOnly.length && !actualOnly.length) { matches++; console.log('  same 10'); }
      else {
        ruleOnly.forEach(r => console.log(`  rule picked, didn't play:  ${byRow.get(r)?.name || r}  — ${e.reasons?.[r] || ''}`));
        actualOnly.forEach(r => console.log(`  played, rule left out:     ${byRow.get(r)?.name || r}  — ${e.reasons?.[r] || 'not in sign-ups the rule saw'}`));
      }
    }
    if (e.guests?.length) console.log(`  guests seen: ${e.guests.join(', ')}`);
  }
  if (sessions) console.log(`\n${matches}/${sessions} sessions where the rule matched the actual 10 exactly.`);
}

// ─── CLI ───────────────────────────────────────────────────────────────────────

const [,, mode, command, ...args] = process.argv;

// Mode-less commands handled first.
if (mode === 'authorize') {
  await authorize();
  process.exit(0);
}
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
  console.log('       node footy-credit.mjs authorize');
  console.log('       node footy-credit.mjs refresh-token');
  console.log('       node footy-credit.mjs update-page');
  console.log('\nCommands: refresh-token, update-page, get-players, search-emails,');
  console.log('          get-thread <id>, read-headers, copy-columns, clear-week,');
  console.log('          write-played <r:v,...>, hide-old, read-sessions,');
  console.log('          build-email, send-preview, send-email, run-all <r:v,...>,');
  console.log('          pick [--cutoff "YYYY-MM-DD HH:MM"] [--no-save], pick-report (mon only)');
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
    case 'clear-week': await clearWeek(mode); break;
    case 'write-played': await writePlayed(mode, args[0].split(',')); break;
    case 'hide-old': await hideOld(mode); break;
    case 'read-sessions': await readSessions(mode); break;
    case 'build-email': buildEmail(mode); break;
    case 'send-preview': await sendPreview(mode); break;
    case 'send-email': await sendEmail(mode); break;
    case 'run-all': await runAll(mode, args[0].split(',')); break;
    case 'pick': await pick(mode, args); break;
    case 'pick-report': pickReport(mode); break;
    default: console.error(`Unknown command: ${command}`); process.exit(1);
  }
} catch (e) {
  console.error('Error:', e.message);
  process.exit(1);
}
