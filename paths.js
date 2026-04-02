import fs from "fs";
import os from "os";
import path from "path";

export const MERIDIAN_DIR = process.env.MERIDIAN_DIR || path.join(os.homedir(), ".meridian");
export const USER_CONFIG_PATH = path.join(MERIDIAN_DIR, "user-config.json");
export const ENV_PATH = path.join(MERIDIAN_DIR, ".env");
export const STATE_FILE = path.join(MERIDIAN_DIR, "state.json");
export const LESSONS_FILE = path.join(MERIDIAN_DIR, "lessons.json");
export const LOG_DIR = path.join(MERIDIAN_DIR, "logs");
export const DEV_BLOCKLIST_FILE = path.join(MERIDIAN_DIR, "dev-blocklist.json");
export const TOKEN_BLACKLIST_FILE = path.join(MERIDIAN_DIR, "token-blacklist.json");
export const POOL_MEMORY_FILE = path.join(MERIDIAN_DIR, "pool-memory.json");
export const STRATEGY_LIBRARY_FILE = path.join(MERIDIAN_DIR, "strategy-library.json");
export const SMART_WALLETS_FILE = path.join(MERIDIAN_DIR, "smart-wallets.json");
export const DISCORD_SIGNALS_FILE = path.join(MERIDIAN_DIR, "discord-signals.json");
export const SIGNAL_WEIGHTS_FILE = path.join(MERIDIAN_DIR, "signal-weights.json");

export function ensureMeridianDir() {
  if (!fs.existsSync(MERIDIAN_DIR)) {
    fs.mkdirSync(MERIDIAN_DIR, { recursive: true });
  }
}
