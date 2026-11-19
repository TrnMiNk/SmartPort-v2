'use strict';

// Minimal static server for local development and tests (no dependencies).
// - Serves only files under Front/ (path traversal is refused).
// - Binds to loopback by default.
// - If SP_API_BASE_URL is set, /js/config.js is generated from it, so the same files can target another API.
//   The value is validated as an http(s) origin before it is placed in JavaScript.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function parseApiBase(value) {
  const url = new URL(value); // throws on invalid input
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('SP_API_BASE_URL must be http or https');
  return url.origin;
}

function createServer({ apiBaseUrl } = {}) {
  const apiBase = apiBaseUrl ? parseApiBase(apiBaseUrl) : null;

  return http.createServer((req, res) => {
    const headers = { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { ...headers, Allow: 'GET, HEAD' });
      return res.end();
    }

    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch (e) {
      res.writeHead(400, headers);
      return res.end('Bad request');
    }
    // A NUL byte makes fs throw synchronously; refuse it before touching the filesystem.
    if (pathname.includes('\0')) {
      res.writeHead(400, headers);
      return res.end('Bad request');
    }
    if (pathname === '/') pathname = '/index.html';

    if (apiBase && pathname === '/js/config.js') {
      res.writeHead(200, { ...headers, 'Content-Type': TYPES['.js'] });
      return res.end(`window.SP_CONFIG = Object.freeze({ apiBaseUrl: ${JSON.stringify(apiBase)} });\n`);
    }

    const file = path.resolve(ROOT, '.' + pathname);
    const relative = path.relative(ROOT, file);
    const blocked = relative.startsWith('..') || path.isAbsolute(relative)
      || relative.split(path.sep).some((part) => part === 'node_modules' || part === 'test' || part === 'scripts' || part.startsWith('.'));
    // Allow-list by extension: package.json, README, source maps and other files are never served.
    if (blocked || !Object.prototype.hasOwnProperty.call(TYPES, path.extname(file))) {
      res.writeHead(404, headers);
      return res.end('Not found');
    }

    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404, headers);
        return res.end('Not found');
      }
      res.writeHead(200, { ...headers, 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
      return res.end(req.method === 'HEAD' ? undefined : data);
    });
  });
}

if (require.main === module) {
  const port = Number(process.env.SP_FRONT_PORT || 5500);
  const host = process.env.SP_FRONT_HOST || '127.0.0.1';
  createServer({ apiBaseUrl: process.env.SP_API_BASE_URL }).listen(port, host, () => {
    process.stdout.write(`SmartPort frontend on http://${host}:${port} (open via http://localhost:${port})\n`);
  });
}

module.exports = { createServer, parseApiBase };
