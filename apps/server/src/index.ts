import { createServer } from 'node:http';
import { serverConfig } from './config.js';
import { AppDatabase } from './db/Database.js';
import { StateStore } from './services/StateStore.js';
import { DiscoveryService } from './services/DiscoveryService.js';
import { authorizedRequest, createRouter } from './http/router.js';
import { WebSocketHub } from './ws/WebSocketHub.js';

const db = new AppDatabase();
const store = new StateStore(db);
const ws = new WebSocketHub();
const router = createRouter(store, ws);
const discovery = new DiscoveryService(store, db, ws);

const server = createServer((req, res) => void router(req, res));

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  if (url.pathname === '/ws') {
    if (!authorizedRequest(req)) {
      socket.destroy();
      return;
    }
    ws.handleUpgrade(req, socket, head);
    ws.broadcast({ type: 'snapshot', payload: store.snapshot() });
    return;
  }
  socket.destroy();
});

server.on('error', (error) => {
  if ('code' in error && error.code === 'EADDRINUSE') {
    console.error(`Agent Monitor server failed: ${serverConfig.host}:${serverConfig.port} is already in use`);
    process.exit(1);
  }
  console.error(`Agent Monitor server failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

server.listen(serverConfig.port, serverConfig.host, () => {
  discovery.start();
  console.log(`Agent Monitor server listening on http://${serverConfig.host}:${serverConfig.port}`);
  console.log(`Hook endpoints: http://${serverConfig.host}:${serverConfig.port}/api/hooks/claude and /api/hooks/codex`);
});

process.on('SIGINT', () => {
  discovery.stop();
  server.close(() => process.exit(0));
});
