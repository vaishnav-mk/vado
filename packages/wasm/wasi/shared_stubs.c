/* Stubs both builds share: what wasm32-wasip1 lacks, and the bio jobs and TLS that aren't built. bio
 * jobs run inline. Each build's stubs.c has the rest. Signatures must match the callers': a mismatch
 * traps in wasm. */
#include <errno.h>
#include <stdarg.h>
#include <unistd.h>

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

int   flock(int fd, int op) { (void)fd; (void)op; return 0; }
int   mkostemp(char *tmpl, int flags) { (void)tmpl; (void)flags; errno = ENOSYS; return -1; }
int   execve(const char *p, char *const av[], char *const ev[]) { (void)p; (void)av; (void)ev; errno = ENOSYS; return -1; }
unsigned umask(unsigned mask) { (void)mask; return 0; }
void  tzset(void) {}

/* One fd can't have two numbers here. Every caller copes with failure: Redis's AOF load skips the
 * close job, and daemonize() and check-rdb's --stats output never run. */
int   dup(int oldfd) { (void)oldfd; errno = ENOSYS; return -1; }
int   dup2(int oldfd, int newfd) { (void)oldfd; (void)newfd; errno = ENOSYS; return -1; }

int   dlclose(void *handle) { (void)handle; return 0; }
char *dlerror(void) { return "dynamic loading not supported"; }
