/* What wasm32-wasip1 lacks, and what the unbuilt bio, io_threads, threads_mngr, tls and rdma
 * would define. bio jobs run inline; the rest fail or do nothing on paths that don't run here.
 * Signatures must match the callers': a mismatch traps in wasm. */
#include <errno.h>
#include <string.h>
#include <stdint.h>
#include <stdarg.h>
#include <unistd.h>

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

int RedisRegisterConnectionTypeTLS(void) { return -1; /* C_ERR */ }
void tlsResetCertInfo(void) {}

int RegisterConnectionTypeRdma(void) { return -1; /* C_ERR */ }

typedef void lazy_free_fn(void *args[]);

void bioInit(void) {}
unsigned long bioPendingJobsOfType(int type) { (void)type; return 0; }
void bioDrainWorker(int job_type) { (void)job_type; }
void bioKillThreads(void) {}

void bioCreateCloseJob(int fd, int need_fsync, int need_reclaim_cache) {
    (void)need_reclaim_cache;
    if (need_fsync) fsync(fd);
    close(fd);
}
void bioCreateCloseAofJob(int fd, long long offset, int need_reclaim_cache) {
    (void)offset; (void)need_reclaim_cache;
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
int inBioThread(void) { return 0; }
void bioCreateSaveRDBToDiskJob(void *conn, int is_dual_channel) {
    (void)conn; (void)is_dual_channel;
}

/* Each offload returns C_ERR, so the caller does the work itself. */
int inMainThread(void) { return 1; }
int getIOThreadID(void) { return 0; }
void initIOThreads(int prev_threads_num) { (void)prev_threads_num; }
void killIOThreads(void) {}
int trySendReadToIOThreads(void *c) { (void)c; return -1; }
int trySendWriteToIOThreads(void *c) { (void)c; return -1; }
int tryOffloadFreeObjToIOThreads(void *o) { (void)o; return -1; }
int tryOffloadFreeArgvToIOThreads(void *c, int argc, void **argv) { (void)c; (void)argc; (void)argv; return -1; }
void adjustIOThreadsByEventLoad(int numevents, int increase_only) { (void)numevents; (void)increase_only; }
void drainIOThreadsQueue(void) {}
void trySendPollJobToIOThreads(void) {}
int  updateIOThreads(const char **err) { (void)err; return 0; /* C_OK */ }
long long getIOThreadActiveTimeMicroseconds(int id) { (void)id; return 0; }
int  clientHasPendingIO(void *c) { (void)c; return 0; }
int  processIOThreadsResponses(void) { return 0; }
void IOThreadsBeforeSleep(long long current_time) { (void)current_time; }
void IOThreadsAfterSleep(int numevents) { (void)numevents; }

void ThreadsManager_init(void) {}
int ThreadsManager_runOnThreads(void *tids, size_t tids_len, void (*cb)(void)) {
    (void)tids; (void)tids_len; (void)cb; return 0;
}

void waitForClientIO(void *c) { (void)c; }

int   flock(int fd, int op) { (void)fd; (void)op; return 0; }
int   mkostemp(char *tmpl, int flags) { (void)tmpl; (void)flags; errno = ENOSYS; return -1; }
int   execve(const char *p, char *const av[], char *const ev[]) { (void)p; (void)av; (void)ev; errno = ENOSYS; return -1; }
unsigned umask(unsigned mask) { (void)mask; return 0; }
void  tzset(void) {}

/* No shared objects, but moduleLoadStatic() finds the static Lua engine with dlopen(NULL) and
 * dlsym("ValkeyModule_OnLoad_lua"), so answer exactly that. */
extern int ValkeyModule_OnLoad_lua(void *ctx, void **argv, int argc);
static char self_handle;
void *dlopen(const char *file, int mode) {
    (void)mode;
    if (file == NULL) return &self_handle;
    return 0;
}
void *dlsym(void *handle, const char *name) {
    (void)handle;
    if (name && strcmp(name, "ValkeyModule_OnLoad_lua") == 0)
        return (void *)&ValkeyModule_OnLoad_lua;
    return 0;
}
int   dlclose(void *handle) { (void)handle; return 0; }
char *dlerror(void) { return "dynamic loading not supported"; }

/* libvalkey isn't built; only sentinel.c uses its async client, and sentinel mode never runs. */
void *valkeyAsyncConnectBind(const char *ip, int port, const char *src) { (void)ip; (void)port; (void)src; return 0; }
int   valkeyAsyncCommand(void *ac, void *fn, void *pd, const char *fmt, ...) { (void)ac; (void)fn; (void)pd; (void)fmt; return -1; }
void  valkeyAsyncFree(void *ac) { (void)ac; }
int   valkeyAsyncSetConnectCallback(void *ac, void *cb) { (void)ac; (void)cb; return -1; }
int   valkeyAsyncSetDisconnectCallback(void *ac, void *cb) { (void)ac; (void)cb; return -1; }
void  valkeyAsyncHandleRead(void *ac) { (void)ac; }
void  valkeyAsyncHandleWrite(void *ac) { (void)ac; }

int dup(int oldfd) { return oldfd; }
int dup2(int oldfd, int newfd) { (void)oldfd; return newfd; }
