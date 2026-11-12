import express from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';
import type {
  GamePhase,
  Player,
  PlayerPublic,
  Clue,
  VoteRecord,
  RevealResult,
  RoomStateSync,
  ClientAction,
} from './src/types/game.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

interface ServerPlayer extends Player {
  sessionToken: string;
  ws?: WebSocket | null;
}

interface Room {
  roomCode: string;
  roundNumber: number;
  phase: GamePhase;
  players: ServerPlayer[];
  hostId: string;
  turnOrder: string[]; // player IDs in turn order for clues (non-hosts)
  currentTurnIndex: number;
  clues: Clue[];
  crewWord: string;
  imposterWord: string;
  imposterId: string;
  votes: Record<string, string>; // voterId -> targetId
  revealResult: RevealResult | null;
  newHostId: string | null;
  botTimeout?: NodeJS.Timeout | null;
}

const rooms = new Map<string, Room>();

function getNextBotName(existingPlayers: ServerPlayer[]): string {
  const existingNames = new Set(existingPlayers.map((p) => p.name));
  for (let i = 1; i <= 8; i++) {
    const candidate = `Bot ${i}`;
    if (!existingNames.has(candidate)) return candidate;
  }
  return `Bot ${existingPlayers.length + 1}`;
}

const BOT_WORD_PAIRS = [
  ['Coffee', 'Tea'],
  ['Apple', 'Pear'],
  ['Sun', 'Moon'],
  ['Guitar', 'Violin'],
  ['Pizza', 'Burger'],
  ['Airplane', 'Helicopter'],
  ['Doctor', 'Nurse'],
  ['Cat', 'Dog'],
  ['Beach', 'Desert'],
  ['Soccer', 'Basketball'],
  ['Detective', 'Spy'],
  ['Rain', 'Snow'],
];

function executeBotHostWordSelection(room: Room) {
  if (room.botTimeout) {
    clearTimeout(room.botTimeout);
  }

  room.botTimeout = setTimeout(() => {
    if (!rooms.has(room.roomCode)) return;
    if (room.phase !== 'HOST_WORD_INPUT') return;

    const host = room.players.find((p) => p.id === room.hostId);
    if (!host || !host.isBot) return;

    const pair = BOT_WORD_PAIRS[Math.floor(Math.random() * BOT_WORD_PAIRS.length)];
    const crewWord = pair[0];
    const imposterWord = pair[1];

    room.crewWord = crewWord;
    room.imposterWord = imposterWord;

    const nonHostPlayers = room.players.filter((p) => p.id !== room.hostId);
    const imposterIndex = Math.floor(Math.random() * nonHostPlayers.length);
    const imposter = nonHostPlayers[imposterIndex];
    room.imposterId = imposter.id;

    for (const p of room.players) {
      if (p.id === room.hostId) {
        p.role = 'HOST';
        p.secretWord = '';
      } else if (p.id === room.imposterId) {
        p.role = 'IMPOSTER';
        p.secretWord = imposterWord;
      } else {
        p.role = 'CREW';
        p.secretWord = crewWord;
      }
    }

    const shuffled = [...nonHostPlayers].sort(() => Math.random() - 0.5);
    room.turnOrder = shuffled.map((p) => p.id);
    room.currentTurnIndex = 0;
    room.clues = [];
    room.phase = 'HINT_ROUND_1';

    broadcastRoomState(room);
    handleBotTurn(room);
  }, 1500);
}

function generateRoomCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return rooms.has(code) ? generateRoomCode() : code;
}

function generateId(): string {
  return Math.random().toString(36).substring(2, 9) + Date.now().toString(36).substring(4);
}

// Helper to broadcast room state to all connected players with privacy filters
function broadcastRoomState(room: Room) {
  for (const player of room.players) {
    if (player.ws && player.ws.readyState === WebSocket.OPEN) {
      const sanitizedState = getSanitizedRoomState(room, player.id);
      player.ws.send(JSON.stringify({ type: 'ROOM_STATE', payload: sanitizedState }));
    }
  }
}

