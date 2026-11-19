'use strict';

// Thin HTTP adapters for vessels (UC-010, UC-011), arrival notices (UC-013) and catalog lists.
// Parse input, call a service, shape the response. Business rules live in the services.

const shipService = require('../services/shipService');
const voyageService = require('../services/voyageService');
const catalogService = require('../services/catalogService');
const etaPredictions = require('../services/etaPredictionService');
const { parseId, parseIfMatch } = require('../validation/common');
const { errors } = require('../errors');

function idParam(req) {
  const id = parseId(req.params.id);
  if (id === null) throw errors.notFound(); // a malformed id cannot match any resource
  return id;
}

function sendOne(res, status, resource) {
  res.setHeader('Cache-Control', 'no-store');
  if (resource && resource.revision !== undefined) res.setHeader('ETag', `"${resource.revision}"`);
  res.status(status).json({ success: true, data: resource });
}

function sendList(res, data) {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ success: true, data });
}

function buildVesselController({ db }) {
  return {
    createShip: async (req, res) => sendOne(res, 201, await shipService.create(db, req.principal, req.body)),
    listShips: async (req, res) => sendList(res, await shipService.list(db, req.principal, req.query)),
    getShip: async (req, res) => sendOne(res, 200, await shipService.get(db, req.principal, idParam(req))),
    shipHistory: async (req, res) => sendList(res, await shipService.history(db, req.principal, idParam(req))),
    updateShip: async (req, res) => sendOne(res, 200,
      await shipService.update(db, req.principal, idParam(req), req.body, parseIfMatch(req.headers['if-match']))),
    deactivateShip: async (req, res) => sendOne(res, 200,
      await shipService.deactivate(db, req.principal, idParam(req), req.body, parseIfMatch(req.headers['if-match']))),

    listVoyages: async (req, res) => sendList(res, await voyageService.list(db, req.principal, req.query)),
    getVoyage: async (req, res) => sendOne(res, 200, await voyageService.get(db, req.principal, idParam(req))),
    etaPredictions: async (req, res) => sendOne(res, 200, await etaPredictions.history(db, req.principal, idParam(req))),

    shipTypes: async (req, res) => sendList(res, { items: await catalogService.shipTypes(db) }),
    ports: async (req, res) => sendList(res, { items: await catalogService.ports(db) }),
    berths: async (req, res) => sendList(res, { items: await catalogService.berths(db) }),
    agents: async (req, res) => sendList(res, { items: await catalogService.agents(db, req.principal) }),
  };
}

module.exports = { buildVesselController };
