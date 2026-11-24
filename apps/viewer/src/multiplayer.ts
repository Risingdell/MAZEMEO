export interface NetworkPlayer {
  id: string;
  name: string;
  spawnIndex: number;
  connected: boolean;
  position: { x: number; y: number; z: number };
  yaw: number;
  speed: number;
  crouch: number;
  sprinting: boolean;
  grounded: boolean;
  moveDir: { x: number; z: number };
  distance: number;
  region: number;
}

export interface NetworkRoom {
  roomCode: string;
  seed: number;
  started: boolean;
  ended: boolean;
  winnerId: string | null;
  hostId: string;
  you: { id: string; token: string; spawnIndex: number };
  players: NetworkPlayer[];
}

interface SavedSession {
  roomCode: string;
  playerId: string;
  token: string;
  name: string;
}

interface MultiplayerHandlers {
  onRoom(room: NetworkRoom): void;
  onSnapshot(players: NetworkPlayer[], winnerId: string | null): void;
  onStart(room: NetworkRoom): void;
  onEnd(winnerId: string | null): void;
}

const STORAGE_KEY = 'forest-escape-local-session';

/** Same-machine or same-Wi-Fi room client. Reconnects to the last room for 60 seconds. */
export class LocalMultiplayer {
  private readonly panel: HTMLElement;
  private readonly status: HTMLElement;
  private readonly playersList: HTMLElement;
  private readonly roomLabel: HTMLElement;
  private readonly startButton: HTMLButtonElement;
  private readonly leaveButton: HTMLButtonElement;
  private readonly handlers: MultiplayerHandlers;
  private socket: WebSocket | null = null;
  private room: NetworkRoom | null = null;
  private saved: SavedSession | null = null;
  private requested: { type: 'create' | 'join'; roomCode?: string; name: string } | null = null;
  private retryTimer = 0;
  private retryDelay = 500;
  private sequence = 0;
  private intentionalClose = false;
  private startedSeed: number | null = null;

