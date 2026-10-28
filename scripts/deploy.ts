import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const npxCommand = process.platform === "win32" ? "npx.cmd" : "npx";

/** Prefix consumed by deployment wrappers that want human-readable progress. */
export const deploymentProgressPrefix = "CLOUDFLARE_RUNNER_DEPLOY_PHASE:";

function run(args: string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(npxCommand, ["cf", ...args], {
      cwd: projectRoot,
      env: process.env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolvePromise();
      } else {
        reject(new Error(`cf ${args.join(" ")} exited with status ${code ?? "unknown"}`));
      }
    });
  });
}

/** Deploy the Worker and its Container directly from cloudflare.config.ts. */
export async function main(arguments_: string[] = process.argv.slice(2)): Promise<void> {
  const dryRun = arguments_.includes("--dry-run");
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  if (accountId === undefined || !/^[a-f0-9]{32}$/iu.test(accountId)) {
    throw new Error("CLOUDFLARE_ACCOUNT_ID must be a 32-character Cloudflare account ID");
  }
  console.log(`${deploymentProgressPrefix}${dryRun ? "Previewing" : "Deploying"} cloudflare.config.ts`);
  await run(["deploy", "--containers-rollout", "immediate", ...(dryRun ? ["--dry-run"] : [])]);
}

const invokedPath = process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
