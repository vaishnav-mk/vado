import type { GeoPath, GeoProjection } from "d3-geo";

export type LonLat = [number, number];

export interface Layer {
  kind: "entry" | "shard" | "replica";
  color: string;
  size: number;
  alpha?: number;
}

/** One place on the globe. Its layers are drawn inside out (shards, replicas, traffic), each later one as a ring
 *  around the earlier ones, so traffic entering in the same city as the shards still shows. */
export interface Spot {
  at: LonLat;
  title: string;
  lines: string[];
  layers: Layer[];
  seed: number;
}

export interface Arc {
  id: string;
  from: LonLat;
  to: LonLat;
  color: string;
  alpha: number;
  rate: number;
  at: (t: number) => LonLat;
}

export interface CommandPath {
  legs: Arc[];
  fan: Arc[];
  at: number;
}

export interface Scene {
  spots: Spot[];
  arcs: Arc[];
  path: CommandPath | null;
  center: LonLat | null;
}

/** A spot as drawn this frame, in CSS pixels, for hit testing. */
export interface Drawn {
  x: number;
  y: number;
  r: number;
  spot: Spot;
}

export interface Tip {
  x: number;
  y: number;
  r: number;
  title: string;
  lines: string[];
}

export interface Colors {
  ocean: string;
  line: string;
  land: string;
  landFill: string;
}

/** What one frame draws with. `fade` is 1 on the visible side, falling to 0 at the edge. */
export interface Frame {
  ctx: CanvasRenderingContext2D;
  path: GeoPath;
  projection: GeoProjection;
  dpr: number;
  size: number;
  calm: boolean;
  fade: (p: LonLat) => number;
}
