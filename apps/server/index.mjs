import { appendFile, mkdir, readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { DEFAULT_CONFIG, buildField, generateMaze, heightAt, isWalkable, regionAt } from '../../packages/maze-core/src/index.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, '../../dist/viewer');
const dataRoot = path.resolve(here, 'data');
const logFile = path.join(dataRoot, 'matches.jsonl');
const port = Number(process.env.PORT ?? 3000);
const MAX_PLAYERS = 6;
const RECONNECT_MS = 60_000;
const SNAPSHOT_MS = 100;
const rooms = new Map();
const sockets = new WeakMap();

const mime = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
};

function safeName(value) {
  const name = String(value ?? 'Explorer').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 18);
  return name || 'Explorer';
}

function send(ws, message) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

function findRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let attempt = 0; attempt < 20; attempt++) {
    let code = '';
    for (let i = 0; i < 5; i++) code += chars[randomBytes(1)[0] % chars.length];
    if (!rooms.has(code)) return code;
  }
  throw new Error('Could not allocate a room code');
}

function playerView(player) {
  return {
    id: player.id,
    name: player.name,
    spawnIndex: player.spawnIndex,
    connected: player.connected,
    ready: player.ready,
    position: player.position,
    yaw: player.yaw,
    speed: player.speed,
    crouch: player.crouch,
    sprinting: player.sprinting,
    grounded: player.grounded,
    moveDir: player.moveDir,
    distance: Math.round(player.distance * 10) / 10,
    region: player.region,
  };
}

function roomMessage(room, forPlayer) {
  return {
    type: 'room',
    roomCode: room.code,
    seed: room.seed,
    started: room.started,
    ended: room.ended,
    winnerId: room.winnerId,
    hostId: room.hostId,
    you: { id: forPlayer.id, token: forPlayer.token, spawnIndex: forPlayer.spawnIndex },
    players: [...room.players.values()].map(playerView),
  };
}

function broadcastRoom(room) {
  for (const player of room.players.values()) {
    if (player.socket) send(player.socket, roomMessage(room, player));
  }
}

function broadcastSnapshot(room) {
  const snapshot = {
    type: 'snapshot',
    serverTime: Date.now(),
    winnerId: room.winnerId,
    players: [...room.players.values()].map(playerView),
  };
  for (const player of room.players.values()) if (player.socket) send(player.socket, snapshot);
}

function createPlayer(room, name, socket) {
  const id = randomUUID();
  const token = randomBytes(24).toString('base64url');
  const occupiedSeats = new Set([...room.players.values()].map((player) => player.spawnIndex));
  const spawnIndex = Array.from({ length: MAX_PLAYERS }, (_, index) => index).find((index) => !occupiedSeats.has(index));
  if (spawnIndex === undefined) throw new Error('No open spawn seat');
  const node = room.maze.nodes[room.maze.spawns[spawnIndex]];
  const p = {
    id,
    token,
    name: safeName(name),
    spawnIndex,
    socket,
    connected: true,
    ready: false,
    expires: null,
    position: { x: node.x, y: node.y + 1.1, z: node.z },
    yaw: 0,
    speed: 0,
    crouch: 0,
    sprinting: false,
    grounded: true,
    moveDir: { x: 0, z: 0 },
    region: regionAt(node.x, node.z, room.maze.layout, DEFAULT_CONFIG),
    distance: 0,
    lastPoseAt: Date.now(),
    lastPoseSeq: -1,
  };
  room.players.set(id, p);
  sockets.set(socket, { roomCode: room.code, playerId: id });
  return p;
}

function expirePlayer(room, player) {
  if (player.socket || room.players.get(player.id) !== player) return;
  room.players.delete(player.id);
  if (room.hostId === player.id) room.hostId = [...room.players.values()].find((candidate) => candidate.connected)?.id ?? null;
  if (room.players.size === 0) {
    rooms.delete(room.code);
    return;
  }
  broadcastRoom(room);
}

async function persistResult(room, reason) {
  await mkdir(dataRoot, { recursive: true });
  const result = {
    room: room.code,
    seed: room.seed,
    startedAt: room.startedAt,
    endedAt: new Date().toISOString(),
    reason,
    winner: room.players.get(room.winnerId)?.name ?? null,
    players: [...room.players.values()].map((player) => ({
      name: player.name,
      spawnIndex: player.spawnIndex,
      distanceMeters: Math.round(player.distance * 10) / 10,
      finalRegion: player.region,
      connected: player.connected,
    })),
  };
  await appendFile(logFile, `${JSON.stringify(result)}\n`, 'utf8');
  console.log(`Saved match ${room.code} (${reason}) to ${path.relative(process.cwd(), logFile)}`);
}

