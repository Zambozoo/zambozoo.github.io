// Manual copy-paste WebRTC signaling. Star topology: the host is the hub.
// Each guest opens ONE connection to the host. The guest is always the
// offerer (and creates the data channel); the host is always the answerer.
//
// Flow:
//   Guest: makeGuestLink() -> getLocalCode()  ==(paste to host)==>
//   Host:  makeHostLink(guestCode) -> getLocalCode()  ==(paste back to guest)==>
//   Guest: acceptRemoteCode(hostCode)  -> channel opens on both sides.

const ICE_CONFIG = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ],
};

// Wait until ICE gathering finishes so the SDP blob is self-contained
// (non-trickle) and can be pasted as a single code.
function waitForIce(pc) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === "complete") return resolve();
    const check = () => {
      if (pc.iceGatheringState === "complete") {
        pc.removeEventListener("icegatheringstatechange", check);
        resolve();
      }
    };
    pc.addEventListener("icegatheringstatechange", check);
    // Safety timeout in case a candidate stalls.
    setTimeout(resolve, 4000);
  });
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
    this.handlers = handlers; // { onOpen, onMessage, onClose }
    this.id = null; // assigned by the game layer

    this.pc.addEventListener("connectionstatechange", () => {
      const s = this.pc.connectionState;
      if (s === "failed" || s === "disconnected" || s === "closed") {
        this.handlers.onClose && this.handlers.onClose(this);
      }
    });
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
    await waitForIce(this.pc);
    this.localCode = encode(this.pc.localDescription);
    return this.localCode;
  }

  // Host side: consume the guest's offer, produce an answer.
  async initHost(guestCode) {
    this.pc.addEventListener("datachannel", (e) => this._bindChannel(e.channel));
    await this.pc.setRemoteDescription(decode(guestCode));
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    await waitForIce(this.pc);
    this.localCode = encode(this.pc.localDescription);
    return this.localCode;
  }

  // Guest side: finish the handshake with the host's answer.
  async acceptRemoteCode(hostCode) {
    await this.pc.setRemoteDescription(decode(hostCode));
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
