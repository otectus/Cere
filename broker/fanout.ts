/**
 * Broadcast delivery to desktop clients. Each frame is serialized once. A client whose socket is
 * backed up (a busy interface) keeps only the newest state snapshot and the newest copy of each
 * message until it drains, so it is never disconnected for falling behind on frames that supersede
 * each other. Frames that cannot be coalesced (results, notices) still end a client that never reads.
 */
export interface FanoutSocket {
  readonly destroyed: boolean;
  readonly writableLength: number;
  write(line: string): unknown;
  destroy(): unknown;
  on(event: 'drain', listener: () => void): unknown;
}
export interface FanoutClient<S extends FanoutSocket = FanoutSocket> { socket: S; subscribed: boolean; pendingState?: string; pendingMessages?: Map<string, string> }
export class Fanout<S extends FanoutSocket = FanoutSocket> {
  clients = new Set<FanoutClient<S>>();
  /** Bytes queued on a socket above which superseding frames wait, and the hard cutoff for a client that never reads. */
  backlog: number; limit: number;
  constructor(backlog = 1024*1024, limit = 16*1024*1024) { this.backlog = backlog; this.limit = limit; }
  add(socket: S): FanoutClient<S> {
    const client: FanoutClient<S> = { socket, subscribed: false };
    this.clients.add(client); socket.on('drain', () => this.flush(client));
    return client;
  }
  remove(client: FanoutClient<S>) { this.clients.delete(client); }
  /** A frame that must reach this client in order: a request's result, a notice, an interface command. */
  send(client: FanoutClient<S>, data: unknown) { this.write(client, JSON.stringify(data)+'\n'); }
  /** An event for every subscriber. State snapshots and message updates supersede older copies. */
  broadcast(event: string, params: any) {
    const line = JSON.stringify({method:event,params})+'\n', coalescable = event==='state'||event==='message';
    for (const client of this.clients) {
      if (!client.subscribed || client.socket.destroyed) continue;
      if (coalescable && (client.socket.writableLength > this.backlog || client.pendingState !== undefined || client.pendingMessages?.size)) {
        if (event==='state') client.pendingState = line; else (client.pendingMessages ??= new Map()).set(String(params?.id), line);
        continue;
      }
      this.write(client, line);
    }
  }
  flush(client: FanoutClient<S>) {
    if (client.socket.destroyed) return;
    for (const [id, line] of client.pendingMessages ?? []) {
      client.pendingMessages!.delete(id); client.socket.write(line);
      if (client.socket.writableLength > this.backlog) return;
    }
    if (client.pendingState !== undefined) { const line = client.pendingState; client.pendingState = undefined; client.socket.write(line); }
  }
  private write(client: FanoutClient<S>, line: string) {
    if (client.socket.destroyed) return;
    if (client.socket.writableLength > this.limit) { client.socket.destroy(); return; }
    client.socket.write(line);
  }
}