async function finishRoom(room, reason, winnerId = null) {
  if (room.ended) return;
  room.ended = true;
  room.started = false;
  room.winnerId = winnerId;
  room.endReason = reason;
  try {
    await persistResult(room, reason);
  } catch (error) {
    console.error('Could not save match result:', error);
  }
  broadcastRoom(room);
}

function startRoom(room) {
  const connected = [...room.players.values()].filter((player) => player.connected);
  if (room.started || room.ended || connected.length < 2 || connected.some((player) => !player.ready)) return false;
  room.started = true;
  room.startedAt = new Date().toISOString();
  for (const p of room.players.values()) {
    const node = room.maze.nodes[room.maze.spawns[p.spawnIndex]];
    p.position = { x: node.x, y: node.y + 1.1, z: node.z };
    p.distance = 0;
    p.lastPoseAt = Date.now();
  }
  broadcastRoom(room);
  console.log(`Match ${room.code} started with ${room.players.size} players (seed ${room.seed})`);
  return true;
}

function createRoom(ws, name) {
  const code = findRoomCode();
  const seed = randomBytes(4).readUInt32LE(0);
  const maze = generateMaze(seed);
  const room = {
    code,
    seed,
    maze,
    field: buildField(maze),
    hostId: null,
    players: new Map(),
    started: false,
    ended: false,
    winnerId: null,
    startedAt: null,
  };
  rooms.set(code, room);
  const player = createPlayer(room, name, ws);
  room.hostId = player.id;
  broadcastRoom(room);
}

function joinRoom(ws, codeValue, name, resume) {
  const code = String(codeValue ?? '').trim().toUpperCase();
  const room = rooms.get(code);
  if (!room) return send(ws, { type: 'error', message: 'Room not found. Check the code and try again.' });
  if (room.ended) return send(ws, { type: 'error', message: 'This match has ended. Create a new room to play again.' });

  if (resume?.id && resume?.token) {
    const player = room.players.get(resume.id);
    if (!player || player.token !== resume.token) return send(ws, { type: 'error', message: 'Reconnect expired. Join the room again.' });
    if (player.socket && player.socket !== ws) player.socket.close(4001, 'Session resumed on another connection');
    if (player.expires) clearTimeout(player.expires);
    player.expires = null;
    player.socket = ws;
    player.connected = true;
    player.name = safeName(name || player.name);
    sockets.set(ws, { roomCode: room.code, playerId: player.id });
    send(ws, roomMessage(room, player));
    broadcastRoom(room);
    console.log(`${player.name} reconnected to ${room.code}`);
    return;
  }

  if (room.started) return send(ws, { type: 'error', message: 'The match has already started. Rejoin with your saved session or create a new room.' });
  if (room.players.size >= MAX_PLAYERS) return send(ws, { type: 'error', message: 'Room is full (6 players maximum).' });
  const player = createPlayer(room, name, ws);
  send(ws, roomMessage(room, player));
  broadcastRoom(room);
  console.log(`${player.name} joined ${room.code} (${room.players.size}/${MAX_PLAYERS})`);
}

function acceptPose(room, player, data) {
  if (!room.started || room.ended || !data.position) return;
  const x = Number(data.position.x);
  const y = Number(data.position.y);
  const z = Number(data.position.z);
  const yaw = Number(data.yaw);
  const now = Date.now();
  if (![x, y, z, yaw].every(Number.isFinite) || !isWalkable(room.field, x, z)) return;

  const elapsed = Math.min(2, Math.max(0.05, (now - player.lastPoseAt) / 1000));
  const moved = Math.hypot(x - player.position.x, z - player.position.z);
  if (moved > 10 * elapsed + 2) return;
  const samples = Math.ceil(moved / 1);
  for (let i = 1; i <= samples; i++) {
    const t = i / samples;
    if (!isWalkable(room.field, player.position.x + (x - player.position.x) * t, player.position.z + (z - player.position.z) * t)) return;
  }
  const floor = heightAt(room.field, x, z) + 1.1;
  if (y < floor - 3 || y > floor + 5) return;

  if (Number.isInteger(data.seq) && data.seq <= player.lastPoseSeq) return;
  const dx = x - player.position.x;
  const dz = z - player.position.z;
  player.distance += Math.hypot(dx, dz);
  player.moveDir = moved > 0.05 ? { x: dx / moved, z: dz / moved } : { x: 0, z: 0 };
  player.position = { x, y: Math.max(floor - 2, Math.min(floor + 2, y)), z };
  player.yaw = Math.atan2(Math.sin(yaw), Math.cos(yaw));
  player.speed = Math.min(9, Math.max(0, Number(data.speed) || moved / elapsed));
  player.crouch = Math.min(1, Math.max(0, Number(data.crouch) || 0));
  player.sprinting = Boolean(data.sprinting);
  player.grounded = Boolean(data.grounded);
  player.region = regionAt(x, z, room.maze.layout, DEFAULT_CONFIG);
  player.lastPoseAt = now;
  if (Number.isInteger(data.seq)) player.lastPoseSeq = data.seq;

  const exit = room.maze.nodes[room.maze.exit];
  if (Math.hypot(x - exit.x, z - exit.z) < 3) void finishRoom(room, 'finished', player.id);
}

