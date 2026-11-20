import { useEffect, useRef, useState } from "react";
import * as echarts from "echarts";
import { feature } from "topojson-client";
import land from "world-atlas/land-110m.json";
import {
  Badge, Banner, BubbleMap, Button, ChartPalette, Dialog, Empty, Grid, Input, LayerCard, Loader, Meter, Select, Table, Text,
  TimeseriesChart, Tooltip, TooltipProvider,
} from "@cloudflare/kumo";
import { ArrowClockwiseIcon, ClockCounterClockwiseIcon, PlayIcon, PlusIcon, StopIcon } from "@phosphor-icons/react";

// Land outlines for the map. Rings that cross the antimeridian (Russia, Fiji) are made continuous and
// clamped to ±180°, since the map projects point by point and would otherwise draw lines across it.
const geoJson = (() => {
  const fc = feature(land, land.objects.land);
  const fix = (ring) => {
    let off = 0, prev = ring[0][0];
    const un = ring.map(([lon, lat]) => { if (lon - prev > 180) off -= 360; else if (lon - prev < -180) off += 360; prev = lon; return [lon + off, lat]; });
    const shift = Math.round(un.reduce((a, p) => a + p[0], 0) / un.length / 360) * 360;
    return un.map(([lon, lat]) => [Math.max(-180, Math.min(180, lon - shift)), lat]);
  };
  const polys = (g) => (g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : []);
  return { type: "FeatureCollection", features: fc.features.map((f) => ({ ...f, geometry: { type: "MultiPolygon", coordinates: polys(f.geometry).filter((p) => p[0].some(([, lat]) => lat > -60)).map((p) => p.map(fix)) } })) };
})();
const SHARD_COLOR = "#F6821F";
const REPLICA_COLOR = "#16A34A";
const SLOTS = 16384;

// ---- formatting ----
const num = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : `${Math.round(n)}`);
const bytes = (b) => (b >= 2 ** 30 ? `${(b / 2 ** 30).toFixed(1)} GB` : b >= 2 ** 20 ? `${(b / 2 ** 20).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`);
const duration = (s) => (s < 60 ? `${Math.round(s)} s` : s < 3600 ? `${Math.round(s / 60)} min` : s < 86400 ? `${(s / 3600).toFixed(1)} h` : `${Math.round(s / 86400)} d`);
const ms = (v) => (v === null || v === undefined ? "–" : `${Math.round(v)} ms`);
const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;
const clock = (t) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const post = (path, body) => fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());

function useLive() {
  const [s, set] = useState(null);
  useEffect(() => { const feed = new EventSource("/events"); feed.onmessage = (m) => set(JSON.parse(m.data)); return () => feed.close(); }, []);
  return s;
}
function useDark() {
  const q = matchMedia("(prefers-color-scheme: dark)");
  const [dark, set] = useState(q.matches);
  useEffect(() => { const f = (e) => set(e.matches); q.addEventListener("change", f); return () => q.removeEventListener("change", f); }, []);
  return dark;
}
function useJson(url, deps = []) {
  const [v, set] = useState(null);
  useEffect(() => { fetch(url).then((r) => r.json()).then(set).catch(() => {}); }, deps);
  return v;
}

export function App() {
  const s = useLive(), dark = useDark(), regions = useJson("/api/regions") ?? {};
  const [selected, setSelected] = useState(null);
  useEffect(() => { document.documentElement.dataset.mode = dark ? "dark" : "light"; }, [dark]);
  useEffect(() => setSelected(null), [s?.db.name]);
  if (!s) return <div className="grid min-h-screen place-items-center bg-kumo-canvas"><Loader size={24} /></div>;
  return (
    <TooltipProvider>
      <div className="min-h-screen bg-kumo-canvas text-kumo-default">
        <Header s={s} regions={regions} />
        <main className="mx-auto flex max-w-7xl flex-col gap-6 px-6 py-6">
          {s.error && <Banner variant="error" title="Can't reach the database" description={s.error} />}
          <Stats s={s} />
          <Grid variant="1-2" gap="base">
            <ShardDial s={s} dark={dark} selected={selected} onSelect={setSelected} />
            <TrafficMap s={s} dark={dark} />
          </Grid>
          <Grid variant="2up" gap="base">
            <Throughput s={s} dark={dark} />
            <ResponseTime s={s} dark={dark} />
          </Grid>
          <Grid variant="2-1" gap="base">
            <Shards s={s} selected={selected} onSelect={setSelected} />
            <div className="flex flex-col gap-6">
              <TestTraffic test={s.test} now={s.now} regions={regions} />
              <RunCommand />
              <Activity events={s.events} />
            </div>
          </Grid>
        </main>
      </div>
    </TooltipProvider>
  );
}

