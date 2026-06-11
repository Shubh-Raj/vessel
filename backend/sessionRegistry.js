const { v4: uuidv4 } = require('uuid');

const sessions = new Map();

function createSession(container, containerWs, port, frontendWs) {
  const id = uuidv4();
  sessions.set(id, {
    id,
    container,
    containerWs,
    frontendWs,
    port,
    status: 'active',
    ttlTimer: null,
    createdAt: new Date(),
  });
  console.log(`[registry] Session created: ${id.slice(0, 8)}... port=${port}. Active: ${sessions.size}`);
  return id;
}

function getSession(id) {
  return sessions.get(id);
}

function markOrphaned(id, ttlTimer) {
  const session = sessions.get(id);
  if (!session) return;
  session.status = 'orphaned';
  session.ttlTimer = ttlTimer;
  session.frontendWs = null;
  console.log(`[registry] Session orphaned: ${id.slice(0, 8)}... TTL started.`);
}

function reconnectSession(id, newFrontendWs) {
  const session = sessions.get(id);
  if (!session || session.status !== 'orphaned') return false;
  clearTimeout(session.ttlTimer);
  session.ttlTimer = null;
  session.frontendWs = newFrontendWs;
  session.status = 'active';
  console.log(`[registry] Session resumed: ${id.slice(0, 8)}...`);
  return true;
}

function deleteSession(id) {
  if (sessions.has(id)) {
    const session = sessions.get(id);
    if (session.ttlTimer) clearTimeout(session.ttlTimer);
    sessions.delete(id);
    console.log(`[registry] Session deleted: ${id.slice(0, 8)}... Active: ${sessions.size}`);
  }
}

function getAllSessions() {
  return Array.from(sessions.values());
}

function getSessionCount() {
  return sessions.size;
}

module.exports = {
  createSession, getSession, markOrphaned,
  reconnectSession, deleteSession, getAllSessions, getSessionCount,
};
