/* -mllvm -wasm-enable-sjlj lowers setjmp/longjmp to these helpers and a throw of the
 * __c_longjmp tag, which the host supplies. wasi-sdk doesn't ship the helpers (Emscripten's
 * runtime does). The struct layout and tag index are the ABI LLVM emits, as in Emscripten's
 * emscripten_setjmp.c; wasi-libc's jmp_buf is larger, so writing through it is safe. */
#include <stdint.h>

struct __WasmLongjmpArgs { void *env; int val; };
struct jmp_buf_impl {
    void *func_invocation_id;
    uint32_t label;
    struct __WasmLongjmpArgs arg;
};

#define C_LONGJMP 1

void __wasm_setjmp(void *env, uint32_t label, void *func_invocation_id) {
    struct jmp_buf_impl *jb = env;
    jb->func_invocation_id = func_invocation_id;
    jb->label = label;
}

uint32_t __wasm_setjmp_test(void *env, void *func_invocation_id) {
    struct jmp_buf_impl *jb = env;
    if (jb->func_invocation_id == func_invocation_id) return jb->label;
    return 0;
}

void __wasm_longjmp(void *env, int val) {
    struct jmp_buf_impl *jb = env;
    struct __WasmLongjmpArgs *arg = &jb->arg;
    if (val == 0) val = 1;
    arg->env = env;
    arg->val = val;
    __builtin_wasm_throw(C_LONGJMP, arg);
}