  constructor(handlers: MultiplayerHandlers) {
    this.handlers = handlers;
    this.panel = document.createElement('aside');
    this.panel.id = 'multiplayer';
    this.panel.innerHTML = `
      <h2>Local multiplayer <span class="mp-limit">6 players</span></h2>
      <label class="mp-label">Player name <input id="mp-name" maxlength="18" value="Explorer" /></label>
      <div class="mp-actions"><button id="mp-create" class="primary">Create room</button></div>
      <div class="mp-join"><input id="mp-code" maxlength="5" placeholder="ROOM CODE" aria-label="Room code" /><button id="mp-join">Join</button></div>
      <div class="mp-roomline"><strong id="mp-room">No room</strong><button id="mp-copy" title="Copy page address">Copy link</button></div>
      <p id="mp-status" role="status">Create a room or join a friend.</p>
      <ul id="mp-players"></ul>
      <div class="mp-actions"><button id="mp-start" class="primary" hidden>Start match</button><button id="mp-leave" hidden>Leave room</button></div>
      <small>Friends on this Wi-Fi open the same address and enter your room code.</small>
    `;
    document.body.append(this.panel);
    this.status = this.panel.querySelector('#mp-status')!;
    this.playersList = this.panel.querySelector('#mp-players')!;
    this.roomLabel = this.panel.querySelector('#mp-room')!;
    this.startButton = this.panel.querySelector('#mp-start')!;
    this.leaveButton = this.panel.querySelector('#mp-leave')!;
    this.panel.querySelector<HTMLButtonElement>('#mp-create')!.addEventListener('click', () => this.create());
    this.panel.querySelector<HTMLButtonElement>('#mp-join')!.addEventListener('click', () => this.join());
    this.startButton.addEventListener('click', () => this.send({ type: 'start' }));
    this.leaveButton.addEventListener('click', () => this.leave());
    this.panel.querySelector<HTMLButtonElement>('#mp-copy')!.addEventListener('click', () => void this.copyAddress());
    this.panel.querySelector<HTMLInputElement>('#mp-code')!.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') this.join();
    });

    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const saved = JSON.parse(stored) as SavedSession;
        if (saved.roomCode && saved.playerId && saved.token) {
          this.saved = saved;
          this.panel.querySelector<HTMLInputElement>('#mp-name')!.value = saved.name || 'Explorer';
          this.status.textContent = `Rejoining room ${saved.roomCode}…`;
          this.reconnect();
        }
      }
    } catch {
      localStorage.removeItem(STORAGE_KEY);
    }
  }

  sendPose(pose: {
    x: number; y: number; z: number; yaw: number; speed: number;
    crouch: number; sprinting: boolean; grounded: boolean;
  }): void {
    if (!this.room?.started || !this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.send({ type: 'pose', seq: this.sequence++, position: { x: pose.x, y: pose.y, z: pose.z }, ...pose });
  }

  dispose(): void {
    this.intentionalClose = true;
    window.clearTimeout(this.retryTimer);
    this.socket?.close();
    this.panel.remove();
  }

  private create(): void {
    this.clearSession();
    this.requested = { type: 'create', name: this.playerName() };
    this.intentionalClose = false;
    this.openSocket();
  }

  private join(): void {
    const roomCode = this.panel.querySelector<HTMLInputElement>('#mp-code')!.value.trim().toUpperCase();
    if (roomCode.length !== 5) {
      this.status.textContent = 'Enter the 5-character room code.';
      return;
    }
    this.clearSession();
    this.requested = { type: 'join', roomCode, name: this.playerName() };
    this.intentionalClose = false;
    this.openSocket();
  }

  private playerName(): string {
    return this.panel.querySelector<HTMLInputElement>('#mp-name')!.value.trim().slice(0, 18) || 'Explorer';
  }

  private reconnect(): void {
    if (!this.saved || this.intentionalClose) return;
    this.requested = { type: 'join', roomCode: this.saved.roomCode, name: this.saved.name };
    this.openSocket();
  }

  private openSocket(): void {
    if (this.socket && this.socket.readyState <= WebSocket.OPEN) this.socket.close();
    const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.socket = new WebSocket(`${scheme}//${window.location.host}`);
    const socket = this.socket;
    socket.addEventListener('open', () => {
      this.retryDelay = 500;
      if (this.saved && this.requested?.roomCode === this.saved.roomCode) {
        this.send({ type: 'join', roomCode: this.saved.roomCode, name: this.saved.name, resume: { id: this.saved.playerId, token: this.saved.token } });
      } else if (this.requested) {
        this.send(this.requested);
      }
    });
    socket.addEventListener('message', (event) => this.onMessage(String(event.data)));
    socket.addEventListener('close', () => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (!this.intentionalClose && this.saved) {
        this.status.textContent = 'Connection lost. Reconnecting…';
        window.clearTimeout(this.retryTimer);
        this.retryTimer = window.setTimeout(() => this.reconnect(), this.retryDelay);
        this.retryDelay = Math.min(5000, this.retryDelay * 1.7);
      }
    });
    socket.addEventListener('error', () => {
      this.status.textContent = 'Can’t reach the game host. Check the address and Wi-Fi.';
    });
  }

  private onMessage(raw: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    if (message.type === 'error') {
      this.status.textContent = String(message.message ?? 'Connection error.');
      if (this.requested?.type !== 'create' && !this.saved) this.closeSocket();
      return;
    }
    if (message.type === 'room') {
      const room = message as unknown as NetworkRoom;
      const wasStarted = this.room?.started ?? false;
      this.room = room;
      this.saved = {
        roomCode: room.roomCode,
        playerId: room.you.id,
        token: room.you.token,
        name: this.playerName(),
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.saved));
      this.requested = { type: 'join', roomCode: room.roomCode, name: this.saved.name };
      this.roomLabel.textContent = `Room ${room.roomCode}`;
      this.status.textContent = room.ended
        ? room.winnerId ? `${room.players.find((p) => p.id === room.winnerId)?.name ?? 'A player'} won.` : 'Match ended.'
        : room.started ? 'Match in progress. Click the forest to capture your mouse.' : 'Waiting for players. Share the room code.';
      this.startButton.hidden = !(!room.started && !room.ended && room.hostId === room.you.id);
      this.startButton.disabled = room.players.filter((player) => player.connected).length < 2;
      this.leaveButton.hidden = false;
      this.renderPlayers(room);
      this.handlers.onRoom(room);
      if (room.started && (!wasStarted || this.startedSeed !== room.seed)) {
        this.startedSeed = room.seed;
        this.handlers.onStart(room);
      }
      if (room.ended) this.handlers.onEnd(room.winnerId);
      return;
    }
    if (message.type === 'snapshot') {
      const players = message.players as NetworkPlayer[];
      const winnerId = (message.winnerId as string | null) ?? null;
      this.handlers.onSnapshot(players, winnerId);
      if (winnerId && this.room && !this.room.ended) {
        this.room.ended = true;
        this.room.winnerId = winnerId;
        this.status.textContent = `${players.find((player) => player.id === winnerId)?.name ?? 'A player'} reached the exit!`;
        this.startButton.hidden = true;
        this.handlers.onEnd(winnerId);
      }
    }
  }

  private renderPlayers(room: NetworkRoom): void {
    this.playersList.replaceChildren();
    for (const player of room.players) {
      const row = document.createElement('li');
      row.textContent = `${player.id === room.hostId ? '♛ ' : ''}${player.name}${player.id === room.you.id ? ' (you)' : ''} · ${player.connected ? 'connected' : 'reconnecting'}`;
      this.playersList.append(row);
    }
  }

  private send(message: object): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  private leave(): void {
    this.intentionalClose = true;
    window.clearTimeout(this.retryTimer);
    this.send({ type: 'leave' });
    this.closeSocket();
    this.clearSession();
    this.room = null;
    this.startedSeed = null;
    this.roomLabel.textContent = 'No room';
    this.status.textContent = 'Create a room or join a friend.';
    this.playersList.replaceChildren();
    this.startButton.hidden = true;
    this.leaveButton.hidden = true;
    this.handlers.onEnd(null);
  }

  private closeSocket(): void {
    this.socket?.close();
    this.socket = null;
  }

  private clearSession(): void {
    this.saved = null;
    this.room = null;
    localStorage.removeItem(STORAGE_KEY);
  }

  private async copyAddress(): Promise<void> {
    try {
      await navigator.clipboard.writeText(`${window.location.href.split('?')[0]} (room ${this.room?.roomCode ?? ''})`);
      this.status.textContent = 'Address copied. Send the address and room code to your friends.';
    } catch {
      this.status.textContent = `Send ${window.location.origin} and room code ${this.room?.roomCode ?? ''} to your friends.`;
    }
  }
}
