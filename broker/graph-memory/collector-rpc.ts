import net from "node:net";
import { mkdir, chmod, lstat, unlink, realpath } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import { z } from "zod";
import { sameUserPeer } from "../peercred.ts";
import { LiveObservationFactory, LiveWorkspaceState } from "./adapters/live.ts";
import { inspectGitCheckout } from "./adapters/workspace.ts";
import { parse } from "./contracts.ts";
const frame = z
  .object({
    protocol_version: z.literal(1),
    request_id: z.string().uuid(),
    method: z.literal("collector.emit"),
    params: z
      .object({
        source: z.literal("fish"),
        source_epoch: z.string().uuid(),
        source_sequence: z.number().int().positive(),
        event: z.enum([
          "start",
          "exit",
          "cwd",
          "postexec",
          "posterror",
          "focus_in",
          "focus_out",
        ]),
        shell_session_id: z.string().uuid(),
        cwd: z.string().max(4096),
        status: z.number().int().optional(),
        pipeline_status: z.array(z.number().int()).max(64).optional(),
        duration_ms: z.number().int().nonnegative().optional(),
        terminal_binding: z
          .object({
            kind: z.literal("kitty_window_id"),
            id: z.string().max(64),
          })
          .strict()
          .optional(),
      })
      .strict(),
  })
  .strict();
export class CollectorRpc {
  server?: net.Server;
  socket: string;
  live: LiveWorkspaceState;
  policy: () => Promise<any>;
  sessions = new Map<
    string,
    { factory: LiveObservationFactory; sequence: number; entity: string }
  >();
  constructor(
    runtime: string,
    live: LiveWorkspaceState,
    policy: () => Promise<any>,
  ) {
    this.socket = join(runtime, "memory.sock");
    this.live = live;
    this.policy = policy;
  }
  async start() {
    const directory = join(this.socket, "..");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    try {
      const stat = await lstat(this.socket);
      if (!stat.isSocket() || stat.uid !== process.getuid?.())
        throw new Error("Unsafe collector socket");
      const occupied = await new Promise<boolean>((resolve) => {
        const socket = net.createConnection(this.socket);
        socket.once("connect", () => {
          socket.destroy();
          resolve(true);
        });
        socket.once("error", () => resolve(false));
      });
      if (occupied) throw new Error("Collector socket is already serving");
      await unlink(this.socket);
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
    }
    this.server = net.createServer((socket) => {
      if (!sameUserPeer(socket)) {
        socket.destroy();
        return;
      }
      socket.setTimeout(1000, () => socket.destroy());
      let buffer = "";
      socket.on("error", () => {});
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        if (Buffer.byteLength(buffer) > 65536) {
          socket.destroy();
          return;
        }
        const end = buffer.indexOf("\n");
        if (end < 0) return;
        socket.pause();
        void this.ingest(buffer.slice(0, end)).then(
          (result) => {
            if (!socket.destroyed)
              socket.end(
                JSON.stringify({ protocol_version: 1, result }) + "\n",
              );
          },
          () => socket.destroy(),
        );
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.socket, () => resolve());
    });
    await chmod(this.socket, 0o600);
  }
  async ingest(text: string) {
    const request = parse(frame, JSON.parse(text)),
      p = request.params,
      { policy } = await this.policy();
    if (!policy.enabled || !policy.fish_enabled)
      throw new Error("Fish observation is disabled");
    if (p.source_epoch !== p.shell_session_id)
      throw new Error("Shell epoch mismatch");
    let state = this.sessions.get(p.shell_session_id);
    if (!state) {
      if (this.sessions.size >= 256)
        this.sessions.delete(this.sessions.keys().next().value!);
      state = {
        factory: new LiveObservationFactory(
          "fish",
          10000,
          undefined,
          p.source_epoch,
        ),
        sequence: 0,
        entity: p.shell_session_id,
      };
      this.sessions.set(p.shell_session_id, state);
    }
    if (p.source_sequence <= state.sequence) return { duplicate: true };
    state.sequence = p.source_sequence;
    let cwd: string | undefined;
    try {
      const path = await realpath(p.cwd);
      for (const root of policy.approved_roots) {
        const approved = await realpath(root),
          delta = relative(approved, path);
        if (delta === "" || (!delta.startsWith("..") && !isAbsolute(delta))) {
          cwd = path;
          break;
        }
      }
    } catch {}
    const observation = state.factory.observation(
      state.entity,
      p.source_epoch,
      p.event === "exit" ? "SHELL_EXIT" : "SHELL_STATE",
      {
        ...(cwd ? { cwd } : {}),
        event: p.event,
        shellSessionId: p.shell_session_id,
        ...(p.status !== undefined
          ? { status: p.status, pipelineStatus: p.pipeline_status || [] }
          : {}),
        ...(p.duration_ms !== undefined ? { durationMs: p.duration_ms } : {}),
        ...(p.terminal_binding ? { kittyPaneId: p.terminal_binding.id } : {}),
      },
    );
    this.live.apply(observation);
    if (cwd) {
      try {
        const checkout = await inspectGitCheckout(cwd);
        const repository = new LiveObservationFactory("repository", 60000);
        this.live.apply(
          repository.observation(
            checkout.checkoutId,
            checkout.checkoutId,
            "CHECKOUT_VERIFIED",
            JSON.parse(JSON.stringify(checkout)),
          ),
        );
      } catch {}
    }
    if (p.event === "exit") this.sessions.delete(p.shell_session_id);
    return { generation: this.live.snapshot().generation, durable: false };
  }
  async close() {
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = undefined;
      await unlink(this.socket).catch(() => {});
    }
    this.sessions.clear();
    this.live.markSourceUnknown("fish", "collector_stopped");
  }
}
