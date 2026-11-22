const APP_HTML = __APP_HTML__;

const SUITS = ["clubs", "diamonds", "hearts", "spades"];
const SYMBOLS = { clubs: "♣", diamonds: "♦", hearts: "♥", spades: "♠" };
const RANKS = ["3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A", "2"];
const RANK_VALUE = Object.fromEntries([...RANKS, "JOKER"].map((rank, index) => [rank, index]));
const SUIT_VALUE = Object.fromEntries(SUITS.map((suit, index) => [suit, index]));
const MAX_AGE = 24 * 60 * 60 * 1000;
const MAX_PLAYERS = 12;
const DEFAULT_RULES = { spade3: false, revolution: true, eightCut: true, nineCut: false, tenDiscard: false, elevenBack: false, qBomber: false, fourStop: false, rokurokubi: false, ambulance: false };

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function card(rank, suit, deckIndex = 0) {
  return { id: `${rank}-${suit}${deckIndex ? `-${deckIndex + 1}` : ""}`, rank, suit };
}

function shuffledDeck(deckCount = 1) {
  const deck = Array.from({ length: deckCount }, (_, deckIndex) => [
    ...SUITS.flatMap((suit) => RANKS.map((rank) => card(rank, suit, deckIndex))),
    { id: deckIndex ? `joker-${deckIndex + 1}` : "joker", rank: "JOKER", suit: "joker" },
  ]).flat();
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function cardOrder(a, b) {
  return RANK_VALUE[a.rank] - RANK_VALUE[b.rank] || (SUIT_VALUE[a.suit] ?? 0) - (SUIT_VALUE[b.suit] ?? 0);
}

function nextActive(state, from, includeFrom = false) {
  for (let step = includeFrom ? 0 : 1; step <= state.players.length; step++) {
    const index = (from + step + state.players.length) % state.players.length;
    const player = state.players[index];
    if ((state.hands[player.id] || []).length > 0 && (!state.table || !(state.passedPlayers || []).includes(player.id))) return index;
  }
  return from;
}

function newState(host, name) {
  return {
    phase: "lobby", hostId: host, players: [{ id: host, name }], hands: {},
    turn: 0, table: null, passes: 0, lastPlayer: null, revolution: false, back: false, openingMove: false,
    pendingEightCut: null, passedPlayers: [], events: [], rules: { ...DEFAULT_RULES },
    finishOrder: [], deckCount: 1, createdAt: Date.now(),
  };
}

function publicState(state, viewerId, spectatorMode = false) {
  const current = state.players[state.turn];
  return {
    phase: state.phase,
    spectatorMode,
    deckCount: state.deckCount || 1,
    openingMove: !!state.openingMove,
    isHost: state.hostId === viewerId,
    players: state.players.map((player) => ({
      name: player.name, cards: (state.hands[player.id] || []).length,
      isHost: player.id === state.hostId, isYou: player.id === viewerId,
      isTurn: current?.id === player.id,
      hasPassed: (state.passedPlayers || []).includes(player.id),
      hand: spectatorMode ? (state.hands[player.id] || []) : undefined,
      place: state.finishOrder.indexOf(player.id) + 1 || null,
    })),
    hand: state.hands[viewerId] || [],
    turnName: current?.name || "",
    table: state.table ? { cards: state.table.cards, playerName: state.players.find((p) => p.id === state.table.playerId)?.name || "?" } : null,
    passes: state.passes,
    revolution: state.revolution,
    back: state.back,
    pendingEightCut: state.pendingEightCut ? { fourCount: state.pendingEightCut.fourCount } : null,
    events: (state.events || []).slice(-8).map((event) => ({
      id: event.id,
      type: event.type,
      playerName: event.playerName || state.players.find((player) => player.id === event.playerId)?.name || "?",
      relatedPlayerName: event.relatedPlayerName || (event.relatedPlayerId ? (state.players.find((player) => player.id === event.relatedPlayerId)?.name || "?") : null),
      isYou: event.playerId === viewerId,
      cards: event.cards || [],
      at: event.at,
    })),
    rules: state.rules,
    finishOrder: state.finishOrder.map((id) => ({ name: state.players.find((p) => p.id === id)?.name || "?", isYou: id === viewerId })),
    createdAt: state.createdAt,
  };
}

async function getRoom(db, code) {
  return db.prepare("SELECT state, version, updated_at FROM rooms WHERE code = ?")
    .bind(code).first();
}

let schemaSetup;
async function ensureSchema(db) {
  if (!schemaSetup) schemaSetup = (async () => {
    await db.prepare("CREATE TABLE IF NOT EXISTS rooms (code TEXT PRIMARY KEY, state TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL)").run();
    await db.prepare("CREATE INDEX IF NOT EXISTS rooms_updated_at_idx ON rooms(updated_at)").run();
  })();
  try { await schemaSetup; }
  catch (error) { schemaSetup = null; throw error; }
}

async function saveRoom(db, code, row, state) {
  const result = await db.prepare("UPDATE rooms SET state = ?, version = version + 1, updated_at = ? WHERE code = ? AND version = ?")
    .bind(JSON.stringify(state), Date.now(), code, row.version).run();
  return result.meta?.changes === 1;
}

async function createRoom(db, body) {
  const id = crypto.randomUUID();
  const name = String(body.name || "").trim().slice(0, 16);
  if (!name) return json({ error: "名前を入力してください。" }, 400);
  await db.prepare("DELETE FROM rooms WHERE updated_at < ?").bind(Date.now() - MAX_AGE).run();
  for (let attempt = 0; attempt < 4; attempt++) {
    const code = Array.from({ length: 5 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[Math.floor(Math.random() * 32)]).join("");
    const state = newState(id, name);
    try {
      await db.prepare("INSERT INTO rooms (code, state, version, updated_at) VALUES (?, ?, 1, ?)")
        .bind(code, JSON.stringify(state), Date.now()).run();
      return json({ code, playerId: id });
    } catch (error) {
      if (!String(error).toLowerCase().includes("unique")) throw error;
    }
  }
  return json({ error: "部屋を作れませんでした。もう一度お試しください。" }, 500);
}

async function joinRoom(db, body) {
  const code = String(body.code || "").trim().toUpperCase();
  const id = String(body.playerId || "").slice(0, 64);
  const name = String(body.name || "").trim().slice(0, 16);
  if (!/^[A-HJ-NP-Z2-9]{5}$/.test(code) || !id || !name) return json({ error: "部屋コードと名前を確認してください。" }, 400);
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await getRoom(db, code);
    if (!row || Date.now() - row.updated_at > MAX_AGE) return json({ error: "部屋が見つかりません。コードを確認してください。" }, 404);
    const state = JSON.parse(row.state);
    if (state.players.some((p) => p.id === id)) return json({ code, playerId: id });
    if (state.phase !== "lobby") return json({ error: "このゲームはすでに始まっています。" }, 409);
    if (state.players.length >= MAX_PLAYERS) return json({ error: `この部屋は満員です（最大${MAX_PLAYERS}人）。` }, 409);
    state.players.push({ id, name });
    if (await saveRoom(db, code, row, state)) return json({ code, playerId: id });
  }
  return json({ error: "参加が重なりました。もう一度お試しください。" }, 409);
}

async function leaveRoom(db, body) {
  const code = String(body.code || "").trim().toUpperCase();
  const id = String(body.playerId || "");
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await getRoom(db, code);
    if (!row) return json({ ok: true, removed: false });
    const state = JSON.parse(row.state);
    const index = state.players.findIndex((player) => player.id === id);
    if (index < 0) return json({ ok: true, removed: false });
    const leavingName = state.players[index].name;
    const currentPlayerId = state.players[state.turn]?.id;
    const wasLeader = state.lastPlayer === id || state.pendingEightCut?.playerId === id;
    recordEvent(state, "leave", id);
    state.players.splice(index, 1);
    delete state.hands[id];
    state.finishOrder = (state.finishOrder || []).filter((playerId) => playerId !== id);
    state.passedPlayers = (state.passedPlayers || []).filter((playerId) => playerId !== id);
    state.passes = state.passedPlayers.length;
    if (state.hostId === id) state.hostId = state.players[0]?.id || null;
    if (!state.players.length) {
      await db.prepare("DELETE FROM rooms WHERE code = ?").bind(code).run();
      return json({ ok: true, removed: true });
    }
    if (state.phase === "playing") {
      const activePlayers = state.players.filter((player) => (state.hands[player.id] || []).length > 0);
      if (activePlayers.length <= 1) {
        finishEmptyHands(state, activePlayers[0]?.id || state.players[0].id);
      } else if (state.table && !wasLeader && state.passes >= activePlayers.length - 1) {
        const leaderId = state.lastPlayer;
        const playedCards = state.table.cards;
        clearTrick(state, leaderId);
        recordEvent(state, "trick_cleared", leaderId, playedCards);
      } else if (wasLeader) {
        state.table = null;
        state.pendingEightCut = null;
        state.lastPlayer = null;
        state.passes = 0;
        state.passedPlayers = [];
        const nextIndex = Math.min(index, state.players.length - 1);
        state.turn = nextActive(state, nextIndex - 1, false);
      } else if (currentPlayerId === id) {
        state.turn = nextActive(state, index - 1, false);
      } else {
        const currentIndex = state.players.findIndex((player) => player.id === currentPlayerId);
        state.turn = currentIndex >= 0 ? currentIndex : nextActive(state, index - 1, false);
      }
    } else if (currentPlayerId && currentPlayerId !== id) {
      state.turn = Math.max(0, state.players.findIndex((player) => player.id === currentPlayerId));
    } else {
      state.turn = 0;
    }
    if (await saveRoom(db, code, row, state)) return json({ ok: true, removed: true, playerName: leavingName });
  }
  return json({ error: "退出処理が重なりました。もう一度お試しください。" }, 409);
}