function getSanitizedRoomState(room: Room, forPlayerId: string): RoomStateSync {
  const me = room.players.find((p) => p.id === forPlayerId);
  const hostPlayer = room.players.find((p) => p.id === room.hostId);

  const playersPublic: PlayerPublic[] = room.players.map((p) => ({
    id: p.id,
    name: p.name,
    avatar: p.avatar,
    isHost: p.id === room.hostId,
    isRoomLeader: p.isRoomLeader,
    isBot: p.isBot,
    connected: p.isBot ? true : !!(p.ws && p.ws.readyState === WebSocket.OPEN),
    isMuted: p.isBot ? true : (p.isMuted ?? true),
    isSpeaking: p.isBot ? false : (p.isSpeaking ?? false),
    hasVoted: room.phase === 'VOTING' ? !!room.votes[p.id] : undefined,
    hasGivenClueCurrentRound:
      room.phase === 'HINT_ROUND_1'
        ? room.clues.some((c) => c.playerId === p.id && c.round === 1)
        : room.phase === 'HINT_ROUND_2'
        ? room.clues.some((c) => c.playerId === p.id && c.round === 2)
        : undefined,
  }));

  const currentTurnPlayerId =
    room.phase === 'HINT_ROUND_1' || room.phase === 'HINT_ROUND_2'
      ? room.turnOrder[room.currentTurnIndex] || null
      : null;
  const currentTurnPlayer = currentTurnPlayerId
    ? room.players.find((p) => p.id === currentTurnPlayerId)
    : null;

  // Role and secret word assignment privacy
  let myRole: 'HOST' | 'CREW' | 'IMPOSTER' | 'UNKNOWN' = 'UNKNOWN';
  let mySecretWord: string | null = null;
  let wordsOverview: RoomStateSync['wordsOverview'] = null;

  if (me) {
    if (me.id === room.hostId) {
      myRole = 'HOST';
      if (room.phase !== 'LOBBY') {
        wordsOverview = {
          crewWord: room.crewWord,
          imposterWord: room.imposterWord,
          imposterPlayerId: room.imposterId,
        };
      }
    } else {
      if (room.phase !== 'LOBBY' && room.phase !== 'HOST_WORD_INPUT') {
        myRole = me.role;
        mySecretWord = me.secretWord || null;
      }
    }
  }

  // If in REVEAL phase, reveal all overview to everyone
  if (room.phase === 'REVEAL') {
    wordsOverview = {
      crewWord: room.crewWord,
      imposterWord: room.imposterWord,
      imposterPlayerId: room.imposterId,
    };
  }

  return {
    roomCode: room.roomCode,
    roundNumber: room.roundNumber,
    phase: room.phase,
    players: playersPublic,
    hostId: room.hostId,
    hostName: hostPlayer ? hostPlayer.name : 'Unknown',
    currentTurnPlayerId,
    currentTurnPlayerName: currentTurnPlayer ? currentTurnPlayer.name : null,
    clues: room.clues,
    myRole,
    mySecretWord,
    wordsOverview,
    revealResult: room.revealResult,
    minPlayersRequired: 5,
    newHostId: room.newHostId,
  };
}

// Bot auto-play logic
function handleBotTurn(room: Room) {
  if (room.botTimeout) {
    clearTimeout(room.botTimeout);
    room.botTimeout = null;
  }

  if (room.phase === 'HINT_ROUND_1' || room.phase === 'HINT_ROUND_2') {
    const currentTurnId = room.turnOrder[room.currentTurnIndex];
    const player = room.players.find((p) => p.id === currentTurnId);
    if (player && player.isBot) {
      room.botTimeout = setTimeout(() => {
        if (!rooms.has(room.roomCode)) return;
        const currentRound = room.phase === 'HINT_ROUND_1' ? 1 : 2;
        const word = player.secretWord || 'something mysterious';
        const cluesPool = generateBotClues(word, currentRound);
        const randomClue = cluesPool[Math.floor(Math.random() * cluesPool.length)];
        submitClue(room, player.id, randomClue);
      }, 1800);
    }
  } else if (room.phase === 'VOTING') {
    // If there are bots who haven't voted yet, make them vote with slight staggered delays
    const nonHostBots = room.players.filter((p) => p.isBot && p.id !== room.hostId && !room.votes[p.id]);
    if (nonHostBots.length > 0) {
      room.botTimeout = setTimeout(() => {
        if (!rooms.has(room.roomCode)) return;
        const candidateIds = room.players.filter((p) => p.id !== room.hostId).map((p) => p.id);
        for (const bot of nonHostBots) {
          // bot chooses someone other than itself
          const targets = candidateIds.filter((id) => id !== bot.id);
          const target = targets[Math.floor(Math.random() * targets.length)];
          room.votes[bot.id] = target;
        }
        checkVotingComplete(room);
        broadcastRoomState(room);
      }, 2000);
    }
  }
}

