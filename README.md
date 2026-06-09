# Vessel

Vessel is a self-hosted remote browser control system that runs entirely on your local machine. Open a web UI, click a button, and a real Chromium browser starts inside a Docker container. Its screen streams back to you live, and every click, scroll, and keystroke you make in the UI gets sent to the remote browser in real time.

---

## What It Does

- Launches a headless Chromium browser inside a Docker container on demand
- Streams the browser screen to your web UI as a live JPEG feed at roughly 30 fps
- Forwards your mouse clicks, scroll events, and keyboard input to the remote browser
- Lets you navigate to any URL from a bar in the UI
- Automatically tears down the container when you end the session

No external services required. Everything runs on localhost.

---

## Architecture

The system has three distinct layers. Each layer has a single responsibility and communicates with its neighbors over WebSockets.

```
+------------------+        WebSocket        +-------------------+        WebSocket        +----------------------+
|                  |  ws://localhost:3000    |                   |  ws://localhost:3001    |                      |
|   Browser (UI)   | <---------------------> |   Backend Server  | <---------------------> |  Docker Container    |
|   Next.js App    |                         |   Node.js/Express |                         |  Node.js + Chromium  |
|   port 3002      |                         |   port 3000       |                         |  (internal port 3001)|
|                  |                         |                   |                         |                      |
| - Renders stream |     HTTP (REST)         | - Spawns Docker   |   CDP over Puppeteer    | - Runs Puppeteer     |
| - Sends input    | GET /api/status         | - Relays messages |                         | - Page.startScreencast|
| - Shows status   | <---------------------> | - Manages cleanup |                         | - Accepts commands   |
+------------------+                         +-------------------+                         +----------------------+
```

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
Container WebSocket server (port 3001)
        |
        v
Backend receives the message, calls .toString() to keep it a text frame
        |
        v
