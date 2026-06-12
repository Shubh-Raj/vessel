# Vessel

Vessel is a self-hosted remote browser control system that runs entirely on your local machine. Open a web UI, click a button, and a real Chromium browser starts inside a Docker container. Its screen streams back to you live, and every click, scroll, and keystroke you make in the UI gets sent to the remote browser in real time.

Multiple users can run independent browser sessions simultaneously. Each session gets its own isolated container with dedicated resource limits, and sessions survive accidental page refreshes.

---

## What It Does

- Launches a headless Chromium browser inside a Docker container on demand
- Streams the browser screen to your web UI as a live JPEG feed at roughly 30 fps
- Forwards mouse clicks, scroll events, and keyboard input to the remote browser
- Lets you navigate to any URL from a bar in the UI
- Supports multiple concurrent users, each with their own fully isolated container
- Survives page refreshes by preserving the session for 2 minutes via TTL-based reconnection
- Caps each container to 256 MB RAM and 0.5 CPU cores to prevent any single user from crashing the server
- Automatically tears down the container when the session ends or the TTL expires

No external services required. Everything runs on localhost.

---

## Architecture

The system has three distinct layers. Each layer has a single responsibility and communicates with its neighbors over WebSockets.

```
+------------------+        WebSocket        +-------------------+        WebSocket        +----------------------+
|                  |  ws://localhost:3000    |                   |  ws://localhost:300XX   |                      |
|   Browser (UI)   | <---------------------> |   Backend Server  | <---------------------> |  Docker Container    |
|   Next.js App    |                         |   Node.js/Express |                         |  Node.js + Chromium  |
|   port 3002      |                         |   port 3000       |                         |  (dynamic host port) |
|                  |                         |                   |                         |                      |
| - Renders stream |     HTTP (REST)         | - Spawns Docker   |   CDP over Puppeteer    | - Runs Puppeteer     |
| - Sends input    | GET /api/status         | - Allocates ports |                         | - Page.startScreencast
| - Stores UUID    | <---------------------> | - Routes sessions |                         | - Accepts commands   |
| - TTL reconnect  |                         | - Enforces limits |                         |                      |
+------------------+                         +-------------------+                         +----------------------+
```

The backend dynamically allocates a host port in the range 30000-40000 for each new container, so multiple containers can run simultaneously without port conflicts.

### Data Flow for a Single Frame

```
Chromium renders a frame
        |
        v
Page.screencastFrame CDP event fires (base64 JPEG)
        |
        v
browser.js sends JSON: { type: "frame", data: "<base64>" }
        |
        v
Container WebSocket server (dynamic port)
        |
        v
Backend receives the message, calls .toString() to keep it a text frame
        |
        v
Backend routes the frame to the correct frontend WebSocket via session registry
        |
        v
Frontend hook receives the message, parses JSON
        |
        v
imgRef.current.src = "data:image/jpeg;base64,..." (direct DOM update, no re-render)
        |
        v
Browser displays the frame
```

### Data Flow for a Click

```
User clicks on the stream <img> element
        |
        v
Click handler reads x, y relative to the element dimensions
        |
        v
Normalizes to 0.0-1.0 range: { type: "click", x: 0.42, y: 0.31 }
        |
        v
Frontend sends JSON over WebSocket to backend
        |
        v
Backend logs the input, looks up the session registry, forwards to the correct container WebSocket
        |
        v
browser.js parses the message, multiplies by viewport size (1280x720)
        |
        v
Sends Input.dispatchMouseEvent via CDP (mousePressed + mouseReleased)
        |
        v
Chromium registers the click at those pixel coordinates
```

---

## Tech Stack

| Layer | Technology | Purpose |
|---|---|---|
| Frontend | Next.js 16, React, TypeScript | Web UI, stream rendering, input capture |
| Backend | Node.js, Express, ws | HTTP API, WebSocket relay, Docker orchestration |
| Container | Debian, Node.js, Chromium | Headless browser runtime |
| Browser Driver | Puppeteer Core | Chromium launch and CDP access |
| Browser Protocol | Chrome DevTools Protocol (CDP) | Screen capture, input injection |
| Container Runtime | Docker (via dockerode) | Spinning up, resource-limiting, and tearing down containers |
| Communication | WebSockets (ws library) | Real-time bidirectional messaging between all layers |
| Session Identity | UUID v4 (uuid library) | Persistent session IDs stored in localStorage for reconnection |