function generateBotClues(word: string, round: number): string[] {
  const w = word.toLowerCase();
  if (round === 1) {
    return [
      `You encounter this quite often in daily life.`,
      `It's related to ${w.length > 5 ? 'a broader category' : 'something familiar'}.`,
      `Most people have a strong opinion about this.`,
      `You would definitely recognize it anywhere.`,
      `Usually found in modern spaces.`,
    ];
  } else {
    return [
      `Comparing this with similar items, it has distinct features.`,
      `I stand by my first clue; think about how it's used.`,
      `Someone here is definitely saying something off!`,
      `It's very practical and noticeable.`,
    ];
  }
}

function submitClue(room: Room, playerId: string, clueText: string) {
  if (room.phase !== 'HINT_ROUND_1' && room.phase !== 'HINT_ROUND_2') return;

  const currentExpectedPlayerId = room.turnOrder[room.currentTurnIndex];
  if (playerId !== currentExpectedPlayerId) return;

  const player = room.players.find((p) => p.id === playerId);
  if (!player) return;

  const currentRound: 1 | 2 = room.phase === 'HINT_ROUND_1' ? 1 : 2;

  const newClue: Clue = {
    id: generateId(),
    playerId: player.id,
    playerName: player.name,
    playerAvatar: player.avatar,
    round: currentRound,
    text: clueText.trim(),
    timestamp: Date.now(),
  };

  room.clues.push(newClue);
  room.currentTurnIndex++;

  // Check if round 1 finished
  if (room.currentTurnIndex >= room.turnOrder.length) {
    if (room.phase === 'HINT_ROUND_1') {
      // Advance to Hint Round 2
      room.phase = 'HINT_ROUND_2';
      room.currentTurnIndex = 0;
    } else {
      // Advance to Voting
      room.phase = 'VOTING';
      room.currentTurnIndex = 0;
      room.votes = {};
    }
  }

  broadcastRoomState(room);
  handleBotTurn(room);
}

function checkVotingComplete(room: Room) {
  const nonHostPlayers = room.players.filter((p) => p.id !== room.hostId);
  const allVoted = nonHostPlayers.every((p) => room.votes[p.id]);

  if (allVoted && nonHostPlayers.length > 0) {
    // Tally votes
    const voteCounts: Record<string, number> = {};
    nonHostPlayers.forEach((p) => {
      voteCounts[p.id] = 0;
    });

    const voteRecords: VoteRecord[] = [];

    for (const voter of nonHostPlayers) {
      const targetId = room.votes[voter.id];
      const targetPlayer = room.players.find((p) => p.id === targetId);
      if (targetPlayer) {
        voteCounts[targetId] = (voteCounts[targetId] || 0) + 1;
        voteRecords.push({
          voterId: voter.id,
          voterName: voter.name,
          targetId: targetPlayer.id,
          targetName: targetPlayer.name,
        });
      }
    }

    // Find highest vote count
    let maxVotes = -1;
    let mostVotedIds: string[] = [];
    for (const [id, count] of Object.entries(voteCounts)) {
      if (count > maxVotes) {
        maxVotes = count;
        mostVotedIds = [id];
      } else if (count === maxVotes) {
        mostVotedIds.push(id);
      }
    }

    const isTie = mostVotedIds.length > 1;
    const mostVotedPlayerId = isTie ? null : mostVotedIds[0];
    const mostVotedPlayer = mostVotedPlayerId
      ? room.players.find((p) => p.id === mostVotedPlayerId)
      : null;

    const imposterPlayer = room.players.find((p) => p.id === room.imposterId);

    // Winner determination:
    // If Imposter got the single highest vote count -> Crew wins!
    // If a Crew member got highest vote count, or there is a tie -> Imposter wins!
    let winner: 'CREW' | 'IMPOSTER' = 'IMPOSTER';
    let summaryMessage = '';

    if (!isTie && mostVotedPlayerId === room.imposterId) {
      winner = 'CREW';
      summaryMessage = `The Crew successfully identified the Imposter (${imposterPlayer?.name})!`;
    } else if (isTie) {
      winner = 'IMPOSTER';
      summaryMessage = `A vote tie spared the Imposter! ${imposterPlayer?.name} escapes undetected!`;
    } else {
      winner = 'IMPOSTER';
      summaryMessage = `The Crew voted out innocent ${mostVotedPlayer?.name}! The Imposter (${imposterPlayer?.name}) wins!`;
    }

    room.revealResult = {
      imposterId: room.imposterId,
      imposterName: imposterPlayer ? imposterPlayer.name : 'Unknown',
      imposterAvatar: imposterPlayer ? imposterPlayer.avatar : '🕵️',
      imposterWord: room.imposterWord,
      crewWord: room.crewWord,
      mostVotedPlayerId,
      mostVotedPlayerName: mostVotedPlayer ? mostVotedPlayer.name : null,
      isTie,
      winner,
      voteCounts,
      votes: voteRecords,
      summaryMessage,
    };

    // Prompt rule 7: "The player who was the Imposter in the current round automatically becomes the NEW HOST for the next round."
    room.newHostId = room.imposterId;
    room.phase = 'REVEAL';
  }
}

