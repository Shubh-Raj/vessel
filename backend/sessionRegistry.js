const { v4: uuidv4 } = require('uuid');

const sessions = new Map();

function createSession(container, containerWs, port) {
  const id = uuidv4();
  sessions.set(id, { id, container, containerWs, port, createdAt: new Date() });
  console.log(`[registry] Session created: ${id.slice(0, 8)}... on port ${port}. Total active: ${sessions.size}`);
  return id;
}

function getSession(id) {
  return sessions.get(id);
}

function deleteSession(id) {
  if (sessions.has(id)) {
    sessions.delete(id);
    console.log(`[registry] Session removed: ${id.slice(0, 8)}... Total active: ${sessions.size}`);
  }
}

function getAllSessions() {
  return Array.from(sessions.values());
}

function getSessionCount() {
  return sessions.size;
}

module.exports = { createSession, getSession, deleteSession, getAllSessions, getSessionCount };
