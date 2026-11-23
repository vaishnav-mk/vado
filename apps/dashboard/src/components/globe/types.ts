import type { GeoPath, GeoProjection } from "d3-geo";

export type LonLat = [number, number];

export interface Layer {
  kind: "entry" | "shard" | "replica";
  color: string;
  size: number;
  alpha?: number;
}

// Later layers are rings around earlier ones, so traffic entering in the shards' city still shows.
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

export interface Frame {
  ctx: CanvasRenderingContext2D;
  path: GeoPath;
  projection: GeoProjection;
  dpr: number;
  size: number;
  calm: boolean;
  fade: (p: LonLat) => number;
}
