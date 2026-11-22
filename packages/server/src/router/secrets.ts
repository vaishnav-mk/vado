// Passwords: constant-time comparison, and the salted hash a database's own password is stored as.
const enc = new TextEncoder();

// SAFETY: Workers' SubtleCrypto has timingSafeEqual; the DOM lib the dashboard needs in tsconfig hides it.
const subtle = crypto.subtle as SubtleCrypto & { timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean };

/** Length leaks; contents don't. */
export const sameSecret = (a: string, b: string): boolean => {
  const x = enc.encode(a),
    y = enc.encode(b);

  return x.length === y.length && subtle.timingSafeEqual(x, y);
};

const sha256 = async (s: string) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

/** "salt:sha256(salt + password)". Passwords are generated (high entropy), so a fast hash is enough, and AUTH stays
 *  cheap for clients that connect often. */
export const hashSecret = async (pass: string): Promise<string> => {
  const salt = crypto.randomUUID();

  return `${salt}:${await sha256(salt + pass)}`;
};

export const secretMatches = async (stored: string, pass: string): Promise<boolean> => {
  const i = stored.indexOf(":");

  return sameSecret(await sha256(stored.slice(0, i) + pass), stored.slice(i + 1));
};
