/* Redis's side of wasi/shared_stubs.c: the rest of what the unbuilt bio (it starts threads) would define. bio
 * jobs run inline; the rest fail or do nothing on paths that don't run here. */
#include <stdint.h>
#include <unistd.h>
#include "server.h"
#include "bio.h"

int bioIsLazyfreeWorker(void) { return 0; }
void bioCreateCloseAofJob(int fd, long long offset, int need_reclaim_cache) {
    (void)offset; (void)need_reclaim_cache;
    fsync(fd);
    close(fd);
}

/* Inline, a completion callback would unblock a client inside its own command (FLUSHALL ASYNC), so it
 * runs from a timer on the next pass. */
typedef struct { comp_fn *fn; uint64_t arg; void *ptr; } compRq;
static int runCompRq(struct aeEventLoop *el, long long id, void *data) {
    (void)el; (void)id;
    compRq *rq = data;
    rq->fn(rq->arg, rq->ptr);
    zfree(rq);
    return AE_NOMORE;
}
void bioCreateCompRq(bio_worker_t assigned_worker, comp_fn *func, uint64_t user_data, void *user_ptr) {
    (void)assigned_worker;
    compRq *rq = zmalloc(sizeof(*rq));
    *rq = (compRq){func, user_data, user_ptr};
    if (aeCreateTimeEvent(server.el, 0, runCompRq, rq, NULL) == AE_ERR) runCompRq(server.el, 0, rq);
}

void *dlopen(const char *file, int mode) { (void)file; (void)mode; return 0; }
void *dlsym(void *handle, const char *name) { (void)handle; (void)name; return 0; }

/* Only sentinel.c uses hiredis' async client, and sentinel mode never runs. */
void *redisAsyncConnectBind(const char *ip, int port, const char *src) { (void)ip; (void)port; (void)src; return 0; }
int   redisAsyncCommand(void *ac, void *fn, void *pd, const char *fmt, ...) { (void)ac; (void)fn; (void)pd; (void)fmt; return -1; }
void  redisAsyncFree(void *ac) { (void)ac; }
int   redisAsyncSetConnectCallback(void *ac, void *cb) { (void)ac; (void)cb; return -1; }
int   redisAsyncSetDisconnectCallback(void *ac, void *cb) { (void)ac; (void)cb; return -1; }
void  redisAsyncHandleRead(void *ac) { (void)ac; }
void  redisAsyncHandleWrite(void *ac) { (void)ac; }
