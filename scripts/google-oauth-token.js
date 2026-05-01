/**
 * One-shot OAuth: opens browser, prints GOOGLE_REFRESH_TOKEN for .env.
 * Uses GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET from .env — same pair TapPrint uses.
 *
 * OAuth client type: prefer "Desktop app". If you use "Web application", add this
 * exact URI under Authorized redirect URIs:
 *   http://127.0.0.1:34579/oauth2callback
 *
 * Usage: npm run oauth-google
 */
require('dotenv').config();

const http = require('http');
const url = require('url');
const { spawn } = require('child_process');
const { google } = require('googleapis');

const SCOPES = ['https://www.googleapis.com/auth/gmail.modify'];
const REDIRECT_PORT = 34579;
const REDIRECT_PATH = '/oauth2callback';
const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}${REDIRECT_PATH}`;

const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error('Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET in .env');
  process.exit(1);
}

const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);

function openBrowser(authUrl) {
  if (process.platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', authUrl], { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  if (process.platform === 'darwin') {
    spawn('open', [authUrl], { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  spawn('xdg-open', [authUrl], { detached: true, stdio: 'ignore' }).unref();
}

async function main() {
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
  });

  await new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const parsed = url.parse(req.url, true);
      if (parsed.pathname !== REDIRECT_PATH) {
        res.writeHead(404);
        res.end();
        return;
      }

      const send = (body, status = 200) => {
        res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(body);
      };

      const code = parsed.query.code;
      const err = parsed.query.error;
      if (err) {
        send(`<p>Authorization failed: ${String(err)}</p>`);
        server.close(() => reject(new Error(String(err))));
        return;
      }
      if (!code || typeof code !== 'string') {
        send('<p>No authorization code in redirect.</p>');
        server.close(() => reject(new Error('missing code')));
        return;
      }

      try {
        const { tokens } = await oauth2Client.getToken(code);
        const rt = tokens.refresh_token;
        send('<p>Success. Close this tab and check the terminal for GOOGLE_REFRESH_TOKEN.</p>');
        server.close(() => {
          if (!rt) {
            console.error(
              '\nNo refresh_token returned. In Google Account → Security → Third-party access,\n' +
                'remove this app, then run npm run oauth-google again (prompt=consent forces a new refresh token).\n'
            );
            reject(new Error('no refresh_token'));
            return;
          }
          console.log('\nAdd or replace this line in .env:\n');
          console.log(`GOOGLE_REFRESH_TOKEN=${rt}\n`);
          resolve();
        });
      } catch (e) {
        const msg = e.response?.data ? JSON.stringify(e.response.data) : e.message;
        send('<p>Token exchange failed.</p>');
        server.close(() => reject(new Error(msg)));
      }
    });

    server.on('error', reject);
    server.listen(REDIRECT_PORT, '127.0.0.1', () => {
      console.log(`Redirect URI (must match Google Cloud client): ${REDIRECT_URI}`);
      console.log('Opening browser. If nothing opens, paste this URL:\n');
      console.log(authUrl, '\n');
      openBrowser(authUrl);
    });
  });
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
