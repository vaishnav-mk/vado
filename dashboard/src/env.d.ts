// The ADMIN binding: valkey-do's Admin entrypoint (src/admin/admin.js), called over a service binding.
type AdminDatabase = import("./lib/types").Database;
type AdminTestView = import("./lib/types").TestView;
type AdminCommandResult = import("./lib/types").CommandResult;

interface AdminBinding {
  databases(): Promise<AdminDatabase[]>;
  database(name: string): Promise<AdminDatabase | null>;
  regions(): Promise<Record<string, string>>;
  create(o: { name: string; shards: number; place: string; replicas: boolean }): Promise<AdminDatabase>;
  restart(name: string, i: number): Promise<void>;
  startTest(name: string, level: string, from: string): Promise<AdminTestView>;
  stopTest(name: string): Promise<null>;
  command(name: string, argv: string[]): Promise<AdminCommandResult>;
  session(token: string): Promise<string | null>;
  authorized(session: string): Promise<boolean>;
}

declare module "cloudflare:workers" {
  export const env: { ADMIN: AdminBinding };
}