app.post('/api/check-name', (req, res) => {
  const { name } = req.body;
  if (!name || typeof name !== 'string') {
    return res.status(400).json({ error: 'Name is required' });
  }
  // Any display name is allowed, multiple players can share the same name
  return res.json({ available: true });
});

app.post('/api/create-room', (req, res) => {
  const { playerName, avatar } = req.body;
  if (!playerName) {
    return res.status(400).json({ error: 'Player name is required' });
  }

  const roomCode = generateRoomCode();
  const playerId = generateId();
  const sessionToken = generateId();

  const newPlayer: ServerPlayer = {
    id: playerId,
    name: playerName.trim(),
    avatar: avatar || '😎',
    isHost: false, // Selected when game starts
    isRoomLeader: true,
    isBot: false,
    connected: true,
    role: 'UNKNOWN',
    sessionToken,
  };

  const room: Room = {
    roomCode,
    roundNumber: 1,
    phase: 'LOBBY',
    players: [newPlayer],
    hostId: '',
    turnOrder: [],
    currentTurnIndex: 0,
    clues: [],
    crewWord: '',
    imposterWord: '',
    imposterId: '',
    votes: {},
    revealResult: null,
    newHostId: null,
  };

  rooms.set(roomCode, room);

  res.json({
    roomCode,
    playerId,
    sessionToken,
  });
});

app.get('/api/room/:code', (req, res) => {
  const code = req.params.code.toUpperCase();
  const room = rooms.get(code);
  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }
  res.json({
    roomCode: room.roomCode,
    playerCount: room.players.length,
    phase: room.phase,
    players: room.players.map((p) => p.name),
  });
});