function Header({ s, regions }) {
  const dbs = useJson("/api/databases", [s.db.name]) ?? [];
  const items = Object.fromEntries(dbs.map((d) => [d.name, `${d.name} · ${plural(d.shards, "shard")}${d.spread ? " around the world" : ""}${d.replicated ? " · replicas everywhere" : ""}`]));
  return (
    <header className="border-b border-kumo-hairline bg-kumo-base">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-3 px-6 py-3">
        <Text variant="heading" size="lg" as="h1">vado</Text>
        <Select aria-label="Database" value={s.db.name} items={items} onValueChange={(name) => name && post("/api/watch", { name })} className="min-w-72" />
        <NewDatabase regions={regions} />
        <div className="ml-auto"><Health s={s} /></div>
      </div>
    </header>
  );
}

function NewDatabase({ regions }) {
  const [open, setOpen] = useState(false), [name, setName] = useState(""), [shards, setShards] = useState("4"), [place, setPlace] = useState("apac"), [copies, setCopies] = useState("yes");
  const [error, setError] = useState(null), [busy, setBusy] = useState(false);
  const create = async (e) => {
    e.preventDefault();
    setBusy(true);
    const r = await post("/api/create", { name: name.trim(), shards: Number(shards), place, replicas: copies === "yes" });
    setBusy(false);
    if (r.error) setError(r.error); else { setOpen(false); setName(""); setError(null); }
  };
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger render={(p) => <Button {...p} variant="secondary" icon={PlusIcon}>New database</Button>} />
      <Dialog className="p-6" size="sm">
        <Dialog.Title className="text-lg font-semibold">New database</Dialog.Title>
        <Dialog.Description className="mb-4 text-sm text-kumo-subtle">Its shards stay where they're created. Keys are spread evenly over them.</Dialog.Description>
        <form onSubmit={create} className="flex flex-col gap-4">
          <Input label="Name" placeholder="sessions" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" spellCheck={false} error={error ?? undefined} variant={error ? "error" : "default"} />
          <Select label="Shards" value={shards} onValueChange={setShards} items={{ 1: "1 shard (64 MB)", 4: "4 shards (256 MB)", 16: "16 shards (1 GB)", 64: "64 shards (4 GB)" }} />
          <Select label="Where the shards live" value={place} onValueChange={setPlace} items={{ world: "Spread around the world", ...regions }} />
          <Select label="Read replicas" value={copies} onValueChange={setCopies} items={{ yes: "In every region", no: "None" }}
            description="A copy of every shard in each region. Reads go to the nearest copy; writes go to the shard." />
          <div className="flex justify-end gap-2">
            <Dialog.Close render={(p) => <Button {...p} variant="secondary">Cancel</Button>} />
            <Button type="submit" variant="primary" loading={busy} disabled={!name.trim()}>Create</Button>
          </div>
        </form>
      </Dialog>
    </Dialog.Root>
  );
}

function Health({ s }) {
  const [variant, label] = {
    healthy: ["success", "Healthy"],
    restarting: ["warning", `${plural(s.restarting, "shard")} restarting`],
    unreachable: ["error", "Not reachable"],
    starting: ["neutral", "Connecting"],
  }[s.health];
  const reps = s.shards.flatMap((x) => x.replicas ?? []), ready = reps.filter((r) => r.state === "ready").length;
  return (
    <div className="flex items-center gap-2">
      <Badge variant={variant} appearance="dot">{label}</Badge>
      {reps.length > 0 && <Badge variant={ready === reps.length ? "success" : "warning"} appearance="dot">{ready} of {plural(reps.length, "replica")} ready</Badge>}
    </div>
  );
}