async function updateRules(db, body) {
  const code = String(body.code || "").trim().toUpperCase();
  const id = String(body.playerId || "");
  const requested = body.rules && typeof body.rules === "object" ? body.rules : {};
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await getRoom(db, code);
    if (!row) return json({ error: "部屋が見つかりません。" }, 404);
    const state = JSON.parse(row.state);
    if (state.hostId !== id) return json({ error: "ルールを変更できるのは部屋主だけです。" }, 403);
    if (state.phase !== "lobby") return json({ error: "ゲーム開始後はルールを変更できません。" }, 409);
    state.rules = Object.fromEntries(Object.keys(DEFAULT_RULES).map((key) => [key, key in requested ? requested[key] === true : (state.rules || DEFAULT_RULES)[key] === true]));
    if (body.deckCount !== undefined) state.deckCount = Number(body.deckCount) === 2 ? 2 : 1;
    if (await saveRoom(db, code, row, state)) return json({ ok: true });
  }
  return json({ error: "ルール変更が重なりました。もう一度お試しください。" }, 409);
}

async function startGame(db, body) {
  const code = String(body.code || "").trim().toUpperCase();
  const id = String(body.playerId || "");
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await getRoom(db, code);
    if (!row) return json({ error: "部屋が見つかりません。" }, 404);
    const state = JSON.parse(row.state);
    if (state.hostId !== id) return json({ error: "ゲームを始められるのは部屋主だけです。" }, 403);
    if (state.phase !== "lobby") return json({ error: "ゲームはすでに始まっています。" }, 409);
    if (state.players.length < 3) return json({ error: "ゲーム開始には3人以上必要です。" }, 400);
    state.deckCount = Number(body.deckCount ?? state.deckCount) === 2 ? 2 : 1;
    const deck = shuffledDeck(state.deckCount);
    const requested = body.rules && typeof body.rules === "object" ? body.rules : (state.rules || DEFAULT_RULES);
    state.rules = Object.fromEntries(Object.keys(DEFAULT_RULES).map((key) => [key, key in requested ? requested[key] === true : DEFAULT_RULES[key]]));
    const hands = Object.fromEntries(state.players.map((p) => [p.id, []]));
    deck.forEach((item, index) => hands[state.players[index % state.players.length].id].push(item));
    Object.values(hands).forEach((hand) => hand.sort(cardOrder));
    state.hands = hands;
    state.passedPlayers = [];
    state.openingMove = true;
    state.turn = state.players.findIndex((p) => hands[p.id].some((item) => item.rank === "3" && item.suit === "clubs"));
    state.phase = "playing";
    if (await saveRoom(db, code, row, state)) return json({ ok: true });
  }
  return json({ error: "開始操作が重なりました。もう一度お試しください。" }, 409);
}

