"use strict";
// Go Fish over manual-signaling WebRTC.
// The HOST runs the authoritative engine and deals; GUESTS send asks and
// render the state the host broadcasts. Host is also a player (id 0).
//
// Shared plumbing (networking, card rendering, deck, setup/lobby wiring)
// lives in ../shared/table.js. This file is Go Fish's engine + rendering.

// ============================================================
// GAME ENGINE (host only)
// ============================================================
const Engine = {
  players: {},      // id -> { id, name }
  order: [],        // ids in seat order
  hands: {},        // id -> [cards]
  books: {},        // id -> [ranks]
  pond: [],
  turn: null,
  phase: "lobby",   // lobby | playing | gameover
  winners: [],

  addPlayer(id, name) {
    if (this.players[id]) return;
    this.players[id] = { id, name };
    if (!this.order.includes(id)) this.order.push(id);
    this.hands[id] = this.hands[id] || [];
    this.books[id] = this.books[id] || [];
    broadcastLog(`${name} joined.`);
  },

  removePlayer(id) {
    const p = this.players[id];
    if (!p) return;
    broadcastLog(`${p.name} left.`);
    // return their cards to the pond so play can continue
    if (this.hands[id]) this.pond.push(...this.hands[id]);
    delete this.players[id];
    delete this.hands[id];
    delete this.books[id];
    this.order = this.order.filter((x) => x !== id);
    if (this.phase === "playing") {
      if (this.turn === id) { this.advanceTurn(); }
      else if (this.maybeGameOver()) { return; }
      else this.broadcast();
    }
  },

  startGame() {
    if (this.order.length < 2) { broadcastLog("Need at least 2 players."); return; }
    this.pond = makeDeck();
    this.winners = [];
    const initial = this.order.length <= 2 ? 7 : 5;
    for (const id of this.order) {
      this.hands[id] = this.pond.splice(0, initial);
      this.books[id] = [];
    }
    this.phase = "playing";
    for (const id of this.order) this.checkBooks(id);
    this.turn = this.order[0];
    broadcastLog("--- New game of Go Fish. ---", true);
    this.startPlayerTurn(this.turn);
  },

  drawOne(id) {
    const c = this.pond.pop();
    this.hands[id].push(c);
    return c;
  },

  checkBooks(id) {
    const counts = {};
    for (const c of this.hands[id]) counts[c.rank] = (counts[c.rank] || 0) + 1;
    for (const rank in counts) {
      if (counts[rank] === 4) {
        this.hands[id] = this.hands[id].filter((c) => c.rank !== +rank);
        this.books[id].push(+rank);
        broadcastLog(`${this.players[id].name} completed a book of ${rankLabel(+rank)}s!`, true);
      }
    }
  },

  totalBooks() {
    return this.order.reduce((s, id) => s + this.books[id].length, 0);
  },

  maybeGameOver() {
    if (this.totalBooks() >= 13 || this.order.length < 2) { this.gameOver(); return true; }
    return false;
  },

  handleAsk(pid, targetId, rank) {
    if (this.phase !== "playing" || pid !== this.turn) return;
    rank = +rank; targetId = +targetId;
    const hand = this.hands[pid];
    if (!hand || !hand.some((c) => c.rank === rank)) return; // must hold the rank
    const target = this.hands[targetId];
    if (!target || targetId === pid || target.length === 0) return;

    const askerName = this.players[pid].name;
    const targetName = this.players[targetId].name;
    const matches = target.filter((c) => c.rank === rank);

    if (matches.length > 0) {
      this.hands[targetId] = target.filter((c) => c.rank !== rank);
      for (const c of matches) hand.push(c);
      broadcastLog(`${askerName} asked ${targetName} for ${rankLabel(rank)}s and took ${matches.length}.`);
      this.checkBooks(pid);
      if (this.maybeGameOver()) return;
      this.startPlayerTurn(pid); // asker goes again
      return;
    }

    broadcastLog(`${askerName} asked ${targetName} for ${rankLabel(rank)}s — Go Fish!`);
    if (this.pond.length > 0) {
      const c = this.drawOne(pid);
      const lucky = c.rank === rank;
      broadcastLog(`${askerName} draws from the pond.`);
      this.checkBooks(pid);
      if (this.maybeGameOver()) return;
      if (lucky) {
        broadcastLog(`${askerName} fished the ${rankLabel(rank)} they wanted — goes again!`, true);
        this.startPlayerTurn(pid);
      } else {
        this.advanceTurn();
      }
    } else {
      broadcastLog("The pond is empty.");
      if (this.maybeGameOver()) return;
      this.advanceTurn();
    }
  },

  // Give `id` the turn, drawing a card if they're empty-handed. Ends the
  // game if the turn player can't do anything.
  startPlayerTurn(id) {
    if (this.hands[id].length === 0 && this.pond.length > 0) {
      this.drawOne(id);
      this.checkBooks(id);
      broadcastLog(`${this.players[id].name} had no cards and drew from the pond.`);
      if (this.maybeGameOver()) return;
    }
    this.turn = id;
    const canAsk = this.order.some((o) => o !== id && this.hands[o].length > 0);
    // Dead hand: no cards, or no one left to ask and the pond is empty.
    if (this.hands[id].length === 0 || (!canAsk && this.pond.length === 0)) {
      this.gameOver();
      return;
    }
    if (!canAsk) {
      // No opponent holds cards but the pond does: fish one and pass.
      this.drawOne(id);
      this.checkBooks(id);
      broadcastLog(`${this.players[id].name} has no one to ask and fishes from the pond.`);
      if (this.maybeGameOver()) return;
      this.advanceTurn();
      return;
    }
    this.broadcast();
  },

  advanceTurn() {
    const n = this.order.length;
    const start = this.order.indexOf(this.turn);
    for (let step = 1; step <= n; step++) {
      const id = this.order[(start + step) % n];
      if (this.hands[id].length > 0 || this.pond.length > 0) {
        this.startPlayerTurn(id);
        return;
      }
    }
    this.gameOver();
  },

  gameOver() {
    this.phase = "gameover";
    this.turn = null;
    let best = -1;
    for (const id of this.order) best = Math.max(best, this.books[id].length);
    this.winners = this.order.filter((id) => this.books[id].length === best && best > 0);
    const names = this.winners.map((id) => this.players[id].name).join(" & ");
    if (this.winners.length) {
      broadcastLog(`Game over! ${names} win${this.winners.length > 1 ? "" : "s"} with ${best} books.`, true);
    } else {
      broadcastLog("Game over!", true);
    }
    this.broadcast();
  },

  // ---- state projection & broadcast ----
  projectFor(viewerId) {
    const seats = this.order.map((id) => ({
      id,
      name: this.players[id].name,
      cardCount: this.hands[id] ? this.hands[id].length : 0,
      books: this.books[id] ? this.books[id].slice() : [],
      isTurn: this.turn === id,
    }));
    return {
      phase: this.phase,
      seats,
      pond: this.pond.length,
      hand: this.hands[viewerId] ? this.hands[viewerId].slice().sort((a, b) => a.rank - b.rank || a.suit - b.suit) : [],
      winners: this.winners.slice(),
      viewerId,
    };
  },

  broadcast() {
    for (const id of this.order) {
      if (id === 0) renderState(this.projectFor(0));
      else sendToPlayer(id, { t: "state", state: this.projectFor(id) });
    }
  },
};

