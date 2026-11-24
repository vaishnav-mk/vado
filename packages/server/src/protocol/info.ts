export function infoFields(text: string) {
  const fields: Record<string, string> = {};

  for (const row of text.split("\r\n")) {
    const colon = row.indexOf(":");

    if (colon > 0) fields[row.slice(0, colon)] = row.slice(colon + 1);
  }

  return fields;
}

// One number from a value like "keys=3,expires=0" or "calls=12,usec=40".
export function subField(value: string | undefined, name: string): number {
  const pair = value?.split(",").find((p) => p.startsWith(`${name}=`));

  return Number(pair?.slice(name.length + 1) ?? 0);
}
