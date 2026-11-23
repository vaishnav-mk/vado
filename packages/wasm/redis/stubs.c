/* What wasm32-wasip1 lacks, and what the unbuilt bio (it starts threads) and tls would define. bio jobs run
 * inline; the rest fail or do nothing on paths that don't run here. */
#include <errno.h>
#include <string.h>
#include <stdint.h>
#include <stdarg.h>
#include <unistd.h>
#include "server.h"
#include "bio.h"

int __wasm_fork(void) { errno = ENOSYS; return -1; }

/* A generous fd limit satisfies adjustOpenFilesLimit(). */
int getrlimit(int resource, struct rlimit *rlim) {
    (void)resource;
    if (rlim) { rlim->rlim_cur = 1ull << 20; rlim->rlim_max = 1ull << 20; }
    return 0;
}

int backtrace(void **buffer, int size) { (void)buffer; (void)size; return 0; }
char **backtrace_symbols(void *const *buffer, int size) { (void)buffer; (void)size; return 0; }
void backtrace_symbols_fd(void *const *buffer, int size, int fd) { (void)buffer; (void)size; (void)fd; }
int dladdr(const void *addr, Dl_info *info) { (void)addr; (void)info; return 0; }

int RedisRegisterConnectionTypeTLS(void) { return C_ERR; }
void tlsResetCertInfo(void) {}

void bioInit(void) {}
unsigned long bioPendingJobsOfType(int type) { (void)type; return 0; }
void bioDrainWorker(int job_type) { (void)job_type; }
void bioKillThreads(void) {}
int bioIsLazyfreeWorker(void) { return 0; }
void bioCreateCloseJob(int fd, int need_fsync, int need_reclaim_cache) {
    (void)need_reclaim_cache;
    if (need_fsync) fsync(fd);
    close(fd);
}
void bioCreateCloseAofJob(int fd, long long offset, int need_reclaim_cache) {
    (void)offset; (void)need_reclaim_cache;
    fsync(fd);
    close(fd);
}
void bioCreateFsyncJob(int fd, long long offset, int need_reclaim_cache) {
    (void)offset; (void)need_reclaim_cache;
    fsync(fd);
}
void bioCreateLazyFreeJob(lazy_free_fn free_fn, int arg_count, ...) {
    void *args[arg_count > 0 ? arg_count : 1];
    va_list ap; va_start(ap, arg_count);
    for (int i = 0; i < arg_count; i++) args[i] = va_arg(ap, void *);
    va_end(ap);
    free_fn(args);
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

int   flock(int fd, int op) { (void)fd; (void)op; return 0; }
int   mkostemp(char *tmpl, int flags) { (void)tmpl; (void)flags; errno = ENOSYS; return -1; }
int   execve(const char *p, char *const av[], char *const ev[]) { (void)p; (void)av; (void)ev; errno = ENOSYS; return -1; }
unsigned umask(unsigned mask) { (void)mask; return 0; }
void  tzset(void) {}
int   dup(int oldfd) { return oldfd; }
int   dup2(int oldfd, int newfd) { (void)oldfd; return newfd; }

void *dlopen(const char *file, int mode) { (void)file; (void)mode; return 0; }
void *dlsym(void *handle, const char *name) { (void)handle; (void)name; return 0; }
int   dlclose(void *handle) { (void)handle; return 0; }
char *dlerror(void) { return "dynamic loading not supported"; }

/* Only sentinel.c uses hiredis' async client, and sentinel mode never runs. */
void *redisAsyncConnectBind(const char *ip, int port, const char *src) { (void)ip; (void)port; (void)src; return 0; }
int   redisAsyncCommand(void *ac, void *fn, void *pd, const char *fmt, ...) { (void)ac; (void)fn; (void)pd; (void)fmt; return -1; }
void  redisAsyncFree(void *ac) { (void)ac; }
int   redisAsyncSetConnectCallback(void *ac, void *cb) { (void)ac; (void)cb; return -1; }
int   redisAsyncSetDisconnectCallback(void *ac, void *cb) { (void)ac; (void)cb; return -1; }
void  redisAsyncHandleRead(void *ac) { (void)ac; }
void  redisAsyncHandleWrite(void *ac) { (void)ac; }
