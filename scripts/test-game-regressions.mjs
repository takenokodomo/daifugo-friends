import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workerText = readFileSync(new URL("../dist/server/index.js", import.meta.url), "utf8");
const worker = await import(`data:text/javascript;base64,${Buffer.from(workerText).toString("base64")}`);

class MemoryDB {
  rooms = new Map();

  prepare(sql) {
    const db = this;
    return {
      values: [],
      bind(...values) { this.values = values; return this; },
      async first() {
        if (sql.includes("SELECT state, version, updated_at FROM rooms")) {
          const row = db.rooms.get(this.values[0]);
          return row ? { ...row } : null;
        }
        return null;
      },
      async run() {
        const values = this.values;
        if (sql.includes("INSERT INTO rooms")) {
          const [code, state, version, updated_at] = values;
          if (db.rooms.has(code)) throw new Error("unique constraint");
          db.rooms.set(code, { state, version, updated_at });
          return { meta: { changes: 1 } };
        }
        if (sql.includes("UPDATE rooms SET state")) {
          const [state, updated_at, code, expectedVersion] = values;
          const row = db.rooms.get(code);
          if (!row || row.version !== expectedVersion) return { meta: { changes: 0 } };
          db.rooms.set(code, { state, updated_at, version: row.version + 1 });
          return { meta: { changes: 1 } };
        }
        if (sql.includes("DELETE FROM rooms")) {
          if (sql.includes("WHERE code = ?")) {
            const existed = db.rooms.delete(values[0]);
            return { meta: { changes: existed ? 1 : 0 } };
          }
          for (const [code, row] of db.rooms) if (row.updated_at < values[0]) db.rooms.delete(code);
        }
        return { meta: { changes: 0 } };
      },
    };
  }
}

