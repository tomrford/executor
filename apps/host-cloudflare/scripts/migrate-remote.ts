import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";

import { parse } from "jsonc-parser";

const APP_DIR = resolve(import.meta.dirname, "..");
const configArg = process.argv.indexOf("--config");
const sourceConfig = resolve(
  configArg === -1 ? resolve(APP_DIR, "wrangler.jsonc") : process.argv[configArg + 1]!,
);
const config = parse(await readFile(sourceConfig, "utf8")) as Record<string, unknown>;
const d1Databases = config.d1_databases as ReadonlyArray<Record<string, unknown>> | undefined;
if (!d1Databases?.length) throw new Error(`${sourceConfig} has no D1 binding`);

const port = await new Promise<number>((resolvePort, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (typeof address === "string" || address === null) {
      server.close();
      reject(new Error("Could not reserve a local migration port"));
      return;
    }
    server.close((error) => (error ? reject(error) : resolvePort(address.port)));
  });
});

const migrationToken = randomBytes(32).toString("hex");
const tempConfig = resolve(APP_DIR, `.wrangler.migrate-${process.pid}.jsonc`);
const migrationConfig = {
  name: `${String(config.name ?? "executor-cloudflare")}-migration`,
  main: "scripts/migrate-worker.ts",
  compatibility_date: config.compatibility_date,
  compatibility_flags: config.compatibility_flags,
  workers_dev: true,
  preview_urls: false,
  d1_databases: config.d1_databases,
  r2_buckets: config.r2_buckets,
};
await writeFile(tempConfig, JSON.stringify(migrationConfig, null, 2));

const child = spawn(
  "bunx",
  [
    "wrangler",
    "dev",
    "--remote",
    "--config",
    tempConfig,
    "--ip",
    "127.0.0.1",
    "--port",
    String(port),
    "--var",
    `MIGRATION_TOKEN:${migrationToken}`,
  ],
  { cwd: APP_DIR, env: process.env, stdio: ["ignore", "inherit", "inherit"] },
);

const baseUrl = `http://127.0.0.1:${port}`;
const waitForReady = async (): Promise<void> => {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Migration Worker exited with ${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {
      // Wrangler has not opened its local proxy yet.
    }
    await Bun.sleep(250);
  }
  throw new Error("Timed out waiting for the remote migration Worker");
};

try {
  await waitForReady();
  const response = await fetch(`${baseUrl}/migrate`, {
    method: "POST",
    headers: { authorization: `Bearer ${migrationToken}` },
    signal: AbortSignal.timeout(120_000),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`D1 migration failed (${response.status}): ${body}`);
  console.log(
    JSON.stringify({
      event: "executor.d1.migrated",
      config: dirname(sourceConfig),
      result: JSON.parse(body),
    }),
  );
} finally {
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolveExit) => child.once("exit", () => resolveExit())),
    Bun.sleep(5_000).then(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }),
  ]);
  await rm(tempConfig, { force: true });
}