// ============================================================
// RENDERING (host + guests share this)
// ============================================================
let lastState = null;
let selectedTarget = null;

function renderState(state) {
  lastState = state;
  show("table");
  const meId = Net.role === "host" ? 0 : Net.myId;

  const mySeat = state.seats.find((s) => s.id === meId) || null;
  const myTurn = mySeat && mySeat.isTurn && state.phase === "playing";

  // pick a valid default target
  const validTargets = state.seats.filter((s) => s.id !== meId && s.cardCount > 0);
  if (!validTargets.some((s) => s.id === selectedTarget)) {
    selectedTarget = validTargets.length ? validTargets[0].id : null;
  }

  // opponents
  const opp = $("opponents");
  opp.innerHTML = "";
  for (const s of state.seats) {
    if (s.id === meId) continue;
    opp.appendChild(seatEl(s, false, myTurn));
  }

  // me seat (cards render in the hand zone)
  $("me").innerHTML = "";
  if (mySeat) $("me").appendChild(seatEl(mySeat, true, false));

  // play area: my completed books, laid face up in front of me
  const play = $("my-play");
  play.innerHTML = "";
  if (mySeat) for (const r of mySeat.books) play.appendChild(cardEl({ rank: r, suit: 0 }, { big: true }));

  // deck zone: the pond (face down)
  renderPile($("deck"), "Pond", state.pond, null);

  // go fish has no shared cards or discard; those zones stay empty (hidden)
  $("shared").innerHTML = "";
  $("discard").innerHTML = "";

  // message
  let msg = "";
  if (state.phase === "gameover") {
    if (state.winners.length) {
      msg = state.winners.map((id) => nameOf(state, id)).join(" & ") + (state.winners.length > 1 ? " win!" : " wins!");
    } else msg = "Game over.";
  } else if (myTurn) {
    msg = "Your turn.";
  } else if (state.phase === "playing") {
    const t = state.seats.find((x) => x.isTurn);
    if (t) msg = `Waiting for ${t.name}…`;
  }
  $("table-msg").textContent = msg;

  renderHand(state, mySeat, myTurn);

  if (Net.role === "host") {
    $("host-controls").classList.toggle("hidden", state.phase !== "gameover");
  }
}