// WebSocket Handling
wss.on('connection', (ws) => {
  let playerSession: { roomCode: string; playerId: string } | null = null;

  ws.on('message', (messageRaw) => {
    try {
      const data: ClientAction = JSON.parse(messageRaw.toString());
      const { type, payload } = data;

      if (type === 'JOIN_ROOM') {
        const { roomCode, playerName, avatar, playerId, sessionToken } = payload || {};
        const code = (roomCode || '').trim().toUpperCase();
        const room = rooms.get(code);

        if (!room) {
          ws.send(JSON.stringify({ type: 'ERROR', message: 'Room not found. Check code.' }));
          return;
        }

        // Check if player already exists in this room (prevent duplicate slots for the same client device)
        const existingPlayer = room.players.find(
          (p) =>
            (playerId && p.id === playerId) ||
            (sessionToken && p.sessionToken === sessionToken) ||
            (playerSession && p.id === playerSession.playerId)
        );

        if (existingPlayer) {
          existingPlayer.ws = ws;
          existingPlayer.connected = true;
          if (playerName) existingPlayer.name = playerName.trim();
          if (avatar) existingPlayer.avatar = avatar;
          playerSession = { roomCode: code, playerId: existingPlayer.id };

          ws.send(
            JSON.stringify({
              type: 'JOINED_SUCCESS',
              payload: {
                roomCode: code,
                playerId: existingPlayer.id,
                sessionToken: existingPlayer.sessionToken,
              },
            })
          );
          broadcastRoomState(room);
          return;
        }

        if (room.players.length >= 8) {
          ws.send(JSON.stringify({ type: 'ERROR', message: 'Room is full (max 8 players).' }));
          return;
        }

        const newPlayerId = generateId();
        const newSessionToken = generateId();
        const newPlayer: ServerPlayer = {
          id: newPlayerId,
          name: (playerName || '').trim() || `Player ${room.players.length + 1}`,
          avatar: avatar || '🚀',
          isHost: false,
          isRoomLeader: room.players.length === 0,
          isBot: false,
          connected: true,
          role: 'UNKNOWN',
          sessionToken: newSessionToken,
          ws,
        };

        room.players.push(newPlayer);
        playerSession = { roomCode: code, playerId: newPlayerId };

        ws.send(
          JSON.stringify({
            type: 'JOINED_SUCCESS',
            payload: { roomCode: code, playerId: newPlayerId, sessionToken: newSessionToken },
          })
        );

        // Check if 5 players reached and we are in LOBBY
        // Prompt rule 4: "Once 5 players are in the room, start the game."
        if (room.players.length === 5 && room.phase === 'LOBBY') {
          startGame(room);
        } else {
          broadcastRoomState(room);
        }
      } else if (type === 'RECONNECT') {
        const { roomCode, playerId, sessionToken } = payload;
        const code = (roomCode || '').trim().toUpperCase();
        const room = rooms.get(code);

        if (!room) {
          ws.send(JSON.stringify({ type: 'ERROR', message: 'Room session expired.' }));
          return;
        }

        const player = room.players.find((p) => p.id === playerId);
        if (!player) {
          ws.send(JSON.stringify({ type: 'ERROR', message: 'Player session not found.' }));
          return;
        }

        player.ws = ws;
        player.connected = true;
        playerSession = { roomCode: code, playerId };

        ws.send(
          JSON.stringify({
            type: 'RECONNECTED_SUCCESS',
            payload: { roomCode: code, playerId, sessionToken: player.sessionToken },
          })
        );
        broadcastRoomState(room);
      } else if (type === 'ADD_BOT') {
        const { roomCode } = payload;
        const room = rooms.get(roomCode);
        if (!room) return;
        if (room.phase !== 'LOBBY') return;
        if (room.players.length >= 5) return;

        const botName = getNextBotName(room.players);
        const botPlayer: ServerPlayer = {
          id: generateId(),
          name: botName,
          avatar: '🤖',
          isHost: false,
          isRoomLeader: false,
          isBot: true,
          connected: true,
          role: 'UNKNOWN',
          sessionToken: generateId(),
          ws: null,
        };

        room.players.push(botPlayer);

        if (room.players.length === 5) {
          startGame(room);
        } else {
          broadcastRoomState(room);
        }
      } else if (type === 'FILL_BOTS') {
        const { roomCode } = payload;
        const room = rooms.get(roomCode);
        if (!room || room.phase !== 'LOBBY') return;

        while (room.players.length < 5) {
          const botName = getNextBotName(room.players);
          const botPlayer: ServerPlayer = {
            id: generateId(),
            name: botName,
            avatar: '🤖',
            isHost: false,
            isRoomLeader: false,
            isBot: true,
            connected: true,
            role: 'UNKNOWN',
            sessionToken: generateId(),
            ws: null,
          };
          room.players.push(botPlayer);
        }

        if (room.players.length >= 5) {
          startGame(room);
        } else {
          broadcastRoomState(room);
        }
      } else if (type === 'REMOVE_BOT') {
        const { roomCode, botId } = payload;
        const room = rooms.get(roomCode);
        if (!room || room.phase !== 'LOBBY') return;

        const index = room.players.findIndex((p) => p.id === botId && p.isBot);
        if (index !== -1) {
          room.players.splice(index, 1);
          broadcastRoomState(room);
        }
      } else if (type === 'START_GAME') {
        const { roomCode } = payload;
        const room = rooms.get(roomCode);
        if (!room || room.phase !== 'LOBBY') return;
        if (room.players.length < 5) {
          ws.send(
            JSON.stringify({
              type: 'ERROR',
              message: 'At least 5 players required to start the game.',
            })
          );
          return;
        }
        startGame(room);
      } else if (type === 'SUBMIT_WORDS') {
        const { roomCode, crewWord, imposterWord } = payload;
        const room = rooms.get(roomCode);
        if (!room || room.phase !== 'HOST_WORD_INPUT') return;
        if (!playerSession || playerSession.playerId !== room.hostId) {
          ws.send(JSON.stringify({ type: 'ERROR', message: 'Only the Host can submit words.' }));
          return;
        }

        const cleanCrewWord = (crewWord || '').trim();
        const cleanImposterWord = (imposterWord || '').trim();

        if (!cleanCrewWord || !cleanImposterWord) {
          ws.send(JSON.stringify({ type: 'ERROR', message: 'Please provide both words.' }));
          return;
        }

        if (cleanCrewWord.toLowerCase() === cleanImposterWord.toLowerCase()) {
          ws.send(
            JSON.stringify({
              type: 'ERROR',
              message: 'Crew word and Imposter word must be different!',
            })
          );
          return;
        }

        room.crewWord = cleanCrewWord;
        room.imposterWord = cleanImposterWord;

        // Word Distribution Rules (Rule 4):
        // 3 players receive the EXACT SAME word (Crew Members).
        // 1 player receives a DIFFERENT word (The Imposter).
        const nonHostPlayers = room.players.filter((p) => p.id !== room.hostId);
        // Randomly pick 1 to be imposter
        const imposterIndex = Math.floor(Math.random() * nonHostPlayers.length);
        const imposter = nonHostPlayers[imposterIndex];
        room.imposterId = imposter.id;

        for (const p of room.players) {
          if (p.id === room.hostId) {
            p.role = 'HOST';
            p.secretWord = '';
          } else if (p.id === room.imposterId) {
            p.role = 'IMPOSTER';
            p.secretWord = cleanImposterWord;
          } else {
            p.role = 'CREW';
            p.secretWord = cleanCrewWord;
          }
        }

        // Setup Hint Phase 1 turn order
        // Shuffle non-host players for a fun random turn order
        const shuffledNonHosts = [...nonHostPlayers].sort(() => Math.random() - 0.5);
        room.turnOrder = shuffledNonHosts.map((p) => p.id);
        room.currentTurnIndex = 0;
        room.clues = [];
        room.phase = 'HINT_ROUND_1';

        broadcastRoomState(room);
        handleBotTurn(room);
      } else if (type === 'SUBMIT_CLUE') {
        const { roomCode, clueText } = payload;
        const room = rooms.get(roomCode);
        if (!room) return;
        if (!playerSession) return;
        submitClue(room, playerSession.playerId, clueText);
      } else if (type === 'SUBMIT_VOTE') {
        const { roomCode, targetPlayerId } = payload;
        const room = rooms.get(roomCode);
        if (!room || room.phase !== 'VOTING') return;
        if (!playerSession) return;

        const voterId = playerSession.playerId;
        if (voterId === room.hostId) {
          ws.send(JSON.stringify({ type: 'ERROR', message: 'Host does not vote.' }));
          return;
        }

        if (voterId === targetPlayerId) {
          ws.send(JSON.stringify({ type: 'ERROR', message: 'You cannot vote for yourself!' }));
          return;
        }

        room.votes[voterId] = targetPlayerId;
        checkVotingComplete(room);
        broadcastRoomState(room);
        handleBotTurn(room);
      } else if (type === 'NEXT_ROUND') {
        // Prompt rule 7: "The player who was the Imposter in the current round automatically becomes the NEW HOST for the next round. Provide a 'Next Round' button for the new Host to start inputting words for Round 2."
        const { roomCode } = payload;
        const room = rooms.get(roomCode);
        if (!room || room.phase !== 'REVEAL') return;

        const nextHostId = room.newHostId || room.imposterId;
        // Verify caller is new host or room leader (or if new host is a bot, any player can start)
        const isCallerAuthorized =
          playerSession?.playerId === nextHostId ||
          room.players.find((p) => p.id === nextHostId)?.isBot ||
          room.players.find((p) => p.id === playerSession?.playerId)?.isRoomLeader;

        if (!isCallerAuthorized) {
          ws.send(
            JSON.stringify({
              type: 'ERROR',
              message: 'Only the new Host can start the next round.',
            })
          );
          return;
        }

        room.roundNumber++;
        room.hostId = nextHostId;
        room.phase = 'HOST_WORD_INPUT';
        room.clues = [];
        room.votes = {};
        room.revealResult = null;
        room.newHostId = null;

        // Reset roles
        for (const p of room.players) {
          p.role = p.id === room.hostId ? 'HOST' : 'UNKNOWN';
          p.secretWord = '';
          p.isHost = p.id === room.hostId;
        }

        // If the new host is a bot, auto-generate words!
        const hostPlayer = room.players.find((p) => p.id === room.hostId);
        if (hostPlayer && hostPlayer.isBot) {
          executeBotHostWordSelection(room);
        }

        broadcastRoomState(room);
      } else if (type === 'VOICE_SIGNAL') {
        const { roomCode, targetPlayerId, signal } = payload || {};
        const code = (roomCode || '').trim().toUpperCase();
        const room = rooms.get(code);
        if (!room) return;

        const targetPlayer = room.players.find((p) => p.id === targetPlayerId);
        const senderPlayer = room.players.find((p) => p.id === playerSession?.playerId);
        if (targetPlayer && targetPlayer.ws && targetPlayer.ws.readyState === WebSocket.OPEN) {
          targetPlayer.ws.send(
            JSON.stringify({
              type: 'VOICE_SIGNAL',
              payload: {
                fromPlayerId: playerSession?.playerId,
                fromPlayerName: senderPlayer?.name,
                signal,
              },
            })
          );
        }
      } else if (type === 'VOICE_STATUS') {
        const { roomCode, isMuted, isSpeaking } = payload || {};
        const code = (roomCode || '').trim().toUpperCase();
        const room = rooms.get(code);
        if (!room) return;
        const playerId = playerSession?.playerId;
        const player = playerId ? room.players.find((p) => p.id === playerId) : null;
        if (player) {
          player.isMuted = isMuted;
          if (typeof isSpeaking === 'boolean') {
            player.isSpeaking = isSpeaking;
          }
          broadcastRoomState(room);
        }
      } else if (type === 'LEAVE_ROOM') {
        if (playerSession) {
          handlePlayerDisconnect(playerSession.roomCode, playerSession.playerId, true);
        }
      }
    } catch (err) {
      console.error('Error handling WebSocket message:', err);
    }
  });

  ws.on('close', () => {
    if (playerSession) {
      handlePlayerDisconnect(playerSession.roomCode, playerSession.playerId, false);
    }
  });
});