async function rematch(db, body) {
  const code = String(body.code || "").trim().toUpperCase();
  const id = String(body.playerId || "");
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await getRoom(db, code);
    if (!row) return json({ error: "部屋が見つかりません。" }, 404);
    const state = JSON.parse(row.state);
    if (state.hostId !== id) return json({ error: "次のゲームを準備できるのは部屋主だけです。" }, 403);
    if (state.phase !== "finished") return json({ error: "ゲーム終了後に次のゲームを準備できます。" }, 409);
    state.phase = "lobby";
    state.hands = Object.fromEntries(state.players.map((player) => [player.id, []]));
    state.turn = 0;
    state.table = null;
    state.passes = 0;
    state.lastPlayer = null;
    state.revolution = false;
    state.back = false;
    state.pendingEightCut = null;
    state.passedPlayers = [];
    state.finishOrder = [];
    state.events = [];
    state.openingMove = true;
    if (await saveRoom(db, code, row, state)) return json({ ok: true });
  }
  return json({ error: "準備画面への移動が重なりました。再読み込みしてください。" }, 409);
}

function effectiveRank(cards) {
  return cards.find((item) => item.rank !== "JOKER")?.rank || "JOKER";
}

function validSet(cards) {
  if (!Array.isArray(cards) || cards.length < 1 || cards.length > 4) return false;
  const rank = effectiveRank(cards);
  if (rank === "JOKER") return cards.length === 1;
  return cards.every((item) => item.rank === "JOKER" || item.rank === rank);
}