// "62% of reads served by nearby replicas", when the database has replicas.
function replicaShare(s) {
  const served = s.shards.reduce((a, x) => a + (x.replicas ?? []).reduce((b, r) => b + (r.reads ?? 0), 0), 0);
  const reads = s.history.at(-1)?.reads ?? 0;
  return served && reads ? `${Math.round((100 * served) / reads)}% of reads served by nearby replicas` : null;
}

function Stat({ title, value, hint, children }) {
  return (
    <LayerCard>
      <LayerCard.Secondary>{title}</LayerCard.Secondary>
      <LayerCard.Primary className="flex flex-col gap-1">
        <span className="text-3xl font-semibold tabular-nums">{value}</span>
        {hint && <Text variant="secondary" size="sm">{hint}</Text>}
        {children}
      </LayerCard.Primary>
    </LayerCard>
  );
}

function Stats({ s }) {
  const { totals, response } = s;
  return (
    <Grid variant="4up" gap="base">
      <Stat title="Commands per second" value={num(totals.ops)} hint={replicaShare(s) ?? (s.test ? "Includes test traffic" : "Reads and writes, all shards")} />
      <Stat title="Response time" value={ms(response.read)} hint={`Reads from this computer. Writes: ${ms(response.write)}.`} />
      <Stat title="Keys" value={totals.keys.toLocaleString()} hint={`Spread over ${plural(s.db.shards, "shard")}`} />
      <Stat title="Memory" value={bytes(totals.mem)}>
        <Meter label={`of ${bytes(totals.maxmem)}`} value={totals.maxmem ? (totals.mem / totals.maxmem) * 100 : 0} showValue={false} />
      </Stat>
    </Grid>
  );
}

// ---- the shard dial: every key hashes to one of 16,384 slots; each shard owns one arc of them ----
const first = (i, n) => Math.ceil((i * SLOTS) / n);
const ang = (slot) => (slot / SLOTS) * Math.PI * 2 - Math.PI / 2;
const pt = (r, a) => [200 + r * Math.cos(a), 200 + r * Math.sin(a)];
function arcSpan(i, n) {
  const gap = n > 1 ? Math.min(0.012, (Math.PI / n) * 0.1) : 0;
  let a0 = ang(first(i, n)) + gap, a1 = ang(first(i + 1, n)) - gap;
  if (a1 - a0 > Math.PI * 2 - 1e-3) a1 = a0 + Math.PI * 2 - 1e-3;
  return [a0, a1];
}
function annulus(r0, r1, a0, a1) {
  const large = a1 - a0 > Math.PI ? 1 : 0, [x0, y0] = pt(r1, a0), [x1, y1] = pt(r1, a1), [x2, y2] = pt(r0, a1), [x3, y3] = pt(r0, a0);
  return `M${x0} ${y0}A${r1} ${r1} 0 ${large} 1 ${x1} ${y1}L${x2} ${y2}A${r0} ${r0} 0 ${large} 0 ${x3} ${y3}Z`;
}
const R_IN = 120, R_OUT = 178, R_HUB = 112;

