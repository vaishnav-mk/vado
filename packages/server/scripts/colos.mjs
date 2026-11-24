// Regenerates src/catalog/colos.json: each Cloudflare colo's city, coordinates and location hint, for maps,
// labels and finding the replica in a router's region.
//   node scripts/colos.mjs
import { writeFile } from "node:fs/promises";

const res = await fetch("https://speed.cloudflare.com/locations", {
  headers: { referer: "https://speed.cloudflare.com/" },
});

if (!res.ok) throw new Error(`speed.cloudflare.com/locations answered ${res.status}`);

const HINT_OF_REGION = {
  Africa: "afr",
  "Asia Pacific": "apac",
  "Middle East": "me",
  Oceania: "oc",
  "South America": "sam",
};

// North America and Europe each hold two hints, split by longitude.
function hintOf({ iata, region, lon }) {
  if (region === "North America") return lon < -100 ? "wnam" : "enam";

  if (region === "Europe") return lon < 15 ? "weur" : "eeur";

  if (HINT_OF_REGION[region]) return HINT_OF_REGION[region];

  throw new Error(`${iata}: no location hint for region ${region}`);
}

const list = (await res.json()).sort((a, b) => a.iata.localeCompare(b.iata));

const rows = list.map(
  (c) => `  ${JSON.stringify(c.iata)}: ${JSON.stringify([c.city, +c.lat.toFixed(2), +c.lon.toFixed(2), hintOf(c)])}`,
);

await writeFile(new URL("../src/catalog/colos.json", import.meta.url), `{\n${rows.join(",\n")}\n}\n`);

console.log(`${list.length} colos`);
