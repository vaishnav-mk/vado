/* The sysroot has no <termios.h>. Only memtest.c uses it, and memtest never runs here. */
#ifndef VALKEY_WASM_TERMIOS_H
#define VALKEY_WASM_TERMIOS_H
#include <sys/types.h>

typedef unsigned char cc_t;
typedef unsigned int  speed_t;
typedef unsigned int  tcflag_t;

#define NCCS 32
struct termios {
    tcflag_t c_iflag, c_oflag, c_cflag, c_lflag;
    cc_t     c_line;
    cc_t     c_cc[NCCS];
    speed_t  c_ispeed, c_ospeed;
};

#define ICANON  0000002
#define ECHO    0000010
#define TCSANOW    0
#define TCSADRAIN  1
#define TCSAFLUSH  2
#define VMIN  6
#define VTIME 5

static inline int tcgetattr(int fd, struct termios *t) { (void)fd; (void)t; return 0; }
static inline int tcsetattr(int fd, int act, const struct termios *t) {
    (void)fd; (void)act; (void)t; return 0;
}

struct winsize {
    unsigned short ws_row, ws_col, ws_xpixel, ws_ypixel;
};
#define TIOCGWINSZ 0x5413

#endif
