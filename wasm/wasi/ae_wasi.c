/* ae.c poll backend over host_poll. Included by ae.c when HAVE_WASI_AE is set
 * (see the small patch to ae.c's backend #include chain). Implements the same
 * 7 aeApi* functions as ae_select.c / ae_epoll.c.
 *
 * Unlike a native backend, aeApiPoll NEVER blocks: under Node the wasm runs on
 * the same thread as the event loop, so it cannot sleep waiting for I/O. JS
 * drives one aeProcessEvents(...AE_DONT_WAIT) iteration (reactor rk_step) each
 * time a socket becomes ready or a timer fires; aeApiPoll just reports what is
 * ready right now, which JS knows from its per-fd buffers. */
#include "host.h"

typedef struct aeApiState {
    /* fds whose events[] mask is nonzero, unordered, so a poll walks only the
     * live fds instead of 0..maxfd (host fds start at HOST_FD_BASE). */
    int *fds;
    int *pos;   /* pos[fd] = index of fd in fds[], or -1 */
    int count;
    int cap;    /* allocated length of fds[] and pos[] */
} aeApiState;

/* scratch buffers for the host_poll hand-off, sized to the loop's setsize */
static int32_t *ae_interest = 0;  /* (fd,mask) pairs */
static int32_t *ae_fired = 0;     /* (fd,mask) pairs */
static int ae_cap = 0;

static void aeApiGrow(aeApiState *state, int setsize) {
    if (setsize > state->cap) {
        state->fds = zrealloc(state->fds, sizeof(int) * setsize);
        state->pos = zrealloc(state->pos, sizeof(int) * setsize);
        for (int i = state->cap; i < setsize; i++) state->pos[i] = -1;
        state->cap = setsize;
    }
    if (setsize > ae_cap) {
        ae_cap = setsize;
        ae_interest = zrealloc(ae_interest, sizeof(int32_t) * 2 * ae_cap);
        ae_fired = zrealloc(ae_fired, sizeof(int32_t) * 2 * ae_cap);
    }
}

static void aeApiUntrack(aeApiState *state, int fd) {
    int i = state->pos[fd];
    int last = state->fds[--state->count];
    state->fds[i] = last;
    state->pos[last] = i;
    state->pos[fd] = -1;
}

static int aeApiCreate(aeEventLoop *eventLoop) {
    aeApiState *state = zcalloc(sizeof(aeApiState));
    if (!state) return -1;
    eventLoop->apidata = state;
    aeApiGrow(state, eventLoop->setsize);
    return 0;
}

static int aeApiResize(aeEventLoop *eventLoop, int setsize) {
    aeApiGrow(eventLoop->apidata, setsize);
    return 0;
}

static void aeApiFree(aeEventLoop *eventLoop) {
    aeApiState *state = eventLoop->apidata;
    zfree(state->fds);
    zfree(state->pos);
    zfree(state);
}

/* ae.c calls this before OR-ing mask into events[fd].mask. */
static int aeApiAddEvent(aeEventLoop *eventLoop, int fd, int mask) {
    aeApiState *state = eventLoop->apidata;
    (void)mask;
    if (state->pos[fd] == -1) {
        state->pos[fd] = state->count;
        state->fds[state->count++] = fd;
    }
    return 0;
}

/* ae.c calls this after clearing mask from events[fd].mask; `& ~mask` keeps
 * the result right whichever order the core uses. */
static void aeApiDelEvent(aeEventLoop *eventLoop, int fd, int mask) {
    aeApiState *state = eventLoop->apidata;
    int remaining = eventLoop->events[fd].mask & ~mask;
    if (remaining == AE_NONE && state->pos[fd] != -1) aeApiUntrack(state, fd);
}

static int aeApiPoll(aeEventLoop *eventLoop, struct timeval *tvp) {
    (void)tvp; /* never block */
    aeApiState *state = eventLoop->apidata;
    int n = 0;
    for (int i = 0; i < state->count;) {
        int fd = state->fds[i];
        int mask = eventLoop->events[fd].mask;
        /* Mask can drop to NONE without a DelEvent (e.g. only AE_BARRIER was
         * removed); prune it here. fds[i] then holds an unvisited fd. */
        if (mask == AE_NONE) {
            aeApiUntrack(state, fd);
            continue;
        }
        ae_interest[n * 2] = fd;
        ae_interest[n * 2 + 1] = mask;
        n++;
        i++;
    }
    if (n == 0) return 0;
    int fired = host_poll(ae_interest, n, ae_fired, ae_cap, 0);
    for (int j = 0; j < fired; j++) {
        eventLoop->fired[j].fd = ae_fired[j * 2];
        eventLoop->fired[j].mask = ae_fired[j * 2 + 1];
    }
    return fired;
}

static char *aeApiName(void) { return "wasi-host"; }
