// BASE and TOKEN reach the bench API; HOST, PORT and PW a database (PW set: AUTH <db> <PW>, as through vado-shim).
import net from "node:net";
import Redis from "ioredis";

export const { BASE = "http://localhost:5173", TOKEN = "local", HOST = "127.0.0.1", FLAVOUR } = process.env;
export const PORT = Number(process.env.PORT ?? 6379);
export const PW = process.env.PW || undefined;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const enc = (a) => `*${a.length}\r\n` + a.map((x) => `$${Buffer.byteLength(x)}\r\n${x}\r\n`).join("");
export const tcp = () => net.connect(PORT, HOST);

export const api = (path, init) =>
  fetch(`${BASE}${path}`, { ...init, headers: { authorization: `Bearer ${TOKEN}` } }).then((r) => r.json());

export const createDb = (db, shards) => api(`/db?db=${db}&shards=${shards}${FLAVOUR ? `&flavour=${FLAVOUR}` : ""}`);

export const redis = (db, o) =>
  new Redis({ port: PORT, host: HOST, username: PW ? db : undefined, password: PW, ...o });
