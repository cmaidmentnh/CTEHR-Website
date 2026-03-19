const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3100;
const WEBHOOK_API_KEY = process.env.WEBHOOK_API_KEY;
const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET;
const CRM_HOST = process.env.CRM_HOST || 'actioncenter.winthehouse.gop';

if (!WEBHOOK_API_KEY || !TURNSTILE_SECRET) {
  console.error('ERROR: WEBHOOK_API_KEY and TURNSTILE_SECRET environment variables are required');
  process.exit(1);
}

const MIME_TYPES = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.otf': 'font/otf', '.woff2': 'font/woff2', '.svg': 'image/svg+xml'
};

function verifyTurnstile(token, ip) {
  return new Promise((resolve) => {
    const postData = JSON.stringify({
      secret: TURNSTILE_SECRET,
      response: token,
      remoteip: ip
    });

    const req = https.request({
      hostname: 'challenges.cloudflare.com',
      path: '/turnstile/v0/siteverify',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': postData.length }
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data).success === true); }
        catch { resolve(false); }
      });
    });
    req.on('error', () => resolve(false));
    req.write(postData);
    req.end();
  });
}

function proxyToWebhook(body) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(body);
    const req = https.request({
      hostname: CRM_HOST,
      path: '/api/webhook/contact',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        'X-API-Key': WEBHOOK_API_KEY
      }
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

const server = http.createServer(async (req, res) => {
  // API endpoint for contact form
  if (req.method === 'POST' && req.url === '/api/contact') {
    let body = '';
    req.on('data', (chunk) => body += chunk);
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        const turnstileToken = data['cf-turnstile-response'];

        if (!turnstileToken) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Turnstile verification required' }));
        }

        const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
        const valid = await verifyTurnstile(turnstileToken, ip);
        if (!valid) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Turnstile verification failed' }));
        }

        // Remove turnstile token before forwarding
        delete data['cf-turnstile-response'];
        const result = await proxyToWebhook(data);

        res.writeHead(result.status, { 'Content-Type': 'application/json' });
        res.end(result.body);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Server error' }));
      }
    });
    return;
  }

  // Static file serving
  let filePath = req.url.split('?')[0];
  if (filePath === '/') filePath = '/index.html';

  const fullPath = path.join(__dirname, filePath);

  // Prevent directory traversal
  if (!fullPath.startsWith(__dirname)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  const ext = path.extname(fullPath);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(fullPath, (err, content) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404);
        res.end('Not found');
      } else {
        res.writeHead(500);
        res.end('Server error');
      }
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    }
  });
});

server.listen(PORT, () => {
  console.log(`CTEHR Website running on port ${PORT}`);
});
