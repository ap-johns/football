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
 *   clear-week                     Clear Played + Collected for current week's column (rows 10-40)
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
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/Credit!A10:A40`
  );
  const slushIdx = (namesResp.values || []).findIndex(r => /slush fund/i.test(r[0] || ''));
  const slushRow = slushIdx >= 0 ? slushIdx + 10 : null;

  // Build row ranges 10..40, splitting around Slush Fund row if present.
  const rowRanges = slushRow
    ? [[10, slushRow - 1], [slushRow + 1, 40]].filter(([a, b]) => a <= b)
    : [[10, 40]];

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
    `Cleared Played(${playedCol}) + Collected(${collectedCol}) rows 10-40` +
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
  const sessionThBase = `background:${C.surfaceRaised};color:${C.ink};font-weight:600;font-size:14px;padding:10px 12px;border-bottom:1px solid ${C.line};text-align:center;font-family:${C.sans};`;
  const sessionTh = `style="${sessionThBase}"`;
  const sessionThSep = `style="${sessionThBase}${sepBorder}"`;
  const countSpan = `style="display:block;font-size:11px;font-weight:500;color:${C.inkSoft};margin-top:2px;letter-spacing:0.06em;text-transform:uppercase;font-family:${C.sans};"`;
  const colThBase = `background:${C.surfaceRaised};color:${C.inkFaint};font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:0.08em;padding:8px 12px;border-bottom:1px solid ${C.line};font-family:${C.sans};`;
  const colTh = `style="${colThBase}text-align:right;"`;
  const colThPlayer = `style="${colThBase}text-align:left;"`;
  const colThPl = `style="${colThBase}text-align:center;"`;
  const colThPlSep = `style="${colThBase}text-align:center;${sepBorder}"`;

  const tdBase = `padding:8px 12px;border-bottom:1px solid ${C.lineSoft};font-family:${C.sans};font-size:14px;`;
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
        `<th colspan="3" ${sessionTh}>${esc(sess.date1)}<span ${countSpan}>${esc(sess.count1 || '')} players</span></th>` +
        `<th colspan="3" ${sessionThSep}>${esc(sess.date2)}<span ${countSpan}>${esc(sess.count2 || '')} players</span></th>` +
      `</tr>` +
      `<tr>` +
        `<th ${colThPlayer}>Player</th>` +
        `<th ${colThPl}>Pl</th><th ${colTh}>Collected</th><th ${colTh}>Credit</th>` +
        `<th ${colThPlSep}>Pl</th><th ${colTh}>Collected</th><th ${colTh}>Credit</th>` +
      `</tr>` +
    `</thead>` +
    `<tbody>${rows}</tbody>` +
    `</table>`;

  return `<div style="background:${C.bg};padding:0 0 18px;">${titleBar}${table}</div>`;
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
  console.log('          get-thread <id>, read-headers, copy-columns, clear-week,');
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
    case 'clear-week': await clearWeek(mode); break;
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
