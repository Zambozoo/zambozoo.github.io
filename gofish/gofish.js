"use strict";
// Go Fish over manual-signaling WebRTC.
// The HOST runs the authoritative engine and deals; GUESTS send asks and
// render the state the host broadcasts. Host is also a player (id 0).

const $ = (id) => document.getElementById(id);
const SUITS = ["♠", "♥", "♦", "♣"]; // spade heart diamond club
const RANK_STR = { 11: "J", 12: "Q", 13: "K", 14: "A" };

function rankLabel(r) { return RANK_STR[r] || String(r); }

function cardEl(card, opts = {}) {
  const el = document.createElement("div");
  el.className = "card" + (opts.big ? " big" : "");
  if (!card) { el.classList.add("back"); return el; }
  if (card.suit === 1 || card.suit === 2) el.classList.add("red");
  el.innerHTML = `<span class="r">${rankLabel(card.rank)}</span><span>${SUITS[card.suit]}</span>`;
  return el;
}

function makeDeck() {
  const d = [];
  for (let s = 0; s < 4; s++) for (let r = 2; r <= 14; r++) d.push({ rank: r, suit: s });
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

function log(msg, hl) {
  const el = document.createElement("div");
  if (hl) el.className = "hl";
  el.textContent = msg;
  $("log").prepend(el);
}

// ============================================================
// NETWORK LAYER
// ============================================================
const Net = {
  role: null,          // 'host' | 'guest'
  myName: "",
  links: [],           // host: PeerLink per guest
  nextGuestId: 1,
  link: null,          // guest: single link to host
  myId: null,
};

// -------- HOST networking --------
function hostAcceptGuest(guestCode) {
  const id = Net.nextGuestId++;
  const link = new RTC.PeerLink({
    onOpen: () => {},
    onMessage: (msg, lnk) => hostOnMessage(msg, lnk),
    onClose: (lnk) => hostOnClose(lnk),
  });
  link.id = id;
  Net.links.push(link);
  return link.initHost(guestCode);
}

function hostOnMessage(msg, link) {
  if (msg.t === "join") {
    Engine.addPlayer(link.id, msg.name);
    link.send({ t: "welcome", id: link.id });
    updateHostConnCount();
    if (Engine.phase !== "lobby") Engine.broadcast();
  } else if (msg.t === "ask") {
    Engine.handleAsk(link.id, msg.targetId, msg.rank);
  }
}

function hostOnClose(link) {
  Engine.removePlayer(link.id);
  if (Engine.phase === "lobby") updateHostConnCount();
}

function sendToPlayer(pid, obj) {
  if (pid === 0) return; // host renders locally
  const link = Net.links.find((l) => l.id === pid);
  if (link) link.send(obj);
}

// -------- GUEST networking --------
async function guestCreateOffer() {
  Net.link = new RTC.PeerLink({
    onOpen: () => Net.link.send({ t: "join", name: Net.myName }),
    onMessage: (msg) => guestOnMessage(msg),
    onClose: () => { $("table-msg").textContent = "Disconnected from host."; },
  });
  return Net.link.initGuest();
}

function guestOnMessage(msg) {
  if (msg.t === "welcome") {
    Net.myId = msg.id;
    show("lobby");
    $("lobby-guest-msg").classList.remove("hidden");
  } else if (msg.t === "state") {
    renderState(msg.state);
  } else if (msg.t === "log") {
    log(msg.msg, msg.hl);
  }
}

// Route a local (host) ask or forward a guest ask.
function submitAsk(targetId, rank) {
  if (Net.role === "host") Engine.handleAsk(0, targetId, rank);
  else Net.link.send({ t: "ask", targetId, rank });
}

function broadcastLog(msg, hl) {
  log(msg, hl);
  for (const l of Net.links) l.send({ t: "log", msg, hl });
}

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

  // me
  $("me").innerHTML = "";
  if (mySeat) $("me").appendChild(seatEl(mySeat, true, false));

  // pond
  $("pond").textContent = `Pond: ${state.pond} card${state.pond === 1 ? "" : "s"}`;

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

  renderAsk(state, mySeat, myTurn);

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
  const bookStr = s.books.length ? "Books: " + s.books.map(rankLabel).join(", ") : "";
  el.innerHTML = `
    <div class="seat-name">${escapeHtml(s.name)}${isMe ? " (you)" : ""}</div>
    <div class="seat-count">${s.cardCount} card${s.cardCount === 1 ? "" : "s"}</div>
    <div class="seat-books">${escapeHtml(bookStr)}</div>`;

  if (isMe) {
    // handled by the ask area / my-hand render below
  } else {
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

function renderAsk(state, mySeat, myTurn) {
  const box = $("ask");
  box.classList.toggle("hidden", !mySeat || state.phase !== "playing");
  const handWrap = $("ask-hand");
  handWrap.innerHTML = "";

  if (!mySeat) return;

  // instruction
  if (myTurn) {
    const tName = selectedTarget != null ? nameOf(state, selectedTarget) : null;
    $("ask-hint").textContent = tName
      ? `Select a player above, then click a card to ask ${tName} for that rank.`
      : "No opponents have cards to ask.";
  } else {
    $("ask-hint").textContent = "Your cards:";
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

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ============================================================
// VIEW SWITCHING
// ============================================================
function show(which) {
  for (const s of ["setup", "lobby", "table"]) {
    $(s).classList.toggle("hidden", which !== s);
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

// ============================================================
// EVENT WIRING
// ============================================================
function setName() {
  const n = $("name-input").value.trim();
  return n || "Player";
}

$("btn-host").onclick = () => {
  Net.role = "host";
  Net.myName = setName();
  Engine.addPlayer(0, Net.myName); // host is seat 0
  $("setup-choose").classList.add("hidden");
  $("setup-host").classList.remove("hidden");
  $("lobby").classList.remove("hidden");
  $("lobby-host-controls").classList.remove("hidden");
  renderLobby();
  log("You are hosting. Add players, then Start game.", true);
};

$("btn-join").onclick = async () => {
  Net.role = "guest";
  Net.myName = setName();
  $("setup-choose").classList.add("hidden");
  $("setup-guest").classList.remove("hidden");
  $("guest-offer-code").value = "Generating…";
  const code = await guestCreateOffer();
  $("guest-offer-code").value = code;
};

$("btn-host-accept").onclick = async () => {
  const code = $("host-guest-code").value.trim();
  if (!code) return;
  try {
    const reply = await hostAcceptGuest(code);
    $("host-reply-code").value = reply;
    $("host-reply-wrap").classList.remove("hidden");
    $("host-guest-code").value = "";
  } catch (e) {
    alert("Couldn't read that join code. Make sure it was copied fully.");
  }
};

$("btn-guest-connect").onclick = async () => {
  const code = $("guest-answer-code").value.trim();
  if (!code) return;
  try { await Net.link.acceptRemoteCode(code); }
  catch (e) { alert("Couldn't read that reply code. Make sure it was copied fully."); }
};

$("btn-start").onclick = () => Engine.startGame();
$("btn-new-game").onclick = () => Engine.startGame();

function copyFrom(id) {
  const ta = $(id);
  ta.select();
  navigator.clipboard.writeText(ta.value).catch(() => {});
}
$("btn-copy-offer").onclick = () => copyFrom("guest-offer-code");
$("btn-copy-reply").onclick = () => copyFrom("host-reply-code");