---

## Project Structure

```
vessel/
|
|-- container/
|   |-- Dockerfile           Debian + Chromium + Node.js image definition
|   |-- browser.js           WebSocket server inside the container, runs Puppeteer and CDP
|   |-- package.json         puppeteer-core + ws
|   |-- test-client.html     Minimal HTML to test the container directly
|
|-- backend/
|   |-- server.js            Express + WebSocket relay + dockerode orchestrator
|   |-- portAllocator.js     Finds free host ports in range 30000-40000, prevents race conditions
|   |-- sessionRegistry.js   In-memory Map of active and orphaned sessions keyed by UUID
|   |-- package.json         express + ws + dockerode + cors + uuid
|   |-- test-client.html     Relay test page
|
|-- frontend/
|   |-- app/
|   |   |-- page.tsx         Main page: LandingView + StreamView components
|   |   |-- layout.tsx       Root layout, metadata
|   |   |-- globals.css      Full design system, light theme
|   |-- hooks/
|   |   |-- useRemoteBrowser.ts  Custom React hook, owns all WebSocket and reconnection logic
|   |-- package.json
|   |-- tsconfig.json
|
|-- .gitignore
|-- README.md
```

---

## How the Container Works

The container image is a Debian Linux environment with Chromium installed via `apt-get` and Node.js 20 installed via NodeSource.

When the container starts, `browser.js` runs. It creates a WebSocket server on port 3001 (internally) and waits. The moment the backend connects to it, it:

1. Launches Chromium using `puppeteer.launch()` with flags like `--no-sandbox` and `--disable-dev-shm-usage` required inside Docker
2. Opens a new page and sets a 1280x720 viewport
3. Navigates to Google
4. Creates a raw CDP session using `page.createCDPSession()`
5. Calls `Page.startScreencast` with JPEG format at 75 quality
6. Listens for `Page.screencastFrame` events and sends each frame to the WebSocket client
7. Listens for input commands and maps them to the appropriate CDP calls

When the backend disconnects, the browser is closed. The container itself is then stopped and removed by the backend.

The reason for using `puppeteer-core` instead of `puppeteer` is image size. The full `puppeteer` package downloads its own copy of Chromium on install (around 300 MB). Since we install Chromium through `apt-get` in the Dockerfile, we only need the Node.js library, not the bundled browser.

---

## How the Backend Works

The backend (`server.js`) has three responsibilities: HTTP API, Docker orchestration, and WebSocket routing across multiple sessions.

### Multi-Tenant Session Management

The backend can handle up to 5 concurrent sessions (configurable via `MAX_SESSIONS`). Each connection goes through this flow:

1. The frontend connects and sends a `hello` message containing either a stored session UUID (reconnection attempt) or `null` (new session)
2. If reconnecting with a valid UUID, the backend resumes that session immediately without touching Docker
3. If starting fresh, the backend allocates a free host port via `portAllocator.js`, creates a Docker container mapped to that port, and registers the session in the `sessionRegistry`

The `portAllocator` uses `net.createServer` to test whether a port is truly free before reserving it. It maintains a `Set` of currently reserved ports to prevent race conditions when multiple users connect simultaneously.

The `sessionRegistry` is an in-memory `Map` keyed by UUID. Each entry stores the container handle, the container WebSocket, the host port, the current session status (`active` or `orphaned`), and the TTL timer handle.

### TCP Readiness Probe

After starting a container, the backend probes the allocated host port using a raw TCP socket (`net.createConnection`) until it opens. A WebSocket probe is deliberately not used here because it would complete the HTTP upgrade handshake, triggering the container's `wss.on('connection')` event and launching Chromium before the real user connects.

### WebSocket Relay

The backend acts as a transparent relay. Container frames are forwarded to the connected frontend socket. Frontend inputs are logged and forwarded to the container socket. Each session has its own pair of sockets and they never cross.

When a frontend disconnects, the backend does not immediately stop the container.

### TTL-Based Graceful Reconnection

