/**
 * Test the full agent loop in dry-run mode (no wallet needed for screening).
 * Run: DRY_RUN=true node test/test-agent.js
 */

import fs from "fs";
import { config as loadDotenv } from "dotenv";
import { ENV_PATH } from "../paths.js";
import { agentLoop } from "../agent.js";

if (fs.existsSync(ENV_PATH)) {
  loadDotenv({ path: ENV_PATH, override: true, quiet: true });
}

async function main() {
  console.log("=== Testing Agent Loop (DRY RUN) ===\n");
  console.log("Goal: Discover top pools and recommend 3 LP opportunities\n");

  const result = await agentLoop(
    "Run get_top_candidates. Then deploy_position into the #1 candidate using 0.1 SOL. Report what was deployed.",
    5
  );

  console.log("\n=== Agent Response ===");
  console.log(result);
  console.log("\n=== Test complete ===");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
