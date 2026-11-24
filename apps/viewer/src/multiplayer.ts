export interface NetworkPlayer {
  id: string;
  name: string;
  spawnIndex: number;
  connected: boolean;
  ready: boolean;
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
  private readonly lobby: HTMLElement;
  private readonly lobbyStatus: HTMLElement;
  private readonly lobbyRoster: HTMLElement;
  private readonly lobbyCode: HTMLElement;
  private readonly lobbyReadyButton: HTMLButtonElement;
  private readonly lobbyStartButton: HTMLButtonElement;
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

    this.lobby = document.createElement('section');
    this.lobby.id = 'mp-lobby';
    this.lobby.hidden = true;
    this.lobby.innerHTML = `
      <div class="lobby-card">
        <div class="lobby-topline"><span>FOREST ESCAPE <i>·</i> LOCAL MATCH</span><button id="mp-lobby-leave">Leave room</button></div>
        <h1>Gather your party</h1>
        <p class="lobby-lede">Join the same Wi-Fi or hotspot, take a seat, then ready up.</p>
        <div class="lobby-content">
          <section class="lobby-share">
            <span class="lobby-caption">ROOM CODE</span>
            <div class="lobby-code"><strong id="mp-lobby-code">-----</strong><button id="mp-lobby-copy">Copy</button></div>
            <p>Friends open this game address and enter the code:</p>
            <code id="mp-lobby-address"></code>
            <div class="lobby-network"><span class="network-dot"></span> Same local network · no internet required</div>
          </section>
          <section class="lobby-roster-wrap">
            <div class="lobby-roster-title"><h2>Players</h2><span id="mp-lobby-count">0 / 6</span></div>
            <div id="mp-lobby-roster" class="lobby-roster"></div>
          </section>
        </div>
        <footer class="lobby-footer">
          <div><strong id="mp-lobby-status">Waiting for players…</strong><small>At least 2 players · maximum 6</small></div>
          <div class="lobby-buttons"><button id="mp-lobby-ready" class="ready-button">I’m ready</button><button id="mp-lobby-start" class="primary" disabled>Start match</button></div>
        </footer>
      </div>
    `;
    document.body.append(this.lobby);
    this.lobbyStatus = this.lobby.querySelector('#mp-lobby-status')!;
    this.lobbyRoster = this.lobby.querySelector('#mp-lobby-roster')!;
    this.lobbyCode = this.lobby.querySelector('#mp-lobby-code')!;
    this.lobbyReadyButton = this.lobby.querySelector('#mp-lobby-ready')!;
    this.lobbyStartButton = this.lobby.querySelector('#mp-lobby-start')!;
    this.lobbyReadyButton.addEventListener('click', () => {
      const self = this.room?.players.find((player) => player.id === this.room?.you.id);
      this.send({ type: 'ready', ready: !self?.ready });
      this.lobbyStatus.textContent = 'Updating your ready status…';
    });
    this.lobbyStartButton.addEventListener('click', () => this.send({ type: 'start' }));
    this.lobby.querySelector<HTMLButtonElement>('#mp-lobby-leave')!.addEventListener('click', () => this.leave());
    this.lobby.querySelector<HTMLButtonElement>('#mp-lobby-copy')!.addEventListener('click', () => void this.copyLobbyInfo());

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
    this.releaseCurrentRoom();
    this.clearSession();
    this.panel.hidden = false;
    this.lobby.hidden = true;
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
    this.releaseCurrentRoom();
    this.clearSession();
    this.panel.hidden = false;
    this.lobby.hidden = true;
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
      if (!this.lobby.hidden) this.lobbyStatus.textContent = this.status.textContent;
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
      this.panel.hidden = !room.ended;
      this.lobby.hidden = room.started || room.ended;
      if (!room.started && !room.ended) this.renderLobby(room);
      if (room.ended) {
        this.lobbyStatus.textContent = room.winnerId
          ? `${room.players.find((player) => player.id === room.winnerId)?.name ?? 'A player'} won the race.`
          : 'The match has ended.';
      }
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

  private renderLobby(room: NetworkRoom): void {
    this.lobbyCode.textContent = room.roomCode;
    this.lobby.querySelector<HTMLElement>('#mp-lobby-address')!.textContent = window.location.origin;
    const connected = room.players.filter((player) => player.connected).length;
    const ready = room.players.filter((player) => player.connected && player.ready).length;
    this.lobby.querySelector<HTMLElement>('#mp-lobby-count')!.textContent = `${connected} / 6 connected`;
    const self = room.players.find((player) => player.id === room.you.id);
    const allReady = connected >= 2 && ready === connected;
    this.lobbyReadyButton.textContent = self?.ready ? '✓ Ready' : 'I’m ready';
    this.lobbyReadyButton.classList.toggle('is-ready', Boolean(self?.ready));
    this.lobbyStartButton.hidden = room.hostId !== room.you.id;
    this.lobbyStartButton.disabled = !allReady;
    this.lobbyStatus.textContent = connected < 2
      ? 'Waiting for at least one more player…'
      : allReady ? 'Everyone is ready. The host can start.' : `${ready} of ${connected} players ready`;

    const bySeat = new Map(room.players.map((player) => [player.spawnIndex, player]));
    this.lobbyRoster.replaceChildren();
    for (let seat = 0; seat < 6; seat++) {
      const player = bySeat.get(seat);
      const slot = document.createElement('div');
      slot.className = `lobby-slot${player ? ' occupied' : ' open'}`;
      const badge = document.createElement('span');
      badge.className = 'slot-number';
      badge.textContent = String(seat + 1).padStart(2, '0');
      const details = document.createElement('span');
      details.className = 'slot-details';
      const name = document.createElement('strong');
      name.textContent = player ? player.name : 'Open seat';
      const state = document.createElement('small');
      state.textContent = player ? !player.connected ? 'Reconnecting…' : player.ready ? 'Ready' : 'Not ready' : 'Waiting for a player';
      details.append(name, state);
      const tag = document.createElement('span');
      tag.className = `slot-state${player?.ready && player.connected ? ' ready' : ''}`;
      tag.textContent = player ? player.id === room.hostId ? 'HOST' : player.ready && player.connected ? 'READY' : player.connected ? 'HERE' : 'OFFLINE' : '+';
      slot.append(badge, details, tag);
      this.lobbyRoster.append(slot);
    }
  }

  private send(message: object): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  private leave(): void {
    this.intentionalClose = true;
    window.clearTimeout(this.retryTimer);
    this.releaseCurrentRoom();
    this.clearSession();
    this.room = null;
    this.startedSeed = null;
    this.panel.hidden = false;
    this.lobby.hidden = true;
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

  private releaseCurrentRoom(): void {
    if (!this.socket) return;
    this.send({ type: 'leave' });
    this.closeSocket();
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

  private async copyLobbyInfo(): Promise<void> {
    const address = window.location.origin;
    const roomCode = this.room?.roomCode ?? '';
    try {
      await navigator.clipboard.writeText(`${address}\nRoom code: ${roomCode}`);
      this.lobbyStatus.textContent = 'Address and room code copied. Send them to your friends.';
    } catch {
      this.lobbyStatus.textContent = `Send ${address} and room code ${roomCode} to your friends.`;
    }
  }
}
