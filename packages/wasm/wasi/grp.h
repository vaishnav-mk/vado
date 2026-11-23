/* The sysroot has no <grp.h>. anet.c uses it only for unix socket ownership, which never runs here. */
#ifndef VALKEY_WASM_GRP_H
#define VALKEY_WASM_GRP_H
#include <sys/types.h>

struct group {
    char  *gr_name;
    char  *gr_passwd;
    gid_t  gr_gid;
    char **gr_mem;
};

static inline struct group *getgrnam(const char *name) { (void)name; return 0; }

#endif
