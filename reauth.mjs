#!/usr/bin/env node
// One-off helper to refresh the Google OAuth refresh_token for footy-credit.
// Starts a localhost server, prints an auth URL, waits for the callback,
// exchanges the code for tokens, and writes refresh_token back into credentials.json.

import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import crypto from 'crypto';
import { exec } from 'child_process';

const CRED_PATH = process.env.FOOTY_CREDIT_CREDENTIALS
  ?? path.join(os.homedir(), '.config', 'footy-credit', 'credentials.json');

const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly',
].join(' ');

const creds = JSON.parse(fs.readFileSync(CRED_PATH, 'utf8'));
const { client_id, client_secret } = creds;
if (!client_id || !client_secret) {
  console.error('credentials.json missing client_id/client_secret');
  process.exit(1);
}

const state = crypto.randomBytes(16).toString('hex');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost`);
  if (!url.searchParams.get('code')) {
    res.writeHead(400); res.end('No code'); return;
  }
  if (url.searchParams.get('state') !== state) {
    res.writeHead(400); res.end('Bad state'); return;
  }
  const code = url.searchParams.get('code');
  const port = server.address().port;
  const redirect_uri = `http://localhost:${port}`;
  try {
    const resp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code, client_id, client_secret, redirect_uri, grant_type: 'authorization_code',
      }),
    });
    const data = await resp.json();
    if (!data.refresh_token) {
      res.writeHead(500); res.end('No refresh_token in response: ' + JSON.stringify(data));
      console.error('No refresh_token returned:', data);
      process.exit(1);
    }
    creds.refresh_token = data.refresh_token;
    fs.writeFileSync(CRED_PATH, JSON.stringify(creds, null, 2));
    fs.chmodSync(CRED_PATH, 0o600);
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<h2>Done — refresh_token saved. You can close this tab.</h2>');
    console.log('refresh_token written to', CRED_PATH);
    setTimeout(() => process.exit(0), 200);
  } catch (e) {
    res.writeHead(500); res.end(String(e));
    console.error(e);
    process.exit(1);
  }
});

server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  const redirect_uri = `http://localhost:${port}`;
  const params = new URLSearchParams({
    client_id,
    redirect_uri,
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline',
    prompt: 'consent',
    state,
  });
  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  console.log('\nOpen this URL in your browser to authorize:\n');
  console.log(authUrl);
  console.log('\nWaiting for callback on', redirect_uri, '...\n');
  exec(`open ${JSON.stringify(authUrl)}`);
});