function nameOf(state, id) { const s = state.seats.find((x) => x.id === id); return s ? s.name : "?"; }

function seatEl(s, isMe, selectable) {
  const el = document.createElement("div");
  let cls = "seat" + (s.isTurn ? " turn" : "");
  if (selectable) { cls += " selectable"; if (s.id === selectedTarget) cls += " selected"; }
  el.className = cls;
  const bookStr = (!isMe && s.books.length) ? "Books: " + s.books.map(rankLabel).join(", ") : "";
  el.innerHTML = `
    <div class="seat-name">${escapeHtml(s.name)}${isMe ? " (you)" : ""}</div>
    <div class="seat-info">${s.cardCount} card${s.cardCount === 1 ? "" : "s"}</div>
    <div class="seat-sub">${escapeHtml(bookStr)}</div>`;

  if (!isMe) {
    const cards = document.createElement("div");
    cards.className = "cards";
    for (let i = 0; i < s.cardCount; i++) cards.appendChild(cardEl(null));
    el.appendChild(cards);
    if (selectable && s.cardCount > 0) {
      el.onclick = () => { selectedTarget = s.id; renderState(lastState); };
    }
  }
  return el;
}

// Render my hand into the hand zone; when it's my turn and a target is
// picked, cards become clickable to ask for that rank.
function renderHand(state, mySeat, myTurn) {
  const hint = $("ask-hint");
  const handWrap = $("my-hand");
  handWrap.innerHTML = "";

  if (!mySeat || state.phase !== "playing") { hint.classList.add("hidden"); return; }
  hint.classList.remove("hidden");

  if (myTurn) {
    const tName = selectedTarget != null ? nameOf(state, selectedTarget) : null;
    hint.textContent = tName
      ? `Select a player above, then click a card to ask ${tName} for that rank.`
      : "No opponents have cards to ask.";
  } else {
    hint.textContent = "Your cards:";
  }

  for (const c of state.hand) {
    const el = cardEl(c, { big: true });
    if (myTurn && selectedTarget != null) {
      el.classList.add("askable");
      el.onclick = () => submitAsk(selectedTarget, c.rank);
    }
    handWrap.appendChild(el);
  }
}

function renderLobby() {
  const ul = $("lobby-players");
  ul.innerHTML = "";
  for (const id of Engine.order) {
    const p = Engine.players[id];
    const li = document.createElement("li");
    li.innerHTML = `<span>${escapeHtml(p.name)}${id === 0 ? " (host)" : ""}</span>`;
    ul.appendChild(li);
  }
}

function updateHostConnCount() {
  $("host-connected-count").textContent = `Connected players: ${Engine.order.length}`;
  renderLobby();
}

// Route a local (host) ask or forward a guest ask.
function submitAsk(targetId, rank) {
  if (Net.role === "host") Engine.handleAsk(0, targetId, rank);
  else Net.link.send({ t: "ask", targetId, rank });
}

// ============================================================
// FRAMEWORK HOOKS + EVENT WIRING
// ============================================================
Table.configure({
  onHost() {
    Engine.addPlayer(0, Net.myName); // host is seat 0
    renderLobby();
    log("You are hosting. Add players, then Start game.", true);
  },
  onJoin(id, name, link) {
    Engine.addPlayer(id, name);
    link.send({ t: "welcome", id });
    updateHostConnCount();
    if (Engine.phase !== "lobby") Engine.broadcast();
  },
  onHostMessage(msg, link) {
    if (msg.t === "ask") Engine.handleAsk(link.id, msg.targetId, msg.rank);
  },
  onLeave(id) {
    Engine.removePlayer(id);
    if (Engine.phase === "lobby") updateHostConnCount();
  },
  render: renderState,
});

$("btn-start").onclick = () => Engine.startGame();
$("btn-new-game").onclick = () => Engine.startGame();