const server = createServer(async (req, res) => {
  const requestUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  if (requestUrl.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, players: [...rooms.values()].reduce((sum, room) => sum + room.players.size, 0) }));
    return;
  }

  let requested = decodeURIComponent(requestUrl.pathname);
  if (requested === '/') requested = '/index.html';
  const file = path.resolve(webRoot, `.${requested}`);
  if (!file.startsWith(`${webRoot}${path.sep}`) && file !== path.join(webRoot, 'index.html')) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error('Not a file');
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': mime[path.extname(file)] ?? 'application/octet-stream', 'content-length': body.length });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Game files not found. Start the local server with `npm run host` from the project folder.');
  }
});

const wss = new WebSocketServer({ server, maxPayload: 16 * 1024 });
wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      return send(ws, { type: 'error', message: 'Invalid message.' });
    }
    const session = sockets.get(ws);
    if (!session) {
      if (data.type === 'create') createRoom(ws, data.name);
      else if (data.type === 'join') joinRoom(ws, data.roomCode, data.name, data.resume);
      else send(ws, { type: 'error', message: 'Create or join a room first.' });
      return;
    }

    const room = rooms.get(session.roomCode);
    const player = room?.players.get(session.playerId);
    if (!room || !player) return send(ws, { type: 'error', message: 'Room session expired.' });
    switch (data.type) {
      case 'start':
        if (player.id !== room.hostId) return send(ws, { type: 'error', message: 'Only the room host can start the match.' });
        if (!startRoom(room)) send(ws, { type: 'error', message: 'At least two players must be connected and everyone must be ready.' });
        break;
      case 'ready':
        if (!room.started && !room.ended) {
          player.ready = Boolean(data.ready);
          broadcastRoom(room);
        }
        break;
      case 'pose':
        acceptPose(room, player, data);
        break;
      case 'end':
        if (player.id === room.hostId) void finishRoom(room, 'host-ended');
        break;
      case 'leave':
        player.socket = null;
        player.connected = false;
        clearTimeout(player.expires);
        room.players.delete(player.id);
        if (room.hostId === player.id) room.hostId = [...room.players.values()].find((candidate) => candidate.connected)?.id ?? null;
        broadcastRoom(room);
        ws.close(1000, 'Left room');
        break;
      default:
        send(ws, { type: 'error', message: 'Unknown action.' });
    }
  });

  ws.on('close', () => {
    const session = sockets.get(ws);
    if (!session) return;
    const room = rooms.get(session.roomCode);
    const player = room?.players.get(session.playerId);
    if (!room || !player || player.socket !== ws) return;
    player.socket = null;
    player.connected = false;
    if (!room.started) player.ready = false;
    if (room.hostId === player.id) room.hostId = [...room.players.values()].find((candidate) => candidate.connected)?.id ?? player.id;
    player.expires = setTimeout(() => expirePlayer(room, player), RECONNECT_MS);
    broadcastRoom(room);
    console.log(`${player.name} disconnected from ${room.code}; keeping their seat for ${RECONNECT_MS / 1000}s`);
  });
});

setInterval(() => {
  for (const room of rooms.values()) if (room.started) broadcastSnapshot(room);
}, SNAPSHOT_MS).unref();

server.listen(port, '0.0.0.0', () => {
  console.log(`Local game server listening on port ${port}`);
  console.log(`Open http://localhost:${port} on this computer.`);
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) console.log(`Players on the same Wi-Fi/hotspot: http://${address.address}:${port}`);
    }
  }
});
