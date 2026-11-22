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
  state.events = [];
  state.rules = { ...state.rules, revolution: false, fourStop: false, ...rules };
  db.rooms.set(code, { ...row, state: JSON.stringify(state), updated_at: Date.now() });
}

const a = players[0].id, b = players[1].id, c = players[2].id;
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
const openTable = { hand, table: null, rules: { eightCut: true }, revolution: false, back: false };
selection.setSelected(["5-clubs"]);
assert.equal(selection.canSelectCard(hand[1], openTable), true, "同じ数字のカードは同時に選べる");
assert.equal(selection.canSelectCard(hand[2], openTable), false, "別の数字は同時に選べない");
assert.equal(selection.canSelectCard(hand[4], openTable), true, "ジョーカーは同じ数字の代わりに選べる");
const pairTable = { ...openTable, table: { cards: [card("5", "clubs"), card("5", "spades")] } };
selection.setSelected(["6-spades"]);
assert.equal(selection.canSelectCard(hand[2], pairTable), true, "場がペアなら強い同数字のペアを組める");
assert.equal(selection.canSelectCard(hand[3], pairTable), false, "ペアを出す場面で別の数字は選べない");
const openingHand = [card("3", "clubs"), card("5", "clubs"), card("5", "hearts")];
selection.setSelected([]);
assert.equal(selection.canSelectCard(openingHand[0], { ...openTable, hand: openingHand }), true, "最初の一手に♣3を選べる");
assert.equal(selection.canSelectCard(openingHand[1], { ...openTable, hand: openingHand }), false, "最初の一手では♣3なしの組を選べない");

const renderStart = script.indexOf("function cardEl(");
const renderEnd = script.indexOf("async function sendPlay(", renderStart);
const renderers = new Function(`const symbol={clubs:"♣",diamonds:"♦",hearts:"♥",spades:"♠"};const esc=s=>String(s);let selected=new Set();${script.slice(renderStart, renderEnd)};return {opponentHand,recentEventMarkup}`)();
const opponentMarkup = renderers.opponentHand({ cards: 4 });
assert.equal((opponentMarkup.match(/opponentCardBack/g) || []).length, 4, "相手の手札枚数を裏向きカードで示す");
assert.match(opponentMarkup, /4枚/);
const eventMarkup = renderers.recentEventMarkup({ events: [{ id: "test", type: "eight_cut", playerName: "A", cards: [card("8", "clubs")], at: Date.now() }] });
assert.match(eventMarkup, /8切り！ A が場を流しました/);
assert.match(eventMarkup, /eventCards/);
assert.match(script, /window\.addEventListener\("pagehide",signalLeave\)/, "ページを離れたとき退出APIを送る");
assert.match(script, /nameInput\.addEventListener\("input",\(\)=>\{if\(!invite\|\|inviteJoinBusy\)return;clearTimeout\(inviteJoinTimer\);if\(nameInput\.value\.trim\(\)\)inviteJoinTimer=setTimeout\(joinInvite,700\)\}\)/, "招待リンクは名前入力後に自動参加する");
console.log("Game regression checks passed: pass skipping, player leave, invites, 8切り, 4止め, and hand selection.");
