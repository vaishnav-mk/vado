import { useEffect, useRef, type RefObject } from "react";
import { SHARD } from "../../lib/colors";
import type { Shard } from "../../lib/types";
import { arcSpan, ops, pt, R_HUB, R_IN } from "./geometry";

interface Dot {
  a: number;
  r: number;
  v: number;
  write: boolean;
}

/** Draws traffic on `canvas`: dots flying from the hub into each shard, reads in `read`, writes in orange. */
export function useTrafficDots(
  canvas: RefObject<HTMLCanvasElement | null>,
  shards: Shard[],
  n: number,
  read: string,
  calm: boolean,
) {
  const live = useRef({ shards, n });

  live.current = { shards, n };

  useEffect(() => {
    if (calm) return;

    let dots: Dot[] = [],
      last = performance.now(),
      raf = 0;

    const acc = new Map<number, number>();

    const draw = (t: number) => {
      raf = requestAnimationFrame(draw);

      const c = canvas.current,
        ctx = c?.getContext("2d"),
        cur = live.current;

      if (!c || !ctx) return;

      const dt = Math.min(0.05, (t - last) / 1000),
        w = Math.round(c.clientWidth * devicePixelRatio);

      last = t;

      if (!w) return;

      if (c.width !== w) {
        c.width = w;
        c.height = w;
      }

      const k = w / 400;

      ctx.clearRect(0, 0, w, w);

      for (const s of cur.shards) {
        const o = ops(s);

        if (!s.ok || !o) continue;
        let a = (acc.get(s.i) ?? 0) + Math.min(50, 1.8 * Math.sqrt(o)) * dt;

        const [a0, a1] = arcSpan(s.i, cur.n),
          share = (s.writes ?? 0) / o;

        for (; a >= 1; a--)
          dots.push({
            a: a0 + Math.random() * (a1 - a0),
            r: R_HUB,
            v: 120 + Math.random() * 60,
            write: Math.random() < share,
          });
        acc.set(s.i, a);
      }

      dots = dots.filter((p) => p.r < R_IN - 2);

      for (const p of dots) {
        p.r += p.v * dt;
        const [x, y] = pt(p.r, p.a);
        ctx.fillStyle = p.write ? SHARD : read;
        ctx.globalAlpha = Math.max(0, Math.min(1, (p.r - R_HUB) / 10, (R_IN - p.r) / 8));
        ctx.beginPath();
        ctx.arc(x * k, y * k, 1.6 * k, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.globalAlpha = 1;
    };

    raf = requestAnimationFrame(draw);

    return () => cancelAnimationFrame(raf);
  }, [canvas, read, calm]);
}
