export function infoFields(text: string) {
  const fields: Record<string, string> = {};

  for (const row of text.split("\r\n")) {
    const colon = row.indexOf(":");

    if (colon > 0) fields[row.slice(0, colon)] = row.slice(colon + 1);
  }

  return fields;
}
