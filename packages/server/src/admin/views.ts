// Browser-safe: the dashboard imports `place`.
import colos from "../catalog/colos.json";
import type { DatabaseRecord, DatabaseSummary } from "../catalog/types";
import type { Database, Place } from "./live-types";

const COLOS = new Map(
  Object.entries(colos).map(([colo, [city, lat, lon]]) => [
    colo,
    { city: String(city), lat: Number(lat), lon: Number(lon) },
  ]),
);

export const place = (colo: string | null): Place => {
  const c = colo === null ? undefined : COLOS.get(colo);

  return c ? { colo, ...c } : { colo, city: null, lat: null, lon: null };
};

export const dbView = (db: DatabaseRecord | DatabaseSummary): Database => ({
  name: db.name,
  created: db.created,
  shards: db.shards,
  regions: db.regions,
  replicas: db.replicas,
  flavour: db.flavour,
  password: "password" in db ? Boolean(db.password) : db.secret !== null,
});
