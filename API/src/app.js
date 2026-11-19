'use strict';

// Express application factory. Dependencies are injected so tests can build the app against a test database.

const express = require('express');
const { buildRoutes } = require('./routes');
const { notFoundHandler, errorHandler } = require('./http/errorHandler');
const { createEtaAdapter } = require('./ai/etaAdapter');

function createApp({ db, policy, corsOrigin, cookieSecure, etaAdapter = createEtaAdapter({}), etaWorker = null }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);

  // Single trusted origin (the frontend). Credentials are allowed only for that origin.
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (req.headers.origin === corsOrigin) {
      res.setHeader('Access-Control-Allow-Origin', corsOrigin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Idempotency-Key, If-Match');
      res.setHeader('Vary', 'Origin');
      if (req.method === 'OPTIONS') return res.status(204).end();
    }
    return next();
  });

  app.use(express.json({ limit: '100kb' }));
  app.use('/api/v1', buildRoutes({ db, policy, cookieSecure, etaAdapter, etaWorker }));
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
