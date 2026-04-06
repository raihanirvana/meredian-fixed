import { discoverPools, getPoolDetail, getTopCandidates } from "./screening.js";
import {
  getActiveBin,
  deployPosition,
  addLiquidity,
  getMyPositions,
  getWalletPositions,
  getPositionPnl,
  claimFees,
  closePosition,
  partialClosePosition,
  searchPools,
} from "./dlmm.js";
import { getWalletBalances, swapToken } from "./wallet.js";
import { studyTopLPers } from "./study.js";
import { addLesson, clearAllLessons, clearPerformance, removeLessonsByKeyword, getPerformanceHistory, pinLesson, unpinLesson, listLessons } from "../lessons.js";
import { setPositionInstruction, isDailyLossLimitReached, isCircuitBreakerActive, recordDailyPnl, recordDailyFees, recordDailyOpen, getDailyPnl } from "../state.js";

import { getPoolMemory, addPoolNote } from "../pool-memory.js";
import { addStrategy, listStrategies, getStrategy, setActiveStrategy, removeStrategy } from "../strategy-library.js";
import { addToBlacklist, removeFromBlacklist, listBlacklist } from "../token-blacklist.js";
import { blockDev, unblockDev, listBlockedDevs } from "../dev-blocklist.js";
import { addSmartWallet, removeSmartWallet, listSmartWallets, checkSmartWalletsOnPool } from "../smart-wallets.js";
import { getTokenInfo, getTokenHolders, getTokenNarrative } from "./token.js";
import { config, reloadScreeningThresholds } from "../config.js";
import fs from "fs";
import { exec, spawn } from "child_process";
import { promisify } from "util";
import { USER_CONFIG_PATH } from "../paths.js";
import { log, logAction } from "../logger.js";
import { notifyDeploy, notifyClose, notifySwap } from "../telegram.js";

const execAsync = promisify(exec);

// Registered by index.js so update_config can restart cron jobs when intervals change
let _cronRestarter = null;
export function registerCronRestarter(fn) { _cronRestarter = fn; }

