'use strict';

// Refresh hints for the berth screens (UC-025, decision D6). A hint only tells the client to re-read the state; it is
// not proof of delivery, so clients also reload when they reconnect and on a timer.
// shortcut: in-process only (one API process); with several processes use a shared channel such as a database
// notification table or a message broker.

const clients = new Set();
let counter = 0;

function subscribe(req, res) {
  res.status(200).set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  clients.add(res);
  const beat = setInterval(() => res.write(': keep-alive\n\n'), 15000);
  beat.unref();
  const done = () => { clearInterval(beat); clients.delete(res); };
  req.on('close', done);
  res.on('error', done);
}

// A second, content-free channel for any signed-in user (for example an agent, who has no berth permission): it only says "re-read your
// notifications". It carries no ids, titles or recipients, so it discloses nothing; the notification list itself is filtered per user.
const noteClients = new Set();
const NOTE_TYPES = new Set(['PLAN_SUBMITTED', 'PLAN_APPROVED', 'PLAN_REJECTED', 'NOTIFICATION']);

function subscribeNotifications(req, res) {
  res.status(200).set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  noteClients.add(res);
  const beat = setInterval(() => res.write(': keep-alive\n\n'), 15000);
  beat.unref();
  const done = () => { clearInterval(beat); noteClients.delete(res); };
  req.on('close', done);
  res.on('error', done);
}

function publish(type, data = {}) {
  counter += 1;
  const frame = `id: ${counter}\nevent: refresh\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  for (const res of clients) { try { res.write(frame); } catch (e) { clients.delete(res); } }
  if (NOTE_TYPES.has(type)) {
    const hint = `id: ${counter}\nevent: refresh\ndata: {"type":"NOTIFICATION"}\n\n`;
    for (const res of noteClients) { try { res.write(hint); } catch (e) { noteClients.delete(res); } }
  }
}

function closeAll() { for (const set of [clients, noteClients]) { for (const res of set) { try { res.end(); } catch (e) { /* already closed */ } } set.clear(); } }

module.exports = { subscribe, subscribeNotifications, publish, closeAll, count: () => clients.size, noteCount: () => noteClients.size };
