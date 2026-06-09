const http     = require('http');
const net      = require('net');
const express  = require('express');
const cors     = require('cors');
const { WebSocketServer, WebSocket } = require('ws');
const Docker   = require('dockerode');

const BACKEND_PORT         = 3000;
const CONTAINER_IMAGE      = 'browse-container:phase2';
const CONTAINER_WS_PORT    = 3001;


const app    = express();
app.use(cors({ origin: 'http://localhost:3002' })); 
const server = http.createServer(app);

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

const wss = new WebSocketServer({ server });

let activeSession = null;


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
      console.log(`[backend] Container port ready after ${attempt} attempt(s). Waiting for WS handshake to be ready...`);
      await new Promise((r) => setTimeout(r, 400));
      return;
    }

    console.log(`[backend] Attempt ${attempt}/${maxRetries} — port not open yet, retrying in ${intervalMs}ms...`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  throw new Error(`Container port ${port} never opened after ${maxRetries} attempts.`);
}

app.get('/api/status', (req, res) => {
  res.json({
    status: 'ok',
    sessionActive: !!activeSession,
    containerId: activeSession?.container?.id?.slice(0, 12) ?? null,
  });
});


wss.on('connection', async (frontendWs, req) => {
  const clientIp = req.socket.remoteAddress;
  console.log(`\n[backend] ── New frontend connection from ${clientIp} ──`);

  if (activeSession) {
    console.warn('[backend] Session already active. Rejecting new connection.');
    frontendWs.send(JSON.stringify({
      type: 'error',
      message: 'A session is already active. Only one session is supported for now.',
    }));
    frontendWs.close();
    return;
  }

  let container = null;
  let containerWs = null;

  try {
   
    console.log(`[backend] Creating container from image: ${CONTAINER_IMAGE}`);

    container = await docker.createContainer({
      Image: CONTAINER_IMAGE,
      HostConfig: {
        PortBindings: {
          '3001/tcp': [{ HostPort: `${CONTAINER_WS_PORT}` }],
        },
        AutoRemove: true,
        NetworkMode: 'bridge',
      },
    });

    await container.start();
    console.log(`[backend] Container started. ID: ${container.id.slice(0, 12)}`);

    frontendWs.send(JSON.stringify({ type: 'status', message: 'container_starting' }));

    await waitForContainerPort(CONTAINER_WS_PORT);

    containerWs = new WebSocket(`ws://localhost:${CONTAINER_WS_PORT}`);

    await new Promise((resolve, reject) => {
      containerWs.on('open', resolve);
      containerWs.on('error', (err) => reject(new Error(`Container WS error: ${err.message}`)));
    });

    console.log('[backend] Relay established: Frontend ↔ Backend ↔ Container');
    frontendWs.send(JSON.stringify({ type: 'status', message: 'session_ready' }));

    activeSession = { container, containerWs };


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
        switch (msg.type) {
          case 'click':
            console.log(`[input] click    x=${msg.x.toFixed(3)} y=${msg.y.toFixed(3)}`);
            break;
          case 'scroll':
            console.log(`[input] scroll   x=${msg.x.toFixed(3)} y=${msg.y.toFixed(3)} deltaY=${msg.deltaY}`);
            break;
          case 'type':
            console.log(`[input] type     "${msg.text}"`);
            break;
          case 'keydown':
            console.log(`[input] keydown  ${msg.key}`);
            break;
          case 'navigate':
            console.log(`[input] navigate → ${msg.url}`);
            break;
        }
      } catch (_) {}
    });

  } catch (err) {
    console.error('[backend] Failed to set up session:', err.message);
    if (frontendWs.readyState === WebSocket.OPEN) {
      frontendWs.send(JSON.stringify({ type: 'error', message: err.message }));
      frontendWs.close();
    }
    await cleanup(container, containerWs);
    return;
  }

  frontendWs.on('close', async () => {
    console.log('[backend] Frontend disconnected. Tearing down session...');
    await cleanup(container, containerWs);
  });

  frontendWs.on('error', (err) => {
    console.error('[backend] Frontend WS error:', err.message);
  });

  containerWs.on('close', () => {
    console.log('[backend] Container WS closed unexpectedly.');
    if (frontendWs.readyState === WebSocket.OPEN) {
      frontendWs.send(JSON.stringify({ type: 'status', message: 'container_closed' }));
      frontendWs.close();
    }
    cleanup(container, containerWs);
  });
});

async function cleanup(container, containerWs) {

  activeSession = null;

  console.log('[backend] Running cleanup...');
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
  console.log('   Browse Backend ready ');
  console.log(`  HTTP  →  http://localhost:${BACKEND_PORT}       `);
  console.log(`  WS    →  ws://localhost:${BACKEND_PORT}        `);
  console.log(`  Status→  http://localhost:${BACKEND_PORT}/api/status `);
});
