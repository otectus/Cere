/**
 * Broadcast delivery to desktop clients. Each frame is serialized once. A client whose socket is
 * backed up (a busy interface) keeps only the newest state snapshot and the newest copy of each
 * message until it drains, so it is never disconnected for falling behind on frames that supersede
 * each other. Frames that cannot be coalesced (results, notices) still end a client that never reads.
 *
 * Everything a client retains is bounded: the bytes queued on its socket plus the snapshot and
 * message copies held for it never exceed `limit`, and at most `maxPendingMessages` distinct
 * messages wait. Past either bound the held message copies are dropped and the client is told to
 * resynchronize ("resync": it rereads the transcript it shows, then receives the newest snapshot);
 * a client that did not offer to resynchronize when it subscribed is disconnected instead, and its
 * reconnection's snapshot recovers the same state. Ordered frames are never dropped or reordered.
 */
export interface FanoutSocket {
  readonly destroyed: boolean;
  readonly writableLength: number;
  write(line: string): unknown;
  destroy(): unknown;
  on(event: 'drain', listener: () => void): unknown;
  off?(event: 'drain', listener: () => void): unknown;
}
export interface FanoutClient<S extends FanoutSocket = FanoutSocket> {
  socket: S; subscribed: boolean;
  /** The client handles a `resync` event; set from its subscription. */
  resync?: boolean;
  pendingState?: string; pendingMessages?: Map<string, string>;
  /** Bytes held in pendingState and pendingMessages. */
  pendingBytes?: number;
  /** A resync event is owed before the next held frame. */
  resyncPending?: boolean;
  drain?: () => void;
}
const size = (line: string) => Buffer.byteLength(line);
export class Fanout<S extends FanoutSocket = FanoutSocket> {
  clients = new Set<FanoutClient<S>>();
  /** Bytes queued on a socket above which superseding frames wait, and the hard cutoff for everything one client retains. */
  backlog: number; limit: number;
  maxPendingMessages: number;
  /** Held copies across every client; past this the largest holder resynchronizes. */
  globalLimit: number;
  constructor(backlog = 1024*1024, limit = 16*1024*1024, maxPendingMessages = 512, globalLimit = 4*limit) {
    this.backlog = backlog; this.limit = limit; this.maxPendingMessages = maxPendingMessages; this.globalLimit = globalLimit;
  }
  add(socket: S): FanoutClient<S> {
    const client: FanoutClient<S> = { socket, subscribed: false, pendingBytes: 0 };
    client.drain = () => this.flush(client);
    this.clients.add(client); socket.on('drain', client.drain);
    return client;
  }
  /** Forgets a client and everything held for it. */
  remove(client: FanoutClient<S>) {
    this.clients.delete(client); this.release(client);
    if (client.drain) client.socket.off?.('drain', client.drain);
    client.drain = undefined; client.resyncPending = false;
  }
  /** A frame that must reach this client in order: a request's result, a notice, an interface command. */
  send(client: FanoutClient<S>, data: unknown) { this.write(client, JSON.stringify(data)+'\n'); }
  /** An event for every subscriber. State snapshots and message updates supersede older copies. */
  broadcast(event: string, params: any) {
    const line = JSON.stringify({method:event,params})+'\n', coalescable = event==='state'||event==='message';
    for (const client of this.clients) {
      if (!client.subscribed || client.socket.destroyed) continue;
      if (coalescable && (client.socket.writableLength > this.backlog || client.pendingState !== undefined || client.pendingMessages?.size || client.resyncPending)) {
        this.hold(client, event, String(params?.id), line);
        continue;
      }
      this.write(client, line);
    }
    this.enforceGlobal();
  }
  /** Bytes this client retains: queued on its socket plus held copies. */
  retained(client: FanoutClient<S>) { return client.socket.writableLength + (client.pendingBytes ?? 0); }
  flush(client: FanoutClient<S>) {
    if (client.socket.destroyed) { this.release(client); return; }
    if (client.resyncPending) {
      client.resyncPending = false;
      this.write(client, JSON.stringify({method:'resync',params:{reason:'backlog'}})+'\n');
      if (client.socket.destroyed) return;
    }
    for (const [id, line] of client.pendingMessages ?? []) {
      client.pendingMessages!.delete(id); client.pendingBytes = (client.pendingBytes ?? 0) - size(line);
      this.write(client, line);
      if (client.socket.destroyed || client.socket.writableLength > this.backlog) return;
    }
    if (client.pendingState !== undefined) {
      const line = client.pendingState; client.pendingState = undefined; client.pendingBytes = (client.pendingBytes ?? 0) - size(line);
      this.write(client, line);
    }
  }
  private hold(client: FanoutClient<S>, event: string, id: string, line: string) {
    if (event === 'state') {
      if (client.pendingState !== undefined) client.pendingBytes = (client.pendingBytes ?? 0) - size(client.pendingState);
      client.pendingState = line;
    } else if (!client.resyncPending) {
      const messages = client.pendingMessages ??= new Map(), previous = messages.get(id);
      if (previous !== undefined) { client.pendingBytes = (client.pendingBytes ?? 0) - size(previous); messages.delete(id); }
      messages.set(id, line);
    } else return; // Resynchronizing: the client rereads its transcript, so message copies are not kept.
    client.pendingBytes = (client.pendingBytes ?? 0) + size(line);
    if (this.retained(client) > this.limit || (client.pendingMessages?.size ?? 0) > this.maxPendingMessages) this.overflow(client);
  }
  /** Past a bound: drop held message copies and ask for a resync, or disconnect a client that cannot resync. */
  private overflow(client: FanoutClient<S>) {
    if (!client.resync) { client.socket.destroy(); this.release(client); return; }
    for (const line of client.pendingMessages?.values() ?? []) client.pendingBytes = (client.pendingBytes ?? 0) - size(line);
    client.pendingMessages?.clear(); client.resyncPending = true;
    // Even the newest snapshot alone does not fit beside what the socket already holds.
    if (this.retained(client) > this.limit) { client.socket.destroy(); this.release(client); }
  }
  private enforceGlobal() {
    let total = 0; for (const client of this.clients) total += client.pendingBytes ?? 0;
    while (total > this.globalLimit) {
      let largest: FanoutClient<S> | undefined;
      for (const client of this.clients) if (!largest || (client.pendingBytes ?? 0) > (largest.pendingBytes ?? 0)) largest = client;
      if (!largest || !(largest.pendingBytes ?? 0)) return;
      const before = largest.pendingBytes ?? 0;
      if (largest.resync && (largest.pendingMessages?.size ?? 0)) this.overflow(largest);
      else { largest.socket.destroy(); this.release(largest); }
      total -= before - (largest.pendingBytes ?? 0);
    }
  }
  private release(client: FanoutClient<S>) { client.pendingState = undefined; client.pendingMessages?.clear(); client.pendingMessages = undefined; client.pendingBytes = 0; }
  private write(client: FanoutClient<S>, line: string) {
    if (client.socket.destroyed) { this.release(client); return; }
    if (client.socket.writableLength + size(line) + (client.pendingBytes ?? 0) > this.limit) { client.socket.destroy(); this.release(client); return; }
    client.socket.write(line);
  }
}
