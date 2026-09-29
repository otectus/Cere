import { readFile } from "node:fs/promises";
import { request } from "./client.ts";
const args = process.argv.slice(2),
  command = (args.shift() || "health").replaceAll("-", "_");
const flags: Record<string, string | boolean> = {};
for (let i = 0; i < args.length; i++) {
  const key = args[i];
  if (!key.startsWith("--")) throw new Error("Use named arguments");
  flags[key.slice(2).replaceAll("-", "_")] =
    args[i + 1] && !args[i + 1].startsWith("--") ? args[++i] : true;
}
async function stdin() {
  let text = "";
  for await (const chunk of process.stdin) {
    text += chunk;
    if (Buffer.byteLength(text) > 1024 * 1024)
      throw new Error("Memory input exceeds 1 MiB");
  }
  return text;
}
try {
  let params: Record<string, unknown> = {};
  if (flags.file || flags.stdin) {
    const text = flags.file
      ? await readFile(String(flags.file), "utf8")
      : await stdin();
    params = JSON.parse(text);
  }
  for (const name of [
    "id",
    "job_id",
    "backend",
    "text",
    "output",
    "input",
    "staging",
  ])
    if (typeof flags[name] === "string") params[name] = flags[name];
  if (flags.job) params.job_id = flags.job;
  if (flags.expected_revision)
    params.expected_revision = Number(flags.expected_revision);
  if (flags.known_revision)
    params.known_revision = Number(flags.known_revision);
  if (flags.world_at)
    params.world_at_us = Date.parse(String(flags.world_at)) * 1000;
  if (flags.dry_run) params.dry_run = true;
  const method =
    command === "query"
      ? "retrieve"
      : command === "forget_preview"
        ? "forget_preview"
        : command;
  if (command === "daemon")
    throw new Error(
      "Graph memory runs in the Cere broker. Start cere-broker.service or node broker/main.ts.",
    );
  if (flags.help) {
    console.log(
      "cere memory health|doctor|query|inspect|remember|correct|resolve-conflict|forget-preview|forget|erasure-status|workspace|policy-get|policy-update|rebuild|backup|restore\nUse --session SESSION_ID to select a project, --file CLAIM.json or --stdin for structured requests, --json for machine output.",
    );
  } else {
    const result = await request("memory.graph", {
      sessionId: flags.session,
      method,
      params,
    });
    console.log(JSON.stringify(result, null, 2));
  }
} catch (error: any) {
  console.error(error.message);
  process.exitCode = 1;
}
