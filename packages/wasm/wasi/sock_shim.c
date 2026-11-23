/* wasi-libc has no sockets, so these use the host imports. read, write, writev, close and fcntl
 * are linked with --wrap and pass every fd below HOST_FD_BASE, except pipes, to wasi-libc. */
#include "host.h"
#include <errno.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <netinet/in.h>
#include <netdb.h>
#include <sys/uio.h>
#include <string.h>
#include <stdlib.h>
#include <stdio.h>
#include <fcntl.h>
#include <stdint.h>

extern ssize_t __real_read(int, void *, size_t);
extern ssize_t __real_write(int, const void *, size_t);
extern ssize_t __real_writev(int, const struct iovec *, int);
extern int     __real_close(int);
extern int     __real_fcntl(int, int, ...);

static int is_host_fd(int fd) { return fd >= HOST_FD_BASE; }

/* wasi-libc has no pipe(), and startup exits without module_pipe, which wakes the loop for
 * module threads. There are no threads, so these fds never have data and writes are discarded. */
#define PIPE_FD_BASE 3072
#define PIPE_FD_MAX  32
static int pipe_next = PIPE_FD_BASE;
static int is_pipe_fd(int fd) { return fd >= PIPE_FD_BASE && fd < PIPE_FD_BASE + PIPE_FD_MAX; }

int pipe(int fds[2]) {
    if (pipe_next + 1 >= PIPE_FD_BASE + PIPE_FD_MAX) { errno = EMFILE; return -1; }
    fds[0] = pipe_next++;
    fds[1] = pipe_next++;
    return 0;
}

int socket(int domain, int type, int protocol) {
    (void)domain; (void)type; (void)protocol;
    int fd = host_socket();
    if (fd < 0) { errno = EMFILE; return -1; }
    return fd;
}

/* bind() records the port for host_listen, which ignores it. */
#define PORTMAP_MAX 16
static struct { int fd, port; } portmap[PORTMAP_MAX];
static void port_set(int fd, int port) {
    for (int i = 0; i < PORTMAP_MAX; i++)
        if (portmap[i].fd == 0 || portmap[i].fd == fd) { portmap[i].fd = fd; portmap[i].port = port; return; }
}
static int port_get(int fd) {
    for (int i = 0; i < PORTMAP_MAX; i++) if (portmap[i].fd == fd) return portmap[i].port;
    return 0;
}

int bind(int fd, const struct sockaddr *addr, socklen_t len) {
    (void)len;
    if (addr && addr->sa_family == AF_INET) {
        const struct sockaddr_in *in = (const struct sockaddr_in *)addr;
        port_set(fd, __builtin_bswap16(in->sin_port));
    }
    return 0;
}

int listen(int fd, int backlog) {
    (void)backlog;
    if (host_listen(fd, port_get(fd)) < 0) { errno = EADDRINUSE; return -1; }
    return 0;
}

int accept(int sfd, struct sockaddr *addr, socklen_t *len) {
    (void)addr; if (len) *len = 0;
    int c = host_accept(sfd);
    if (c < 0) { errno = EAGAIN; return -1; }
    return c;
}
int accept4(int sfd, struct sockaddr *addr, socklen_t *len, int flags) {
    (void)flags; return accept(sfd, addr, len);
}

/* The host makes no outgoing connections. */
int connect(int fd, const struct sockaddr *addr, socklen_t len) {
    (void)fd; (void)addr; (void)len; errno = ECONNREFUSED; return -1;
}

/* Socket options mean nothing to the host. */
int setsockopt(int fd, int lvl, int opt, const void *val, socklen_t len) {
    (void)fd; (void)lvl; (void)opt; (void)val; (void)len; return 0;
}
int getsockopt(int fd, int lvl, int opt, void *val, socklen_t *len) {
    (void)fd; (void)lvl; (void)opt;
    if (val && len && *len >= (socklen_t)sizeof(int)) { *(int *)val = 0; *len = sizeof(int); }
    return 0;
}
int getsockname(int fd, struct sockaddr *addr, socklen_t *len) {
    (void)fd; if (len) *len = 0; (void)addr; return 0;
}
int getpeername(int fd, struct sockaddr *addr, socklen_t *len) {
    (void)fd; if (len) *len = 0; (void)addr; return 0;
}

