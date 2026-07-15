"use strict";
// ============================================================
// Shared card-game framework.
//
// Handles everything identical across card games: manual-signaling
// connection flow, the host/guest message plumbing, card rendering,
// the deck, logging, and setup/lobby wiring.
//
// A game plugs in its engine + rendering via Table.configure({...}),
// then wires its own start/action buttons. Star topology: the host
// runs the authoritative engine (and is player id 0); guests send
// intents and render the state the host broadcasts.
// ============================================================

const $ = (id) => document.getElementById(id);
const SUITS = ["♠", "♥", "♦", "♣"]; // spade heart diamond club
const RANK_STR = { 11: "J", 12: "Q", 13: "K", 14: "A" };

function rankLabel(r) { return RANK_STR[r] || String(r); }

// Build a DOM card. Pass null for a face-down back.
function cardEl(card, opts = {}) {
  const el = document.createElement("div");
  el.className = "card" + (opts.big ? " big" : "");
  if (!card) { el.classList.add("back"); return el; }
  if (card.suit === 1 || card.suit === 2) el.classList.add("red");
  el.innerHTML = `<span class="r">${rankLabel(card.rank)}</span><span>${SUITS[card.suit]}</span>`;
  return el;
}

// Standard 52-card shuffled deck. Cards are { rank: 2..14, suit: 0..3 }.
function makeDeck() {
  const d = [];
  for (let s = 0; s < 4; s++) for (let r = 2; r <= 14; r++) d.push({ rank: r, suit: s });
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

// Render a pile (deck or discard) into a zone: a stacked card + count.
// `top` is the visible card (a card object, or null for a face-down back).
function renderPile(zone, label, count, top) {
  zone.innerHTML = "";
  if (count <= 0) return; // empty zone hides itself via CSS
  const pile = document.createElement("div");
  pile.className = "pile";
  pile.appendChild(cardEl(top, { big: true }));
  const c = document.createElement("div");
  c.className = "pile-count";
  c.textContent = `${count}`;
  pile.appendChild(c);
  zone.appendChild(pile);
}

function log(msg, hl) {
  const el = document.createElement("div");
  if (hl) el.className = "hl";
  el.textContent = msg;
  const box = $("log");
  if (box) box.prepend(el);
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ============================================================
// PLAYER NAMES — silly auto-generated defaults + collision-free
// ============================================================
const SILLY_ADJ = ["Dancing", "Sneaky", "Jolly", "Wobbly", "Sleepy", "Grumpy", "Zippy", "Fuzzy",
  "Cosmic", "Bouncy", "Sparkly", "Cranky", "Nifty", "Peppy", "Goofy", "Sly", "Brave", "Mellow", "Snazzy", "Witty"];
const SILLY_ANIMAL = ["Otter", "Penguin", "Hedgehog", "Narwhal", "Panda", "Koala", "Wombat", "Platypus",
  "Ferret", "Llama", "Raccoon", "Quokka", "Axolotl", "Meerkat", "Pangolin", "Capybara", "Hippo", "Sloth", "Lemur", "Puffin"];
function sillyName() {
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  return pick(SILLY_ADJ) + " " + pick(SILLY_ANIMAL);
}

// Host-side registry so no two seated players share a name. Returns the
// unique name actually assigned (appending " 2", " 3", … on collision).
function claimName(id, desired) {
  const taken = new Set(
    Object.keys(Net.usedNames).filter((k) => +k !== id).map((k) => Net.usedNames[k].toLowerCase())
  );
  let name = desired, n = 2;
  while (taken.has(name.toLowerCase())) name = `${desired} ${n++}`;
  Net.usedNames[id] = name;
  return name;
}
function releaseName(id) { delete Net.usedNames[id]; }

// ============================================================
// NETWORK LAYER
// ============================================================
const Net = {
  role: null,        // 'host' | 'guest'
  myName: "",
  links: [],         // host: one PeerLink per guest
  nextGuestId: 1,
  link: null,        // guest: single link to host
  myId: null,
  usedNames: {},     // host: id -> assigned unique name
};

// Hooks a game supplies. Defaults are no-ops so a game only overrides
// what it needs.
const Table = {
  maxPlayers: Infinity, // a game may cap its table size
  handlers: {
    onHost() {},                 // host chosen: add self as player 0, render lobby, log
    onJoin(id, name, link) {},   // host received a join: register + welcome + maybe broadcast
    onHostMessage(msg, link) {}, // host received a game message (ask/action/etc)
    onLeave(id, link) {},        // host: a guest disconnected
    onWelcome(msg) {},           // guest: accepted by host (extra work beyond lobby view)
    onGuestMessage(msg) {},      // guest received a non-standard message
    render(state) {},            // render a broadcast state snapshot
  },
  configure(h) {
    if (typeof h.maxPlayers === "number") { this.maxPlayers = h.maxPlayers; delete h.maxPlayers; }
    Object.assign(this.handlers, h);
  },
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
    // Net.links already includes this guest; +1 for the host.
    if (Net.links.length + 1 > Table.maxPlayers) { link.send({ t: "full" }); return; }
    Table.handlers.onJoin(link.id, claimName(link.id, msg.name), link);
  } else Table.handlers.onHostMessage(msg, link);
}

function hostOnClose(link) {
  releaseName(link.id);
  Table.handlers.onLeave(link.id, link);
}

function sendToPlayer(pid, obj) {
  if (pid === 0) return; // host renders locally
  const link = Net.links.find((l) => l.id === pid);
  if (link) link.send(obj);
}

function broadcastLog(msg, hl) {
  log(msg, hl);
  for (const l of Net.links) l.send({ t: "log", msg, hl });
}

// -------- GUEST networking --------
async function guestCreateOffer() {
  Net.link = new RTC.PeerLink({
    onOpen: () => Net.link.send({ t: "join", name: Net.myName }),
    onMessage: (msg) => guestOnMessage(msg),
    onClose: () => { const m = $("table-msg"); if (m) m.textContent = "Disconnected from host."; },
  });
  return Net.link.initGuest();
}

function guestOnMessage(msg) {
  if (msg.t === "welcome") {
    Net.myId = msg.id;
    show("lobby");
    const gm = $("lobby-guest-msg");
    if (gm) gm.classList.remove("hidden");
    Table.handlers.onWelcome(msg);
  } else if (msg.t === "state") {
    Table.handlers.render(msg.state);
  } else if (msg.t === "log") {
    log(msg.msg, msg.hl);
  } else if (msg.t === "full") {
    alert("Sorry — the table is full (maximum players reached).");
  } else {
    Table.handlers.onGuestMessage(msg);
  }
}

// ============================================================
// VIEW SWITCHING
// ============================================================
function show(which) {
  for (const s of ["setup", "lobby", "table"]) {
    $(s).classList.toggle("hidden", which !== s);
  }
}

// ============================================================
// SETUP / CONNECTION WIRING (identical across games)
// ============================================================
function setName() {
  const n = $("name-input").value.trim();
  return n || sillyName();
}

function copyFrom(id) {
  const ta = $(id);
  ta.select();
  navigator.clipboard.writeText(ta.value).catch(() => {});
}

// Pre-fill a silly default name the player can overwrite by typing.
(function () {
  const ni = $("name-input");
  if (ni && !ni.value) ni.value = sillyName();
})();

$("btn-host").onclick = () => {
  Net.role = "host";
  Net.myName = claimName(0, setName());
  $("setup-choose").classList.add("hidden");
  $("setup-host").classList.remove("hidden");
  $("lobby").classList.remove("hidden");
  $("lobby-host-controls").classList.remove("hidden");
  Table.handlers.onHost();
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

$("btn-copy-offer").onclick = () => copyFrom("guest-offer-code");
$("btn-copy-reply").onclick = () => copyFrom("host-reply-code");