function beats(cards, table, reversed, rules) {
  if (!validSet(cards)) return false;
  if (!table) return true;
  if (cards.length !== table.cards.length) return false;
  const topJoker = table.cards.length === 1 && table.cards[0].rank === "JOKER";
  const pickedSpade3 = cards.length === 1 && cards[0].rank === "3" && cards[0].suit === "spades";
  if (topJoker) return rules.spade3 && pickedSpade3;
  if (pickedSpade3 && table.cards.length === 1 && table.cards[0].rank === "3" && table.cards[0].suit === "spades") return false;
  const strength = (group) => RANK_VALUE[effectiveRank(group)] * 4 + Math.max(0, ...group.filter((item) => item.rank !== "JOKER").map((item) => SUIT_VALUE[item.suit] ?? 0));
  const candidate = strength(cards), previous = strength(table.cards);
  return reversed ? candidate < previous : candidate > previous;
}

function clearTrick(state, leaderId) {
  state.table = null;
  state.pendingEightCut = null;
  state.passes = 0;
  state.passedPlayers = [];
  state.back = false;
  const leaderIndex = state.players.findIndex((p) => p.id === leaderId);
  state.turn = nextActive(state, leaderIndex < 0 ? state.turn : leaderIndex, true);
}

function recordEvent(state, type, playerId, cards = [], relatedPlayerId = null) {
  const playerName = state.players.find((player) => player.id === playerId)?.name || "?";
  const relatedPlayerName = relatedPlayerId ? (state.players.find((player) => player.id === relatedPlayerId)?.name || "?") : null;
  state.events = [...(state.events || []), {
    id: crypto.randomUUID(), type, playerId, playerName, relatedPlayerId, relatedPlayerName, cards, at: Date.now(),
  }].slice(-8);
}

