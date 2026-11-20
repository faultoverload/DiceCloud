// Minimal Meteor DDP client: connect, log in, call methods, subscribe and collect documents.
// Uses the WebSocket client built into Node 22.
import crypto from 'node:crypto';

/** The server refused the credentials. Never retried: the source is a volunteer-run service. */
export class LoginError extends Error {}

export const errorText = (e) => (e ? `${e.error || ''} ${e.reason || e.message || ''}`.trim() : 'unknown error');

export class DDP {
  constructor(url) {
    this.url = url;
    this.n = 0;
    this.pending = new Map();
    this.collections = new Map();
    this.closed = true;
  }

  /** Documents received for a collection, by id */
  col(name) {
    if (!this.collections.has(name)) this.collections.set(name, new Map());
    return this.collections.get(name);
  }

  async connect(timeoutMs = 30000) {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    this.closed = false;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error('connect timeout')); this.close(); }, timeoutMs);
      const fail = (error) => { clearTimeout(timer); reject(error); };
      ws.addEventListener('open', () => this.send({ msg: 'connect', version: '1', support: ['1'] }));
      ws.addEventListener('error', (event) => fail(new Error(`websocket error: ${event.message || event.error?.message || 'connection failed'}`)));
      ws.addEventListener('close', () => {
        this.closed = true;
        fail(new Error('socket closed'));
        for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('socket closed')); }
        this.pending.clear();
      });
      ws.addEventListener('message', (event) => {
        let d;
        try { d = JSON.parse(event.data); } catch { return; }
        if (d.msg === 'connected') { clearTimeout(timer); resolve(); return; }
        if (d.msg === 'failed') { fail(new Error('DDP version rejected')); return; }
        this.dispatch(d);
      });
    });
  }

  /** Password login as the Meteor accounts-password client does it (the digest is sent, not the password). */
  async login(username, password) {
    const user = username.includes('@') ? { email: username } : { username };
    const result = await this.call('login', [{
      user,
      password: { digest: crypto.createHash('sha256').update(password).digest('hex'), algorithm: 'sha-256' },
    }]);
    if (result.error) throw new LoginError(`login failed: ${errorText(result.error)}`);
    return result.result;
  }

  send(o) { this.ws.send(JSON.stringify(o)); }

  dispatch(d) {
    switch (d.msg) {
      case 'ping': this.send({ msg: 'pong', id: d.id }); break;
      case 'added': this.col(d.collection).set(d.id, { _id: d.id, ...(d.fields || {}) }); break;
      case 'changed': {
        const doc = this.col(d.collection).get(d.id) || { _id: d.id };
        Object.assign(doc, d.fields || {});
        (d.cleared || []).forEach((key) => delete doc[key]);
        this.col(d.collection).set(d.id, doc);
        break;
      }
      case 'removed': this.col(d.collection).delete(d.id); break;
      case 'result': this.settle(`m${d.id}`, d); break;
      case 'ready': (d.subs || []).forEach((id) => this.settle(`s${id}`, { ok: true })); break;
      case 'nosub':
        // Either the refusal of a pending subscription, or the acknowledgement of an unsub
        if (!this.settle(`s${d.id}`, { ok: false, error: d.error })) this.settle(`u${d.id}`, { ok: true });
        break;
    }
  }

  settle(key, value) {
    const p = this.pending.get(key);
    if (!p) return false;
    clearTimeout(p.timer);
    this.pending.delete(key);
    p.resolve(value);
    return true;
  }

  wait(key, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(key); reject(new Error(`timeout waiting for ${key}`)); }, timeoutMs);
      this.pending.set(key, { resolve, reject, timer });
    });
  }

  call(method, params, timeoutMs = 60000) {
    const id = String(++this.n);
    const p = this.wait(`m${id}`, timeoutMs);
    this.send({ msg: 'method', method, params, id });
    return p;
  }

  /** Resolves { ok, error, id } once the server says `ready`, or refuses with `nosub`. */
  async sub(name, params, timeoutMs = 120000) {
    const id = String(++this.n);
    const p = this.wait(`s${id}`, timeoutMs);
    this.send({ msg: 'sub', id, name, params });
    return { ...(await p), id };
  }

  async unsub(id, timeoutMs = 180000) {
    const p = this.wait(`u${id}`, timeoutMs);
    this.send({ msg: 'unsub', id });
    await p;
  }

  close() {
    try { this.ws?.close(); } catch { /* already closed */ }
  }
}
