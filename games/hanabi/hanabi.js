"use strict";
// Hanabi over manual-signaling WebRTC — a cooperative game.
// The HOST runs the authoritative engine and deals; GUESTS send actions and
// render the state the host broadcasts. Host is also a player (id 0).
//
// The twist: you can see everyone ELSE'S hand but not your own, so each
// player's projection hides only their own cards. Shared plumbing lives in
// ../shared/table.js; this file is Hanabi's engine + rendering.
//
// Suits are data-driven so variants (Rainbow, Black Powder) just add entries.

const MAX_HINTS = 8;
const START_FUSES = 3;

// Standard multiplicity per suit: three 1s, two 2s/3s/4s, one 5.
const NORMAL_COUNTS = { 1: 3, 2: 2, 3: 2, 4: 2, 5: 1 };
// A "short" suit has just one of every rank.
const SHORT_COUNTS = { 1: 1, 2: 1, 3: 1, 4: 1, 5: 1 };
// Black Powder is reversed: plentiful 5s down to a lone 1.
const BLACK_COUNTS = { 5: 3, 4: 2, 3: 2, 2: 2, 1: 1 };

const BASE_SUITS = [
  { key: "r", letter: "R", name: "Red" },
  { key: "y", letter: "Y", name: "Yellow" },
  { key: "g", letter: "G", name: "Green" },
  { key: "b", letter: "B", name: "Blue" },
  { key: "w", letter: "W", name: "White" },
];

function suit(base, extra) {
  return Object.assign({ hasColorClue: true, reversed: false, matchAny: false, counts: NORMAL_COUNTS }, base, extra);
}

// Build the ordered suit list for a set of options.
function buildSuits(opts) {
  const suits = BASE_SUITS.map((b) => suit(b, {}));
  if (opts.rainbow === "full") {
    suits.push(suit({ key: "m", letter: "M", name: "Rainbow" }, {}));
  } else if (opts.rainbow === "short") {
    suits.push(suit({ key: "m", letter: "M", name: "Rainbow" }, { counts: SHORT_COUNTS }));
  } else if (opts.rainbow === "wild") {
    suits.push(suit({ key: "m", letter: "M", name: "Rainbow" }, { hasColorClue: false, matchAny: true }));
  }
  if (opts.blackPowder) {
    suits.push(suit({ key: "k", letter: "K", name: "Black" }, { hasColorClue: false, reversed: true, counts: BLACK_COUNTS }));
  }
  return suits;
}

const BONUS_LABEL = {
  restore: "Restore a clue",
  fuseSwap: "Swap fuses for clues",
  shuffle: "Reshuffle a discard",
  reveal: "Reveal a card",
};

