/**
 * Local cron trigger — hits one of the /api/cron/* endpoints with the
 * proper CRON_SECRET header.
 *
 * Run:
 *   npm run trigger-cron weekly-poll
 *   npm run trigger-cron weekly-report
 *   npm run trigger-cron monthly-deepdive
 *
 * Requires `npm run dev` to be running (or pass --url=https://prod.app).
 *
 * Useful for:
 *   - Smoke-testing the discovery + enrichment pipeline end-to-end
 *   - Generating a real weekly report on demand without waiting for Monday
 *   - Reproducing a production cron failure locally
 */

const validTargets = ["weekly-poll", "weekly-report", "monthly-deepdive"] as const;
type Target = (typeof validTargets)[number];

function parseArgs(): { target: Target; url: string } {
  const args = process.argv.slice(2);
  const targetArg = args.find((a) => !a.startsWith("--"));
  if (!targetArg) {
    console.error(`Usage: npm run trigger-cron <${validTargets.join("|")}> [--url=http://...]`);
    process.exit(1);
  }
  if (!validTargets.includes(targetArg as Target)) {
    console.error(`Unknown target "${targetArg}". Valid: ${validTargets.join(", ")}`);
    process.exit(1);
  }
  const urlArg = args.find((a) => a.startsWith("--url="));
  const url = urlArg ? urlArg.slice("--url=".length) : "http://localhost:3000";
  return { target: targetArg as Target, url: url.replace(/\/$/, "") };
}

async function main() {
  const { target, url } = parseArgs();
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error("CRON_SECRET not set in environment. Did you set it in .env.local?");
    process.exit(1);
  }
  const endpoint = `${url}/api/cron/${target}`;
  console.log(`POST ${endpoint}`);
  const startedAt = Date.now();
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/json",
    },
  });
  const ms = Date.now() - startedAt;
  const text = await res.text();
  console.log(`← ${res.status} in ${ms}ms`);
  try {
    const json = JSON.parse(text);
    console.log(JSON.stringify(json, null, 2));
  } catch {
    console.log(text);
  }
  if (!res.ok) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