When a frontend WebSocket closes (for example when the user refreshes the page), the backend:

1. Marks the session as `orphaned` in the registry
2. Starts a 2-minute TTL timer using `setTimeout`
3. If the user reconnects within 2 minutes with the same UUID from `localStorage`, the timer is cancelled, the new socket is wired to the existing container, and the stream resumes
4. If the timer expires, the cleanup function runs and the container is stopped

This means a page refresh never destroys the remote browser session.

### Resource Limits (Noisy Neighbor Protection)

Every container is created with hard resource limits injected into the Docker `HostConfig` via the cgroups interface:

- `Memory: 256 MB` — if any process in the container exceeds 256 MB RAM, the Linux OOM Killer fires immediately inside that container only
- `MemorySwap: 256 MB` — equal to `Memory`, which disables swap entirely for this container, preventing silent disk thrashing
- `NanoCpus: 0.5 CPU cores` — enforced by the Linux CFS scheduler, preventing any single container from monopolising the host CPU

These limits are enforced at the Linux kernel level. Other containers and the Node.js backend process are in separate cgroups and are completely unaffected if one container's processes are OOM-killed.

---

## How the Frontend Works

The frontend is a Next.js app with two visual states: a landing page and a stream view.

All WebSocket logic lives in `useRemoteBrowser.ts`, a custom React hook. The hook manages connection state, status messages, frame callbacks, and reconnection identity.

### Session Persistence

On startup, the hook checks `localStorage` for a `vessel_session_id` key. If one exists, it sends it in the `hello` message. If the backend confirms the session is still alive (`session_resumed`), the stream picks up immediately. If the backend reports the session expired, `localStorage` is cleared and a fresh container is booted.

The `disconnect` function explicitly removes the UUID from `localStorage`, ensuring a deliberate end session does not reconnect to the old container.

### High-Performance Frame Rendering

Incoming JPEG frames arrive at roughly 30 per second. Instead of calling `setState` for each frame (which would trigger 30 React re-renders per second), the hook stores a callback in a `useRef`. The callback directly mutates `imgRef.current.src` via a DOM reference. React never re-renders for frame updates. Only genuine state changes (connection status, errors, FPS count) go through `useState`.

### Input Handling

Keyboard input is captured by a `window.addEventListener('keydown')` listener. Single printable characters are sent as `{ type: "type" }` commands, which map to the `Input.insertText` CDP command on the container side. Special keys like Enter, Backspace, Tab, and arrow keys are sent as `{ type: "keydown" }` and mapped to `Input.dispatchKeyEvent`.

Mouse coordinates are normalized to a 0.0-1.0 range before being sent. The container multiplies them back to pixel coordinates using the viewport dimensions (1280x720). This means the frontend does not need to know the container's resolution.

---

## Getting Started

### Prerequisites

- Docker installed and running
- Node.js 18 or higher
- npm

### Step 1: Build the Container Image

```bash
cd container
docker build -t browse-container:phase2 .
```

This step takes 2-3 minutes on the first run because it downloads Chromium and Node.js. Subsequent builds use Docker layer cache and are much faster.

### Step 2: Start the Backend

```bash
cd backend
npm install
node server.js
```

You should see:

```
[backend] Vessel backend ready
  HTTP   -> http://localhost:3000
  WS     -> ws://localhost:3000
  Status -> http://localhost:3000/api/status
  Max sessions: 5 | Orphan TTL: 120s
```

### Step 3: Start the Frontend

Open a second terminal:

```bash
cd frontend
npm install
npm run dev
```

You should see Next.js start on port 3002:

```
Local: http://localhost:3002
```

### Step 4: Open the UI

Visit `http://localhost:3002` in your browser. Click "Start Browser". The backend will:

1. Allocate a free host port in the range 30000-40000
2. Spin up the Docker container mapped to that port (takes about 5-10 seconds on first run)
3. Launch Chromium inside it with 256 MB RAM and 0.5 CPU limits applied
4. Start streaming frames to your browser

You will see Google load in the stream. Click anywhere on the stream to interact with it. Type to enter text. Use the URL bar at the top to navigate.

Click "End Session" to stop the container. Docker removes it automatically.

