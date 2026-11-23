/* Force-included into every file (common.sh -include): what wasm32-wasip1 lacks, so the upstream
 * sources compile unchanged apart from the patches. */
#ifndef VALKEY_WASM_COMPAT_H
#define VALKEY_WASM_COMPAT_H

/* Included before fmacros.h sets it, and <signal.h> below needs it. */
#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif

#ifdef VALKEY_WASM

/* No fork(): callers take their failed-fork path, and the AOF rewrite patches avoid forking. */
#define fork() (-1)
#define wait3(a, b, c) (-1)
/* No child ever exits, so a rewrite the host runs ends only through rk_rewrite_done(). */
#define waitpid(a, b, c) (0)

#define setrlimit(a, b) (0)

/* The rest is behind __wasilibc_unmodified_upstream in the sysroot headers. No signal is ever
 * delivered, so signal setup and the crash handler only need to compile. */
typedef unsigned long long rlim_t;
struct rlimit { rlim_t rlim_cur, rlim_max; };
#ifndef RLIMIT_NOFILE
#define RLIMIT_NOFILE 7
#endif
#ifndef RLIM_INFINITY
#define RLIM_INFINITY (~0ULL)
#endif
int getrlimit(int resource, struct rlimit *rlim);

/* sigset_t is behind the same guard in <signal.h>, so take it from bits/alltypes.h. */
#define __NEED_sigset_t
#define __NEED_pid_t
#define __NEED_uid_t
#include <bits/alltypes.h>
#include <signal.h>
#include <errno.h>

#ifndef SA_SIGINFO
typedef struct {
    int si_signo, si_errno, si_code;
    int si_pid;
    unsigned si_uid;
    void *si_addr;
} siginfo_t;
struct sigaction {
    union {
        void (*sa_handler)(int);
        void (*sa_sigaction)(int, siginfo_t *, void *);
    };
    sigset_t sa_mask;
    int sa_flags;
};
#define SA_SIGINFO   0x00000004
#define SA_NODEFER   0x40000000
#define SA_RESETHAND 0x80000000
#define SA_RESTART   0x10000000
#define SA_ONSTACK   0x08000000
#ifndef SI_USER
#define SI_USER 0
#endif

static inline int sigemptyset(sigset_t *s) { if (s) { sigset_t z = {0}; *s = z; } return 0; }
static inline int sigfillset(sigset_t *s) { (void)s; return 0; }
static inline int sigaddset(sigset_t *s, int n) { (void)s; (void)n; return 0; }
static inline int sigdelset(sigset_t *s, int n) { (void)s; (void)n; return 0; }
static inline int sigismember(const sigset_t *s, int n) { (void)s; (void)n; return 0; }
static inline int sigprocmask(int how, const sigset_t *s, sigset_t *o) { (void)how; (void)s; (void)o; return 0; }
static inline int pthread_sigmask(int how, const sigset_t *s, sigset_t *o) { (void)how; (void)s; (void)o; return 0; }
static inline int sigaction(int signum, const struct sigaction *act, struct sigaction *old) {
    (void)signum; (void)act; (void)old; return 0;
}
/* No other process exists, so killAppendOnlyChild() doesn't wait for one to exit. */
static inline int kill(pid_t pid, int sig) { (void)pid; (void)sig; errno = ESRCH; return -1; }
#endif /* SA_SIGINFO */

#include <sys/time.h>
#ifndef ITIMER_REAL
#define ITIMER_REAL    0
#define ITIMER_VIRTUAL 1
#define ITIMER_PROF    2
struct itimerval { struct timeval it_interval, it_value; };
static inline int setitimer(int which, const struct itimerval *nv, struct itimerval *ov) {
    (void)which; (void)nv; (void)ov; return 0;
}
static inline int getitimer(int which, struct itimerval *cv) { (void)which; (void)cv; return 0; }
#endif

/* Defined in stubs.c and sock_shim.c. Without a prototype, callers assume int f() and wasm-ld
 * links a stub that traps on the signature mismatch. */
void tzset(void);
int  flock(int fd, int op);
int  mkostemp(char *tmpl, int flags);
int  pipe(int fd[2]);
int  execve(const char *path, char *const argv[], char *const envp[]);
unsigned umask(unsigned mask);

/* Only the names are used, so any value works. */
#ifndef ESOCKTNOSUPPORT
#define ESOCKTNOSUPPORT 240
#endif
#ifndef EPFNOSUPPORT
#define EPFNOSUPPORT 241
#endif

/* sock_shim.c ignores these, so only the names must exist. */
#include <sys/socket.h>
#ifndef SO_ERROR
#define SO_ERROR 4
#endif
#ifndef SO_REUSEADDR
#define SO_REUSEADDR 2
#endif
#ifndef SO_KEEPALIVE
#define SO_KEEPALIVE 9
#endif
#ifndef SO_RCVTIMEO
#define SO_RCVTIMEO 66
#endif
#ifndef SO_SNDTIMEO
#define SO_SNDTIMEO 67
#endif
#ifndef AF_LOCAL
#define AF_LOCAL 1
#endif
#ifndef AF_UNIX
#define AF_UNIX AF_LOCAL
#endif
#ifndef AF_UNSPEC
#define AF_UNSPEC 0
#endif
#ifndef IPPROTO_TCP
#define IPPROTO_TCP 6
#endif
#ifndef IPPROTO_IPV6
#define IPPROTO_IPV6 41
#endif
#ifndef IPV6_V6ONLY
#define IPV6_V6ONLY 26
#endif
#ifndef TCP_NODELAY
#define TCP_NODELAY 1
#endif
#ifndef TCP_KEEPALIVE
#define TCP_KEEPALIVE 0x10
#endif
#ifndef TCP_KEEPIDLE
#define TCP_KEEPIDLE 4
#endif
#ifndef TCP_KEEPINTVL
#define TCP_KEEPINTVL 5
#endif
#ifndef TCP_KEEPCNT
#define TCP_KEEPCNT 6
#endif

#ifndef VALKEY_WASM_HAVE_DLINFO
#define VALKEY_WASM_HAVE_DLINFO
typedef struct {
    const char *dli_fname;
    void *dli_fbase;
    const char *dli_sname;
    void *dli_saddr;
} Dl_info;
int dladdr(const void *addr, Dl_info *info);
#endif

#endif /* VALKEY_WASM */
#endif
