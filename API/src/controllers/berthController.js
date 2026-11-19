'use strict';

// Thin HTTP adapters for the berth catalog (UC-024), berth state (UC-025) and the placement check (UC-026).

const berthService = require('../services/berthService');
const statusService = require('../services/berthStatusService');
const placementService = require('../services/placementService');
const planService = require('../services/berthPlanService');
const hazardService = require('../services/hazardService');
const recommendations = require('../services/berthRecommendationService');
const events = require('../realtime/m2Events');
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

function buildBerthController({ db }) {
  return {
    list: async (req, res) => send(res, 200, await berthService.list(db, req.query)),
    get: async (req, res) => { const b = await berthService.get(db, idParam(req)); send(res, 200, b, b.revision); },
    create: async (req, res) => { const b = await berthService.create(db, req.principal, req.body); send(res, 201, b, b.revision); },
    update: async (req, res) => {
      const b = await berthService.update(db, req.principal, idParam(req), req.body, parseIfMatch(req.headers['if-match']));
      send(res, 200, b, b.revision);
    },
    recommend: async (req, res) => send(res, 201, await recommendations.generate(db, req.principal, req.body)),
    getRecommendation: async (req, res) => send(res, 200, await recommendations.get(db, idParam(req))),
    ignoreRecommendation: async (req, res) => send(res, 200, await recommendations.ignore(db, req.principal, idParam(req), req.body)),
    status: async (req, res) => send(res, 200, await statusService.snapshot(db)),
    detail: async (req, res) => send(res, 200, await statusService.detail(db, idParam(req))),
    chart: async (req, res) => send(res, 200, await statusService.chart(db, idParam(req), req.query)),
    check: async (req, res) => send(res, 200, await placementService.check(db, req.body)),
    events: (req, res) => events.subscribe(req, res),
    listPlans: async (req, res) => send(res, 200, await planService.list(db, req.query)),
    getPlan: async (req, res) => { const p = await planService.get(db, idParam(req)); send(res, 200, p, p.revision); },
    createPlan: async (req, res) => { const p = await planService.createDraft(db, req.principal, req.body); send(res, 201, p, p.revision); },
    updatePlan: async (req, res) => { const p = await planService.updateDraft(db, req.principal, idParam(req), req.body, parseIfMatch(req.headers['if-match'])); send(res, 200, p, p.revision); },
    submitPlan: async (req, res) => { const p = await planService.submit(db, req.principal, idParam(req), req.body, parseIfMatch(req.headers['if-match'])); send(res, 200, p, p.revision); },
    approvePlan: async (req, res) => { const p = await planService.approve(db, req.principal, idParam(req), req.body, parseIfMatch(req.headers['if-match'])); send(res, 200, p, p.revision); },
    rejectPlan: async (req, res) => { const p = await planService.reject(db, req.principal, idParam(req), req.body, parseIfMatch(req.headers['if-match'])); send(res, 200, p, p.revision); },
    verifyHazard: async (req, res) => send(res, 200, await hazardService.verify(db, req.principal, idParam(req), req.body)),
  };
}

module.exports = { buildBerthController };
