import type { D1Database, R2Bucket } from "@cloudflare/workers-types";

import { migrateD1ExecutorDb } from "../src/db/d1";

interface MigrationEnv {
  readonly DB: D1Database;
  readonly BLOBS?: R2Bucket;
  readonly MIGRATION_TOKEN: string;
}

export default {
  async fetch(request: Request, env: MigrationEnv): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/health") return new Response("ok");
    if (
      pathname !== "/migrate" ||
      request.method !== "POST" ||
      request.headers.get("authorization") !== `Bearer ${env.MIGRATION_TOKEN}`
    ) {
      return new Response("Not found", { status: 404 });
    }

    const applied = await migrateD1ExecutorDb(env.DB, env.BLOBS);
    return Response.json({ applied });
  },
};