function shuffleArr(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ============================================================
// GAME ENGINE (host only)
// ============================================================
const Engine = {
  players: {},          // id -> { id, name }
  order: [],            // ids in seat order
  hands: {},            // id -> [ { suit, rank, colorHints:[], rankHint } ]
  deck: [],
  suits: [],            // active suit defs
  fireworks: [],        // cards played per suit (0..5)
  discard: [],
  hints: MAX_HINTS,
  fuses: START_FUSES,
  turn: null,
  phase: "lobby",       // lobby | playing | gameover
  finalTurnsLeft: null, // set once the deck empties (unless Perfect Game)
  reason: null,         // 'perfect' | 'boom' | 'deck' | 'dead' | 'abandoned'
  opts: { rainbow: "off", blackPowder: false, masterArtisan: false, perfectGame: false, hideClues: false },
  bonusBag: [],
  pendingBonus: null,   // { pid, type } — blocks turn flow until resolved

  addPlayer(id, name) {
    if (this.players[id]) return;
    this.players[id] = { id, name };
    if (!this.order.includes(id)) this.order.push(id);
    this.hands[id] = this.hands[id] || [];
    broadcastLog(`${name} joined.`);
  },

  removePlayer(id) {
    const p = this.players[id];
    if (!p) return;
    broadcastLog(`${p.name} left.`);
    delete this.players[id];
    delete this.hands[id];
    this.order = this.order.filter((x) => x !== id);
    if (this.phase === "playing") { this.gameOver("abandoned"); return; }
  },

  suitName(i) { return this.suits[i].name; },
  maxScore() { return this.suits.length * 5; },
  // Next rank this suit needs, given how many cards it has played.
  needed(i) { const c = this.fireworks[i]; return this.suits[i].reversed ? 5 - c : c + 1; },

  buildDeck() {
    const d = [];
    for (let s = 0; s < this.suits.length; s++) {
      const counts = this.suits[s].counts;
      for (const rank in counts) {
        for (let n = 0; n < counts[rank]; n++) d.push({ suit: s, rank: +rank, colorHints: [], rankHint: null, negColors: [], negRanks: [] });
      }
    }
    return shuffleArr(d);
  },

  startGame() {
    if (this.order.length < 2) { broadcastLog("Need at least 2 players."); return; }
    this.suits = buildSuits(this.opts);
    this.deck = this.buildDeck();
    this.fireworks = this.suits.map(() => 0);
    this.discard = [];
    this.hints = MAX_HINTS;
    this.fuses = START_FUSES;
    this.finalTurnsLeft = null;
    this.reason = null;
    this.pendingBonus = null;
    this.bonusBag = this.opts.masterArtisan
      ? shuffleArr(["restore", "restore", "fuseSwap", "shuffle", "shuffle", "reveal"])
      : [];
    const handSize = this.order.length <= 3 ? 5 : 4;
    for (const id of this.order) {
      this.hands[id] = [];
      for (let i = 0; i < handSize; i++) this.hands[id].push(this.deck.pop());
    }
    this.phase = "playing";
    this.turn = this.order[0];
    broadcastLog("--- New game of Hanabi. ---", true);
    const notes = this.optionNotes();
    if (notes) broadcastLog("Options: " + notes, true);
    this.broadcast();
  },

  optionNotes() {
    const n = [];
    if (this.opts.rainbow === "full") n.push("Rainbow (own clue)");
    else if (this.opts.rainbow === "wild") n.push("Rainbow (matches any color)");
    else if (this.opts.rainbow === "short") n.push("Rainbow (short suit)");
    if (this.opts.blackPowder) n.push("Black Powder");
    if (this.opts.masterArtisan) n.push("Master Artisan");
    if (this.opts.perfectGame) n.push("Perfect Game");
    if (this.opts.hideClues) n.push("Memory Mode");
    return n.join(", ");
  },

  score() { return this.fireworks.reduce((a, b) => a + b, 0); },

  draw(id) {
    if (this.deck.length === 0) return;
    this.hands[id].push(this.deck.pop());
    if (this.deck.length === 0 && !this.opts.perfectGame && this.finalTurnsLeft === null) {
      this.finalTurnsLeft = this.order.length - 1; // everyone else gets one last turn
      broadcastLog("Last card drawn — final round!", true);
    }
  },

  handleAction(pid, msg) {
    if (this.phase !== "playing") return;
    // Reorganizing your own hand is allowed any time and doesn't use a turn.
    if (msg.action === "reorder") { this.doReorder(pid, msg.from, msg.to); return; }
    if (this.pendingBonus) {
      if (msg.action === "bonus" && pid === this.pendingBonus.pid) this.resolveBonus(pid, msg);
      return;
    }
    if (pid !== this.turn) return;
    if (msg.action === "play") this.doPlay(pid, msg.index);
    else if (msg.action === "discard") this.doDiscard(pid, msg.index);
    else if (msg.action === "hint") this.doHint(pid, msg.targetId, msg.hintType, msg.value);
  },

  doReorder(pid, from, to) {
    const hand = this.hands[pid];
    if (!hand) return;
    from = +from; to = +to;
    if (isNaN(from) || isNaN(to) || from < 0 || from >= hand.length || to < 0 || to >= hand.length || from === to) return;
    const [c] = hand.splice(from, 1);
    hand.splice(to, 0, c);
    this.broadcast();
  },

  doPlay(pid, idx) {
    const hand = this.hands[pid];
    if (idx < 0 || idx >= hand.length) return;
    const card = hand.splice(idx, 1)[0];
    const name = this.players[pid].name;
    if (card.rank === this.needed(card.suit)) {
      this.fireworks[card.suit]++;
      broadcastLog(`${name} played ${this.suitName(card.suit)} ${card.rank}.`, true);
      if (this.fireworks[card.suit] === 5) this.rewardCompletion(pid, card.suit);
    } else {
      this.fuses--;
      this.discard.push(card);
      broadcastLog(`${name} misplayed ${this.suitName(card.suit)} ${card.rank} — a fuse blows! (${this.fuses} left)`, true);
    }
    this.draw(pid);
    if (this.pendingBonus) { this.broadcast(); return; } // wait for the bonus choice
    this.afterAction();
  },

  doDiscard(pid, idx) {
    if (this.hints >= MAX_HINTS) return; // no token to regain; discarding is illegal
    const hand = this.hands[pid];
    if (idx < 0 || idx >= hand.length) return;
    const card = hand.splice(idx, 1)[0];
    this.discard.push(card);
    this.hints++;
    broadcastLog(`${this.players[pid].name} discarded ${this.suitName(card.suit)} ${card.rank}.`);
    this.draw(pid);
    this.afterAction();
  },

  colorMatches(card, suitIdx) {
    // A color clue for suitIdx (always a suit with its own clue) touches that
    // suit's cards, plus any "matches-any" (wild Rainbow) card.
    return card.suit === suitIdx || this.suits[card.suit].matchAny;
  },

  doHint(pid, targetId, hintType, value) {
    if (this.hints <= 0) return;
    targetId = +targetId; value = +value;
    if (targetId === pid || !this.hands[targetId]) return;
    const th = this.hands[targetId];
    const isMatch = (c) => (hintType === "color" ? this.colorMatches(c, value) : c.rank === value);
    const matches = th.filter(isMatch);
    if (matches.length === 0) return; // empty hints are not allowed
    for (const c of th) {
      if (isMatch(c)) {
        if (hintType === "color") { if (!c.colorHints.includes(value)) c.colorHints.push(value); }
        else c.rankHint = value;
      } else {
        // A card not touched by the clue is known NOT to be that color/rank.
        const neg = hintType === "color" ? c.negColors : c.negRanks;
        if (!neg.includes(value)) neg.push(value);
      }
    }
    this.hints--;
    const label = hintType === "color" ? this.suitName(value) + "s" : value + "s";
    broadcastLog(`${this.players[pid].name} told ${this.players[targetId].name} about their ${matches.length} ${label}.`);
    this.afterAction();
  },

  // ---- Master Artisan bonus tokens ----
  canPerformBonus(type) {
    if (type === "shuffle") return this.discard.length > 0;
    if (type === "fuseSwap") return this.fuses > 1 && this.hints < MAX_HINTS;
    if (type === "reveal") return this.order.some((id) => id !== this.turn && this.hands[id].length > 0);
    return true;
  },

  rewardCompletion(pid, suitIdx) {
    const name = this.players[pid].name;
    if (!this.opts.masterArtisan) {
      if (this.hints < MAX_HINTS) {
        this.hints++;
        broadcastLog(`${this.suitName(suitIdx)} firework complete — a hint token is returned!`, true);
      } else {
        broadcastLog(`${this.suitName(suitIdx)} firework complete!`, true);
      }
      return;
    }
    const token = this.bonusBag.length ? this.bonusBag.pop() : null;
    if (!token) {
      broadcastLog(`${this.suitName(suitIdx)} firework complete — no bonus tokens remain.`, true);
      return;
    }
    if (token === "restore" || !this.canPerformBonus(token)) {
      if (this.hints < MAX_HINTS) this.hints++;
      const why = token === "restore" ? "a clue is restored" : `${BONUS_LABEL[token]} (unavailable — a clue is restored)`;
      broadcastLog(`${name} completed a firework — bonus: ${why}.`, true);
      return;
    }
    this.pendingBonus = { pid, type: token };
    broadcastLog(`${name} completed a firework and drew a bonus: ${BONUS_LABEL[token]}!`, true);
  },

  resolveBonus(pid, msg) {
    const pend = this.pendingBonus;
    if (!pend || pend.pid !== pid) return;
    const name = this.players[pid].name;
    const type = pend.type;
    if (type === "fuseSwap") {
      let amt = Math.max(0, Math.min(+msg.amount || 0, 2, this.fuses - 1, MAX_HINTS - this.hints));
      if (amt > 0) {
        this.fuses -= amt; this.hints += amt;
        broadcastLog(`${name} swapped ${amt} fuse${amt > 1 ? "s" : ""} for ${amt} clue${amt > 1 ? "s" : ""}.`, true);
      } else broadcastLog(`${name} declined the bonus swap.`);
    } else if (type === "shuffle") {
      const idx = +msg.discardIndex;
      if (msg.skip || isNaN(idx) || idx < 0 || idx >= this.discard.length) {
        broadcastLog(`${name} declined the reshuffle.`);
      } else {
        const c = this.discard.splice(idx, 1)[0];
        c.colorHints = []; c.rankHint = null; c.negColors = []; c.negRanks = [];
        this.deck.push(c); shuffleArr(this.deck);
        broadcastLog(`${name} shuffled ${this.suitName(c.suit)} ${c.rank} back into the deck.`, true);
        if (this.finalTurnsLeft !== null) {
          this.finalTurnsLeft = null;
          broadcastLog("The deck is no longer empty — the final round is reset.", true);
        }
      }
    } else if (type === "reveal") {
      const tid = +msg.targetId, ci = +msg.cardIndex;
      const th = this.hands[tid];
      if (msg.skip || tid === pid || !th || isNaN(ci) || ci < 0 || ci >= th.length) {
        broadcastLog(`${name} declined the reveal.`);
      } else {
        const c = th[ci];
        c.colorHints = [c.suit]; c.rankHint = c.rank;
        broadcastLog(`${name} revealed ${this.players[tid].name}'s card: ${this.suitName(c.suit)} ${c.rank}.`, true);
      }
    }
    this.pendingBonus = null;
    this.afterAction();
  },

  afterAction() {
    if (this.fuses <= 0) { this.gameOver("boom"); return; }
    if (this.fireworks.every((f) => f === 5)) { this.gameOver("perfect"); return; }
    if (this.opts.perfectGame && this.perfectImpossible()) { this.gameOver("dead"); return; }
    this.nextTurn();
  },

  // Perfect Game: it's over if some still-needed card has had all copies discarded.
  perfectImpossible() {
    for (let s = 0; s < this.suits.length; s++) {
      const def = this.suits[s];
      const played = this.fireworks[s];
      // ranks still required for this suit to reach 5
      const ranks = [];
      if (def.reversed) { for (let r = 5 - played; r >= 1; r--) ranks.push(r); }
      else { for (let r = played + 1; r <= 5; r++) ranks.push(r); }
      for (const r of ranks) {
        const total = def.counts[r] || 0;
        const gone = this.discard.filter((d) => d.suit === s && d.rank === r).length;
        if (total - gone <= 0) return true;
      }
    }
    return false;
  },

  nextTurn() {
    if (this.finalTurnsLeft !== null) {
      if (this.finalTurnsLeft <= 0) { this.gameOver("deck"); return; }
      this.finalTurnsLeft--;
    }
    const i = this.order.indexOf(this.turn);
    this.turn = this.order[(i + 1) % this.order.length];
    this.broadcast();
  },

  gameOver(reason) {
    this.phase = "gameover";
    this.turn = null;
    this.pendingBonus = null;
    this.reason = reason;
    const s = this.score(), max = this.maxScore();
    if (reason === "perfect") broadcastLog(`Perfect display! Final score: ${s}/${max}.`, true);
    else if (reason === "boom") broadcastLog(`The show blew up. Final score: ${s}/${max}.`, true);
    else if (reason === "abandoned") broadcastLog(`A player left — game ended. Score: ${s}/${max}.`, true);
    else if (reason === "dead") broadcastLog(`A perfect display is no longer possible. Final score: ${s}/${max}.`, true);
    else broadcastLog(`Game over. Final score: ${s}/${max}.`, true);
    this.broadcast();
  },

  // ---- state projection & broadcast ----
  knownColorFor(c) {
    const hs = c.colorHints;
    if (hs.length === 0) return null;
    if (hs.length === 1) return hs[0];
    // Two different color clues on one card means it must be the wild Rainbow.
    const wild = this.suits.findIndex((s) => s.matchAny);
    return wild >= 0 ? wild : hs[hs.length - 1];
  },

  projCard(c, own) {
    const hide = this.opts.hideClues; // Memory Mode: no persistent clue markers
    const card = {
      suit: own ? null : c.suit,
      rank: own ? null : c.rank,
      knownColor: hide ? null : this.knownColorFor(c),
      knownRank: hide ? null : (c.rankHint != null ? c.rankHint : null),
      hidden: own,
    };
    // Negative deductions are surfaced only on your own hand, and only when
    // clue markers are allowed (not Memory Mode).
    if (own && !hide) {
      card.negColors = c.negColors.slice();
      card.negRanks = c.negRanks.slice();
    }
    return card;
  },

  projectFor(viewerId) {
    const seats = this.order.map((id) => {
      const own = id === viewerId;
      return {
        id, name: this.players[id].name, isTurn: this.turn === id,
        cards: this.hands[id].map((c) => this.projCard(c, own)),
      };
    });
    let pending = null;
    if (this.pendingBonus) {
      pending = { pid: this.pendingBonus.pid, type: this.pendingBonus.type };
      if (this.pendingBonus.type === "shuffle") {
        pending.discards = this.discard.map((c, i) => ({ suit: c.suit, rank: c.rank, index: i }));
      }
    }
    return {
      phase: this.phase,
      seats,
      suits: this.suits.map((s) => ({ key: s.key, letter: s.letter, name: s.name, hasColorClue: s.hasColorClue, reversed: s.reversed })),
      fireworks: this.fireworks.slice(),
      discard: this.discard.map((c) => ({ suit: c.suit, rank: c.rank })),
      deckCount: this.deck.length,
      hints: this.hints,
      fuses: this.fuses,
      score: this.score(),
      maxScore: this.maxScore(),
      masterArtisan: this.opts.masterArtisan,
      bonusRemaining: this.bonusBag.length,
      hideClues: this.opts.hideClues,
      pendingBonus: pending,
      reason: this.reason,
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
let uiMode = null;         // null | 'play' | 'discard' | 'hint'
let selectedTarget = null; // opponent id for a hint
let selectedCardIdx = null;// which of that opponent's cards was clicked
let SUITDEFS = [];         // suit defs from the current state
let dragFrom = null;       // hand index being dragged

function suitKey(i) { return SUITDEFS[i] ? SUITDEFS[i].key : "w"; }
function suitLetter(i) { return SUITDEFS[i] ? SUITDEFS[i].letter : "?"; }

// A fully visible colored card (opponents, fireworks, discards).
function suitCardEl(suitIdx, rank, opts = {}) {
  const el = document.createElement("div");
  el.className = "card " + (opts.big ? "big " : "") + (opts.mini ? "mini " : "") + "h" + suitKey(suitIdx);
  el.innerHTML = `<span class="r">${rank}</span><span class="cl">${suitLetter(suitIdx)}</span>`;
  return el;
}
function fullCardEl(card, opts = {}) { return suitCardEl(card.suit, card.rank, opts); }

// My own card: a back, tinted/labeled with whatever hints I've received.
function myCardEl(info, opts = {}) {
  const el = document.createElement("div");
  el.className = "card" + (opts.big ? " big" : "");
  if (info.knownColor != null) {
    el.classList.add("h" + suitKey(info.knownColor));
    el.innerHTML = `<span class="r">${info.knownRank != null ? info.knownRank : "?"}</span>`;
  } else if (info.knownRank != null) {
    el.classList.add("back", "known");
    el.innerHTML = `<span class="r">${info.knownRank}</span>`;
  } else {
    el.classList.add("back");
  }
  return el;
}

// Tooltip listing the clues this card has been shown NOT to be.
function negTooltip(info, state) {
  if (!info.negColors && !info.negRanks) return "";
  const parts = [];
  if (info.negColors && info.negColors.length) {
    parts.push("not " + info.negColors.map((i) => state.suits[i].name).join(", "));
  }
  if (info.negRanks && info.negRanks.length) {
    parts.push("not " + info.negRanks.slice().sort((a, b) => a - b).join(", "));
  }
  return parts.length ? "Ruled out — " + parts.join("; ") : "";
}

// Enable drag-to-reorder for a hand card at index `idx`.
function makeDraggable(el, idx) {
  el.setAttribute("draggable", "true");
  el.addEventListener("dragstart", (e) => {
    dragFrom = idx;
    el.classList.add("dragging");
    if (e.dataTransfer) { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", String(idx)); }
  });
  el.addEventListener("dragend", () => { dragFrom = null; el.classList.remove("dragging"); });
  el.addEventListener("dragover", (e) => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = "move"; el.classList.add("dragover"); });
  el.addEventListener("dragleave", () => el.classList.remove("dragover"));
  el.addEventListener("drop", (e) => {
    e.preventDefault();
    el.classList.remove("dragover");
    const from = dragFrom != null ? dragFrom : parseInt(e.dataTransfer && e.dataTransfer.getData("text/plain"), 10);
    if (from != null && !isNaN(from) && from !== idx) submit({ action: "reorder", from, to: idx });
  });
}

function dotRow(cls, filled, total) {
  const w = document.createElement("span");
  w.className = "dots";
  for (let i = 0; i < total; i++) {
    const d = document.createElement("span");
    d.className = "dot " + cls + (i < filled ? "" : " off");
    w.appendChild(d);
  }
  return w;
}

function renderState(state) {
  lastState = state;
  SUITDEFS = state.suits || [];
  show("table");
  const meId = Net.role === "host" ? 0 : Net.myId;
  const mySeat = state.seats.find((s) => s.id === meId) || null;
  const myTurn = mySeat && mySeat.isTurn && state.phase === "playing";
  const bonusMine = state.pendingBonus && state.pendingBonus.pid === meId;
  const revealMode = bonusMine && state.pendingBonus.type === "reveal";

  // opponents (face-up). Cards are clickable when giving a hint or when the
  // reveal bonus is active.
  const hintMode = myTurn && uiMode === "hint" && !state.pendingBonus;
  const opp = $("opponents");
  opp.innerHTML = "";
  for (const s of state.seats) {
    if (s.id === meId) continue;
    let cardClick = null;
    if (hintMode) cardClick = (seatId, idx) => { selectedTarget = seatId; selectedCardIdx = idx; renderState(lastState); };
    else if (revealMode) cardClick = (seatId, idx) => submit({ action: "bonus", targetId: seatId, cardIndex: idx });
    opp.appendChild(seatEl(s, { cardClick, selectedSeat: selectedTarget, selectedIdx: selectedCardIdx }));
  }

  // my seat: name + count only (cards render in the hand zone)
  $("me").innerHTML = "";
  if (mySeat) {
    const el = document.createElement("div");
    el.className = "seat" + (mySeat.isTurn ? " turn" : "");
    el.innerHTML = `<div class="seat-name">${escapeHtml(mySeat.name)} (you)</div><div class="seat-info">${mySeat.cards.length} cards</div>`;
    $("me").appendChild(el);
  }

  // my hand: backs with any known-hint info; clickable in play/discard mode,
  // draggable any time to reorganize, with a tooltip of what each card is NOT.
  const hand = $("my-hand");
  hand.innerHTML = "";
  if (mySeat) mySeat.cards.forEach((c, idx) => {
    const el = myCardEl(c, { big: true });
    if (myTurn && !state.pendingBonus && (uiMode === "play" || uiMode === "discard")) {
      el.classList.add("askable");
      el.onclick = () => submit(uiMode === "play" ? { action: "play", index: idx } : { action: "discard", index: idx });
    }
    const tip = negTooltip(c, state);
    if (tip) el.title = tip;
    makeDraggable(el, idx);
    hand.appendChild(el);
  });

  renderShared(state);
  renderPile($("deck"), "Deck", state.deckCount, null);
  renderDiscard(state);

  $("table-msg").textContent = messageFor(state, myTurn, meId);
  renderControls(state, mySeat, myTurn, meId);

  if (Net.role === "host") {
    $("host-controls").classList.toggle("hidden", state.phase !== "gameover");
  }
}

function renderShared(state) {
  const shared = $("shared");
  shared.innerHTML = "";
  const row = document.createElement("div");
  row.className = "cards fireworks";
  for (let i = 0; i < state.suits.length; i++) {
    const count = state.fireworks[i];
    if (count > 0) {
      const rank = state.suits[i].reversed ? 6 - count : count;
      row.appendChild(suitCardEl(i, rank, { big: true }));
    } else {
      const ph = document.createElement("div");
      ph.className = "card big placeholder";
      ph.innerHTML = `<span class="r">${state.suits[i].letter}</span>`;
      row.appendChild(ph);
    }
  }
  shared.appendChild(row);

  const status = document.createElement("div");
  status.className = "status";
  const s1 = document.createElement("span");
  s1.innerHTML = `Score <b>${state.score}</b>/${state.maxScore}`;
  const s2 = document.createElement("span"); s2.className = "stat"; s2.append("Hints ", dotRow("hint", state.hints, MAX_HINTS));
  const s3 = document.createElement("span"); s3.className = "stat"; s3.append("Fuses ", dotRow("fuse", state.fuses, START_FUSES));
  status.append(s1, s2, s3);
  if (state.masterArtisan) {
    const s4 = document.createElement("span"); s4.className = "stat";
    s4.innerHTML = `Bonus tokens <b>${state.bonusRemaining}</b>`;
    status.append(s4);
  }
  shared.appendChild(status);
}

function renderDiscard(state) {
  const dz = $("discard");
  dz.innerHTML = "";
  if (!state.discard.length) return;
  const wrap = document.createElement("div");
  wrap.className = "cards discard-cards";
  const sorted = state.discard.slice().sort((a, b) => a.suit - b.suit || a.rank - b.rank);
  for (const c of sorted) wrap.appendChild(fullCardEl(c, { mini: true }));
  dz.appendChild(wrap);
}

function seatEl(s, opts) {
  opts = opts || {};
  const el = document.createElement("div");
  el.className = "seat" + (s.isTurn ? " turn" : "");
  el.innerHTML = `<div class="seat-name">${escapeHtml(s.name)}</div>`;
  const cards = document.createElement("div");
  cards.className = "cards";
  s.cards.forEach((c, idx) => {
    const cc = fullCardEl(c, {});
    if (c.knownColor != null || c.knownRank != null) {
      const badge = document.createElement("span");
      badge.className = "known-badge";
      badge.textContent = (c.knownColor != null ? "C" : "") + (c.knownRank != null ? "#" : "");
      cc.appendChild(badge);
    }
    if (opts.cardClick) {
      cc.classList.add("askable");
      if (opts.selectedSeat === s.id && opts.selectedIdx === idx) cc.classList.add("selected");
      cc.onclick = () => opts.cardClick(s.id, idx);
    }
    cards.appendChild(cc);
  });
  el.appendChild(cards);
  return el;
}

function messageFor(state, myTurn, meId) {
  if (state.phase === "gameover") {
    if (state.reason === "boom") return `Boom — the fireworks blew up. Final score ${state.score}/${state.maxScore}.`;
    if (state.reason === "perfect") return `A perfect display! ${state.score}/${state.maxScore}.`;
    if (state.reason === "dead") return `A perfect display is no longer possible. Final score ${state.score}/${state.maxScore}.`;
    if (state.reason === "abandoned") return `A player left. Game ended at ${state.score}/${state.maxScore}.`;
    return `Game over. Final score ${state.score}/${state.maxScore}.`;
  }
  if (state.pendingBonus) {
    const who = state.seats.find((x) => x.id === state.pendingBonus.pid);
    if (state.pendingBonus.pid === meId) return "You drew a bonus token — resolve it below.";
    return who ? `${who.name} is using a bonus token…` : "";
  }
  if (myTurn) return "Your turn — choose an action below.";
  const t = state.seats.find((x) => x.isTurn);
  return t ? `Waiting for ${t.name}…` : "";
}

function renderControls(state, mySeat, myTurn, meId) {
  const modes = $("action-modes");
  const picker = $("hint-picker");
  const bonus = $("bonus-picker");
  const hint = $("turn-hint");
  const bonusMine = state.pendingBonus && state.pendingBonus.pid === meId;

  // Bonus resolution takes over the control area.
  if (bonusMine) {
    uiMode = null; selectedTarget = null; selectedCardIdx = null;
    modes.classList.add("hidden");
    picker.classList.add("hidden");
    bonus.classList.remove("hidden");
    hint.classList.remove("hidden");
    buildBonusPicker(state);
    return;
  }
  bonus.classList.add("hidden");

  if (!myTurn || state.pendingBonus) {
    uiMode = null; selectedTarget = null; selectedCardIdx = null;
    modes.classList.add("hidden");
    picker.classList.add("hidden");
    hint.classList.add("hidden");
    return;
  }

  modes.classList.remove("hidden");
  hint.classList.remove("hidden");
  $("mode-discard").disabled = state.hints >= MAX_HINTS;
  $("mode-hint").disabled = state.hints <= 0;
  $("mode-play").classList.toggle("active", uiMode === "play");
  $("mode-discard").classList.toggle("active", uiMode === "discard");
  $("mode-hint").classList.toggle("active", uiMode === "hint");

  const cardPicked = selectedTarget != null && selectedCardIdx != null;
  if (uiMode === "play") hint.textContent = "Click one of your cards to play it.";
  else if (uiMode === "discard") hint.textContent = "Click one of your cards to discard it (regains a hint token).";
  else if (uiMode === "hint") hint.textContent = cardPicked ? "Tell them about that card:" : "Click a card in another player's hand.";
  else hint.textContent = "Choose an action: play, discard, or give a hint.";

  if (uiMode === "hint" && cardPicked) {
    picker.classList.remove("hidden");
    buildHintPicker(state);
  } else {
    picker.classList.add("hidden");
  }
}

// Options are driven by the card the player clicked: give a hint about that
// card's number, and about its color when a color clue applies.
//  - Wild Rainbow (matches any color): any real color can be used.
//  - Rainbow with its own clue: the color is Multicolor (the Rainbow suit).
//  - Black Powder (no color clue): number only.
function buildHintPicker(state) {
  const picker = $("hint-picker");
  picker.innerHTML = "";
  const target = state.seats.find((s) => s.id === selectedTarget);
  if (!target) return;
  const card = target.cards[selectedCardIdx];
  if (!card) return;
  const def = state.suits[card.suit];

  const colorBtn = (suitIdx) => {
    const b = document.createElement("button");
    b.className = "hint-btn h" + state.suits[suitIdx].key;
    b.textContent = state.suits[suitIdx].name;
    b.onclick = () => submit({ action: "hint", targetId: selectedTarget, hintType: "color", value: suitIdx });
    return b;
  };

  const colRow = document.createElement("div");
  colRow.className = "hint-row";
  if (def.matchAny) {
    // Any real color clue would touch this Rainbow card.
    for (let c = 0; c < state.suits.length; c++) if (state.suits[c].hasColorClue) colRow.appendChild(colorBtn(c));
  } else if (def.hasColorClue) {
    colRow.appendChild(colorBtn(card.suit)); // its own color (Rainbow shows as Multicolor)
  }

  const numRow = document.createElement("div");
  numRow.className = "hint-row";
  const nb = document.createElement("button");
  nb.className = "hint-btn";
  nb.textContent = "Number " + card.rank;
  nb.onclick = () => submit({ action: "hint", targetId: selectedTarget, hintType: "rank", value: card.rank });
  numRow.appendChild(nb);

  if (colRow.childNodes.length) picker.append(colRow);
  picker.append(numRow);
}

function buildBonusPicker(state) {
  const picker = $("bonus-picker");
  const hint = $("turn-hint");
  picker.innerHTML = "";
  const type = state.pendingBonus.type;

  if (type === "fuseSwap") {
    hint.textContent = "Bonus: swap fuse tokens for clue tokens (one for one).";
    const row = document.createElement("div"); row.className = "hint-row";
    const maxAmt = Math.min(2, state.fuses - 1, MAX_HINTS - state.hints);
    for (let a = 1; a <= maxAmt; a++) {
      const b = document.createElement("button");
      b.className = "hint-btn"; b.textContent = `Swap ${a}`;
      b.onclick = () => submit({ action: "bonus", amount: a });
      row.appendChild(b);
    }
    row.appendChild(skipBtn());
    picker.appendChild(row);
  } else if (type === "shuffle") {
    hint.textContent = "Bonus: choose a discarded card to shuffle back into the deck.";
    const row = document.createElement("div"); row.className = "hint-row";
    (state.pendingBonus.discards || []).forEach((d) => {
      const b = document.createElement("button");
      b.className = "hint-btn"; b.title = `${state.suits[d.suit].name} ${d.rank}`;
      b.appendChild(suitCardEl(d.suit, d.rank, { mini: true }));
      b.onclick = () => submit({ action: "bonus", discardIndex: d.index });
      row.appendChild(b);
    });
    row.appendChild(skipBtn());
    picker.appendChild(row);
  } else if (type === "reveal") {
    hint.textContent = "Bonus: click a card in an opponent's hand to reveal its color and rank.";
    const row = document.createElement("div"); row.className = "hint-row";
    row.appendChild(skipBtn());
    picker.appendChild(row);
  }
}

function skipBtn() {
  const b = document.createElement("button");
  b.className = "hint-btn"; b.textContent = "Skip";
  b.onclick = () => submit({ action: "bonus", skip: true });
  return b;
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

// Route a local (host) action or forward a guest action.
function submit(msg) {
  if (Net.role === "host") Engine.handleAction(0, msg);
  else Net.link.send({ t: "act", ...msg });
}

// ============================================================
// FRAMEWORK HOOKS + EVENT WIRING
// ============================================================
Table.configure({
  onHost() {
    Engine.addPlayer(0, Net.myName); // host is seat 0
    renderLobby();
    log("You are hosting. Add players (2–5), pick options, then Start game.", true);
  },
  onJoin(id, name, link) {
    Engine.addPlayer(id, name);
    link.send({ t: "welcome", id });
    updateHostConnCount();
    if (Engine.phase !== "lobby") Engine.broadcast();
  },
  onHostMessage(msg, link) {
    if (msg.t === "act") Engine.handleAction(link.id, msg);
  },
  onLeave(id) {
    Engine.removePlayer(id);
    if (Engine.phase === "lobby") updateHostConnCount();
  },
  render: renderState,
});
Table.maxPlayers = 5; // Hanabi seats 2–5 players

function readOpts() {
  const rainbowOn = $("opt-rainbow").checked;
  const master = $("opt-master").checked;
  return {
    rainbow: rainbowOn ? $("opt-rainbow-mode").value : "off",
    blackPowder: $("opt-black").checked,
    masterArtisan: master,
    perfectGame: $("opt-perfect").checked && !master, // mutually exclusive
    hideClues: $("opt-hideclues").checked,
  };
}

function startWithOpts() {
  Engine.opts = readOpts();
  Engine.startGame();
}

$("btn-start").onclick = startWithOpts;
$("btn-new-game").onclick = startWithOpts;

// Config UI behavior (host only, but the elements exist for everyone).
const optRainbow = $("opt-rainbow"), optMaster = $("opt-master"), optPerfect = $("opt-perfect");
if (optRainbow) optRainbow.addEventListener("change", () => {
  $("rainbow-modes").classList.toggle("hidden", !optRainbow.checked);
});
// Master Artisan and Perfect Game are mutually exclusive.
if (optMaster) optMaster.addEventListener("change", () => {
  if (optMaster.checked) optPerfect.checked = false;
  optPerfect.disabled = optMaster.checked;
});
if (optPerfect) optPerfect.addEventListener("change", () => {
  if (optPerfect.checked) optMaster.checked = false;
  optMaster.disabled = optPerfect.checked;
});

$("mode-play").onclick = () => { uiMode = "play"; selectedTarget = null; selectedCardIdx = null; renderState(lastState); };
$("mode-discard").onclick = () => {
  if ($("mode-discard").disabled) return;
  uiMode = "discard"; selectedTarget = null; selectedCardIdx = null; renderState(lastState);
};
$("mode-hint").onclick = () => {
  if ($("mode-hint").disabled) return;
  uiMode = "hint"; selectedTarget = null; selectedCardIdx = null;
  renderState(lastState);
};