function ShardDial({ s, dark, selected, onSelect }) {
  const n = s.db.shards, shards = s.shards, max = Math.max(1, ...shards.map((x) => x.ops ?? 0));
  const read = ChartPalette.categorical(0, dark);
  const level = (x) => (x.ok && x.ops ? Math.log1p(x.ops) / Math.log1p(Math.max(max, 500)) : 0);
  const [hover, setHover] = useState(null);
  const focus = hover ?? selected, f = focus !== null ? shards[focus] : null;
  const canvas = useRef(null), live = useRef(s);
  live.current = s;
  // Traffic: dots flying from the middle into each shard, as many as its commands per second allow.
  useEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let parts = [], last = performance.now(), raf;
    const draw = (t) => {
      const c = canvas.current, cur = live.current;
      if (!c) return;
      const dt = Math.min(0.05, (t - last) / 1000), w = c.clientWidth * devicePixelRatio;
      last = t;
      if (c.width !== w) { c.width = w; c.height = w; }
      const ctx = c.getContext("2d"), k = w / 400;
      ctx.clearRect(0, 0, w, w);
      for (const x of cur.shards) {
        if (!x.ok || !x.ops) continue;
        x.acc = (x.acc ?? 0) + Math.min(50, 1.8 * Math.sqrt(x.ops)) * dt;
        const [a0, a1] = arcSpan(x.i, cur.db.shards);
        for (; x.acc >= 1; x.acc--) parts.push({ a: a0 + Math.random() * (a1 - a0), r: R_HUB, v: 120 + Math.random() * 60, write: Math.random() < (x.writeShare ?? 0) });
      }
      parts = parts.filter((p) => p.r < R_IN - 2);
      for (const p of parts) {
        p.r += p.v * dt;
        const [x1, y1] = pt(p.r, p.a);
        ctx.fillStyle = p.write ? SHARD_COLOR : read;
        ctx.globalAlpha = Math.min(1, (p.r - R_HUB) / 10, (R_IN - p.r) / 8);
        ctx.beginPath(); ctx.arc(x1 * k, y1 * k, 1.6 * k, 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalAlpha = 1;
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [read]);
  return (
    <LayerCard>
      <LayerCard.Secondary>Shards</LayerCard.Secondary>
      <LayerCard.Primary className="flex flex-col items-center gap-3">
        <div className="relative aspect-square w-full max-w-[360px]">
          <svg viewBox="0 0 400 400" className="absolute inset-0 size-full" role="img" aria-label={`${plural(n, "shard")}, brighter with more traffic`}>
            <circle cx="200" cy="200" r={R_HUB} className="fill-none stroke-kumo-hairline" />
            {shards.map((x) => {
              const [a0, a1] = arcSpan(x.i, n), l = level(x), [lx, ly] = pt((R_IN + R_OUT) / 2, (a0 + a1) / 2);
              return (
                <g key={x.i} onMouseEnter={() => setHover(x.i)} onMouseLeave={() => setHover(null)} onClick={() => onSelect(selected === x.i ? null : x.i)} className="cursor-pointer">
                  <path d={annulus(R_IN, R_OUT, a0, a1)} className={`${x.ok ? "fill-kumo-recessed" : "fill-kumo-danger/30"} stroke-kumo-base`} strokeWidth={2} />
                  {l > 0 && <path d={annulus(R_IN, R_OUT, a0, a1)} style={{ fill: read, fillOpacity: 0.15 + 0.85 * l }} className="transition-[fill-opacity] duration-700" />}
                  {selected === x.i && <path d={annulus(R_IN, R_OUT, a0, a1)} className="fill-none stroke-kumo-brand" strokeWidth={3} />}
                  {n <= 32 && <text x={lx} y={ly} textAnchor="middle" dominantBaseline="central" className={`pointer-events-none text-[15px] font-semibold ${l > 0.55 ? "fill-white" : "fill-current text-kumo-default"}`}>{x.i}</text>}
                  {(x.replicas ?? []).map((r, k, all) => {
                    const [dx, dy] = pt(R_OUT + 10, a0 + ((k + 0.5) / all.length) * (a1 - a0));
                    return <circle key={k} cx={dx} cy={dy} r={n > 16 ? 2 : 3.2} style={{ fill: r.state === "ready" ? REPLICA_COLOR : r.state === "idle" ? "#9CA3AF" : "#F59E0B" }} />;
                  })}
                </g>
              );
            })}
          </svg>
          <canvas ref={canvas} className="pointer-events-none absolute inset-0 size-full" />
          <div className="pointer-events-none absolute inset-0 grid place-content-center text-center">
            <span className="text-3xl font-semibold tabular-nums">{num(s.totals.ops)}</span>
            <Text variant="secondary" size="sm">commands/s</Text>
          </div>
        </div>
        <Text variant="secondary" size="sm">
          {f ? (f.ok ? `Shard ${f.i}${f.city ? ` in ${f.city}` : ""}: ${num(f.ops)} commands/s, ${f.keys.toLocaleString()} keys, ${bytes(f.mem)}` : `Shard ${f.i} isn't responding`)
            : "Each key belongs to one shard. Brighter shards are busier. Select one to find it in the table."}
        </Text>
      </LayerCard.Primary>
    </LayerCard>
  );
}

function TrafficMap({ s, dark }) {
  const entries = s.map?.entries ?? [], homes = s.map?.shards ?? [];
  // One size scale for both kinds: traffic by commands/s, shards by count (offset so they read as larger).
  const rows = [
    ...entries.map((e) => ({ ...e, kind: "traffic", value: Math.max(1, e.ops) })),
    ...homes.map((h) => ({ ...h, kind: "shards", value: 1e6 * h.count })),
    ...(s.map?.replicas ?? []).map((h) => ({ ...h, kind: "replicas", value: Math.max(1, h.reads) })),
  ];
  const size = (v) => (v >= 1e6 ? 8 + 2.5 * Math.sqrt(v / 1e6) : Math.min(26, 5 + 3 * Math.log10(1 + v)));
  const cities = (xs) => (xs.length > 3 ? `${xs.slice(0, 3).join(", ")} and ${xs.length - 3} more` : xs.join(", "));
  return (
    <LayerCard>
      <LayerCard.Secondary>Where traffic comes from</LayerCard.Secondary>
      <LayerCard.Primary className="flex flex-col gap-3">
        <BubbleMap
          echarts={echarts} geoJson={geoJson} mapName="vado-land-fixed" data={rows} lng="lon" lat="lat" name="city" value="value" bubbleSize={size}
          bubbleColor={(r) => (r.kind === "shards" ? SHARD_COLOR : r.kind === "replicas" ? REPLICA_COLOR : ChartPalette.categorical(0, dark))}
          bubbleBorderColor={(r) => (r.kind === "traffic" ? "transparent" : "rgba(0,0,0,.25)")} bubbleBorderWidth={(r) => (r.kind === "traffic" ? 0 : 1)}
          tooltipFormatter={(r) => (r.kind === "shards"
            ? `<strong>${esc(r.city)}</strong><br/>${esc(plural(r.count, "shard"))} of this database`
            : r.kind === "replicas" ? `<strong>${esc(r.city)}</strong><br/>${esc(plural(r.count, "read replica"))}, serving ${esc(num(r.reads))} reads/s`
            : `<strong>${esc(r.city)}</strong><br/>${esc(num(r.ops))} commands/s from ${esc(plural(r.conns, "connection"))}`)}
          height={360} isDarkMode={dark}
        />
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
          <Legend color={ChartPalette.categorical(0, dark)} label="Traffic entering Cloudflare" />
          <Legend color={SHARD_COLOR} label="Shards" />
          {(s.map?.replicas ?? []).length > 0 && <Legend color={REPLICA_COLOR} label="Read replicas" />}
        </div>
        <Text variant="secondary" size="sm">
          {entries.length && (s.map?.replicas ?? []).length ? `Traffic from ${cities(entries.sort((a, b) => b.ops - a.ops).map((e) => e.city))}. Reads are served by the nearest replica; writes go to the shards in ${cities(homes.map((h) => h.city))}.`
            : entries.length ? `Traffic from ${cities(entries.sort((a, b) => b.ops - a.ops).map((e) => e.city))} reaches shards in ${cities(homes.map((h) => h.city))}.`
            : homes.length ? `Shards in ${cities(homes.map((h) => h.city))}. No traffic right now.` : "Waiting for the first numbers."}
        </Text>
      </LayerCard.Primary>
    </LayerCard>
  );
}
const Legend = ({ color, label }) => (
  <span className="flex items-center gap-2 text-sm text-kumo-subtle"><span className="size-2.5 rounded-full" style={{ background: color }} />{label}</span>
);

function Throughput({ s, dark }) {
  const data = [
    { name: "Reads", data: s.history.map((h) => [h.t, h.reads]), color: ChartPalette.categorical(0, dark) },
    { name: "Writes", data: s.history.map((h) => [h.t, h.writes]), color: SHARD_COLOR },
  ];
  return (
    <LayerCard>
      <LayerCard.Secondary>Commands per second</LayerCard.Secondary>
      <LayerCard.Primary><TimeseriesChart echarts={echarts} data={data} height={220} isDarkMode={dark} yAxisTickFormat={num} tooltipValueFormat={(v) => `${num(v)}/s`} /></LayerCard.Primary>
    </LayerCard>
  );
}

function ResponseTime({ s, dark }) {
  const series = (key) => s.history.filter((h) => h[key] !== null).map((h) => [h.t, h[key]]);
  const data = [
    { name: "Reads", data: series("readMs"), color: ChartPalette.categorical(0, dark) },
    { name: "Writes", data: series("writeMs"), color: SHARD_COLOR },
  ];
  return (
    <LayerCard>
      <LayerCard.Secondary>Response time from this computer</LayerCard.Secondary>
      <LayerCard.Primary><TimeseriesChart echarts={echarts} data={data} height={220} isDarkMode={dark} yAxisTickFormat={(v) => `${v} ms`} tooltipValueFormat={(v) => `${Math.round(v)} ms`} /></LayerCard.Primary>
    </LayerCard>
  );
}

function Shards({ s, selected, onSelect }) {
  const rows = useRef({});
  useEffect(() => { if (selected !== null) rows.current[selected]?.scrollIntoView({ block: "nearest", behavior: "smooth" }); }, [selected]);
  return (
    <LayerCard>
      <LayerCard.Secondary>Shard details</LayerCard.Secondary>
      <LayerCard.Primary className="max-h-[640px] overflow-auto p-0">
        <Table>
          <Table.Header>
            <Table.Row>
              <Table.Head>Shard</Table.Head>
              <Table.Head>Location</Table.Head>
              <Table.Head>Status</Table.Head>
              <Table.Head className="text-right">Commands/s</Table.Head>
              <Table.Head className="text-right">Keys</Table.Head>
              <Table.Head className="w-48">Memory</Table.Head>
              <Table.Head className="text-right whitespace-nowrap">Up for</Table.Head>
              {s.shards.some((x) => x.replicas?.length) && <Table.Head>Replicas</Table.Head>}
              <Table.Head><span className="sr-only">Restart</span></Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {s.shards.map((x) => {
              const fresh = x.ok && s.now - x.restartedAt < 10_000;
              return (
                <Table.Row key={x.i} variant={selected === x.i ? "selected" : "default"} ref={(el) => { rows.current[x.i] = el; }} onClick={() => onSelect(selected === x.i ? null : x.i)} className="cursor-pointer">
                  <Table.Cell><Text bold>{x.i}</Text></Table.Cell>
                  <Table.Cell>{x.city ?? "–"}</Table.Cell>
                  <Table.Cell>{!x.ok ? <Badge variant="error" appearance="dot">Not responding</Badge> : fresh ? <Badge variant="warning" appearance="dot">Just restarted</Badge> : <Badge variant="success" appearance="dot">Healthy</Badge>}</Table.Cell>
                  <Table.Cell className="text-right tabular-nums">{x.ok ? num(x.ops) : "–"}</Table.Cell>
                  <Table.Cell className="text-right tabular-nums">{x.ok ? x.keys.toLocaleString() : "–"}</Table.Cell>
                  <Table.Cell>{x.ok && <Meter label={`${bytes(x.mem)} of ${bytes(x.maxmem)}`} value={(x.mem / x.maxmem) * 100} showValue={false} />}</Table.Cell>
                  <Table.Cell className="text-right tabular-nums whitespace-nowrap">{x.ok ? duration(x.uptime) : "–"}</Table.Cell>
                  {s.shards.some((y) => y.replicas?.length) && <Table.Cell><ReplicaSummary replicas={x.replicas ?? []} /></Table.Cell>}
                  <Table.Cell className="text-right">
                    <Tooltip content="Restart this shard, as a deploy or crash would. Saved data stays.">
                      <Button variant="ghost" size="sm" shape="square" icon={ArrowClockwiseIcon} aria-label={`Restart shard ${x.i}`} onClick={(e) => { e.stopPropagation(); post("/api/restart", { shard: x.i }); }} />
                    </Tooltip>
                  </Table.Cell>
                </Table.Row>
              );
            })}
          </Table.Body>
        </Table>
      </LayerCard.Primary>
    </LayerCard>
  );
}

function ReplicaSummary({ replicas }) {
  if (!replicas.length) return <Text variant="secondary" size="sm">–</Text>;
  const ready = replicas.filter((r) => r.state === "ready"), worst = Math.max(0, ...ready.map((r) => r.lagMs ?? 0));
  const lag = worst < 1000 ? `${Math.round(worst)} ms` : `${(worst / 1000).toFixed(1)} s`;
  return (
    <div className="flex flex-col whitespace-nowrap">
      <Text size="sm">{ready.length === replicas.length ? `All ${replicas.length} ready` : `${ready.length} of ${replicas.length} ready`}</Text>
      {ready.length > 0 && <Text variant="secondary" size="xs">up to {lag} behind</Text>}
    </div>
  );
}

function TestTraffic({ test, now, regions }) {
  const [level, setLevel] = useState("medium"), [from, setFrom] = useState("everywhere");
  return (
    <LayerCard>
      <LayerCard.Secondary>Test traffic</LayerCard.Secondary>
      <LayerCard.Primary className="flex flex-col gap-3">
        <Text variant="secondary" size="sm">Writes keys from Cloudflare locations, then reads them back three times, so you can watch the database under load.</Text>
        <div className="grid grid-cols-2 gap-2">
          <Select label="From" value={from} onValueChange={setFrom} disabled={!!test} items={{ everywhere: "Everywhere", ...regions }} />
          <Select label="Amount" value={level} onValueChange={setLevel} disabled={!!test} items={{ light: "Light", medium: "Medium", heavy: "Heavy" }} />
        </div>
        {test
          ? <Button variant="secondary" icon={StopIcon} onClick={() => post("/api/test", { level: null })}>Stop test traffic</Button>
          : <Button variant="primary" icon={PlayIcon} onClick={() => post("/api/test", { level, from })}>Start test traffic</Button>}
        {test && <Text variant="secondary" size="sm">Running for {duration((now - test.since) / 1000)}.</Text>}
      </LayerCard.Primary>
    </LayerCard>
  );
}

function RunCommand() {
  const [line, setLine] = useState(""), [out, setOut] = useState(null), [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    if (!line.trim()) return;
    setBusy(true);
    setOut(await post("/api/run", { line }).catch((err) => ({ error: err.message })));
    setBusy(false);
  };
  return (
    <LayerCard>
      <LayerCard.Secondary>Run a command</LayerCard.Secondary>
      <LayerCard.Primary className="flex flex-col gap-3">
        <form onSubmit={submit} className="flex gap-2">
          <div className="min-w-0 flex-1"><Input aria-label="Command" className="w-full font-mono" placeholder="SET greeting hello" value={line} onChange={(e) => setLine(e.target.value)} autoComplete="off" spellCheck={false} /></div>
          <Button type="submit" variant="primary" loading={busy}>Run</Button>
        </form>
        {out && (
          <div className="flex flex-col gap-1">
            <pre className="max-h-48 overflow-auto rounded-md bg-kumo-recessed p-3 font-mono text-sm break-all whitespace-pre-wrap">{out.error ? `Error: ${out.error}` : show(out.reply)}</pre>
            {!out.error && out.shard !== null && <Text variant="secondary" size="sm">Handled by shard {out.shard}.</Text>}
          </div>
        )}
      </LayerCard.Primary>
    </LayerCard>
  );
}
const show = (v, d = 0) => (v === null ? "(nil)" : Array.isArray(v) ? (v.length ? v.map((x, i) => `${"  ".repeat(d)}${i + 1}) ${show(x, d + 1)}`).join("\n") : "(empty list)") : typeof v === "number" ? `(integer) ${v}` : String(v).slice(0, 4000));

function Activity({ events }) {
  return (
    <LayerCard>
      <LayerCard.Secondary>Activity</LayerCard.Secondary>
      <LayerCard.Primary>
        {events.length ? (
          <ul className="flex max-h-72 flex-col gap-2 overflow-auto">
            {events.map((e) => (
              <li key={`${e.t}${e.text}`} className="flex gap-3"><Text variant="mono-secondary">{clock(e.t)}</Text><Text size="sm">{e.text}</Text></li>
            ))}
          </ul>
        ) : <Empty icon={<ClockCounterClockwiseIcon size={28} />} title="Nothing yet" description="Restarts and test traffic show up here." />}
      </LayerCard.Primary>
    </LayerCard>
  );
}
