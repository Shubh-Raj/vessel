const net = require('net');

const PORT_RANGE_START = 30000;
const PORT_RANGE_END   = 40000;

const reservedPorts = new Set();

function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();

    server.once('error', () => {
      resolve(false);
    });

    server.once('listening', () => {
      server.close(() => resolve(true));
    });

    server.listen(port, '127.0.0.1');
  });
}

async function allocatePort() {
  for (let port = PORT_RANGE_START; port <= PORT_RANGE_END; port++) {
    if (reservedPorts.has(port)) continue;

    const free = await isPortFree(port);
    if (free) {
      reservedPorts.add(port);
      console.log(`[portAllocator] Allocated port ${port}. Reserved: [${[...reservedPorts].join(', ')}]`);
      return port;
    }
  }
  throw new Error('No free ports available in range 30000-40000');
}

function releasePort(port) {
  if (port && reservedPorts.has(port)) {
    reservedPorts.delete(port);
    console.log(`[portAllocator] Released port ${port}. Reserved: [${[...reservedPorts].join(', ')}]`);
  }
}

module.exports = { allocatePort, releasePort };
