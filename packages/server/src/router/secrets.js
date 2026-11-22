// Passwords: constant-time comparison, and the salted hash a database's own password is stored as.
const te = new TextEncoder();
// Length leaks; contents don't.
export const sameSecret = (a, b) => { const x = te.encode(a), y = te.encode(b); return x.length === y.length && crypto.subtle.timingSafeEqual(x, y); };
// A database's own password is stored as "salt:sha256(salt + password)". Passwords are generated (high
// entropy), so a fast hash is enough, and AUTH stays cheap for clients that connect often.
const sha256 = async (s) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", te.encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");
export const hashSecret = async (pass) => { const salt = crypto.randomUUID(); return `${salt}:${await sha256(salt + pass)}`; };
export const secretMatches = async (stored, pass) => { const i = stored.indexOf(":"); return sameSecret(await sha256(stored.slice(0, i) + pass), stored.slice(i + 1)); };
