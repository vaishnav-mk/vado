/* Valkey's side of wasi/shared_stubs.c: what the unbuilt bio, io_threads, threads_mngr, tls and rdma
 * would define. bio jobs run inline; the rest fail or do nothing on paths that don't run here.
 * Signatures must match the callers': a mismatch traps in wasm. */
#include <errno.h>
#include <string.h>
#include <unistd.h>
#include "server.h"

void tlsResetCertInfo(void) {}

int RegisterConnectionTypeRdma(void) { return -1; /* C_ERR */ }

/* bio.c's BIO_CLOSE_AOF job, inline. */
void bioCreateCloseAofJob(int fd, long long offset, int need_reclaim_cache) {
    (void)need_reclaim_cache;
    if (valkey_fsync(fd) == -1 && errno != EBADF && errno != EINVAL) {
        int last_status = server.aof_bio_fsync_status;
        server.aof_bio_fsync_errno = errno;
        server.aof_bio_fsync_status = C_ERR;
        if (last_status == C_OK) serverLog(LL_WARNING, "Fail to fsync the AOF file: %s", strerror(errno));
    } else {
        server.aof_bio_fsync_status = C_OK;
        server.fsynced_reploff_pending = offset;
    }
    close(fd);
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

void waitForClientIO(client *c) { (void)c; }

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

/* libvalkey isn't built; only sentinel.c uses its async client, and sentinel mode never runs. */
void *valkeyAsyncConnectBind(const char *ip, int port, const char *src) { (void)ip; (void)port; (void)src; return 0; }
int   valkeyAsyncCommand(void *ac, void *fn, void *pd, const char *fmt, ...) { (void)ac; (void)fn; (void)pd; (void)fmt; return -1; }
void  valkeyAsyncFree(void *ac) { (void)ac; }
int   valkeyAsyncSetConnectCallback(void *ac, void *cb) { (void)ac; (void)cb; return -1; }
int   valkeyAsyncSetDisconnectCallback(void *ac, void *cb) { (void)ac; (void)cb; return -1; }
void  valkeyAsyncHandleRead(void *ac) { (void)ac; }
void  valkeyAsyncHandleWrite(void *ac) { (void)ac; }
