// Minimal RFC 6455 WebSocket server side (zero dependencies), enough for the WebCraft dedicated server:
// text + binary messages, fragmentation, ping / pong, close handshake, payload limits, a heartbeat that
// drops dead peers and a send-buffer limit that drops clients which cannot keep up. No extensions.
//
//   const ws = acceptWebSocket(req, socket, head, { maxPayload });   // inside http 'upgrade'
//   ws.on('message', (data, isBinary) => ...)                       // data: string | Buffer
//   ws.on('close', (code, reason) => ...)
//   ws.send('text') / ws.send(uint8array) / ws.close(1000, 'bye')
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OP_CONT = 0x0, OP_TEXT = 0x1, OP_BINARY = 0x2, OP_CLOSE = 0x8, OP_PING = 0x9, OP_PONG = 0xa;

const CONNECTING = 0, OPEN = 1, CLOSING = 2, CLOSED = 3;

export class WebSocketConnection extends EventEmitter {
  /**
   * @param {import('node:net').Socket} socket upgraded socket
   * @param {{ maxPayload?: number, maxBuffered?: number, heartbeatMs?: number }} [opts]
   */
  constructor(socket, opts = {}) {
    super();
    this.socket = socket;
    this.maxPayload = opts.maxPayload ?? 1 << 20;
    this.maxBuffered = opts.maxBuffered ?? 4 << 20;
    this.readyState = OPEN;
    this._buf = Buffer.alloc(0);
    this._frag = null;            // { opcode, parts: Buffer[], size }
    this._alive = true;
    this._closeTimer = null;
    socket.setNoDelay(true);
    socket.on('data', (d) => this._onData(d));
    socket.on('error', () => this._terminate(1006, ''));
    socket.on('close', () => this._terminate(1006, ''));
    const hb = opts.heartbeatMs ?? 20000;
    if (hb > 0) {
      this._heartbeat = setInterval(() => {
        if (!this._alive) {
          this._terminate(1006, 'heartbeat timeout');
          return;
        }
        this._alive = false;
        this._sendFrame(OP_PING, Buffer.alloc(0));
      }, hb);
      this._heartbeat.unref?.();
    }
  }

  /** Bytes queued in the socket that the peer has not taken yet. */
  get bufferedAmount() {
    return this.socket.writableLength;
  }

  /** Send a text (string) or binary (Buffer / Uint8Array / ArrayBuffer) message. Returns false if dropped. */
  send(data) {
    if (this.readyState !== OPEN) return false;
    if (this.socket.writableLength > this.maxBuffered) {
      // The client cannot keep up (or is gone without a FIN): better to drop it than to grow forever.
      this.close(1008, 'too slow');
      return false;
    }
    if (typeof data === 'string') return this._sendFrame(OP_TEXT, Buffer.from(data, 'utf8'));
    const buf = Buffer.isBuffer(data) ? data
      : data instanceof ArrayBuffer ? Buffer.from(data) : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    return this._sendFrame(OP_BINARY, buf);
  }

  /** Start the closing handshake (the socket is destroyed if the peer does not answer within 3 s). */
  close(code = 1000, reason = '') {
    if (this.readyState !== OPEN) return;
    this.readyState = CLOSING;
    const r = Buffer.from(String(reason).slice(0, 120), 'utf8');
    const payload = Buffer.alloc(2 + r.length);
    payload.writeUInt16BE(code, 0);
    r.copy(payload, 2);
    this._sendFrame(OP_CLOSE, payload);
    this._closeCode = code;
    this._closeReason = String(reason);
    this._closeTimer = setTimeout(() => this._terminate(code, reason), 3000);
    this._closeTimer.unref?.();
  }

  _sendFrame(opcode, payload) {
    const n = payload.length;
    let header;
    if (n < 126) {
      header = Buffer.alloc(2);
      header[1] = n;
    } else if (n < 65536) {
      header = Buffer.alloc(4);
      header[1] = 126;
      header.writeUInt16BE(n, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(n), 2);
    }
    header[0] = 0x80 | opcode;
    try {
      this.socket.cork();
      this.socket.write(header);
      if (n > 0) this.socket.write(payload);
      this.socket.uncork();
      return true;
    } catch {
      this._terminate(1006, '');
      return false;
    }
  }

