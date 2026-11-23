import { DB_NAME, DB_NAME_RULE } from "../catalog/names";
import { error } from "../protocol/resp";
import type { Conn } from "./conn";
import { droppedDatabase, errorOf, TOO_MANY, WRONGPASS } from "./replies-text";
import { sameSecret, secretMatches } from "./secrets";

const shared = (c: Conn, pass: string) => c.options.password === undefined || sameSecret(pass, c.options.password);

function wrong(c: Conn): void {
  c.options.signIns?.failed();
  c.replies.reply(WRONGPASS);
}

// `user` names the database. Its own password, if set, is the only one, except through a service binding.
export function login(c: Conn, user: string | null, pass: string, then: () => void): void {
  const name = !user || user === "default" ? c.db.name : user;

  if (!DB_NAME.test(name)) return c.replies.reply(error(`ERR ${DB_NAME_RULE}`));

  if (c.options.signIns?.blocked()) return c.replies.reply(TOO_MANY);

  if (name === c.db.name && !(c.db.secret && !c.options.trusted)) {
    if (!shared(c, pass)) return wrong(c);
    c.authed = true;

    return then();
  }

  c.replies.hold(signIn(c, name, pass, then).catch((cause: unknown) => c.replies.reply(errorOf(cause))));
}

async function signIn(c: Conn, name: string, pass: string, then: () => void): Promise<void> {
  const known = name === c.db.name ? c.db : await c.options.lookup(name);

  // A guesser learns no names.
  if (known?.dropped) return shared(c, pass) ? c.replies.reply(droppedDatabase(name)) : wrong(c);
  const ok = known?.secret && !c.options.trusted ? await secretMatches(known.secret, pass) : shared(c, pass);

  if (!ok) return wrong(c);

  if (name !== c.db.name) {
    const next = await c.options.open(name);
    // Earlier requests went to the old database's upstreams.
    await c.replies.afterAll();
    c.pool.closeAll();
    c.tx.clearWatch();
    c.endPassthrough(false);
    c.target = next;
  }

  c.authed = true;
  then();
}
