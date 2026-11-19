'use strict';

// Thin HTTP adapters for notifications. The rules are in notificationService.

const service = require('../services/notificationService');
const events = require('../realtime/m2Events');

function buildNotificationController({ db }) {
  const send = (res, data) => { res.setHeader('Cache-Control', 'no-store'); res.json({ success: true, data }); };
  return {
    list: async (req, res) => send(res, await service.list(db, req.principal, req.query)),
    events: (req, res) => events.subscribeNotifications(req, res),
    read: async (req, res) => send(res, await service.markRead(db, req.principal, req.params.id)),
  };
}

module.exports = { buildNotificationController };
