# vado dashboard

The live view of a vado database: shards, read replicas, where traffic comes from, response time, and a
timeline of what happened. Anyone can watch. Signing in with the bench token lets you create databases,
run commands, restart shards and start test traffic.

It is a TanStack Start app (React, TypeScript, Kumo) on Cloudflare Workers. It only renders:

- Live numbers come from `/live?db=<name>` on the same origin, a WebSocket served by the database Worker
  (`src/admin/watcher.js`). `src/lib/live.ts` reconnects and merges the messages.
- Everything else goes through server functions in `src/server/` to the `ADMIN` service binding,
  valkey-do's `Admin` entrypoint (`src/admin/admin.js`). Every change checks the `vado_session` cookie.

## Reached through the main URL

`vado-dashboard` has no URL of its own (`workers_dev` and `preview_urls` are off). valkey-do forwards every
request that isn't `/ws`, `/live` or a bench call to its `DASHBOARD` service binding, which points here.

## Deploy

The two Workers bind to each other. On a new account, deploy valkey-do once without its `DASHBOARD` service, then
this one, then valkey-do again ([operations](../docs/operations.md#watch-it-live)). After that, either deploys on its
own. From `dashboard/`:

```sh
npm install
npm run build
npx wrangler deploy
```

`npm test` checks the command parser and chart axes; `npx tsc --noEmit` checks types.