const db = new MemoryDB();
async function call(path, body) {
  const response = await worker.default.fetch(new Request(`https://daifugo.test${path}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  }), { DB: db });
  return { status: response.status, data: await response.json() };
}

const created = await call("/api/rooms", { name: "A" });
assert.equal(created.status, 200);
const code = created.data.code;
const players = [{ id: created.data.playerId, name: "A" }];
for (const [id, name] of [["player-b", "B"], ["player-c", "C"]]) {
  const joined = await call("/api/join", { code, playerId: id, name });
  assert.equal(joined.status, 200);
  players.push({ id, name });
}
assert.equal((await call("/api/start", { code, playerId: players[0].id })).status, 200);

function card(rank, suit) { return { id: `${rank}-${suit}`, rank, suit }; }
function setState({ hands, rules }) {
  const row = db.rooms.get(code);
  const state = JSON.parse(row.state);
  state.phase = "playing";
  state.hands = hands;
  state.turn = 0;
  state.table = null;
  state.passes = 0;
  state.lastPlayer = null;
  state.pendingEightCut = null;
  state.passedPlayers = [];
  state.currentPasses = [];
  state.openingMove = false;
  state.events = [];
  state.rules = { ...state.rules, revolution: false, fourStop: false, ...rules };
  db.rooms.set(code, { ...row, state: JSON.stringify(state), updated_at: Date.now() });
}

const a = players[0].id, b = players[1].id, c = players[2].id;
setState({
  hands: { [a]: [card("A", "clubs")], [b]: [card("A", "spades")], [c]: [card("K", "hearts")] },
  rules: { eightCut: true },
});
const tieRow = db.rooms.get(code), tieState = JSON.parse(tieRow.state);
tieState.table = { cards: [card("A", "clubs")], playerId: a };
tieState.turn = 1; tieState.lastPlayer = a; tieState.openingMove = false;
db.rooms.set(code, { ...tieRow, state: JSON.stringify(tieState) });
assert.equal((await call("/api/action", { code, playerId: b, action: "play", cards: ["A-spades"] })).status, 400, "同じAはマークが違っても上に出せない");

setState({
  hands: { [a]: [card("8", "clubs"), card("6", "diamonds")], [b]: [card("4", "clubs"), card("5", "clubs")], [c]: [card("7", "diamonds")] },
  rules: { eightCut: true },
});
assert.equal((await call("/api/action", { code, playerId: a, action: "play", cards: ["8-clubs"] })).status, 200);
for (const player of players) {
  const view = await call(`/api/room?code=${code}&playerId=${player.id}`);
  assert.equal(view.data.table, null, "8切り後は場が流れる");
  const event = view.data.events.at(-1);
  assert.equal(event.type, "eight_cut");
  assert.equal(event.playerName, "A");
  assert.equal(event.cards[0].id, "8-clubs", "全員に出した8が共有される");
}

setState({
  hands: { [a]: [card("8", "clubs"), card("6", "diamonds")], [b]: [card("4", "clubs"), card("JOKER", "joker"), card("7", "hearts")], [c]: [card("7", "diamonds")] },
  rules: { eightCut: true, fourStop: true },
});
assert.equal((await call("/api/action", { code, playerId: a, action: "play", cards: ["8-clubs"] })).status, 200);
let view = await call(`/api/room?code=${code}&playerId=${b}`);
assert.equal(view.data.pendingEightCut.fourCount, 2);
assert.equal(view.data.events.at(-1).type, "eight_pending");
assert.equal((await call("/api/action", { code, playerId: b, action: "stop8" })).status, 200);
view = await call(`/api/room?code=${code}&playerId=${c}`);
assert.equal(view.data.events.at(-1).type, "eight_stopped");
assert.equal(view.data.events.at(-1).cards.length, 2);

setState({
  hands: { [a]: [card("8", "clubs"), card("6", "diamonds")], [b]: [card("5", "clubs"), card("7", "hearts")], [c]: [card("7", "diamonds")] },
  rules: { eightCut: true, fourStop: true },
});
await call("/api/action", { code, playerId: a, action: "play", cards: ["8-clubs"] });
assert.equal((await call("/api/action", { code, playerId: b, action: "pass" })).status, 200);
view = await call(`/api/room?code=${code}&playerId=${c}`);
assert.equal(view.data.events.at(-1).type, "eight_accepted");
assert.equal(view.data.events.at(-1).relatedPlayerName, "A");

setState({
  hands: { [a]: [card("6", "clubs"), card("7", "diamonds")], [b]: [card("5", "clubs"), card("8", "hearts")], [c]: [card("9", "diamonds"), card("J", "spades")] },
  rules: { eightCut: true },
});
await call("/api/action", { code, playerId: a, action: "play", cards: ["6-clubs"] });
assert.equal((await call("/api/action", { code, playerId: b, action: "pass" })).status, 200);
view = await call(`/api/room?code=${code}&playerId=${b}`);
assert.equal(view.data.players.find(p => p.isYou).hasPassed, true, "パスした状態が全員に共有される");
assert.equal(view.data.players.find(p => p.name === "C").isTurn, true, "パスした人を飛ばして次の人へ進む");
const skippedPlay = await call("/api/action", { code, playerId: b, action: "play", cards: ["8-hearts"] });
assert.equal(skippedPlay.status, 409, "パスした人は同じ場でカードを出せない");
assert.equal((await call("/api/action", { code, playerId: c, action: "pass" })).status, 200);
view = await call(`/api/room?code=${code}&playerId=${a}`);
assert.equal(view.data.table, null, "残りのプレイヤーがパスすると場が流れる");
assert.equal(view.data.players.find(p => p.name === "A").isTurn, true, "場が流れた後は最後に出した人へ戻る");

setState({
  hands: { [a]: [card("6", "clubs"), card("9", "diamonds")], [b]: [card("5", "clubs"), card("8", "hearts")], [c]: [card("7", "diamonds"), card("10", "diamonds")] },
  rules: { passSkip: true },
});
await call("/api/action", { code, playerId: a, action: "play", cards: ["6-clubs"] });
await call("/api/action", { code, playerId: b, action: "pass" });
await call("/api/action", { code, playerId: c, action: "play", cards: ["7-diamonds"] });
view = await call(`/api/room?code=${code}&playerId=${a}`);
assert.equal(view.data.players.find(p => p.name === "B").hasPassed, true, "パス後スキップ設定では、他の人が出してもパス状態を維持する");
assert.equal(view.data.players.find(p => p.name === "A").isTurn, true, "パス済みの人を場が流れるまで飛ばす");
assert.equal((await call("/api/action", { code, playerId: b, action: "play", cards: ["8-hearts"] })).status, 409, "パス済みプレイヤーは場が流れるまで出せない");

setState({
  hands: { [a]: [card("6", "clubs"), card("9", "diamonds")], [b]: [card("5", "clubs"), card("8", "hearts")], [c]: [card("7", "diamonds"), card("10", "diamonds")] },
  rules: { passSkip: false },
});
await call("/api/action", { code, playerId: a, action: "play", cards: ["6-clubs"] });
await call("/api/action", { code, playerId: b, action: "pass" });
await call("/api/action", { code, playerId: c, action: "play", cards: ["7-diamonds"] });
await call("/api/action", { code, playerId: a, action: "pass" });
assert.equal((await call("/api/action", { code, playerId: b, action: "play", cards: ["8-hearts"] })).status, 200, "スキップ無効なら一度パスした人も再参加できる");

setState({
  hands: { [a]: [card("6", "clubs"), card("7", "diamonds")], [b]: [card("5", "clubs"), card("8", "hearts")], [c]: [card("9", "diamonds"), card("J", "spades")] },
  rules: { eightCut: true },
});
await call("/api/action", { code, playerId: a, action: "play", cards: ["6-clubs"] });
assert.equal((await call("/api/leave", { code, playerId: b })).status, 200);
view = await call(`/api/room?code=${code}&playerId=${c}`);
assert.equal(view.data.players.some(p => p.name === "B"), false, "退出した参加者を部屋から削除する");
assert.equal(view.data.players.find(p => p.name === "C").isTurn, true, "手番中の退出後は次の参加者へ進む");
await call("/api/leave", { code, playerId: a });
await call("/api/leave", { code, playerId: c });
assert.equal(db.rooms.has(code), false, "最後の参加者が退出すると空の部屋を削除する");

const largeRoom = await call("/api/rooms", { name: "Host" });
const largeCode = largeRoom.data.code;
const largePlayers = [{ id: largeRoom.data.playerId, name: "Host" }];
for (let index = 1; index < 12; index++) {
  const joined = await call("/api/join", { code: largeCode, playerId: `large-${index}`, name: `P${index}` });
  assert.equal(joined.status, 200, `12人部屋の${index + 1}人目が参加できる`);
  largePlayers.push({ id: joined.data.playerId, name: `P${index}` });
}
assert.equal((await call("/api/join", { code: largeCode, playerId: "large-13", name: "TooMany" })).status, 409, "13人目は参加できない");
assert.equal((await call("/api/rules", { code: largeCode, playerId: largePlayers[0].id, deckCount: 2 })).status, 200);
assert.equal((await call("/api/start", { code: largeCode, playerId: largePlayers[0].id, deckCount: 2 })).status, 200);
const lateSpectator = await call("/api/join", { code: largeCode, playerId: "late-observer", name: "Observer" });
assert.equal(lateSpectator.status, 200, "ゲーム開始後も招待リンクから観戦参加できる");
assert.equal(lateSpectator.data.spectator, true);
assert.equal(JSON.parse(db.rooms.get(largeCode).state).players.length, 12, "観戦者は手番のある参加者に数えない");
const spectatorJoinView = await call(`/api/room?code=${largeCode}&playerId=late-observer`);
assert.equal(spectatorJoinView.data.isSpectator, true);
assert.equal(spectatorJoinView.data.spectatorMode, true);
assert.equal(spectatorJoinView.data.players.reduce((sum, player) => sum + player.hand.length, 0), 106);
assert.equal((await call("/api/leave", { code: largeCode, playerId: "late-observer" })).data.removed, true, "観戦者の退出を記録から削除する");
const privateView = await call(`/api/room?code=${largeCode}&playerId=${largePlayers[0].id}`);
assert.equal(privateView.data.spectatorMode, false);
assert.equal(privateView.data.players[1].hand, undefined, "通常画面では他プレイヤーのカードを公開しない");
const activePeek = await call(`/api/room?code=${largeCode}&playerId=${largePlayers[0].id}&spectate=1`);
assert.equal(activePeek.data.spectatorMode, false, "上がる前のプレイヤーは観戦APIで手札を見られない");
assert.equal(activePeek.data.players[1].hand, undefined);
let spectatorView = await call(`/api/room?code=${largeCode}&playerId=${largePlayers[0].id}&spectate=1`);
assert.equal(spectatorView.data.spectatorMode, false, "現役プレイヤーは観戦モードへ移動できない");
assert.equal(spectatorView.data.players[1].hand, undefined);
const finishedPlayerState = JSON.parse(db.rooms.get(largeCode).state);
finishedPlayerState.finishOrder = [largePlayers[0].id];
db.rooms.set(largeCode, { ...db.rooms.get(largeCode), state: JSON.stringify(finishedPlayerState) });
const finishedPlayerView = await call(`/api/room?code=${largeCode}&playerId=${largePlayers[0].id}&spectate=1`);
assert.equal(finishedPlayerView.data.spectatorMode, true, "上がったプレイヤーは観戦モードへ移動できる");
spectatorView = finishedPlayerView;
assert.equal(spectatorView.data.deckCount, 2);
assert.equal(spectatorView.data.players.length, 12);
assert.equal(spectatorView.data.players.reduce((sum, player) => sum + player.hand.length, 0), 106, "2デッキ分の全手札を観戦画面へ返す");
assert.equal(new Set(spectatorView.data.players.flatMap(player => player.hand.map(item => item.id))).size, 106, "2デッキのカードIDが重複しない");
const largeRow = db.rooms.get(largeCode), largeState = JSON.parse(largeRow.state);
largeState.hands = Object.fromEntries(largePlayers.map((player, index) => [player.id, index === 0 ? [card("5", "clubs"), card("5", "hearts"), card("9", "diamonds")] : index < 4 ? [card(String(5 + index), "clubs")] : []]));
largeState.turn = 0; largeState.table = null; largeState.lastPlayer = null; largeState.passes = 0; largeState.passedPlayers = []; largeState.currentPasses = []; largeState.openingMove = false; largeState.finishOrder = []; largeState.events = []; largeState.rules = { ...largeState.rules, fiveSkip: true, sevenGive: false, passSkip: false };
db.rooms.set(largeCode, { ...largeRow, state: JSON.stringify(largeState) });
assert.equal((await call("/api/action", { code: largeCode, playerId: largePlayers[0].id, action: "play", cards: ["5-clubs", "5-hearts"] })).status, 200, "ペアの5でスキップできる");
const fiveSkipView = await call(`/api/room?code=${largeCode}&playerId=${largePlayers[3].id}`);
assert.equal(fiveSkipView.data.players.find(p => p.name === "P1").isTurn, false, "5スキップでは最初の相手を飛ばす");
assert.equal(fiveSkipView.data.players.find(p => p.name === "P2").isTurn, false, "5を2枚出すと次の2人を飛ばす");
assert.equal(fiveSkipView.data.players.find(p => p.name === "P3").isTurn, true, "5を2枚出した次の相手が手番になる");
assert.equal(fiveSkipView.data.events.at(-1).skippedPlayerNames.join(","), "P1,P2");

const giveRow = db.rooms.get(largeCode), giveState = JSON.parse(giveRow.state);
giveState.hands = Object.fromEntries(largePlayers.map((player, index) => [player.id, index === 0 ? [card("7", "clubs"), card("6", "diamonds"), card("9", "hearts")] : index < 4 ? [card(String(3 + index), "clubs")] : []]));
giveState.turn = 0; giveState.table = null; giveState.lastPlayer = null; giveState.passes = 0; giveState.passedPlayers = []; giveState.currentPasses = []; giveState.openingMove = false; giveState.finishOrder = []; giveState.events = []; giveState.rules = { ...giveState.rules, fiveSkip: false, sevenGive: true, passSkip: false };
db.rooms.set(largeCode, { ...giveRow, state: JSON.stringify(giveState) });
assert.equal((await call("/api/action", { code: largeCode, playerId: largePlayers[0].id, action: "play", cards: ["7-clubs"], give: ["6-diamonds"] })).status, 200, "7を出して手札を次の人へ渡せる");
const giveView = await call(`/api/room?code=${largeCode}&playerId=${largePlayers[2].id}`);
assert.equal(giveView.data.players.find(p => p.name === "Host").cards, 1, "渡したカードを出した人の手札から除く");
assert.equal(giveView.data.players.find(p => p.name === "P1").cards, 2, "渡したカードを次の人の手札へ加える");
assert.equal(giveView.data.events.at(-1).type, "seven_give");
assert.equal(giveView.data.events.at(-1).relatedPlayerName, "P1");
assert.equal(giveView.data.events.at(-1).givenCount, 1);
const illegalGiveRow = db.rooms.get(largeCode), illegalGiveState = JSON.parse(illegalGiveRow.state);
illegalGiveState.turn = 0; illegalGiveState.table = null; illegalGiveState.lastPlayer = null;
db.rooms.set(largeCode, { ...illegalGiveRow, state: JSON.stringify(illegalGiveState) });
assert.equal((await call("/api/action", { code: largeCode, playerId: largePlayers[0].id, action: "play", cards: ["9-hearts"], give: ["6-diamonds"] })).status, 400, "7以外では7渡しできない");

const openingRow = db.rooms.get(largeCode), openingState = JSON.parse(openingRow.state);
Object.assign(largeState, openingState);
largeState.hands = Object.fromEntries(largePlayers.map((player, index) => [player.id, index ? [card("6", "hearts")] : [card("3", "clubs"), { ...card("3", "clubs"), id: "3-clubs-2" }, card("5", "clubs")]]));
largeState.turn = 0; largeState.table = null; largeState.lastPlayer = null; largeState.passes = 0; largeState.passedPlayers = []; largeState.currentPasses = []; largeState.openingMove = true; largeState.finishOrder = []; largeState.events = []; largeState.rules.eightCut = false;
db.rooms.set(largeCode, { ...openingRow, state: JSON.stringify(largeState) });
assert.equal((await call("/api/action", { code: largeCode, playerId: largePlayers[0].id, action: "play", cards: ["3-clubs"] })).status, 200, "最初の手に複数組の♣3を出せる");
for (const player of largePlayers.slice(1)) assert.equal((await call("/api/action", { code: largeCode, playerId: player.id, action: "pass" })).status, 200);
assert.equal((await call(`/api/room?code=${largeCode}&playerId=${largePlayers[0].id}`)).data.openingMove, false, "最初の一手の制限は初回だけ");
assert.equal((await call("/api/action", { code: largeCode, playerId: largePlayers[0].id, action: "play", cards: ["5-clubs"] })).status, 200, "2枚目の♣3を残していても次の場を始められる");
const rematchRow = db.rooms.get(largeCode), rematchState = JSON.parse(rematchRow.state);
rematchState.phase = "finished";
rematchState.finishOrder = largePlayers.map(player => player.id);
db.rooms.set(largeCode, { ...rematchRow, state: JSON.stringify(rematchState) });
assert.equal((await call("/api/rematch", { code: largeCode, playerId: largePlayers[1].id })).status, 403, "次ゲームの準備は部屋主だけができる");
assert.equal((await call("/api/rematch", { code: largeCode, playerId: largePlayers[0].id })).status, 200);
const lobbyAgain = await call(`/api/room?code=${largeCode}&playerId=${largePlayers[0].id}`);
assert.equal(lobbyAgain.data.phase, "lobby", "次ゲームの準備画面へ戻る");
assert.equal(lobbyAgain.data.players.length, 12, "再準備後も参加者を維持する");
assert.equal(lobbyAgain.data.finishOrder.length, 0, "再準備時に順位をリセットする");

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
assert.ok(script, "browser script exists");
new Function(script);
const enterStart = script.indexOf("function handleNameEnter(e){");
const enterEnd = script.indexOf("nameInput.addEventListener", enterStart);
const makeEnterHandler = new Function("invite", "$", "joinInvite", `${script.slice(enterStart, enterEnd)};return handleNameEnter`);
const clicked = [];
const fakeDollar = selector => ({ click: () => clicked.push(selector) });
let inviteJoined = false;
makeEnterHandler("ABCDE", fakeDollar, () => { inviteJoined = true })({ key: "Enter" });
assert.equal(inviteJoined, true, "招待リンクではEnterで自動参加する");
makeEnterHandler(null, fakeDollar, () => {})({ key: "Enter" });
assert.equal(clicked.pop(), "#createBtn", "トップ画面では名前入力のEnterで部屋を作る");
const helpersStart = script.indexOf("function effectivePlayRank(");
const helpersEnd = script.indexOf("function opponentHand(", helpersStart);
const selection = new Function(`let selected=new Set();${script.slice(helpersStart, helpersEnd)};return {canSelectCard:(card,s)=>canSelectCard(card,s),setSelected:ids=>selected=new Set(ids)}`)();
const hand = [card("5", "clubs"), card("5", "hearts"), card("6", "spades"), card("4", "diamonds"), card("JOKER", "joker")];
const openTable = { hand, table: null, openingMove: true, rules: { eightCut: true }, revolution: false, back: false };
selection.setSelected(["5-clubs"]);
assert.equal(selection.canSelectCard(hand[1], openTable), true, "同じ数字のカードは同時に選べる");
assert.equal(selection.canSelectCard(hand[2], openTable), false, "別の数字は同時に選べない");
assert.equal(selection.canSelectCard(hand[4], openTable), true, "ジョーカーは同じ数字の代わりに選べる");
const pairTable = { ...openTable, table: { cards: [card("5", "clubs"), card("5", "spades")] } };
selection.setSelected(["6-spades"]);
assert.equal(selection.canSelectCard(hand[2], pairTable), true, "場がペアなら強い同数字のペアを組める");
assert.equal(selection.canSelectCard(hand[3], pairTable), false, "ペアを出す場面で別の数字は選べない");
selection.setSelected([]);
const aceHand = [card("A", "spades")];
assert.equal(selection.canSelectCard(aceHand[0], { ...openTable, hand: aceHand, openingMove: false, table: { cards: [card("A", "clubs")] } }), false, "画面上でも同じAを出せない");
const openingHand = [card("3", "clubs"), card("5", "clubs"), card("5", "hearts")];
selection.setSelected([]);
assert.equal(selection.canSelectCard(openingHand[0], { ...openTable, hand: openingHand }), true, "最初の一手に♣3を選べる");
assert.equal(selection.canSelectCard(openingHand[1], { ...openTable, hand: openingHand }), false, "最初の一手では♣3なしの組を選べない");

const renderStart = script.indexOf("function cardEl(");
const renderEnd = script.indexOf("async function sendPlay(", renderStart);
const renderers = new Function(`const symbol={clubs:"♣",diamonds:"♦",hearts:"♥",spades:"♠"};const esc=s=>String(s);let selected=new Set();${script.slice(renderStart, renderEnd)};return {opponentHand,visibleHandMarkup,recentEventMarkup}`)();
const opponentMarkup = renderers.opponentHand({ cards: 4 });
assert.equal((opponentMarkup.match(/opponentCardBack/g) || []).length, 4, "相手の手札枚数を裏向きカードで示す");
assert.match(opponentMarkup, /4枚/);
const visibleMarkup = renderers.opponentHand({ cards: 2, hand: [card("3", "clubs"), card("A", "hearts")] });
assert.match(visibleMarkup, /spectatorCards/);
assert.match(visibleMarkup, /JOKER|<b>3<\/b>/);
const eventMarkup = renderers.recentEventMarkup({ events: [{ id: "test", type: "eight_cut", playerName: "A", cards: [card("8", "clubs")], at: Date.now() }] });
assert.match(eventMarkup, /8切り！ A が場を流しました/);
assert.match(eventMarkup, /eventCards/);
assert.match(script, /window\.addEventListener\("pagehide",signalLeave\)/, "ページを離れたとき退出APIを送る");
assert.match(script, /nameInput\.addEventListener\("input",\(\)=>\{if\(!invite\|\|inviteJoinBusy\)return;clearTimeout\(inviteJoinTimer\);if\(nameInput\.value\.trim\(\)\)inviteJoinTimer=setTimeout\(joinInvite,700\)\}\)/, "招待リンクは名前入力後に自動参加する");
assert.match(script, /spectatorMode\?1:0/, "観戦切り替え状態をAPIへ送る");
assert.match(script, /観戦モード · 全員の手札を見る/, "ゲーム中に観戦モードへ切り替えられる");
assert.match(html, /\.myHand \.card\[data-group-start="false"\]/, "同じ数字のカードを重ねるスタイルを定義する");
assert.match(script, /c\.rank!==s\.hand\[i-1\]\.rank/, "手札を数字ごとにまとめて表示する");
assert.match(html, /@keyframes card-from-seat/, "カードをプレイヤー位置から出すアニメーションを定義する");
assert.match(script, /次のゲームを準備/, "終了後に同じ部屋で再準備できる");
console.log("Game regression checks passed: 12 players, two decks, spectator hands, rematch, pass skipping, invites, and card selection.");