  _onData(chunk) {
    this._alive = true;
    this._buf = this._buf.length === 0 ? chunk : Buffer.concat([this._buf, chunk]);
    while (this.readyState !== CLOSED) {
      const buf = this._buf;
      if (buf.length < 2) return;
      const fin = (buf[0] & 0x80) !== 0;
      const rsv = buf[0] & 0x70;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (rsv !== 0 || !masked) {
        this._fail(1002, rsv !== 0 ? 'unexpected RSV bits' : 'client frames must be masked');
        return;
      }
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        const big = buf.readBigUInt64BE(2);
        if (big > BigInt(this.maxPayload)) {
          this._fail(1009, 'message too big');
          return;
        }
        len = Number(big);
        off = 10;
      }
      if (len > this.maxPayload) {
        this._fail(1009, 'message too big');
        return;
      }
      if (buf.length < off + 4 + len) return;
      const mask = buf.subarray(off, off + 4);
      const payload = Buffer.allocUnsafe(len);
      const data = buf.subarray(off + 4, off + 4 + len);
      for (let i = 0; i < len; i++) payload[i] = data[i] ^ mask[i & 3];
      this._buf = buf.subarray(off + 4 + len);
      this._onFrame(fin, opcode, payload);
    }
  }

  _onFrame(fin, opcode, payload) {
    if (opcode >= 0x8) {
      if (!fin || payload.length > 125) {
        this._fail(1002, 'bad control frame');
        return;
      }
      if (opcode === OP_PING) this._sendFrame(OP_PONG, payload);
      else if (opcode === OP_CLOSE) this._onClose(payload);
      else if (opcode !== OP_PONG) this._fail(1002, 'unknown opcode');
      return;
    }
    if (opcode === OP_CONT) {
      if (!this._frag) {
        this._fail(1002, 'unexpected continuation');
        return;
      }
      this._frag.parts.push(payload);
      this._frag.size += payload.length;
      if (this._frag.size > this.maxPayload) {
        this._fail(1009, 'message too big');
        return;
      }
      if (fin) {
        const { opcode: op, parts } = this._frag;
        this._frag = null;
        this._deliver(op, Buffer.concat(parts));
      }
      return;
    }
    if (opcode !== OP_TEXT && opcode !== OP_BINARY) {
      this._fail(1002, 'unknown opcode');
      return;
    }
    if (this._frag) {
      this._fail(1002, 'expected continuation');
      return;
    }
    if (!fin) {
      this._frag = { opcode, parts: [payload], size: payload.length };
      return;
    }
    this._deliver(opcode, payload);
  }

  _deliver(opcode, payload) {
    if (this.readyState !== OPEN) return;
    if (opcode === OP_TEXT) {
      const text = payload.toString('utf8');
      this.emit('message', text, false);
    } else {
      this.emit('message', payload, true);
    }
  }

  _onClose(payload) {
    const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
    const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
    if (this.readyState === OPEN) {
      // Echo the close frame, then end the TCP connection.
      this.readyState = CLOSING;
      const echo = Buffer.alloc(2);
      echo.writeUInt16BE(code === 1005 ? 1000 : code, 0);
      this._sendFrame(OP_CLOSE, echo);
    }
    this._terminate(code, reason);
  }

  _fail(code, reason) {
    if (this.readyState === OPEN) this.close(code, reason);
    this._buf = Buffer.alloc(0);
    setImmediate(() => this._terminate(code, reason));
  }

  _terminate(code, reason) {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    clearInterval(this._heartbeat);
    clearTimeout(this._closeTimer);
    try {
      this.socket.end();
      this.socket.destroy();
    } catch { /* already gone */ }
    this.emit('close', this._closeCode ?? code, this._closeReason ?? reason);
  }
}

WebSocketConnection.CONNECTING = CONNECTING;
WebSocketConnection.OPEN = OPEN;
WebSocketConnection.CLOSING = CLOSING;
WebSocketConnection.CLOSED = CLOSED;

/**
 * Complete a WebSocket upgrade request. Returns the connection, or null after answering the request with
 * an HTTP error (not a WebSocket handshake).
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:net').Socket} socket
 * @param {Buffer} head
 */
export function acceptWebSocket(req, socket, head, opts = {}) {
  const key = req.headers['sec-websocket-key'];
  const upgrade = String(req.headers.upgrade ?? '').toLowerCase();
  const version = req.headers['sec-websocket-version'];
  if (req.method !== 'GET' || upgrade !== 'websocket' || typeof key !== 'string' || version !== '13') {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    return null;
  }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const ws = new WebSocketConnection(socket, opts);
  if (head && head.length > 0) ws._onData(head);
  return ws;
}
