const http     = require('http');
const net      = require('net');
const express  = require('express');
const cors     = require('cors');
const { WebSocketServer, WebSocket } = require('ws');
const Docker   = require('dockerode');

const { allocatePort, releasePort } = require('./portAllocator');
const registry = require('./sessionRegistry');

const BACKEND_PORT    = 3000;
const CONTAINER_IMAGE = 'browse-container:phase2';
const MAX_SESSIONS    = 5;

const app    = express();
app.use(cors({ origin: '*' }));
const server = http.createServer(app);
const docker = new Docker({ socketPath: '/var/run/docker.sock' });
const wss    = new WebSocketServer({ server });

async function waitForContainerPort(port, maxRetries = 30, intervalMs = 500) {
  console.log(`[backend] Probing TCP port ${port} (up to ${maxRetries} attempts)...`);

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const open = await new Promise((resolve) => {
      const socket = net.createConnection({ host: 'localhost', port });

      const timer = setTimeout(() => {
        socket.destroy();
        resolve(false);
      }, 800);

      socket.on('connect', () => {
        clearTimeout(timer);
        socket.destroy();
        resolve(true);
      });

      socket.on('error', () => {
        clearTimeout(timer);
        resolve(false);
      });
    });

    if (open) {
      console.log(`[backend] Port ${port} ready after ${attempt} attempt(s).`);
      await new Promise((r) => setTimeout(r, 400));
      return;
    }

    console.log(`[backend] Attempt ${attempt}/${maxRetries} — port ${port} not open yet...`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  throw new Error(`Container port ${port} never opened after ${maxRetries} attempts.`);
}

app.get('/api/status', (req, res) => {
  res.json({
    status: 'ok',
    activeSessions: registry.getSessionCount(),
    maxSessions: MAX_SESSIONS,
    sessions: registry.getAllSessions().map((s) => ({
      id: s.id,
      port: s.port,
      createdAt: s.createdAt,
    })),
  });
});

wss.on('connection', async (frontendWs) => {
  console.log(`\n[backend] New frontend connection. Active sessions: ${registry.getSessionCount()}/${MAX_SESSIONS}`);

  if (registry.getSessionCount() >= MAX_SESSIONS) {
    console.warn('[backend] At capacity. Rejecting connection.');
    frontendWs.send(JSON.stringify({
      type: 'error',
      message: 'Server is at capacity. Please try again later.',
    }));
    frontendWs.close();
    return;
  }

  let container   = null;
  let containerWs = null;
  let sessionId   = null;
  let port        = null;

  try {
    port = await allocatePort();
    console.log(`[backend] Allocated port: ${port}`);

    container = await docker.createContainer({
      Image: CONTAINER_IMAGE,
      HostConfig: {
        AutoRemove: true,
        NetworkMode: 'bridge',
        PortBindings: {
          '3001/tcp': [{ HostPort: String(port) }],
        },
      },
    });

    await container.start();
    console.log(`[backend] Container started. ID: ${container.id.slice(0, 12)} on port ${port}`);

    frontendWs.send(JSON.stringify({ type: 'status', message: 'container_starting' }));

    await waitForContainerPort(port);

    containerWs = new WebSocket(`ws://localhost:${port}`);

    await new Promise((resolve, reject) => {
      containerWs.on('open', resolve);
      containerWs.on('error', (err) => reject(new Error(`Container WS error: ${err.message}`)));
    });

    sessionId = registry.createSession(container, containerWs, port);

    console.log(`[backend] Relay established. Session: ${sessionId.slice(0, 8)}...`);
    frontendWs.send(JSON.stringify({ type: 'status', message: 'session_ready', sessionId }));

    containerWs.on('message', (data) => {
      if (frontendWs.readyState === WebSocket.OPEN) {
        frontendWs.send(data.toString());
      }
    });

    frontendWs.on('message', (data) => {
      if (containerWs.readyState !== WebSocket.OPEN) return;
      containerWs.send(data);

      try {
        const msg = JSON.parse(data.toString());
        const tag = `[${sessionId.slice(0, 8)}]`;
        switch (msg.type) {
          case 'click':
            console.log(`${tag} click    x=${msg.x?.toFixed(3)} y=${msg.y?.toFixed(3)}`);
            break;
          case 'scroll':
            console.log(`${tag} scroll   x=${msg.x?.toFixed(3)} y=${msg.y?.toFixed(3)} deltaY=${msg.deltaY}`);
            break;
          case 'type':
            console.log(`${tag} type     "${msg.text}"`);
            break;
          case 'keydown':
            console.log(`${tag} keydown  ${msg.key}`);
            break;
          case 'navigate':
            console.log(`${tag} navigate → ${msg.url}`);
            break;
        }
      } catch (_) {}
    });

  } catch (err) {
    console.error('[backend] Session setup failed:', err.message);
    if (frontendWs.readyState === WebSocket.OPEN) {
      frontendWs.send(JSON.stringify({ type: 'error', message: err.message }));
      frontendWs.close();
    }
    await cleanup(sessionId, container, containerWs, port);
    return;
  }

  frontendWs.on('close', async () => {
    console.log(`[backend] Frontend disconnected. Tearing down session ${sessionId?.slice(0, 8)}...`);
    await cleanup(sessionId, container, containerWs, port);
  });

  frontendWs.on('error', (err) => {
    console.error(`[backend] Frontend WS error:`, err.message);
  });

  containerWs.on('close', () => {
    console.log(`[backend] Container WS closed for session ${sessionId?.slice(0, 8)}.`);
    if (frontendWs.readyState === WebSocket.OPEN) {
      frontendWs.send(JSON.stringify({ type: 'status', message: 'container_closed' }));
      frontendWs.close();
    }
    cleanup(sessionId, container, containerWs, port);
  });
});

async function cleanup(sessionId, container, containerWs, port) {
  if (sessionId) registry.deleteSession(sessionId);
  if (port) releasePort(port);

  try {
    if (containerWs && containerWs.readyState !== WebSocket.CLOSED) {
      containerWs.terminate();
    }
  } catch (_) {}

  try {
    if (container) {
      await container.stop({ t: 2 });
      console.log('[backend] Container stopped and removed.');
    }
  } catch (err) {
    if (!err.statusCode || (err.statusCode !== 304 && err.statusCode !== 404)) {
      console.error('[backend] Error stopping container:', err.message);
    }
  }
}

server.listen(BACKEND_PORT, () => {
  console.log(`\n[backend] Vessel backend ready`);
  console.log(`  HTTP    → http://localhost:${BACKEND_PORT}`);
  console.log(`  WS      → ws://localhost:${BACKEND_PORT}`);
  console.log(`  Status  → http://localhost:${BACKEND_PORT}/api/status`);
  console.log(`  Max sessions: ${MAX_SESSIONS}\n`);
});
