// Where things run: Durable Object location hints, the regions a database can use, and which region each
// Cloudflare colo (IATA code) is in, so a router can find the replica in its region.

/** Durable Object location hints. A database may spread its shards over several (`regions`). */
export const HINTS = new Set(["wnam", "enam", "sam", "weur", "eeur", "apac", "apac-ne", "apac-se", "oc", "afr", "me"]);
/** One shard per region in turn, for a database spread around the world. */
export const WORLD = ["wnam", "enam", "sam", "weur", "eeur", "me", "afr", "apac", "oc"];

/** What each region is called, for people. */
export const REGION_NAMES = { wnam: "Western North America", enam: "Eastern North America", sam: "South America", weur: "Western Europe", eeur: "Eastern Europe", me: "Middle East", afr: "Africa", apac: "Asia Pacific", oc: "Oceania" };

// Generated from https://speed.cloudflare.com/locations (region and longitude); unknown colos read from the primary.
const BY_HINT = {
  wnam: "ABQ ANC DEN GDL HNL LAS LAX PDX PHX QRO SAN SEA SFO SJC SLC SMF YVR YXE YYC",
  enam: "ATL AUS BGI BGR BNA BOS CLE CLT CMH CVG DFW DTW EWR FSD GUA IAD IAH IND JAX KIN MCI MEM MEX MIA MSP OKC OMA ORD ORF PHL PIT RDU RIC SAT SDQ SJU STI STL TLH TPA YHZ YUL YWG YYZ",
  sam: "ARI ARU ASU BAQ BEL BOG BSB CAW CFC CGB CLO CNF COR CWB EZE FLN FOR GEO GIG GND GRU GYE GYN JDO JOI LIM LPB MAO MDE NQN NVT PBM PMW POA POS PTY QWJ RAO REC SAP SCL SJK SJO SJP SOD SSA TGU UDI UIO VCP VIX XAP",
  weur: "AMS BCN BOD BRU CDG CPH DUB DUS FCO FRA GOT GVA HAM KEF LHR LIS LJU LUX LYS MAD MAN MLA MRS MUC MXP OSL PMO PRG STR TXL ZRH",
  eeur: "ADB AKX ALA ARN ATH BEG BTS BUD DME HEL IST KBP LCA LED MSQ OTP RIX SKG SKP SOF TBS TIA TLL VIE VNO WAW WRO ZAG",
  me: "AMM BAH BEY BGW BSR DMM DOH DXB EBL EVN GYD HFA ISU JED KWI LLK MCT NJF RUH TLV XNH ZDM",
  afr: "AAE ABJ ACC ADD ALG ASK CAI CPT CZL DAR DKR DLA DUR EBB FIH GBE HRE JIB JNB KGL LAD LLW LOS LUN MBA MPM MRU NBO ORN OUA RUN TNR TUN WDH",
  apac: "AGR AIP AMD BBI BDQ BKK BLR BOM BWN CCU CEB CGK CGP CGY CJB CMB CNN CNX COK CRK DAC DAD DEL DPS DYU FRU FUK GUM HAN HKG HYD ICN ISB IXC JAI JHB JOG JRG KCH KHH KHI KIX KNU KTM KUL LHE LUH MAA MFM MLE MLG MNL NAG NQZ NRT OKA PAT PBH PNH PNQ SGN SIN TEZ TPE UDR ULN URT VTE",
  oc: "ADL AKL BNE CBR CHC HBA MEL NOU PER PPT SUV SYD WLG",
};
export const REGION_OF = new Map(Object.entries(BY_HINT).flatMap(([hint, colos]) => colos.split(" ").map((c) => [c, hint])));

/** The colo this code runs in, from Cloudflare's trace endpoint; null if it can't be reached (offline dev). */
export async function coloOf() {
  const text = await (await fetch("https://cloudflare.com/cdn-cgi/trace")).text();
  return /^colo=(\w+)$/m.exec(text)?.[1] ?? null;
}
