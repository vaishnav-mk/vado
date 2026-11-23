/* The sysroot's sockaddr_un lacks sun_path, which anet.c uses. No unix socket is ever created. */
#ifndef VALKEY_WASM_SYS_UN_H
#define VALKEY_WASM_SYS_UN_H
#include <sys/socket.h>

struct sockaddr_un {
    sa_family_t sun_family;
    char        sun_path[108];
};

#endif
