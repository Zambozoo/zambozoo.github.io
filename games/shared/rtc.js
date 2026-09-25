// Manual copy-paste WebRTC signaling. Star topology: the host is the hub.
// Each guest opens ONE connection to the host. The guest is always the
// offerer (and creates the data channel); the host is always the answerer.
//
// Flow:
//   Guest: makeGuestLink() -> getLocalCode()  ==(paste to host)==>
//   Host:  makeHostLink(guestCode) -> getLocalCode()  ==(paste back to guest)==>
//   Guest: acceptRemoteCode(hostCode)  -> channel opens on both sides.

// STUN alone only discovers a peer's public address; it cannot carry traffic.
// When either side is behind a symmetric NAT there is no direct path at all,
// so a TURN relay is required for players on different networks. Fill this in
// with real credentials to enable cross-network play.
const TURN_SERVERS = [
  // { urls: "turn:turn.example.com:3478", username: "...", credential: "..." },
  // { urls: "turns:turn.example.com:5349", username: "...", credential: "..." },
];

const ICE_CONFIG = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    ...TURN_SERVERS,
  ],
};

// Gathering normally reports "complete" in about a second and we resolve
// immediately; this cap only matters when a STUN round-trip is slow. At the
// old 4s the cap fired first on slower links, so the pasted code carried only
// LAN candidates and could never reach a peer on another network.
const ICE_BUDGET_MS = 12000;

// Wait until ICE gathering finishes so the SDP blob is self-contained
// (non-trickle) and can be pasted as a single code. Resolves true if the
// safety timeout fired first, meaning the pasted code is missing candidates.
function waitForIce(pc) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === "complete") return resolve(false);
    const done = (timedOut) => {
      clearTimeout(timer);
      pc.removeEventListener("icegatheringstatechange", check);
      resolve(timedOut);
    };
    const check = () => {
      if (pc.iceGatheringState === "complete") done(false);
    };
    const timer = setTimeout(() => done(true), ICE_BUDGET_MS);
    pc.addEventListener("icegatheringstatechange", check);
  });
}

// Count the candidates actually embedded in an SDP blob. This is what the
// far side receives, so it is the ground truth for "what did we send".
function summarizeSdp(sdp) {
  const out = { host: 0, srflx: 0, relay: 0, prflx: 0, mdns: 0 };
  for (const line of (sdp || "").split(/\r?\n/)) {
    if (!line.startsWith("a=candidate:")) continue;
    const m = /\btyp (\w+)/.exec(line);
    if (m && out[m[1]] !== undefined) out[m[1]]++;
    // Chrome hides private IPs behind mDNS names that only resolve on the
    // same LAN; such a candidate is useless to a remote peer.
    if (/\s\S+\.local\s/.test(line)) out.mdns++;
  }
  return out;
}

// Which candidate pair the connection actually settled on.
async function selectedPair(pc) {
  try {
    const stats = await pc.getStats();
    let pair = null;
    stats.forEach((r) => {
      if (r.type === "candidate-pair" && r.state === "succeeded" && (r.nominated || !pair)) pair = r;
    });
    if (!pair) return null;
    const local = stats.get(pair.localCandidateId);
    const remote = stats.get(pair.remoteCandidateId);
    return {
      local: local && local.candidateType,
      remote: remote && remote.candidateType,
      protocol: local && local.protocol,
    };
  } catch {
    return null;
  }
}

function encode(desc) {
  return btoa(JSON.stringify({ type: desc.type, sdp: desc.sdp }));
}
function decode(code) {
  return JSON.parse(atob(code.trim()));
}

// A single peer connection + data channel, with pluggable callbacks.
class PeerLink {
  constructor(handlers = {}) {
    this.pc = new RTCPeerConnection(ICE_CONFIG);
    this.dc = null;
    this.localCode = null;
    this.handlers = handlers; // { onOpen, onMessage, onClose, onDiag }
    this.id = null; // assigned by the game layer
    this.diag = {
      state: "new",
      local: null,      // candidate counts in the SDP we sent
      remote: null,     // candidate counts in the SDP we received
      gatherMs: null,
      timedOut: false,
      pair: null,       // candidate pair actually selected
    };

    this.pc.addEventListener("connectionstatechange", async () => {
      const s = this.pc.connectionState;
      this._diag({ state: s });
      if (s === "connected") this._diag({ pair: await selectedPair(this.pc) });
      if (s === "failed" || s === "disconnected" || s === "closed") {
        this.handlers.onClose && this.handlers.onClose(this);
      }
    });
  }

  _diag(patch) {
    Object.assign(this.diag, patch);
    this.handlers.onDiag && this.handlers.onDiag(this);
  }

  async _finishLocal() {
    const t0 = performance.now();
    const timedOut = await waitForIce(this.pc);
    this.localCode = encode(this.pc.localDescription);
    this._diag({
      gatherMs: Math.round(performance.now() - t0),
      timedOut,
      local: summarizeSdp(this.pc.localDescription.sdp),
    });
    return this.localCode;
  }

  _bindChannel(dc) {
    this.dc = dc;
    dc.addEventListener("open", () => this.handlers.onOpen && this.handlers.onOpen(this));
    dc.addEventListener("close", () => this.handlers.onClose && this.handlers.onClose(this));
    dc.addEventListener("message", (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { msg = e.data; }
      this.handlers.onMessage && this.handlers.onMessage(msg, this);
    });
  }

  // Guest side: create the offer + data channel.
  async initGuest() {
    this._bindChannel(this.pc.createDataChannel("game"));
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    return this._finishLocal();
  }

  // Host side: consume the guest's offer, produce an answer.
  async initHost(guestCode) {
    this.pc.addEventListener("datachannel", (e) => this._bindChannel(e.channel));
    const remote = decode(guestCode);
    await this.pc.setRemoteDescription(remote);
    this._diag({ remote: summarizeSdp(remote.sdp) });
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    return this._finishLocal();
  }

  // Guest side: finish the handshake with the host's answer.
  async acceptRemoteCode(hostCode) {
    const remote = decode(hostCode);
    await this.pc.setRemoteDescription(remote);
    this._diag({ remote: summarizeSdp(remote.sdp) });
  }

  send(obj) {
    if (this.dc && this.dc.readyState === "open") {
      this.dc.send(JSON.stringify(obj));
    }
  }

  isOpen() {
    return this.dc && this.dc.readyState === "open";
  }

  close() {
    try { this.dc && this.dc.close(); } catch {}
    try { this.pc.close(); } catch {}
  }
}

window.RTC = { PeerLink };
