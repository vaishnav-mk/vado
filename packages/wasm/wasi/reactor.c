/* Exports for the host in packages/server/src/wasm-shard/host/. The 0002 patch makes main() return
 * after init, so the host runs the event loop one pass at a time. */
#include "server.h"
#include "ae.h"
#include "module.h"

extern int main(int argc, char **argv);

/* The host writes NUL-separated arguments after argv[0] here, then calls rk_boot_args(len). */
static char rk_args[8192];

__attribute__((export_name("rk_args_ptr")))
char *rk_args_ptr(void) { return rk_args; }

__attribute__((export_name("rk_args_cap")))
int rk_args_cap(void) { return (int)sizeof rk_args; }

__attribute__((export_name("rk_boot_args")))
int rk_boot_args(int len) {
    static char *argv[256];
    int argc = 0;
    argv[argc++] = "valkey-server";
    for (int i = 0; i < len && argc < 255; ) {
        argv[argc++] = &rk_args[i];
        while (i < len && rk_args[i] != '\0') i++;
        i++;
    }
    argv[argc] = NULL;
    return main(argc, argv);
}

/* aeMain's order (afterSleep, events, timers, beforeSleep), so this pass's AOF write and reply
 * flush happen in this call. afterSleep takes the module GIL; boot leaves it held, and locking a
 * held mutex traps without threads, so release it first. */
__attribute__((export_name("rk_tick")))
int rk_tick(void) {
    aeEventLoop *el = server.el;
    if (moduleCount()) {
        moduleTryAcquireGIL();
        moduleReleaseGIL();
    }
    int processed = aeProcessEvents(el, AE_ALL_EVENTS | AE_DONT_WAIT | AE_CALL_AFTER_SLEEP);
    if (el->beforesleep) el->beforesleep(el);
    return processed;
}

/* The serverCron period, which the host uses as its timer interval. */
__attribute__((export_name("rk_next_timeout_ms")))
int rk_next_timeout_ms(void) {
    return 1000 / server.hz;
}