/* No DNS: lookups answer 127.0.0.1 with the service as the port, enough for anet to bind. */
int getaddrinfo(const char *node, const char *service,
                const struct addrinfo *hints, struct addrinfo **res) {
    (void)node;
    if (hints && hints->ai_family == AF_INET6) return EAI_FAMILY;

    struct addrinfo *ai = calloc(1, sizeof(*ai));
    struct sockaddr_in *sa = calloc(1, sizeof(*sa));
    if (!ai || !sa) { free(ai); free(sa); return EAI_MEMORY; }

    sa->sin_family = AF_INET;
    sa->sin_port = __builtin_bswap16(service ? (uint16_t)atoi(service) : 0);
    sa->sin_addr.s_addr = __builtin_bswap32(INADDR_LOOPBACK);

    ai->ai_family = AF_INET;
    ai->ai_socktype = (hints && hints->ai_socktype) ? hints->ai_socktype : SOCK_STREAM;
    ai->ai_protocol = 0;
    ai->ai_addr = (struct sockaddr *)sa;
    ai->ai_addrlen = sizeof(*sa);
    ai->ai_next = 0;
    *res = ai;
    return 0;
}

void freeaddrinfo(struct addrinfo *res) {
    while (res) {
        struct addrinfo *next = res->ai_next;
        free(res->ai_addr);
        free(res);
        res = next;
    }
}

const char *gai_strerror(int errcode) { (void)errcode; return "name resolution disabled"; }

/* Host sockets have no real peer address. */
int getnameinfo(const struct sockaddr *sa, socklen_t salen,
                char *host, socklen_t hostlen,
                char *serv, socklen_t servlen, int flags) {
    (void)salen; (void)flags;
    if (host && hostlen) {
        const char *h = "127.0.0.1";
        strncpy(host, h, hostlen - 1); host[hostlen - 1] = 0;
    }
    if (serv && servlen) {
        uint16_t port = 0;
        if (sa && sa->sa_family == AF_INET)
            port = __builtin_bswap16(((const struct sockaddr_in *)sa)->sin_port);
        snprintf(serv, servlen, "%u", port);
    }
    return 0;
}

ssize_t __wrap_read(int fd, void *buf, size_t n) {
    if (is_host_fd(fd)) {
        int r = host_read(fd, buf, (int)n);
        if (r < 0) { errno = EAGAIN; return -1; }
        return r;
    }
    if (is_pipe_fd(fd)) { errno = EAGAIN; return -1; }
    return __real_read(fd, buf, n);
}
ssize_t __wrap_write(int fd, const void *buf, size_t n) {
    if (is_host_fd(fd)) {
        int r = host_write(fd, buf, (int)n);
        if (r < 0) { errno = EPIPE; return -1; }
        return r;
    }
    if (is_pipe_fd(fd)) return (ssize_t)n;
    return __real_write(fd, buf, n);
}
ssize_t __wrap_writev(int fd, const struct iovec *iov, int iovcnt) {
    if (is_host_fd(fd)) {
        ssize_t total = 0;
        for (int i = 0; i < iovcnt; i++) {
            if (iov[i].iov_len == 0) continue;
            int r = host_write(fd, iov[i].iov_base, (int)iov[i].iov_len);
            if (r < 0) return total ? total : (errno = EPIPE, -1);
            total += r;
            if (r < (int)iov[i].iov_len) break;
        }
        return total;
    }
    if (is_pipe_fd(fd)) {
        ssize_t total = 0;
        for (int i = 0; i < iovcnt; i++) total += iov[i].iov_len;
        return total;
    }
    return __real_writev(fd, iov, iovcnt);
}

int __wrap_close(int fd) {
    if (is_host_fd(fd)) { host_close(fd); return 0; }
    if (is_pipe_fd(fd)) return 0;
    return __real_close(fd);
}
int __wrap_fcntl(int fd, int cmd, ...) {
    if (is_host_fd(fd) || is_pipe_fd(fd)) return 0; /* always nonblocking */
    __builtin_va_list ap; __builtin_va_start(ap, cmd);
    int arg = __builtin_va_arg(ap, int); __builtin_va_end(ap);
    return __real_fcntl(fd, cmd, arg);
}