function finishEmptyHands(state, firstPlayerId) {
  const first = state.players.findIndex((p) => p.id === firstPlayerId);
  for (let step = 0; step < state.players.length; step++) {
    const player = state.players[(Math.max(0, first) + step) % state.players.length];
    if ((state.hands[player.id] || []).length === 0 && !state.finishOrder.includes(player.id)) state.finishOrder.push(player.id);
  }
  const remaining = state.players.filter((p) => (state.hands[p.id] || []).length > 0);
  if (remaining.length <= 1) {
    if (remaining.length === 1 && !state.finishOrder.includes(remaining[0].id)) state.finishOrder.push(remaining[0].id);
    state.phase = "finished";
    state.pendingEightCut = null;
  }
}

async function act(db, body) {
  const code = String(body.code || "").trim().toUpperCase();
  const id = String(body.playerId || "");
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await getRoom(db, code);
    if (!row) return json({ error: "部屋が見つかりません。" }, 404);
    const state = JSON.parse(row.state);
    if (state.phase !== "playing") return json({ error: "ゲーム中ではありません。" }, 409);
    if (state.players[state.turn]?.id !== id) return json({ error: "あなたの番ではありません。" }, 409);
    const hand = state.hands[id] || [];
    const action = body.action;
    const rules = { ...DEFAULT_RULES, ...(state.rules || {}) };
    if (state.pendingEightCut && action === "stop8") {
      const requiredFours = state.pendingEightCut.fourCount;
      const fours = hand.filter((item) => item.rank === "4" || item.rank === "JOKER");
      if (fours.length < requiredFours) return json({ error: `4を${requiredFours}枚持っていないため、4止めできません。` }, 400);
      const picked = fours.slice(0, requiredFours);
      const eightPlayerId = state.pendingEightCut.playerId;
      state.hands[id] = hand.filter((item) => !picked.some((four) => four.id === item.id));
      state.lastPlayer = id;
      state.table = null;
      state.pendingEightCut = null;
      state.passes = 0;
      state.back = false;
      finishEmptyHands(state, id);
      if (state.phase !== "finished") state.turn = state.players.findIndex((p) => p.id === id);
      recordEvent(state, "eight_stopped", id, picked, eightPlayerId);
      if (await saveRoom(db, code, row, state)) return json({ ok: true });
      continue;
    }
    if (state.pendingEightCut && action === "pass") {
      const leaderId = state.pendingEightCut.playerId;
      const playedCards = state.table?.cards || [];
      clearTrick(state, leaderId);
      recordEvent(state, "eight_accepted", id, playedCards, leaderId);
      if (await saveRoom(db, code, row, state)) return json({ ok: true });
      continue;
    }
    if (action === "play") {
      const ids = Array.isArray(body.cards) ? [...new Set(body.cards.map(String))] : [];
      const picked = ids.map((cardId) => hand.find((item) => item.id === cardId));
      if (picked.some((item) => !item) || !beats(picked, state.table, state.revolution !== state.back, rules)) return json({ error: "そのカードでは出せません。枚数と強さを確認してください。" }, 400);
      const playRank = effectiveRank(picked);
      if (state.pendingEightCut) return json({ error: "8切りへの対応を選んでください。" }, 400);
      if (state.openingMove && hand.some((item) => item.rank === "3" && item.suit === "clubs") && !picked.some((item) => item.rank === "3" && item.suit === "clubs")) return json({ error: "最初の一手には♣3を含めてください。" }, 400);
      if (state.table?.cards.length === 1 && state.table.cards[0].rank === "8" && rules.fourStop) return json({ error: "8切りは4止めかパスで対応してください。" }, 400);
      if (state.table?.cards.length === 1 && state.table.cards[0].rank === "8" && rules.eightCut) return json({ error: "8切りは4止めかパスで対応してください。" }, 400);
      if (playRank === "8" && !rules.eightCut) return json({ error: "8切りはこの部屋で無効です。" }, 400);
      if (playRank === "9" && rules.nineCut) {
        // 9切り is an optional immediate trick clear.
      }
      if (state.table?.cards.length === 1 && state.table.cards[0].rank === "JOKER" && rules.spade3 && !(picked.length === 1 && picked[0].rank === "3" && picked[0].suit === "spades")) return json({ error: "ジョーカーには♠3で返してください。" }, 400);
      const discardIds = Array.isArray(body.discard) ? [...new Set(body.discard.map(String))] : [];
      const tenLimit = rules.tenDiscard && playRank === "10" ? picked.length : 0;
      if (discardIds.length > tenLimit || discardIds.some((discardId) => !hand.some((item) => item.id === discardId) || ids.includes(discardId))) return json({ error: "10捨ての枚数を確認してください。" }, 400);
      const bombRanks = Array.isArray(body.bombRanks) ? [...new Set(body.bombRanks.map(String))] : [];
      const bombLimit = rules.qBomber && playRank === "Q" ? picked.length : 0;
      if (bombRanks.length > bombLimit || bombRanks.some((rank) => !RANKS.includes(rank) && rank !== "JOKER")) return json({ error: "Qボンバーの指定を確認してください。" }, 400);
      const spade3Return = rules.spade3 && state.table?.cards.length === 1 && state.table.cards[0].rank === "JOKER" && picked.length === 1 && picked[0].rank === "3" && picked[0].suit === "spades";
      state.hands[id] = hand.filter((item) => !ids.includes(item.id));
      state.openingMove = false;
      state.hands[id] = state.hands[id].filter((item) => !discardIds.includes(item.id));
      state.table = { cards: picked, playerId: id };
      state.lastPlayer = id;
      state.passes = 0;
      state.passedPlayers = [];
      if (rules.revolution && picked.length === 4) state.revolution = !state.revolution;
      if (rules.elevenBack && playRank === "J") state.back = !state.back;
      if (rules.qBomber && bombRanks.length) {
        for (const player of state.players) state.hands[player.id] = (state.hands[player.id] || []).filter((item) => !bombRanks.includes(item.rank));
      }
      finishEmptyHands(state, id);
      const has8 = rules.eightCut && playRank === "8";
      const has9 = rules.nineCut && playRank === "9";
      const has66 = rules.rokurokubi && picked.length === 2 && playRank === "6";
      const has99 = rules.ambulance && picked.length === 2 && playRank === "9";
      if (state.phase !== "finished" && rules.fourStop && has8) {
        state.pendingEightCut = { playerId: id, fourCount: picked.length * 2 };
        state.turn = nextActive(state, state.players.findIndex((p) => p.id === id));
        recordEvent(state, "eight_pending", id, picked);
      } else if (state.phase !== "finished" && (has8 || has9 || has66 || has99 || spade3Return)) {
        clearTrick(state, id);
        recordEvent(state, has8 ? "eight_cut" : "special_clear", id, picked);
      } else if (state.phase !== "finished") {
        recordEvent(state, "play", id, picked);
        state.turn = nextActive(state, state.turn);
      } else {
        recordEvent(state, has8 ? "eight_cut" : "play", id, picked);
      }
    } else if (action === "pass") {
      if (!state.table) return json({ error: "場が流れています。最初のカードを出してください。" }, 400);
      state.passedPlayers = [...new Set([...(state.passedPlayers || []), id])];
      state.passes = state.passedPlayers.length;
      const activeCount = state.players.filter((p) => (state.hands[p.id] || []).length > 0).length;
      if (state.passes >= activeCount - 1) {
        const leaderId = state.lastPlayer;
        const playedCards = state.table.cards;
        clearTrick(state, leaderId);
        recordEvent(state, "trick_cleared", leaderId, playedCards);
      } else {
        recordEvent(state, "pass", id);
        state.turn = nextActive(state, state.turn);
      }
    } else {
      return json({ error: "不明な操作です。" }, 400);
    }
    if (await saveRoom(db, code, row, state)) return json({ ok: true });
  }
  return json({ error: "操作が重なりました。画面が更新されてから再度お試しください。" }, 409);
}