If you accidentally refresh the page, the session will resume automatically within 2 minutes using the UUID stored in your browser's `localStorage`.

---

## Ports Reference

| Port | Service | Notes |
|---|---|---|
| 3000 | Backend HTTP + WebSocket | REST API and relay server |
| 3002 | Frontend (Next.js dev) | The UI you interact with |
| 30000-40000 | Container WebSockets | Dynamically allocated per session, mapped from internal port 3001 |

---

## How Input Commands Work

The container's `browser.js` accepts the following JSON commands over its WebSocket connection:

| Command | Fields | Action |
|---|---|---|
| `hello` | sessionId (string or null) | Handshake sent on connection, identifies reconnecting sessions |
| `click` | x, y (normalized 0-1) | Left mouse click at that position |
| `scroll` | x, y, deltaY | Mouse wheel scroll |
| `type` | text | Insert printable character via CDP insertText |
| `keydown` | key | Special key press (Enter, Backspace, etc.) |
| `navigate` | url | Navigate the page to a new URL |
| `mousemove` | x, y | Move the mouse cursor |

---

## Session Lifecycle

```
User opens UI
      |
      v
Frontend sends { type: "hello", sessionId: null } (first visit)
or { type: "hello", sessionId: "uuid-xxx" }  (returning user)
      |
      v
Backend: new session -> allocate port, boot container, register session
Backend: returning   -> find session in registry, cancel TTL, resume stream
      |
      v
Session is ACTIVE: frames flow, inputs are relayed
      |
      v (user closes tab or refreshes)
Backend marks session ORPHANED, starts 2-minute TTL timer
      |
      v (user returns within 2 minutes)      | (timer expires)
Session resumes, TTL cancelled               | Cleanup runs, container stopped
```

---

## Known Limitations and Gotchas

**Container startup time.** Chromium takes 5-10 seconds to launch inside the container. This is normal. The booting overlay in the UI covers the stream area during this time.

**Port conflicts.** If containers are not cleaned up properly (for example if the backend crashes), ports in the 30000-40000 range may remain allocated. Clean up all Vessel containers with:

```bash
docker ps -a --filter ancestor=browse-container:phase2 --format "{{.ID}}" | xargs -r docker rm -f
```

**Frame quality vs performance.** The screencast is configured at JPEG quality 75. You can raise this in `container/browser.js` under `Page.startScreencast` options, but it increases bandwidth between the container and the backend.

**No HTTPS.** All communication is plain HTTP and WS. This is fine for local use, but you would need TLS and proper authentication before exposing this to any network.

**Memory limit and Chromium.** The 256 MB RAM limit is intentionally conservative. Very heavy pages with many media elements may hit this limit and cause tab crashes inside the remote browser. You can raise `CONTAINER_MEMORY_BYTES` in `backend/server.js` if needed.

---

## How It Was Built (Phase by Phase)

The project was built incrementally.

**Phase 1** established that Chromium could run headlessly inside Docker at all. The output was a single screenshot saved to `/tmp/screenshot.png`.

**Phase 2** turned `browser.js` into a persistent WebSocket server. It used `Page.startScreencast` via a raw CDP session to stream frames. A test HTML file connected directly to the container to confirm the stream worked.

**Phase 3** introduced the backend orchestrator. Instead of connecting directly to the container, the test client connected to the backend, which spawned the container on demand and relayed messages. This is where `dockerode` and the TCP port probe were introduced.

**Phase 4** replaced the raw HTML test client with a proper Next.js UI. The custom hook pattern was introduced to separate connection logic from rendering. Direct DOM mutation was used for frame rendering to avoid re-render overhead.

**Phase 5** added multi-tenant support. The single `activeSession` global was replaced with a `portAllocator` module and a `sessionRegistry` Map. Each user now gets a dynamically allocated container on a unique host port.

**Phase 6** added graceful reconnection with TTL-based session preservation. Page refreshes no longer destroy the remote browser. Sessions are kept alive for 2 minutes in an `orphaned` state before being garbage collected.

**Phase 7** added Linux cgroup-based resource limits. Each container is capped at 256 MB RAM and 0.5 CPU cores, enforced at the kernel level, to prevent any single user from crashing the host machine.
