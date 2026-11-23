import type { Source } from "./types";

export const REPO = "https://github.com/vaishnav-mk/vado";

export const source = (path: string): Source => ({ label: path, href: `${REPO}/blob/main/${path}` });

export const server = (path: string): Source => source(`packages/server/src/${path}`);
