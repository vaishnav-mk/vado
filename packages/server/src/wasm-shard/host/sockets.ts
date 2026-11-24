import type { Views } from "../vfs/types";
import { CLIENT_LOW_WATER, SHARD_HIGH_WATER, SHARD_LOW_WATER } from "./config";
import type { HostSocket, SocketEvents, SocketWriter } from "./types";

const FD_BASE = 4096; // the wasm's sock_shim: fds from here on are host sockets
const AE_READABLE = 1;
const AE_WRITABLE = 2;

export class Sockets {
  readonly open = new Map<number, HostSocket>();
  readonly #accepting: number[] = [];
  #listenFd = -1;
  #nextFd = FD_BASE;
  readonly #free: number[] = []; // closed fds, reused first: Valkey rejects fds past its setsize
  total = 0; // unacknowledged reply bytes across all clients, plus held bytes
  writes = 0;
  draining = false;
  readonly #stalled = new Set<() => void>();

  #allocate(): number {
    return this.#free.pop() ?? this.#nextFd++;
  }

  add(writer: SocketWriter, internal: boolean): HostSocket {
    const socket: HostSocket = {
      fd: this.#allocate(),
      chunks: [],
      off: 0,
      eof: false,
      writer,
      internal,
      inflight: 0,
      wake: null,
      closed: Promise.withResolvers<void>(),
      finished: Promise.withResolvers<void>(),
    };

    this.open.set(socket.fd, socket);
    this.#accepting.push(socket.fd);

    return socket;
  }

  clients(): HostSocket[] {
    return [...this.open.values()].filter((s) => !s.internal);
  }

  release(n: number): void {
    this.total -= n;
    this.wake(null);
  }

  paused(socket: HostSocket): Promise<void> {
    return new Promise((resolve) => {
      if (this.total > SHARD_HIGH_WATER) this.#stalled.add(resolve);
      socket.wake = resolve;
    });
  }

  wake(socket: HostSocket | null): void {
    if (socket?.wake && socket.inflight <= CLIENT_LOW_WATER && this.total <= SHARD_HIGH_WATER) {
      const wake = socket.wake;
      socket.wake = null;
      wake();
    }

    if (this.total <= SHARD_LOW_WATER && this.#stalled.size) this.wakeAll();
  }

  wakeAll(): void {
    const all = [...this.#stalled];
    this.#stalled.clear();

    for (const wake of all) wake();
  }

  #written(socket: HostSocket, len: number): void {
    socket.inflight -= len;
    this.total -= len;
    this.wake(socket);
  }

  imports({ u8, dv }: Views, events: SocketEvents) {
    return {
      socket: () => this.#allocate(),
      listen: (fd: number) => ((this.#listenFd = fd), 0),
      accept: (fd: number) => (fd === this.#listenFd ? (this.#accepting.shift() ?? -1) : -1),
      read: (fd: number, ptr: number, len: number) => {
        const s = this.open.get(fd);

        if (!s) return -1;

        if (!s.chunks.length) return s.eof ? 0 : -1;
        const memory = u8();
        let n = 0;

        while (n < len && s.chunks.length) {
          const head = s.chunks[0];
          const take = Math.min(head.length - s.off, len - n);
          memory.set(head.subarray(s.off, s.off + take), ptr + n);
          n += take;
          s.off += take;

          if (s.off === head.length) {
            s.chunks.shift();
            s.off = 0;
          }
        }

        return n;
      },
      write: (fd: number, ptr: number, len: number) => {
        const s = this.open.get(fd);

        if (!s || s.eof) return -1;
        this.writes++;
        s.inflight += len;
        this.total += len;
        s.writer.write(u8().slice(ptr, ptr + len)).then(
          () => this.#written(s, len),
          () => {
            s.eof = true;
            this.#written(s, len);
            events.schedule();
          },
        );

        return len;
      },
      close: (fd: number) => {
        const s = this.open.get(fd);

        if (!s) return;
        this.open.delete(fd);
        this.#free.push(fd);
        s.closed.resolve();
        events.closed();
      },
      poll: (interestPtr: number, count: number, firedPtr: number, max: number) => {
        const view = dv();
        let fired = 0;

        for (let i = 0; i < count && fired < max; i++) {
          const fd = view.getInt32(interestPtr + i * 8, true);
          const mask = view.getInt32(interestPtr + i * 8 + 4, true);
          let ready = 0;

          if (fd === this.#listenFd) {
            if (mask & AE_READABLE && this.#accepting.length) ready |= AE_READABLE;
          } else {
            const s = this.open.get(fd);

            if (s) {
              if (mask & AE_READABLE && (s.chunks.length || s.eof)) ready |= AE_READABLE;

              if (mask & AE_WRITABLE) ready |= AE_WRITABLE;
            }
          }

          if (ready) {
            view.setInt32(firedPtr + fired * 8, fd, true);
            view.setInt32(firedPtr + fired * 8 + 4, ready, true);
            fired++;
          }
        }

        return fired;
      },
    };
  }
}
