'use strict';

// Thin HTTP adapters for drafts, automatic validation and the berth queue. Business rules are in the services.

const draftService = require('../services/draftService');
const voyageService = require('../services/voyageService');
const queueService = require('../services/queueService');
const scheduleService = require('../services/scheduleService');
const movement = require('../services/voyageMovementService');
const { parseId, parseIfMatch } = require('../validation/common');
const { errors } = require('../errors');

function idParam(req) {
  const id = parseId(req.params.id);
  if (id === null) throw errors.notFound();
  return id;
}

function send(res, status, data, etag) {
  res.setHeader('Cache-Control', 'no-store');
  if (etag !== undefined) res.setHeader('ETag', `"${etag}"`);
  res.status(status).json({ success: true, data });
}

function buildFlowController({ db, etaAdapter, etaWorker }) {
  const deps = { etaAdapter, etaWorker };
  return {
    schedule: async (req, res) => send(res, 200, await scheduleService.get(db, req.query)),
    createDraft: async (req, res) => { const d = await draftService.create(db, req.principal, req.body); send(res, 201, d, d.revision); },
    listDrafts: async (req, res) => send(res, 200, await draftService.list(db, req.principal)),
    getDraft: async (req, res) => { const d = await draftService.get(db, req.principal, idParam(req)); send(res, 200, d, d.revision); },
    updateDraft: async (req, res) => {
      const d = await draftService.update(db, req.principal, idParam(req), req.body, parseIfMatch(req.headers['if-match']));
      send(res, 200, d, d.revision);
    },
    discardDraft: async (req, res) => {
      const d = await draftService.discard(db, req.principal, idParam(req), parseIfMatch(req.headers['if-match']));
      send(res, 200, d, d.revision);
    },
    submitDraft: async (req, res) => {
      const r = await draftService.submit(db, deps, req.principal, idParam(req));
      send(res, r.created ? 201 : 200, r.voyage, r.voyage.revision);
    },

    createVoyage: async (req, res) => {
      const r = await voyageService.submitNotice(db, deps, req.principal, req.body);
      send(res, 201, r.voyage, r.voyage.revision);
    },
    validateVoyage: async (req, res) => {
      const v = await voyageService.revalidate(db, deps, req.principal, idParam(req));
      send(res, 200, v, v.revision);
    },

    confirmBerthing: async (req, res) => {
      const r = await movement.confirmBerthing(db, req.principal, idParam(req), req.body, parseIfMatch(req.headers['if-match']));
      send(res, 200, r, r.revision);
    },
    confirmDeparture: async (req, res) => {
      const r = await movement.confirmDeparture(db, req.principal, idParam(req), req.body, parseIfMatch(req.headers['if-match']));
      send(res, 200, r, r.revision);
    },

    queue: async (req, res) => { const q = await queueService.list(db); send(res, 200, q, q.revision); },
    moveQueue: async (req, res) => {
      const q = await queueService.move(db, req.principal, idParam(req), req.body, parseIfMatch(req.headers['if-match']));
      send(res, 200, q, q.revision);
    },
  };
}

module.exports = { buildFlowController };
