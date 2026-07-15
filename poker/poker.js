"use strict";
// Texas Hold'em over manual-signaling WebRTC.
// The HOST runs the authoritative engine and deals; GUESTS send actions and
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
  // host:
  links: [],           // PeerLink per guest
  nextGuestId: 1,
  // guest:
  link: null,
  myId: null,
};

// -------- HOST networking --------
function hostAcceptGuest(guestCode) {
  const id = Net.nextGuestId++;
  const link = new RTC.PeerLink({
    onOpen: () => {}, // player registers via 'join' message
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
    Engine.broadcast();
  } else if (msg.t === "action") {
    Engine.handleAction(link.id, msg.action, msg.amount);
  }
}

function hostOnClose(link) {
  Engine.removePlayer(link.id);
  Engine.broadcast();
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

function guestSendAction(action, amount) {
  Net.link.send({ t: "action", action, amount });
}

// Route a local (host player) action or forward a guest action.
function submitAction(action, amount) {
  if (Net.role === "host") Engine.handleAction(0, action, amount);
  else guestSendAction(action, amount);
}

function broadcastLog(msg, hl) {
  log(msg, hl);
  for (const l of Net.links) l.send({ t: "log", msg, hl });
}

// ============================================================
// GAME ENGINE (host only)
// ============================================================
const Engine = {
  cfg: { chips: 1000, sb: 5, bb: 10 },
  players: {},      // id -> { id, name, chips }
  order: [],        // ids in seat order
  dealerIdx: -1,
  phase: "lobby",   // lobby | preflop | flop | turn | river | showdown | handover
  hand: null,       // per-hand state
  started: false,

  addPlayer(id, name) {
    if (this.players[id]) return;
    this.players[id] = { id, name, chips: this.cfg.chips };
    if (!this.order.includes(id)) this.order.push(id);
    broadcastLog(`${name} joined.`);
  },

  removePlayer(id) {
    const p = this.players[id];
    if (!p) return;
    broadcastLog(`${p.name} left.`);
    delete this.players[id];
    this.order = this.order.filter((x) => x !== id);
    if (this.hand && this.hand.seats[id]) {
      this.hand.seats[id].folded = true;
      if (this.phase !== "lobby" && this.phase !== "handover") this.afterAction(id);
    }
  },

  startHand() {
    const eligible = this.order.filter((id) => this.players[id].chips > 0);
    if (eligible.length < 2) { broadcastLog("Need at least 2 players with chips."); return; }
    this.started = true;
    this.cfg.chips = +$("cfg-chips").value || this.cfg.chips;
    this.cfg.sb = +$("cfg-sb").value || this.cfg.sb;
    this.cfg.bb = +$("cfg-bb").value || this.cfg.bb;

    // advance dealer to next eligible player
    do { this.dealerIdx = (this.dealerIdx + 1) % this.order.length; }
    while (this.players[this.order[this.dealerIdx]].chips <= 0);

    const deck = makeDeck();
    const seats = {};
    for (const id of this.order) {
      const inHand = this.players[id].chips > 0;
      seats[id] = {
        hole: inHand ? [deck.pop(), deck.pop()] : [],
        bet: 0, totalBet: 0, folded: !inHand, allIn: false, hasActed: false,
        inHand, lastAction: "", showdown: false,
      };
    }
    this.hand = { deck, seats, community: [], currentBet: 0, minRaise: this.cfg.bb, turn: null, winners: [] };
    this.phase = "preflop";

    const active = this.activeIdxs();
    const n = active.length;
    let sbPos, bbPos, firstPos;
    const dPos = active.indexOf(this.dealerIdx);
    if (n === 2) { sbPos = dPos; bbPos = (dPos + 1) % n; firstPos = dPos; }
    else { sbPos = (dPos + 1) % n; bbPos = (dPos + 2) % n; firstPos = (dPos + 3) % n; }

    this.postBlind(active[sbPos], this.cfg.sb, "SB");
    this.postBlind(active[bbPos], this.cfg.bb, "BB");
    this.hand.currentBet = this.cfg.bb;
    this.hand.minRaise = this.cfg.bb;

    broadcastLog(`--- New hand. Dealer: ${this.players[this.order[this.dealerIdx]].name} ---`, true);
    this.hand.turn = this.nextActorFrom(active[firstPos], true);
    this.broadcast();
  },

  postBlind(idx, amount, label) {
    const id = this.order[idx];
    const s = this.hand.seats[id];
    const amt = Math.min(amount, this.players[id].chips);
    this.players[id].chips -= amt;
    s.bet += amt; s.totalBet += amt;
    if (this.players[id].chips === 0) s.allIn = true;
    s.lastAction = label;
  },

  activeIdxs() {
    // order-positions of players dealt into this hand (not sitting out)
    return this.order.map((id, i) => (this.hand.seats[id].inHand ? i : -1)).filter((i) => i >= 0);
  },

  // find next player to act starting at order-index `startIdx`
  nextActorFrom(startIdx, inclusive) {
    const n = this.order.length;
    for (let step = inclusive ? 0 : 1; step <= n; step++) {
      const idx = (startIdx + step) % n;
      const id = this.order[idx];
      const s = this.hand.seats[id];
      if (!s.inHand || s.folded || s.allIn) continue;
      if (!s.hasActed || s.bet < this.hand.currentBet) return id;
    }
    return null;
  },

  handleAction(pid, action, amount) {
    if (this.phase === "lobby" || this.phase === "handover" || !this.hand) return;
    if (pid !== this.hand.turn) return; // not your turn / stale
    const s = this.hand.seats[pid];
    const p = this.players[pid];
    const toCall = this.hand.currentBet - s.bet;

    const commit = (amt) => {
      amt = Math.min(amt, p.chips);
      p.chips -= amt; s.bet += amt; s.totalBet += amt;
      if (p.chips === 0) s.allIn = true;
      return amt;
    };

    if (action === "fold") {
      s.folded = true; s.lastAction = "Fold";
    } else if (action === "check") {
      if (toCall > 0) return;
      s.lastAction = "Check";
    } else if (action === "call") {
      const amt = commit(toCall);
      s.lastAction = s.allIn ? "All-in" : `Call ${amt}`;
    } else if (action === "bet" || action === "raise") {
      // amount = target total bet for this street
      let target = Math.floor(amount);
      const maxTotal = s.bet + p.chips;
      if (target > maxTotal) target = maxTotal;
      const minTarget = this.hand.currentBet + (this.hand.currentBet === 0 ? this.cfg.bb : this.hand.minRaise);
      const isAllIn = target === maxTotal;
      if (target <= this.hand.currentBet) return;            // must exceed current bet
      if (!isAllIn && target < minTarget) target = minTarget; // enforce min raise unless all-in
      const raiseSize = target - this.hand.currentBet;
      commit(target - s.bet);
      if (raiseSize >= this.hand.minRaise) this.hand.minRaise = raiseSize;
      this.hand.currentBet = s.bet;
      s.lastAction = s.allIn ? "All-in" : (action === "bet" ? `Bet ${s.bet}` : `Raise to ${s.bet}`);
      // reopen action for everyone else
      for (const id of this.order) {
        if (id !== pid && !this.hand.seats[id].folded && !this.hand.seats[id].allIn) this.hand.seats[id].hasActed = false;
      }
    } else if (action === "allin") {
      const before = this.hand.currentBet;
      commit(p.chips);
      if (s.bet > before) {
        const raiseSize = s.bet - before;
        if (raiseSize >= this.hand.minRaise) this.hand.minRaise = raiseSize;
        this.hand.currentBet = s.bet;
        for (const id of this.order) {
          if (id !== pid && !this.hand.seats[id].folded && !this.hand.seats[id].allIn) this.hand.seats[id].hasActed = false;
        }
      }
      s.lastAction = "All-in";
    } else return;

    s.hasActed = true;
    broadcastLog(`${p.name}: ${s.lastAction}`);
    this.afterAction(pid);
  },

  afterAction(pid) {
    const contenders = this.order.filter((id) => this.hand.seats[id].inHand && !this.hand.seats[id].folded);
    if (contenders.length === 1) { this.awardUncontested(contenders[0]); return; }

    const next = this.nextActorFrom(this.order.indexOf(pid), false);
    if (next !== null) { this.hand.turn = next; this.broadcast(); return; }

    this.endStreet();
  },

  endStreet() {
    // move contributions to totalBet already tracked; reset street bets
    for (const id of this.order) {
      const s = this.hand.seats[id];
      s.bet = 0; s.hasActed = false; if (s.lastAction !== "Fold" && !s.allIn) s.lastAction = "";
    }
    this.hand.currentBet = 0; this.hand.minRaise = this.cfg.bb;
    this.hand.turn = null; // no one is on the clock until a new actor is chosen

    // players who can still make betting decisions
    const canAct = this.order.filter((id) => {
      const s = this.hand.seats[id]; return s.inHand && !s.folded && !s.allIn;
    });
    const runOut = canAct.length <= 1; // rest are all-in: deal remaining board, no betting

    const deal = (n) => { for (let i = 0; i < n; i++) this.hand.community.push(this.hand.deck.pop()); };

    if (this.phase === "preflop") { deal(3); this.phase = "flop"; }
    else if (this.phase === "flop") { deal(1); this.phase = "turn"; }
    else if (this.phase === "turn") { deal(1); this.phase = "river"; }
    else if (this.phase === "river") { return this.showdown(); }

    broadcastLog(`${this.phase.toUpperCase()}: ${this.hand.community.map((c) => rankLabel(c.rank) + SUITS[c.suit]).join(" ")}`, true);

    if (runOut) { this.broadcast(); setTimeout(() => this.endStreet(), 1200); return; }

    const firstPos = this.nextActorFrom((this.dealerIdx) % this.order.length, false);
    this.hand.turn = firstPos;
    this.broadcast();
  },

  awardUncontested(id) {
    const pot = this.totalPot();
    this.players[id].chips += pot;
    this.hand.winners = [{ id, amount: pot, hand: "(uncontested)" }];
    broadcastLog(`${this.players[id].name} wins ${pot} (everyone folded).`, true);
    this.endHand();
  },

  showdown() {
    this.phase = "showdown";
    const contenders = this.order.filter((id) => this.hand.seats[id].inHand && !this.hand.seats[id].folded);
    for (const id of contenders) this.hand.seats[id].showdown = true;

    // evaluate each contender
    const scores = {};
    for (const id of contenders) {
      scores[id] = HandEval.evaluate7(this.hand.seats[id].hole.concat(this.hand.community));
    }

    // build side pots from totalBet contributions
    const contribs = this.order.map((id) => ({ id, amt: this.hand.seats[id].totalBet, folded: this.hand.seats[id].folded }))
      .filter((c) => c.amt > 0);
    const pots = [];
    while (contribs.some((c) => c.amt > 0)) {
      const min = Math.min(...contribs.filter((c) => c.amt > 0).map((c) => c.amt));
      const layer = contribs.filter((c) => c.amt > 0);
      const amount = min * layer.length;
      const eligible = layer.filter((c) => !c.folded).map((c) => c.id);
      pots.push({ amount, eligible });
      for (const c of layer) c.amt -= min;
    }

    const winners = [];
    for (const pot of pots) {
      if (pot.eligible.length === 0) continue;
      let best = null, bestIds = [];
      for (const id of pot.eligible) {
        const cmp = best === null ? 1 : HandEval.compareScore(scores[id], best);
        if (cmp > 0) { best = scores[id]; bestIds = [id]; }
        else if (cmp === 0) bestIds.push(id);
      }
      const share = Math.floor(pot.amount / bestIds.length);
      let remainder = pot.amount - share * bestIds.length;
      for (const id of bestIds) {
        let amt = share;
        if (remainder > 0) { amt += 1; remainder -= 1; }
        this.players[id].chips += amt;
        winners.push({ id, amount: amt, hand: scores[id].name });
      }
    }
    this.hand.winners = winners;
    for (const w of winners) broadcastLog(`${this.players[w.id].name} wins ${w.amount} with ${w.hand}.`, true);
    this.endHand();
  },

  totalPot() {
    return this.order.reduce((sum, id) => sum + this.hand.seats[id].totalBet, 0);
  },

  endHand() {
    this.phase = "handover";
    this.hand.turn = null;
    this.broadcast();
    const withChips = this.order.filter((id) => this.players[id].chips > 0);
    if (withChips.length < 2) broadcastLog(`Game over. ${this.players[withChips[0]].name} wins!`, true);
  },

  // ---- state projection & broadcast ----
  projectFor(viewerId) {
    const revealAll = this.phase === "showdown" || this.phase === "handover";
    const seats = this.order.map((id) => {
      const p = this.players[id];
      const s = this.hand ? this.hand.seats[id] : null;
      const showHole = s && s.inHand && (id === viewerId || (revealAll && s.showdown));
      return {
        id, name: p.name, chips: p.chips,
        bet: s ? s.bet : 0,
        folded: s ? s.folded : false,
        allIn: s ? s.allIn : false,
        inHand: s ? s.inHand : false,
        cardsCount: s ? s.hole.length : 0,
        hole: showHole ? s.hole : null,
        lastAction: s ? s.lastAction : "",
        isDealer: this.order[this.dealerIdx] === id,
        isTurn: this.hand && this.hand.turn === id,
      };
    });
    return {
      phase: this.phase,
      seats,
      community: this.hand ? this.hand.community : [],
      pot: this.hand ? this.totalPot() : 0,
      currentBet: this.hand ? this.hand.currentBet : 0,
      minRaise: this.hand ? this.hand.minRaise : this.cfg.bb,
      bb: this.cfg.bb,
      winners: this.hand ? this.hand.winners : [],
      viewerId,
    };
  },

  broadcast() {
    for (const id of this.order) {
      if (id === 0) renderState(this.projectFor(0));
      else sendToPlayer(id, { t: "state", state: this.projectFor(id) });
    }
    if (!this.order.includes(0)) {} // host always seat 0
  },
};

// ============================================================
// RENDERING (host + guests share this)
// ============================================================
function renderState(state) {
  show("table");
  const meId = Net.role === "host" ? 0 : Net.myId;

  // opponents (everyone except me)
  const opp = $("opponents");
  opp.innerHTML = "";
  let mySeat = null;
  for (const s of state.seats) {
    if (s.id === meId) { mySeat = s; continue; }
    opp.appendChild(seatEl(s, false));
  }

  // me
  $("me").innerHTML = "";
  if (mySeat) $("me").appendChild(seatEl(mySeat, true));

  // community
  const comm = $("community");
  comm.innerHTML = "";
  for (const c of state.community) comm.appendChild(cardEl(c, { big: true }));

  $("pot").textContent = state.pot > 0 ? `Pot: ${state.pot}` : "";

  // message
  let msg = "";
  if (state.phase === "handover" && state.winners.length) {
    msg = state.winners.map((w) => `${nameOf(state, w.id)} wins ${w.amount} (${w.hand})`).join(" · ");
  } else if (state.phase === "showdown") {
    msg = "Showdown!";
  } else if (mySeat && mySeat.isTurn) {
    msg = "Your turn.";
  } else if (state.phase !== "lobby") {
    const t = state.seats.find((x) => x.isTurn);
    if (t) msg = `Waiting for ${t.name}…`;
  }
  $("table-msg").textContent = msg;

  renderActions(state, mySeat);

  // host controls: show "Next hand" between hands
  if (Net.role === "host") {
    $("host-controls").classList.toggle("hidden", !(state.phase === "handover"));
  }
}

function nameOf(state, id) { const s = state.seats.find((x) => x.id === id); return s ? s.name : "?"; }

function seatEl(s, isMe) {
  const el = document.createElement("div");
  el.className = "seat" + (s.isTurn ? " turn" : "") + (s.folded ? " folded" : "");
  const dealer = s.isDealer ? '<span class="dealer-btn">D</span>' : "";
  el.innerHTML = `
    ${dealer}
    <div class="seat-name">${escapeHtml(s.name)}${isMe ? " (you)" : ""}</div>
    <div class="seat-chips">${s.chips} chips</div>
    <div class="seat-bet">${s.bet > 0 ? "bet " + s.bet : ""}</div>
    <div class="seat-action">${s.folded ? "folded" : (s.allIn ? "all-in" : escapeHtml(s.lastAction || ""))}</div>`;
  const cards = document.createElement("div");
  cards.className = "cards";
  if (s.hole) for (const c of s.hole) cards.appendChild(cardEl(c));
  else for (let i = 0; i < s.cardsCount; i++) cards.appendChild(cardEl(null));
  el.appendChild(cards);
  return el;
}

function renderActions(state, mySeat) {
  const box = $("actions");
  const myTurn = mySeat && mySeat.isTurn && (state.phase !== "handover" && state.phase !== "showdown");
  box.classList.toggle("hidden", !myTurn);
  if (!myTurn) return;

  const toCall = state.currentBet - mySeat.bet;
  const canCheck = toCall === 0;
  const myChips = mySeat.chips;
  const maxTotal = mySeat.bet + myChips;

  $("act-check").classList.toggle("hidden", !canCheck);
  $("act-call").classList.toggle("hidden", canCheck);
  if (!canCheck) $("act-call").textContent = toCall >= myChips ? `Call ${myChips} (all-in)` : `Call ${toCall}`;

  const isBet = state.currentBet === 0;
  $("act-bet").classList.toggle("hidden", !isBet);
  $("act-raise").classList.toggle("hidden", isBet);

  // bet/raise slider
  const bc = $("bet-controls");
  const canRaise = myChips > toCall; // enough to raise beyond a call
  bc.classList.toggle("hidden", !canRaise);
  $("act-bet").disabled = !canRaise;
  $("act-raise").disabled = !canRaise;
  if (canRaise) {
    const minTarget = Math.min(maxTotal, state.currentBet + (isBet ? state.bb : state.minRaise));
    const slider = $("bet-slider"), amt = $("bet-amount");
    slider.min = amt.min = minTarget;
    slider.max = amt.max = maxTotal;
    slider.step = amt.step = 1;
    slider.value = amt.value = minTarget;
  }
  $("act-allin").textContent = `All-in (${myChips})`;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ============================================================
// VIEW SWITCHING
// ============================================================
function show(which) {
  for (const s of ["setup", "lobby", "table"]) {
    if (s === "table") $(s).classList.toggle("hidden", which !== "table");
    else $(s).classList.toggle("hidden", which !== s);
  }
  // lobby + table can share screen with log; setup hidden once playing
  if (which === "table") $("setup").classList.add("hidden");
}

function renderLobby() {
  const ul = $("lobby-players");
  ul.innerHTML = "";
  for (const id of Engine.order) {
    const p = Engine.players[id];
    const li = document.createElement("li");
    li.innerHTML = `<span>${escapeHtml(p.name)}${id === 0 ? " (host)" : ""}</span><span>${p.chips} chips</span>`;
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
  log("You are hosting. Add players, then Start hand.", true);
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

$("btn-start").onclick = () => Engine.startHand();
$("btn-next-hand").onclick = () => Engine.startHand();

function copyFrom(id) {
  const ta = $(id);
  ta.select();
  navigator.clipboard.writeText(ta.value).catch(() => {});
}
$("btn-copy-offer").onclick = () => copyFrom("guest-offer-code");
$("btn-copy-reply").onclick = () => copyFrom("host-reply-code");

// action buttons
$("act-fold").onclick = () => submitAction("fold");
$("act-check").onclick = () => submitAction("check");
$("act-call").onclick = () => submitAction("call");
$("act-bet").onclick = () => submitAction("bet", +$("bet-amount").value);
$("act-raise").onclick = () => submitAction("raise", +$("bet-amount").value);
$("act-allin").onclick = () => submitAction("allin");

$("bet-slider").oninput = () => { $("bet-amount").value = $("bet-slider").value; };
$("bet-amount").oninput = () => { $("bet-slider").value = $("bet-amount").value; };