function startGame(room: Room) {
  room.phase = 'HOST_WORD_INPUT';
  room.roundNumber = 1;

  // Host Selection (Rule 4):
  // "1 player is randomly selected as the Host for Round 1."
  const randomHostIndex = Math.floor(Math.random() * room.players.length);
  const selectedHost = room.players[randomHostIndex];
  room.hostId = selectedHost.id;

  for (const p of room.players) {
    p.isHost = p.id === room.hostId;
    p.role = p.id === room.hostId ? 'HOST' : 'UNKNOWN';
    p.secretWord = '';
  }

  // If host is a bot, automatically select words and start round
  if (selectedHost.isBot) {
    executeBotHostWordSelection(room);
  }

  broadcastRoomState(room);
}

function handlePlayerDisconnect(roomCode: string, playerId: string, explicitLeave: boolean) {
  const room = rooms.get(roomCode);
  if (!room) return;

  const player = room.players.find((p) => p.id === playerId);
  if (!player) return;

  if (explicitLeave || room.phase === 'LOBBY') {
    // Remove player completely
    room.players = room.players.filter((p) => p.id !== playerId);
    if (room.players.length === 0) {
      if (room.botTimeout) clearTimeout(room.botTimeout);
      rooms.delete(roomCode);
      return;
    }
    // If room leader left, reassign
    if (player.isRoomLeader && room.players.length > 0) {
      room.players[0].isRoomLeader = true;
    }
    // If host left during lobby
    if (player.id === room.hostId) {
      room.hostId = room.players[0].id;
    }
  } else {
    // Soft disconnect during active game to allow reconnection
    player.connected = false;
    player.ws = null;
  }

  broadcastRoomState(room);
}

// Dev vs Production static/Vite serving
async function startServer() {
  const isProduction = process.env.NODE_ENV === 'production';
  const PORT = 3000;

  if (!isProduction) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[Undercover Server] Running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
