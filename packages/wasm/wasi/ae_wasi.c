/* ae.c includes this when HAVE_WASI_AE is set. aeApiPoll never blocks: the module runs on the
 * Durable Object's thread, so it only reports what the host has ready now. */
#include "host.h"

typedef struct aeApiState {
    /* fds with a nonzero mask, so a poll skips 0..maxfd (host fds start at HOST_FD_BASE) */
    int *fds;
    int *pos;
    int count;
    int cap;
} aeApiState;

static int32_t *ae_interest = 0;
static int32_t *ae_fired = 0;
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

static int aeApiAddEvent(aeEventLoop *eventLoop, int fd, int mask) {
    aeApiState *state = eventLoop->apidata;
    (void)mask;
    if (state->pos[fd] == -1) {
        state->pos[fd] = state->count;
        state->fds[state->count++] = fd;
    }
    return 0;
}

/* Redis calls this before clearing mask from events[fd].mask and Valkey after; & ~mask suits both. */
static void aeApiDelEvent(aeEventLoop *eventLoop, int fd, int mask) {
    aeApiState *state = eventLoop->apidata;
    int remaining = eventLoop->events[fd].mask & ~mask;
    if (remaining == AE_NONE && state->pos[fd] != -1) aeApiUntrack(state, fd);
}

static int aeApiPoll(aeEventLoop *eventLoop, struct timeval *tvp) {
    (void)tvp;
    aeApiState *state = eventLoop->apidata;
    int n = 0;
    for (int i = 0; i < state->count;) {
        int fd = state->fds[i];
        int mask = eventLoop->events[fd].mask;
        /* Removing only AE_BARRIER empties a mask without a DelEvent. Untracking moves an
         * unvisited fd into fds[i]. */
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
