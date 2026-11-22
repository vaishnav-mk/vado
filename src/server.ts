// The Worker: the database (@vado/server) takes TCP clients, /ws, /live and the bench API, and the dashboard
// (TanStack Start) serves every other request. The dashboard loads on the first page request, so the database's
// Durable Objects, which never serve one, don't start it.
import { worker } from "@vado/server";

export * from "@vado/server/objects.js";
export default worker({
  fetch: async (req: Request) => (await import("@tanstack/react-start/server-entry")).default.fetch(req),
});
