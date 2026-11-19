'use strict';

// Route table. Routes only wire paths to controllers and middleware; no business logic here.

const express = require('express');
const { buildController } = require('../controllers/authController');
const { buildVesselController } = require('../controllers/vesselController');
const { buildFlowController } = require('../controllers/flowController');
const { buildBerthController } = require('../controllers/berthController');
const { buildNotificationController } = require('../controllers/notificationController');
const { requireSession, requirePermission } = require('../http/auth');

function buildRoutes({ db, policy, cookieSecure, etaAdapter, etaWorker }) {
  const router = express.Router();
  const auth = buildController({ db, policy, cookieSecure });
  const session = requireSession({ db, policy, cookieSecure });

  // Health: reports whether the API can reach the database. No internal details are returned.
  router.get('/health', async (req, res) => {
    try {
      await db.pool.request().query('SELECT 1 AS ok');
      res.json({ success: true, data: { status: 'ok', database: 'ok' } });
    } catch (err) {
      res.status(503).json({ success: false, error: { code: 'DATABASE_UNAVAILABLE', message: 'Cơ sở dữ liệu chưa sẵn sàng.' } });
    }
  });

  router.post('/auth/login', auth.login);
  router.get('/auth/me', session, auth.me);
  router.delete('/auth/logout', session, auth.logout);

  // Vessels, arrival notices and catalogs (UC-010, UC-011, UC-013). Permissions come from the SRS matrix
  // (src/security/permissions.js); every route needs a session and a granted action, default deny.
  const allow = (actions, auditAction) => requirePermission({ db }, 'M1_VESSELS', actions, auditAction);
  const vessels = buildVesselController({ db });
  const flow = buildFlowController({ db, etaAdapter, etaWorker });
  const READ = ['view', 'view_own'];
  router.post('/ships', session, allow(['edit'], 'SHIP_CREATE'), vessels.createShip);
  router.get('/ships', session, allow(READ), vessels.listShips);
  router.get('/ships/:id', session, allow(READ), vessels.getShip);
  router.get('/ships/:id/history', session, allow(READ), vessels.shipHistory);
  router.patch('/ships/:id', session, allow(['edit'], 'SHIP_UPDATE'), vessels.updateShip);
  router.post('/ships/:id/deactivate', session, allow(['edit'], 'SHIP_DEACTIVATE'), vessels.deactivateShip);
  router.post('/voyages', session, allow(['notice'], 'VOYAGE_CREATE'), flow.createVoyage);
  router.get('/voyages', session, allow(READ), vessels.listVoyages);
  // The queue routes are registered before /voyages/:id so that 'queue' is not read as an id.
  router.get('/voyages/schedule', session, allow(['view']), flow.schedule);
  router.get('/voyages/queue', session, allow(['view']), flow.queue);
  router.patch('/voyages/:id/queue-position', session, allow(['edit'], 'QUEUE_MOVE'), flow.moveQueue);
  router.post('/voyages/:id/validate', session, allow(['notice'], 'VOYAGE_VALIDATE'), flow.validateVoyage);
  // UC-022 / UC-023: actual berthing and departure by the coordinator (M1 'edit'; port management has no 'edit' on M1, so it is refused).
  router.post('/voyages/:id/berthing', session, allow(['edit'], 'VOYAGE_BERTHING'), flow.confirmBerthing);
  router.post('/voyages/:id/departure', session, allow(['edit'], 'VOYAGE_DEPARTURE'), flow.confirmDeparture);
  router.get('/voyages/:id/eta-predictions', session, allow(READ), vessels.etaPredictions);   // UC-016 5a: prediction history of one voyage, newest first
  router.get('/voyages/:id', session, allow(READ), vessels.getVoyage);

  // Drafts of arrival notices (UC-013 3a): private to the owner, submitted through the same path as a direct notice.
  router.post('/voyage-drafts', session, allow(['notice'], 'DRAFT_CREATE'), flow.createDraft);
  router.get('/voyage-drafts', session, allow(['notice']), flow.listDrafts);
  router.get('/voyage-drafts/:id', session, allow(['notice']), flow.getDraft);
  router.put('/voyage-drafts/:id', session, allow(['notice'], 'DRAFT_UPDATE'), flow.updateDraft);
  router.delete('/voyage-drafts/:id', session, allow(['notice'], 'DRAFT_DISCARD'), flow.discardDraft);
  router.post('/voyage-drafts/:id/submit', session, allow(['notice'], 'DRAFT_SUBMIT'), flow.submitDraft);
  // Module 2: berth catalog (UC-024), berth state and refresh hints (UC-025), placement check (UC-026). Matrix feature M2_BERTHS.
  const m2 = (actions, auditAction) => requirePermission({ db }, 'M2_BERTHS', actions, auditAction);
  const berths = buildBerthController({ db });
  const notifications = buildNotificationController({ db });
  router.get('/berths', session, m2(['view']), berths.list);
  router.post('/berths', session, m2(['edit'], 'BERTH_CREATE'), berths.create);
  router.get('/berths/status', session, m2(['view']), berths.status);
  router.get('/berths/:id', session, m2(['view']), berths.get);
  router.patch('/berths/:id', session, m2(['edit'], 'BERTH_UPDATE'), berths.update);
  router.get('/berths/:id/detail', session, m2(['view']), berths.detail);
  router.get('/berths/:id/chart', session, m2(['view']), berths.chart);   // FR-BRT-03 chart layers, read only
  router.post('/berth-plan-checks', session, m2(['view']), berths.check);
  // UC-027 local recommendations: the coordinator (M2 'edit') asks and records the final choice; anyone who can view berths reads one.
  router.post('/berth-recommendations', session, m2(['edit'], 'BERTH_RECOMMEND'), berths.recommend);
  router.get('/berth-recommendations/:id', session, m2(['view']), berths.getRecommendation);
  router.post('/berth-recommendations/:id/ignore', session, m2(['edit'], 'BERTH_RECOMMEND_IGNORE'), berths.ignoreRecommendation);
  router.get('/berth-plans', session, m2(['view']), berths.listPlans);
  router.post('/berth-plans', session, m2(['edit'], 'BERTH_PLAN_CREATE'), berths.createPlan);
  router.get('/berth-plans/:id', session, m2(['view']), berths.getPlan);
  router.put('/berth-plans/:id', session, m2(['edit'], 'BERTH_PLAN_UPDATE'), berths.updatePlan);
  router.post('/berth-plans/:id/submit', session, m2(['edit'], 'BERTH_PLAN_SUBMIT'), berths.submitPlan);
  router.post('/berth-plans/:id/approve', session, m2(['approve'], 'BERTH_PLAN_APPROVE'), berths.approvePlan);
  router.post('/berth-plans/:id/reject', session, m2(['approve'], 'BERTH_PLAN_REJECT'), berths.rejectPlan);
  router.put('/voyages/:id/cargo-hazard', session, allow(['edit'], 'CARGO_HAZARD_VERIFY'), berths.verifyHazard);
  router.get('/realtime/m2/events', session, m2(['view']), berths.events);
  // Notifications addressed to the signed-in user or to one of their roles (decision D6). No feature permission: everyone reads only their own.
  router.get('/realtime/notifications', session, notifications.events);   // content-free hints for any signed-in user (the list stays per user)
  router.get('/notifications', session, notifications.list);
  router.post('/notifications/:id/read', session, notifications.read);
  router.get('/catalog/ship-types', session, allow([...READ, 'notice']), vessels.shipTypes);
  router.get('/catalog/ports', session, allow([...READ, 'notice']), vessels.ports);
  router.get('/catalog/berths', session, allow(['view']), vessels.berths);
  router.get('/catalog/agents', session, allow([...READ, 'notice']), vessels.agents);

  return router;
}

module.exports = { buildRoutes };