async function route(request, env) {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/") {
    return new Response(APP_HTML, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  }
  if (!url.pathname.startsWith("/api/")) return new Response("Not found", { status: 404 });
  if (!env.DB) return json({ error: "対戦データベースを準備しています。数分後に再読み込みしてください。" }, 503);
  try {
    await ensureSchema(env.DB);
    if (request.method === "POST" && url.pathname === "/api/rooms") return await createRoom(env.DB, await request.json());
    if (request.method === "POST" && url.pathname === "/api/join") return await joinRoom(env.DB, await request.json());
    if (request.method === "POST" && url.pathname === "/api/leave") return await leaveRoom(env.DB, await request.json());
    if (request.method === "POST" && url.pathname === "/api/rules") return await updateRules(env.DB, await request.json());
    if (request.method === "POST" && url.pathname === "/api/start") return await startGame(env.DB, await request.json());
    if (request.method === "POST" && url.pathname === "/api/rematch") return await rematch(env.DB, await request.json());
    if (request.method === "POST" && url.pathname === "/api/action") return await act(env.DB, await request.json());
    if (request.method === "GET" && url.pathname === "/api/room") {
      const code = String(url.searchParams.get("code") || "").toUpperCase();
      const playerId = String(url.searchParams.get("playerId") || "");
      const row = await getRoom(env.DB, code);
      if (!row || Date.now() - row.updated_at > MAX_AGE) return json({ error: "部屋が見つかりません。" }, 404);
      const state = JSON.parse(row.state);
      if (!state.players.some((p) => p.id === playerId)) return json({ error: "この部屋の参加者ではありません。" }, 403);
      const spectatorMode = url.searchParams.get("spectate") === "1" && state.phase !== "lobby";
      return json(publicState(state, playerId, spectatorMode));
    }
    return json({ error: "Not found" }, 404);
  } catch (error) {
    return json({ error: "通信に失敗しました。接続を確認してください。" }, 500);
  }
}

const ALLOWED_WEB_ORIGINS = new Set([
  "https://takenokodomo.github.io",
  "https://daifugo-friends-2026.adoreddisc16.chatgpt.site",
]);

function corsHeaders(origin) {
  const headers = new Headers();
  if (ALLOWED_WEB_ORIGINS.has(origin)) {
    headers.set("access-control-allow-origin", origin);
    headers.set("access-control-allow-methods", "GET, POST, OPTIONS");
    headers.set("access-control-allow-headers", "content-type");
    headers.set("access-control-max-age", "86400");
    headers.set("vary", "Origin");
  }
  return headers;
}

function withCors(response, origin) {
  const headers = new Headers(response.headers);
  for (const [key, value] of corsHeaders(origin)) headers.set(key, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("origin") || "";
    if (request.method === "OPTIONS") {
      return ALLOWED_WEB_ORIGINS.has(origin)
        ? new Response(null, { status: 204, headers: corsHeaders(origin) })
        : new Response(null, { status: 403 });
    }
    try { return withCors(await route(request, env), origin); }
    catch { return withCors(json({ error: "サーバーでエラーが発生しました。" }, 500), origin); }
  },
};

