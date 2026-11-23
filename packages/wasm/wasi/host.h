/* Imports from the "host" module, implemented in packages/server/src/shard/host/ (sockets.ts and
 * aof-rewrite.ts). */
#ifndef VALKEY_WASM_HOST_H
#define VALKEY_WASM_HOST_H
#include <stddef.h>
#include <stdint.h>

#define HOST_IMPORT(name) __attribute__((import_module("host"), import_name(name)))

/* ae.c indexes events[fd], so host fds must stay under the loop's set size (maxclients plus a
 * margin). 4096 clears wasi-libc's own fds. */
#define HOST_FD_BASE 4096

HOST_IMPORT("socket")  int   host_socket(void);
/* The host ignores port and returns 0. */
HOST_IMPORT("listen")  int   host_listen(int fd, int port);
/* The next queued client fd, or -1. */
HOST_IMPORT("accept")  int   host_accept(int lfd);
/* n > 0, 0 at EOF, or -1 when nothing is buffered. */
HOST_IMPORT("read")    int   host_read(int fd, void *buf, int len);
/* len (the host queues it all), or -1 after EOF or a failed write. */
HOST_IMPORT("write")   int   host_write(int fd, const void *buf, int len);
HOST_IMPORT("close")   void  host_close(int fd);

/* Fills fired[] with the (fd, mask) pairs from interest[] that are ready now and returns how
 * many. Readable means a queued client, buffered input or EOF. Writable is always reported: the
 * host applies backpressure by pausing input. timeout_ms is ignored. */
HOST_IMPORT("poll")    int   host_poll(const int32_t *interest, int count,
                                       int32_t *fired, int max, int timeout_ms);

/* After opening a new incr file: write to tmpfile a base equal to the files before it, as RDB if
 * rdb. Returns 1 if the host does (it then calls rk_rewrite_done(ok, gen)), or 0 to rewrite
 * inline. */
HOST_IMPORT("aof_rewrite") int host_aof_rewrite(const char *tmpfile, int len, int rdb, int gen);

#endif
