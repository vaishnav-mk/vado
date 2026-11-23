/* The sysroot has no <sys/wait.h>. wasm_compat.h makes waitpid() return 0 and wait3() -1, so no
 * status is ever read. */
#ifndef VALKEY_WASM_SYS_WAIT_H
#define VALKEY_WASM_SYS_WAIT_H
#include <sys/types.h>

#define WNOHANG   1
#define WUNTRACED 2

#define WIFEXITED(s)    (((s) & 0x7f) == 0)
#define WEXITSTATUS(s)  (((s) >> 8) & 0xff)
#define WIFSIGNALED(s)  (((signed char)(((s) & 0x7f) + 1) >> 1) > 0)
#define WTERMSIG(s)     ((s) & 0x7f)
#define WIFSTOPPED(s)   (((s) & 0xff) == 0x7f)
#define WSTOPSIG(s)     WEXITSTATUS(s)
#define WCOREDUMP(s)    ((s) & 0x80)
#define WIFCONTINUED(s) ((s) == 0xffff)

#endif