Backend forwards to the connected frontend WebSocket client
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
Backend logs the input and forwards to container WebSocket
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
| Container Runtime | Docker (via dockerode) | Spinning up and tearing down the browser container |
| Communication | WebSockets (ws library) | Real-time bidirectional messaging between all layers |

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
|   |-- package.json         express + ws + dockerode + cors
|   |-- test-client.html     Relay test page
|
|-- frontend/
|   |-- app/
|   |   |-- page.tsx         Main page: LandingView + StreamView components
|   |   |-- layout.tsx       Root layout, metadata
|   |   |-- globals.css      Full design system, light theme
|   |-- hooks/
|   |   |-- useRemoteBrowser.ts  Custom React hook, owns all WebSocket logic
|   |-- package.json
|   |-- tsconfig.json
|
|-- .gitignore
|-- README.md
```

---

## How the Container Works

The container image is a Debian Linux environment with Chromium installed via `apt-get` and Node.js 20 installed via NodeSource.

When the container starts, `browser.js` runs. It creates a WebSocket server on port 3001 and waits. The moment a client connects, it:

1. Launches Chromium using `puppeteer.launch()` with flags like `--no-sandbox` and `--disable-dev-shm-usage` that are required inside Docker
2. Opens a new page and sets a 1280x720 viewport
3. Navigates to Google
4. Creates a raw CDP session using `page.createCDPSession()`
5. Calls `Page.startScreencast` with JPEG format at 75 quality
6. Listens for `Page.screencastFrame` events and sends each frame to the WebSocket client
7. Listens for input commands and maps them to the appropriate CDP calls

When the client disconnects, the browser is closed and the container becomes idle.

The key reason for using `puppeteer-core` instead of `puppeteer` is size. The full `puppeteer` package downloads its own copy of Chromium on install (around 300MB). Since we install Chromium through `apt-get` in the Dockerfile, we only need the library.

---

## How the Backend Works

The backend (`server.js`) serves two purposes. First, it exposes an HTTP endpoint at `GET /api/status` so the frontend can poll session state. Second, it manages the WebSocket relay.

When the frontend opens a WebSocket connection to the backend on port 3000, the backend:

1. Creates a Docker container using `dockerode`, which talks to the Docker daemon via `/var/run/docker.sock`
2. Starts the container with port 3001 mapped from the container to the host
3. Probes the host port using a raw TCP socket (`net.createConnection`) until it opens
4. Waits 400ms after the port opens before proceeding (the WebSocket server needs a moment after the TCP port binds)
5. Connects to the container's WebSocket server as a client
6. Sets up a bidirectional relay: container messages go to the frontend, frontend messages go to the container
7. Logs every input event (click, scroll, type, keydown, navigate) to the terminal

When the frontend closes or the session ends, the backend stops the container via `dockerode`. The container has `AutoRemove: true`, so Docker removes it as soon as it stops.

Note: the backend uses a raw TCP probe rather than a WebSocket probe to check container readiness. A WebSocket probe would complete the full handshake, triggering `wss.on('connection')` inside the container and causing it to launch Chromium prematurely. The TCP probe only checks that the port is listening, without any application-level handshake.

---

## How the Frontend Works

The frontend is a Next.js app with two visual states: a landing page and a stream view.

All WebSocket logic lives in `useRemoteBrowser.ts`, a custom React hook. The hook manages connection state, status messages, and a frame callback. The page component only handles rendering.

The most important performance decision is how frames are displayed. Incoming JPEG frames arrive at roughly 30 per second. Instead of calling `setState` for each frame (which would trigger 30 React re-renders per second), the hook stores a callback in a `useRef`. The callback directly mutates `imgRef.current.src` via a DOM reference. React never re-renders for frame updates. Only genuine state changes (connection status, errors, FPS count) go through `useState`.

Keyboard input is captured by a `window.addEventListener('keydown')` listener. Single printable characters are sent as `{ type: "type" }` commands, which map to the `Input.insertText` CDP command on the container side. This is more reliable than firing individual `keydown`/`keyup` pairs for text. Special keys like Enter, Backspace, Tab, and arrow keys are sent as `{ type: "keydown" }` and mapped to `Input.dispatchKeyEvent`.

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
   Browse Backend ready
  HTTP  ->  http://localhost:3000
  WS    ->  ws://localhost:3000
  Status->  http://localhost:3000/api/status
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

1. Spin up the Docker container (takes about 5-10 seconds on first run)
2. Launch Chromium inside it
3. Start streaming frames to your browser

You will see Google load in the stream. Click anywhere on the stream to interact with it. Type to enter text. Use the URL bar at the top to navigate.

Click "End Session" to stop the container. Docker removes it automatically.

---

## Ports Reference

| Port | Service | Notes |
|---|---|---|
| 3000 | Backend HTTP + WebSocket | REST API and relay server |
| 3001 | Container WebSocket | Mapped from inside Docker to host |
| 3002 | Frontend (Next.js dev) | The UI you interact with |

---

## How Input Commands Work

The container's `browser.js` accepts the following JSON commands over its WebSocket connection:

| Command | Fields | Action |
|---|---|---|
| `click` | x, y (normalized 0-1) | Left mouse click at that position |
| `scroll` | x, y, deltaY | Mouse wheel scroll |
| `type` | text | Insert printable character via CDP insertText |
| `keydown` | key | Special key press (Enter, Backspace, etc.) |
| `navigate` | url | Navigate the page to a new URL |
| `mousemove` | x, y | Move the mouse cursor |

---

## Known Limitations and Gotchas

**One session at a time.** The backend rejects new WebSocket connections if a session is already active. This is intentional for the current scope.

**Container startup time.** Chromium takes 5-10 seconds to launch inside the container. This is normal. The booting overlay in the UI covers the stream area during this time.

**Port conflicts.** If a container is not cleaned up properly (for example if the backend crashes), port 3001 will remain allocated. Clean up with:

```bash
docker ps -a --filter ancestor=browse-container:phase2 --format "{{.ID}}" | xargs -r docker rm -f
```

**Frame quality vs performance.** The screencast is configured at JPEG quality 75. You can raise this in `container/browser.js` under `Page.startScreencast` options, but it increases bandwidth between the container and the backend.

**No HTTPS.** All communication is plain HTTP and WS. This is fine for local use, but you would need TLS and proper authentication before exposing this to any network.

---

## How It Was Built (Phase by Phase)

The project was built incrementally.

**Phase 1** established that Chromium could run headlessly inside Docker at all. The output was a single screenshot saved to `/tmp/screenshot.png`.

**Phase 2** turned `browser.js` into a persistent WebSocket server. It used `Page.startScreencast` via a raw CDP session to stream frames. A test HTML file connected directly to the container to confirm the stream worked.

**Phase 3** introduced the backend orchestrator. Instead of connecting directly to the container, the test client connected to the backend, which spawned the container on demand and relayed messages. This is where `dockerode` and the TCP port probe were introduced.

**Phase 4** replaced the raw HTML test client with a proper Next.js UI. The custom hook pattern was introduced to separate connection logic from rendering. Direct DOM mutation was used for frame rendering to avoid re-render overhead.

---