// Map tool names to implementations
const toolMap = {
  discover_pools: discoverPools,
  get_top_candidates: getTopCandidates,
  get_pool_detail: getPoolDetail,
  get_position_pnl: getPositionPnl,
  get_active_bin: getActiveBin,
  deploy_position: deployPosition,
  get_my_positions: getMyPositions,
  get_wallet_positions: getWalletPositions,
  search_pools: searchPools,
  get_token_info: getTokenInfo,
  get_token_holders: getTokenHolders,
  get_token_narrative: getTokenNarrative,
  add_smart_wallet: addSmartWallet,
  remove_smart_wallet: removeSmartWallet,
  list_smart_wallets: listSmartWallets,
  check_smart_wallets_on_pool: checkSmartWalletsOnPool,
  claim_fees: claimFees,
  close_position: closePosition,
  partial_close_position: partialClosePosition,
  get_wallet_balance: getWalletBalances,
  swap_token: swapToken,
  get_top_lpers: studyTopLPers,
  study_top_lpers: studyTopLPers,
  set_position_note: ({ position_address, instruction }) => {
    const ok = setPositionInstruction(position_address, instruction || null);
    if (!ok) return { error: `Position ${position_address} not found in state` };
    return { saved: true, position: position_address, instruction: instruction || null };
  },
  self_update: async () => {
    try {
      const { stdout, stderr } = await execAsync("git pull", { cwd: process.cwd() });
      const result = `${stdout || ""}${stderr || ""}`.trim();
      if (result.includes("Already up to date")) {
        return { success: true, updated: false, message: "Already up to date — no restart needed." };
      }
      // Delay restart so this tool response (and Telegram message) gets sent first
      setTimeout(() => {
        const child = spawn(process.execPath, process.argv.slice(1), {
          detached: true,
          stdio: "inherit",
          cwd: process.cwd(),
        });
        child.unref();
        process.exit(0);
      }, 3000);
      return { success: true, updated: true, message: `Updated! Restarting in 3s...\n${result}` };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },
  get_performance_history: getPerformanceHistory,
  add_strategy:        addStrategy,
  list_strategies:     listStrategies,
  get_strategy:        getStrategy,
  set_active_strategy: setActiveStrategy,
  remove_strategy:     removeStrategy,
  get_pool_memory: getPoolMemory,
  add_pool_note: addPoolNote,
  add_to_blacklist: addToBlacklist,
  remove_from_blacklist: removeFromBlacklist,
  list_blacklist: listBlacklist,
  block_deployer: blockDev,
  unblock_deployer: unblockDev,
  list_blocked_deployers: listBlockedDevs,
  add_lesson: ({ rule, tags, pinned, role }) => {
    addLesson(rule, tags || [], { pinned: !!pinned, role: role || null });
    return { saved: true, rule, pinned: !!pinned, role: role || "all" };
  },
  pin_lesson:   ({ id }) => pinLesson(id),
  unpin_lesson: ({ id }) => unpinLesson(id),
  list_lessons: ({ role, pinned, tag, limit } = {}) => listLessons({ role, pinned, tag, limit }),
  clear_lessons: ({ mode, keyword }) => {
    if (mode === "all") {
      const n = clearAllLessons();
      log("lessons", `Cleared all ${n} lessons`);
      return { cleared: n, mode: "all" };
    }
    if (mode === "performance") {
      const n = clearPerformance();
      log("lessons", `Cleared ${n} performance records`);
      return { cleared: n, mode: "performance" };
    }
    if (mode === "keyword") {
      if (!keyword) return { error: "keyword required for mode=keyword" };
      const n = removeLessonsByKeyword(keyword);
      log("lessons", `Cleared ${n} lessons matching "${keyword}"`);
      return { cleared: n, mode: "keyword", keyword };
    }
    return { error: "invalid mode" };
  },
  update_config: ({ changes, reason = "" }) => {
    // Flat key → config section mapping (covers everything in config.js)
    const CONFIG_MAP = {
      // screening
      minFeeActiveTvlRatio: ["screening", "minFeeActiveTvlRatio"],
      minTvl: ["screening", "minTvl"],
      maxTvl: ["screening", "maxTvl"],
      minVolume: ["screening", "minVolume"],
      minOrganic: ["screening", "minOrganic"],
      minHolders: ["screening", "minHolders"],
      minMcap: ["screening", "minMcap"],
      maxMcap: ["screening", "maxMcap"],
      minBinStep: ["screening", "minBinStep"],
      maxBinStep: ["screening", "maxBinStep"],
      timeframe: ["screening", "timeframe"],
      category: ["screening", "category"],
      minTokenFeesSol: ["screening", "minTokenFeesSol"],
      maxBundlePct:     ["screening", "maxBundlePct"],
      maxBotHoldersPct: ["screening", "maxBotHoldersPct"],
      maxTop10Pct: ["screening", "maxTop10Pct"],
      minTokenAgeHours: ["screening", "minTokenAgeHours"],
      maxTokenAgeHours: ["screening", "maxTokenAgeHours"],
      athFilterPct:     ["screening", "athFilterPct"],
      minVolumeTrendPct: ["screening", "minVolumeTrendPct"],
      minFeePerTvl24h: ["management", "minFeePerTvl24h"],
      // management
      minClaimAmount: ["management", "minClaimAmount"],
      autoSwapAfterClaim: ["management", "autoSwapAfterClaim"],
      outOfRangeBinsToClose: ["management", "outOfRangeBinsToClose"],
      outOfRangeWaitMinutes: ["management", "outOfRangeWaitMinutes"],
      minAgeBeforeYieldCheck: ["management", "minAgeBeforeYieldCheck"],
      stopLossPct: ["management", "stopLossPct"],
      takeProfitFeePct: ["management", "takeProfitFeePct"],
      trailingTakeProfit: ["management", "trailingTakeProfit"],
      trailingTriggerPct: ["management", "trailingTriggerPct"],
      trailingDropPct: ["management", "trailingDropPct"],
      solMode: ["management", "solMode"],
      maxHoldMinutes: ["management", "maxHoldMinutes"],
      maxDailyLossSol: ["management", "maxDailyLossSol"],
      dailyProfitTargetSol: ["management", "dailyProfitTargetSol"],
      maxRebalancesPerPosition: ["management", "maxRebalancesPerPosition"],
      autoCompoundFees: ["management", "autoCompoundFees"],
      minSolToOpen: ["management", "minSolToOpen"],
      deployAmountSol: ["management", "deployAmountSol"],
      gasReserve: ["management", "gasReserve"],
      positionSizePct: ["management", "positionSizePct"],
      // risk
      maxPositions: ["risk", "maxPositions"],
      maxDeployAmount: ["risk", "maxDeployAmount"],
      // schedule
      managementIntervalMin: ["schedule", "managementIntervalMin"],
      screeningIntervalMin: ["schedule", "screeningIntervalMin"],
      healthCheckIntervalMin: ["schedule", "healthCheckIntervalMin"],
      // models
      managementModel: ["llm", "managementModel"],
      screeningModel: ["llm", "screeningModel"],
      generalModel: ["llm", "generalModel"],
      // strategy
      binsBelow: ["strategy", "binsBelow"],
    };

    const applied = {};
    const unknown = [];

    // Build case-insensitive lookup
    const CONFIG_MAP_LOWER = Object.fromEntries(
      Object.entries(CONFIG_MAP).map(([k, v]) => [k.toLowerCase(), [k, v]])
    );

    for (const [key, val] of Object.entries(changes)) {
      const match = CONFIG_MAP[key] ? [key, CONFIG_MAP[key]] : CONFIG_MAP_LOWER[key.toLowerCase()];
      if (!match) { unknown.push(key); continue; }
      applied[match[0]] = val;
    }

    if (Object.keys(applied).length === 0) {
      log("config", `update_config failed — unknown keys: ${JSON.stringify(unknown)}, raw changes: ${JSON.stringify(changes)}`);
      return { success: false, unknown, reason };
    }

    // Apply to live config immediately
    for (const [key, val] of Object.entries(applied)) {
      const [section, field] = CONFIG_MAP[key];
      const before = config[section][field];
      config[section][field] = val;
      log("config", `update_config: config.${section}.${field} ${before} → ${val} (verify: ${config[section][field]})`);
    }

    // Persist to user-config.json
    let userConfig = {};
    if (fs.existsSync(USER_CONFIG_PATH)) {
      try { userConfig = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8").replace(/^\uFEFF/, "")); } catch { /**/ }
    }
    Object.assign(userConfig, applied);
    userConfig._lastAgentTune = new Date().toISOString();
    fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(userConfig, null, 2));

    // Restart cron jobs if intervals changed
    const intervalChanged =
      applied.managementIntervalMin != null ||
      applied.screeningIntervalMin != null ||
      applied.healthCheckIntervalMin != null;
    if (intervalChanged && _cronRestarter) {
      _cronRestarter();
      log("config", `Cron restarted — management: ${config.schedule.managementIntervalMin}m, screening: ${config.schedule.screeningIntervalMin}m`);
    }

    // Save as a lesson — but skip ephemeral per-deploy interval changes
    // (managementIntervalMin / screeningIntervalMin change every deploy based on volatility;
    //  the rule is already in the system prompt, storing it 75+ times is pure noise)
    const lessonsKeys = Object.keys(applied).filter(
      k => k !== "managementIntervalMin" && k !== "screeningIntervalMin"
    );
    if (lessonsKeys.length > 0) {
      const summary = lessonsKeys.map(k => `${k}=${applied[k]}`).join(", ");
      addLesson(`[SELF-TUNED] Changed ${summary} — ${reason}`, ["self_tune", "config_change"]);
    }

    log("config", `Agent self-tuned: ${JSON.stringify(applied)} — ${reason}`);
    return { success: true, applied, unknown, reason };
  },
};

// Tools that modify on-chain state (need extra safety checks)
const WRITE_TOOLS = new Set([
  "deploy_position",
  "claim_fees",
  "close_position",
  "partial_close_position",
  "swap_token",
]);

/**
 * Execute a tool call with safety checks and logging.
 */
export async function executeTool(name, args) {
  const startTime = Date.now();

  // Strip model artifacts like "<|channel|>commentary" appended to tool names
  name = name.replace(/<.*$/, "").trim();

  // ─── Validate tool exists ─────────────────
  const fn = toolMap[name];
  if (!fn) {
    const error = `Unknown tool: ${name}`;
    log("error", error);
    return { error };
  }

  // ─── Pre-execution safety checks ──────────
  if (WRITE_TOOLS.has(name)) {
    const safetyCheck = await runSafetyChecks(name, args);
    if (!safetyCheck.pass) {
      log("safety_block", `${name} blocked: ${safetyCheck.reason}`);
      return {
        blocked: true,
        reason: safetyCheck.reason,
      };
    }
  }

  // ─── Execute ──────────────────────────────
  try {
    let preExecutionBalances = null;
    if (name === "close_position" || (name === "claim_fees" && (config.management.autoSwapAfterClaim || config.management.autoCompoundFees))) {
      try {
        preExecutionBalances = await getWalletBalances({});
      } catch {
        preExecutionBalances = null;
      }
    }

    const result = await fn(args);
    const duration = Date.now() - startTime;
    const success = result?.success !== false && !result?.error;

    logAction({
      tool: name,
      args,
      result: summarizeResult(result),
      duration_ms: duration,
      success,
    });

    if (success) {
      if (name === "swap_token" && result.tx) {
        notifySwap({ inputSymbol: args.input_mint?.slice(0, 8), outputSymbol: args.output_mint === "So11111111111111111111111111111111111111112" || args.output_mint === "SOL" ? "SOL" : args.output_mint?.slice(0, 8), amountIn: result.amount_in, amountOut: result.amount_out, tx: result.tx }).catch(() => {});
      } else if (name === "deploy_position") {
        recordDailyOpen();
        // If this is a rebalance, link old → new position for rebalance count tracking
        if (args.rebalance_from && result.position) {
          const { recordRebalance } = await import("../state.js");
          recordRebalance(args.rebalance_from, result.position);
        }
        notifyDeploy({ pair: result.pool_name || args.pool_name || args.pool_address?.slice(0, 8), amountSol: args.amount_y ?? args.amount_sol ?? 0, position: result.position, tx: result.txs?.[0] ?? result.tx, priceRange: result.price_range, binStep: result.bin_step, baseFee: result.base_fee }).catch(() => {});
      } else if (name === "close_position") {
        // Record daily P&L in SOL — prefer absolute SOL PnL when available.
        const pnlPctForRecord = result.pnl_sol_pct ?? result.pnl_pct;
        if (result.pnl_sol != null) {
          recordDailyPnl(result.pnl_sol);
        } else if (pnlPctForRecord != null) {
          const tracked = (await import("../state.js")).getTrackedPosition(args.position_address);
          const amountSol = tracked?.amount_sol || 0;
          recordDailyPnl(amountSol * (pnlPctForRecord / 100));
        }
        const pnlValue = config.management.solMode
          ? (result.pnl_sol ?? result.pnl_usd ?? 0)
          : (result.pnl_usd ?? 0);
        notifyClose({
          pair: result.pool_name || args.position_address?.slice(0, 8),
          pnlValue,
          pnlPct: config.management.solMode ? (result.pnl_sol_pct ?? result.pnl_pct ?? 0) : (result.pnl_pct ?? 0),
          currencySymbol: config.management.solMode ? "◎" : "$",
        }).catch(() => {});
        // Note low-yield closes in pool memory so screener avoids redeploying
        if (args.reason && args.reason.toLowerCase().includes("yield")) {
          const poolAddr = result.pool || args.pool_address;
          if (poolAddr) addPoolNote({ pool_address: poolAddr, note: `Closed: low yield (fee/TVL below threshold) at ${new Date().toISOString().slice(0,10)}` }).catch?.(() => {});
        }
        // Auto-swap base token back to SOL unless user said to hold
        if (!args.skip_swap && result.base_mint) {
          try {
            const balances = await getWalletBalances({});
            const token = balances.tokens?.find(t => t.mint === result.base_mint);
            const preToken = preExecutionBalances?.tokens?.find(t => t.mint === result.base_mint);
            const deltaBalance = Math.max(0, (token?.balance || 0) - (preToken?.balance || 0));
            const deltaUsd = Math.max(0, (token?.usd || 0) - (preToken?.usd || 0));
            if (token && deltaBalance > 0 && deltaUsd >= 0.10) {
              log("executor", `Auto-swapping received ${token.symbol || result.base_mint.slice(0, 8)} ($${deltaUsd.toFixed(2)}) back to SOL`);
              const swapResult = await swapToken({ input_mint: result.base_mint, output_mint: "SOL", amount: deltaBalance });
              // Tell the model the swap already happened so it doesn't call swap_token again
              result.auto_swapped = true;
              result.auto_swap_note = `Base token already auto-swapped back to SOL (${token.symbol || result.base_mint.slice(0, 8)} → SOL). Do NOT call swap_token again.`;
              if (swapResult?.amount_out) result.sol_received = swapResult.amount_out;
            } else if (token && token.usd >= 0.10) {
              log("executor", `Skipping auto-swap for ${token.symbol || result.base_mint.slice(0, 8)} - no fresh token delta detected`);
            }
          } catch (e) {
            log("executor_warn", `Auto-swap after close failed: ${e.message}`);
          }
        }
      } else if (name === "claim_fees") {
        if ((result.claimed_fees_sol ?? 0) > 0 || (result.claimed_fees_usd ?? 0) > 0) {
          const solPrice = preExecutionBalances?.sol_price || 135;
          recordDailyFees(result.claimed_fees_sol ?? ((result.claimed_fees_usd || 0) / solPrice));
        }
      }
      const shouldSwapClaimFees = config.management.autoSwapAfterClaim || config.management.autoCompoundFees;
      if (name === "claim_fees" && shouldSwapClaimFees && result.base_mint) {
        try {
          const balances = await getWalletBalances({});
          const token = balances.tokens?.find(t => t.mint === result.base_mint);
          const preToken = preExecutionBalances?.tokens?.find(t => t.mint === result.base_mint);
          const deltaBalance = Math.max(0, (token?.balance || 0) - (preToken?.balance || 0));
          const deltaUsd = Math.max(0, (token?.usd || 0) - (preToken?.usd || 0));
          if (token && deltaBalance > 0 && deltaUsd >= 0.10) {
            log("executor", `Auto-swapping claimed ${token.symbol || result.base_mint.slice(0, 8)} ($${deltaUsd.toFixed(2)}) back to SOL`);
            const swapResult = await swapToken({ input_mint: result.base_mint, output_mint: "SOL", amount: deltaBalance });
            if (swapResult?.amount_out) result.sol_received = swapResult.amount_out;
          } else if (token && token.usd >= 0.10) {
            log("executor", `Skipping auto-swap after claim for ${token.symbol || result.base_mint.slice(0, 8)} - no fresh token delta detected`);
          }
        } catch (e) {
          log("executor_warn", `Auto-swap after claim failed: ${e.message}`);
        }
      }
      if (name === "claim_fees" && config.management.autoCompoundFees && result.pool) {
        try {
          const tracked = (await import("../state.js")).getTrackedPosition(args.position_address);
          const postClaimBalances = await getWalletBalances({});
          const netSolDelta = Math.max(0, (postClaimBalances.sol || 0) - (preExecutionBalances?.sol || 0));
          const compoundAmountSol = Math.round(netSolDelta * 1e6) / 1e6;
          if (!tracked) {
            result.compound_note = "Auto-compound skipped: tracked position metadata missing.";
          } else if (compoundAmountSol < 0.01) {
            result.compound_note = `Auto-compound skipped: fresh SOL delta too small (${compoundAmountSol} SOL).`;
          } else {
            log("executor", `Auto-compounding ${compoundAmountSol} SOL back into ${args.position_address.slice(0, 8)}`);
            const compoundResult = await addLiquidity({
              position_address: args.position_address,
              pool_address: tracked.pool || result.pool,
              amount_x: 0,
              amount_y: compoundAmountSol,
              strategy: tracked.strategy,
              bins_below: tracked.bin_range?.bins_below,
              bins_above: tracked.bin_range?.bins_above,
            });
            if (compoundResult?.success) {
              result.compounded = true;
              result.compound_amount_sol = compoundAmountSol;
              result.compound_txs = compoundResult.txs;
            } else {
              result.compound_note = compoundResult?.error || "Auto-compound failed";
            }
          }
        } catch (e) {
          log("executor_warn", `Auto-compound after claim failed: ${e.message}`);
          result.compound_note = `Auto-compound failed: ${e.message}`;
        }
      }
    }

    return result;
  } catch (error) {
    const duration = Date.now() - startTime;

    logAction({
      tool: name,
      args,
      error: error.message,
      duration_ms: duration,
      success: false,
    });

    // Return error to LLM so it can decide what to do
    return {
      error: error.message,
      tool: name,
    };
  }
}

/**
 * Run safety checks before executing write operations.
 */
async function runSafetyChecks(name, args) {
  switch (name) {
    case "deploy_position": {
      // Circuit breaker — block all deploys when active
      if (isCircuitBreakerActive()) {
        return { pass: false, reason: "Circuit breaker is active — all deploys paused. Use /resume to re-enable." };
      }

      // Daily loss limit — block new deploys when daily loss exceeds threshold
      const lossCheck = isDailyLossLimitReached(config.management.maxDailyLossSol);
      if (lossCheck.exceeded) {
        return { pass: false, reason: `Daily loss limit reached: lost ${lossCheck.currentLoss} SOL today (limit: ${lossCheck.limit} SOL). No new deploys until tomorrow UTC.` };
      }

      // Reject pools with bin_step out of configured range
      const minStep = config.screening.minBinStep;
      const maxStep = config.screening.maxBinStep;
      if (args.bin_step != null && (args.bin_step < minStep || args.bin_step > maxStep)) {
        return {
          pass: false,
          reason: `bin_step ${args.bin_step} is outside the allowed range of [${minStep}-${maxStep}].`,
        };
      }

      // Check position count limit + duplicate pool guard — force fresh scan to avoid stale cache
      const positions = await getMyPositions({ force: true });
      const effectiveOpenPositions = positions.total_positions - (args.rebalance_from ? 1 : 0);
      if (effectiveOpenPositions >= config.risk.maxPositions) {
        return {
          pass: false,
          reason: `Max positions (${config.risk.maxPositions}) reached. Close a position first.`,
        };
      }
      const alreadyInPool = positions.positions.some(
        (p) => p.pool === args.pool_address
      );
      if (alreadyInPool && !args.rebalance_from) {
        return {
          pass: false,
          reason: `Already have an open position in pool ${args.pool_address}. Cannot open duplicate.`,
        };
      }

      // Block same base token across different pools
      if (args.base_mint && !args.rebalance_from) {
        const alreadyHasMint = positions.positions.some(
          (p) => p.base_mint === args.base_mint
        );
        if (alreadyHasMint) {
          return {
            pass: false,
            reason: `Already holding base token ${args.base_mint} in another pool. One position per token only.`,
          };
        }
      }

      // Check amount limits
      const amountY = args.amount_y ?? args.amount_sol ?? 0;
      if (amountY <= 0) {
        return {
          pass: false,
          reason: `Must provide a positive SOL amount (amount_y).`,
        };
      }

      const minDeploy = Math.max(0.1, config.management.deployAmountSol);
      if (amountY < minDeploy) {
        return {
          pass: false,
          reason: `Amount ${amountY} SOL is below the minimum deploy amount (${minDeploy} SOL). Use at least ${minDeploy} SOL.`,
        };
      }
      if (amountY > config.risk.maxDeployAmount) {
        return {
          pass: false,
          reason: `SOL amount ${amountY} exceeds maximum allowed per position (${config.risk.maxDeployAmount}).`,
        };
      }

      // Check SOL balance
      const balance = await getWalletBalances();
      const gasReserve = config.management.gasReserve;
      const minRequired = amountY + gasReserve;
      if (balance.sol < minRequired) {
        return {
          pass: false,
          reason: `Insufficient SOL: have ${balance.sol} SOL, need ${minRequired} SOL (${amountY} deploy + ${gasReserve} gas reserve).`,
        };
      }

      return { pass: true };
    }

    case "swap_token": {
      // Basic check — prevent swapping when DRY_RUN is true
      // (handled inside swapToken itself, but belt-and-suspenders)
      return { pass: true };
    }

    default:
      return { pass: true };
  }
}

/**
 * Summarize a result for logging (truncate large responses).
 */
function summarizeResult(result) {
  const str = JSON.stringify(result);
  if (str.length > 1000) {
    return str.slice(0, 1000) + "...(truncated)";
  }
  return result;
}
