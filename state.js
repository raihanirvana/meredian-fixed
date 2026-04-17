/**
 * Persistent agent state — stored in state.json.
 *
 * Tracks position metadata that isn't available on-chain:
 * - When a position was deployed
 * - Strategy and bin config used
 * - When it first went out of range
 * - Actions taken (claims, rebalances)
 */

import fs from "fs";
import { log } from "./logger.js";
import { STATE_FILE, ensureMeridianDir } from "./paths.js";

ensureMeridianDir();
const STATE_FILE_TMP = `${STATE_FILE}.tmp`;

const MAX_RECENT_EVENTS = 20;

function load() {
  if (!fs.existsSync(STATE_FILE)) {
    return { positions: {}, recentEvents: [], lastUpdated: null };
  }
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch (err) {
    log("state_error", `Failed to read state.json: ${err.message}`);
    return { positions: {}, lastUpdated: null };
  }
}

function save(state) {
  try {
    state.lastUpdated = new Date().toISOString();
    fs.writeFileSync(STATE_FILE_TMP, JSON.stringify(state, null, 2));
    try {
      fs.renameSync(STATE_FILE_TMP, STATE_FILE);
    } catch {
      // Windows may reject replacing an existing file via rename; fall back to replace.
      fs.rmSync(STATE_FILE, { force: true });
      fs.renameSync(STATE_FILE_TMP, STATE_FILE);
    }
  } catch (err) {
    log("state_error", `Failed to write state.json: ${err.message}`);
  }
}

function mutateState(mutator) {
  const state = load();
  const result = mutator(state);
  if (result?.save === false) return result?.value;
  save(state);
  return result?.value;
}

// ─── Position Registry ─────────────────────────────────────────

/**
 * Record a newly deployed position.
 */
export function trackPosition({
  position,
  pool,
  pool_name,
  strategy,
  bin_range = {},
  amount_sol,
  amount_x = 0,
  base_mint = null,
  active_bin,
  bin_step,
  volatility,
  fee_tvl_ratio,
  organic_score,
  initial_value_usd,
  signal_snapshot = null,
}) {
  mutateState((state) => {
    state.positions[position] = {
      position,
      pool,
      pool_name,
      strategy,
      bin_range,
      amount_sol,
      amount_x,
      base_mint,
      active_bin_at_deploy: active_bin,
      bin_step,
      volatility,
      fee_tvl_ratio,
      initial_fee_tvl_24h: fee_tvl_ratio,
      organic_score,
      initial_value_usd,
      signal_snapshot: signal_snapshot || null,
      deployed_at: new Date().toISOString(),
      out_of_range_since: null,
      last_claim_at: null,
      total_fees_claimed_usd: 0,
      rebalance_count: 0,
      partial_close_count: 0,
      closed: false,
      closed_at: null,
      closing_pending_since: null,
      closing_pending_reason: null,
      closing_pending_txs: [],
      notes: [],
      peak_pnl_pct: 0,
      trailing_active: false,
    };
    pushEvent(state, { action: "deploy", position, pool_name: pool_name || pool });
    return { value: true };
  });
  log("state", `Tracked new position: ${position} in pool ${pool}`);
}

/**
 * Mark a position as out of range (sets timestamp on first detection).
 */
export function markOutOfRange(position_address) {
  const changed = mutateState((state) => {
    const pos = state.positions[position_address];
    if (!pos || pos.out_of_range_since) return { value: false, save: false };
    pos.out_of_range_since = new Date().toISOString();
    return { value: true };
  });
  if (changed) log("state", `Position ${position_address} marked out of range`);
}

/**
 * Mark a position as back in range (clears OOR timestamp).
 */
export function markInRange(position_address) {
  const changed = mutateState((state) => {
    const pos = state.positions[position_address];
    if (!pos || !pos.out_of_range_since) return { value: false, save: false };
    pos.out_of_range_since = null;
    return { value: true };
  });
  if (changed) log("state", `Position ${position_address} back in range`);
}

/**
 * How many minutes has a position been out of range?
 * Returns 0 if currently in range.
 */
export function minutesOutOfRange(position_address) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || !pos.out_of_range_since) return 0;
  const ms = Date.now() - new Date(pos.out_of_range_since).getTime();
  return Math.floor(ms / 60000);
}

/**
 * Record a fee claim event.
 */
export function recordClaim(position_address, fees_usd) {
  mutateState((state) => {
    const pos = state.positions[position_address];
    if (!pos) return { value: false, save: false };
    pos.last_claim_at = new Date().toISOString();
    pos.total_fees_claimed_usd = (pos.total_fees_claimed_usd || 0) + (fees_usd || 0);
    pos.notes.push(`Claimed ~$${fees_usd?.toFixed(2) || "?"} fees at ${pos.last_claim_at}`);
    return { value: true };
  });
}

/**
 * Increase tracked deployed amounts after adding liquidity to an open position.
 */
export function recordLiquidityAdded(position_address, amount_sol = 0, amount_x = 0) {
  mutateState((state) => {
    const pos = state.positions[position_address];
    if (!pos) return { value: false, save: false };
    pos.amount_sol = (pos.amount_sol || 0) + (amount_sol || 0);
    pos.amount_x = (pos.amount_x || 0) + (amount_x || 0);
    pos.notes.push(`Added liquidity: +${amount_sol || 0} SOL, +${amount_x || 0} X`);
    return { value: true };
  });
}

/**
 * Reduce tracked deployed amounts after a partial close.
 */
export function recordLiquidityRemoved(position_address, bps) {
  mutateState((state) => {
    const pos = state.positions[position_address];
    if (!pos) return { value: false, save: false };
    const keepRatio = Math.max(0, (10000 - (bps || 0)) / 10000);
    pos.amount_sol = Math.round((pos.amount_sol || 0) * keepRatio * 1e6) / 1e6;
    pos.amount_x = Math.round((pos.amount_x || 0) * keepRatio * 1e6) / 1e6;
    pos.partial_close_count = (pos.partial_close_count || 0) + 1;
    pos.notes.push(`Partial close: removed ${(bps / 100).toFixed(2)}% liquidity`);
    return { value: true };
  });
}

/**
 * Append to the recent events log (shown in every prompt).
 */
function pushEvent(state, event) {
  if (!state.recentEvents) state.recentEvents = [];
  state.recentEvents.push({ ts: new Date().toISOString(), ...event });
  if (state.recentEvents.length > MAX_RECENT_EVENTS) {
    state.recentEvents = state.recentEvents.slice(-MAX_RECENT_EVENTS);
  }
}

/**
 * Mark a position as closed.
 */
export function recordClose(position_address, reason) {
  const changed = mutateState((state) => {
    const pos = state.positions[position_address];
    if (!pos) return { value: false, save: false };
    pos.closed = true;
    pos.closed_at = new Date().toISOString();
    pos.closing_pending_since = null;
    pos.closing_pending_reason = null;
    pos.closing_pending_txs = [];
    pos.notes.push(`Closed at ${pos.closed_at}: ${reason}`);
    pushEvent(state, { action: "close", position: position_address, pool_name: pos.pool_name || pos.pool, reason });
    return { value: true };
  });
  if (changed) log("state", `Position ${position_address} marked closed: ${reason}`);
}

/**
 * Mark a position as having a close transaction submitted but not yet confirmed
 * by the live position fetcher.
 */
export function markClosingPending(position_address, reason, txs = []) {
  const changed = mutateState((state) => {
    const pos = state.positions[position_address];
    if (!pos || pos.closed) return { value: false, save: false };
    pos.closing_pending_since = new Date().toISOString();
    pos.closing_pending_reason = reason || null;
    pos.closing_pending_txs = Array.isArray(txs) ? txs.filter(Boolean) : [];
    pos.notes.push(`Close submitted at ${pos.closing_pending_since}${reason ? `: ${reason}` : ""}`);
    pushEvent(state, { action: "close_submitted", position: position_address, pool_name: pos.pool_name || pos.pool, reason: reason || null });
    return { value: true };
  });
  if (changed) log("state", `Position ${position_address} marked closing-pending`);
  return changed;
}

/**
 * Clear the closing-pending marker on a position.
 */
export function clearClosingPending(position_address) {
  const changed = mutateState((state) => {
    const pos = state.positions[position_address];
    if (!pos) return { value: false, save: false };
    if (!pos.closing_pending_since && !pos.closing_pending_reason && !(pos.closing_pending_txs || []).length) {
      return { value: false, save: false };
    }
    pos.closing_pending_since = null;
    pos.closing_pending_reason = null;
    pos.closing_pending_txs = [];
    return { value: true };
  });
  if (changed) log("state", `Position ${position_address} closing-pending cleared`);
  return changed;
}

/**
 * Record a rebalance (close + redeploy).
 */
export function recordRebalance(old_position, new_position) {
  mutateState((state) => {
    const old = state.positions[old_position];
    if (old) {
      old.closed = true;
      old.closed_at = new Date().toISOString();
      old.notes.push(`Rebalanced into ${new_position} at ${old.closed_at}`);
    }
    const newPos = state.positions[new_position];
    if (newPos) {
      newPos.rebalance_count = (old?.rebalance_count || 0) + 1;
      newPos.notes.push(`Rebalanced from ${old_position}`);
    }
    return { value: true };
  });
}

/**
 * Check if a position has reached its rebalance limit.
 * @param {string} position_address
 * @param {number} maxRebalances - Max allowed rebalances (from config)
 * @returns {boolean}
 */
export function isRebalanceLimitReached(position_address, maxRebalances) {
  if (!maxRebalances || maxRebalances <= 0) return false;
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return false;
  return (pos.rebalance_count || 0) >= maxRebalances;
}

/**
 * Set a persistent instruction for a position (e.g. "hold until 5% profit").
 * Overwrites any previous instruction. Pass null to clear.
 */
export function setPositionInstruction(position_address, instruction) {
  const changed = mutateState((state) => {
    const pos = state.positions[position_address];
    if (!pos) return { value: false, save: false };
    pos.instruction = instruction || null;
    return { value: true };
  });
  if (changed) log("state", `Position ${position_address} instruction set: ${instruction}`);
  return changed;
}

/**
 * Get all tracked positions (optionally filter open-only).
 */
export function getTrackedPositions(openOnly = false) {
  const state = load();
  const all = Object.values(state.positions);
  return openOnly ? all.filter((p) => !p.closed) : all;
}

/**
 * Get a single tracked position.
 */
export function getTrackedPosition(position_address) {
  const state = load();
  return state.positions[position_address] || null;
}

/**
 * Summarize state for the agent system prompt.
 */
export function getStateSummary() {
  const state = load();
  const open = Object.values(state.positions).filter((p) => !p.closed);
  const closed = Object.values(state.positions).filter((p) => p.closed);
  const totalFeesClaimed = Object.values(state.positions)
    .reduce((sum, p) => sum + (p.total_fees_claimed_usd || 0), 0);

  const daily = getDailyPnl();
  return {
    open_positions: open.length,
    closed_positions: closed.length,
    total_fees_claimed_usd: Math.round(totalFeesClaimed * 100) / 100,
    daily_pnl: daily,
    circuit_breaker: state.circuitBreaker?.active ? {
      active: true,
      reason: state.circuitBreaker.reason,
      resume_at: state.circuitBreaker.resume_at,
    } : null,
    positions: open.map((p) => ({
      position: p.position,
      pool: p.pool,
      strategy: p.strategy,
      deployed_at: p.deployed_at,
      out_of_range_since: p.out_of_range_since,
      minutes_out_of_range: minutesOutOfRange(p.position),
      total_fees_claimed_usd: p.total_fees_claimed_usd,
      initial_fee_tvl_24h: p.initial_fee_tvl_24h,
      rebalance_count: p.rebalance_count,
      partial_close_count: p.partial_close_count,
      closing_pending_since: p.closing_pending_since || null,
      instruction: p.instruction || null,
    })),
    last_updated: state.lastUpdated,
    recent_events: (state.recentEvents || []).slice(-10),
  };
}

/**
 * Check all exit conditions for a position (trailing TP, stop loss, OOR, low yield).
 * Updates peak_pnl_pct, trailing_active, and OOR state.
 * @param {string} position_address
 * @param {object} positionData - fields from getMyPositions: pnl_pct, in_range, fee_per_tvl_24h
 * @param {object} mgmtConfig
 * Returns { action, reason } or null if no exit needed.
 */
export function updatePnlAndCheckExits(position_address, positionData, mgmtConfig) {
  const { pnl_pct: currentPnlPct, in_range, fee_per_tvl_24h } = positionData;
  const pos = mutateState((state) => {
    const pos = state.positions[position_address];
    if (!pos || pos.closed) return { value: null, save: false };

    let changed = false;

    // Track peak PnL
    if (currentPnlPct != null && currentPnlPct > (pos.peak_pnl_pct ?? 0)) {
      pos.peak_pnl_pct = currentPnlPct;
      changed = true;
    }

    // Activate trailing TP once trigger threshold is reached
    if (mgmtConfig.trailingTakeProfit && !pos.trailing_active && currentPnlPct >= mgmtConfig.trailingTriggerPct) {
      pos.trailing_active = true;
      changed = true;
      log("state", `Position ${position_address} trailing TP activated at ${currentPnlPct}% (peak: ${pos.peak_pnl_pct}%)`);
    }

    // Update OOR state
    if (in_range === false && !pos.out_of_range_since) {
      pos.out_of_range_since = new Date().toISOString();
      changed = true;
      log("state", `Position ${position_address} marked out of range`);
    } else if (in_range === true && pos.out_of_range_since) {
      pos.out_of_range_since = null;
      changed = true;
      log("state", `Position ${position_address} back in range`);
    }

    return {
      value: { ...pos },
      save: changed,
    };
  });
  if (!pos || pos.closed) return null;

  // ── Stop loss ──────────────────────────────────────────────────
  if (currentPnlPct != null && mgmtConfig.stopLossPct != null && currentPnlPct <= mgmtConfig.stopLossPct) {
    return {
      action: "STOP_LOSS",
      reason: `Stop loss: PnL ${currentPnlPct.toFixed(2)}% <= ${mgmtConfig.stopLossPct}%`,
    };
  }

  // ── Trailing TP ────────────────────────────────────────────────
  if (pos.trailing_active) {
    const dropFromPeak = pos.peak_pnl_pct - currentPnlPct;
    if (dropFromPeak >= mgmtConfig.trailingDropPct) {
      return {
        action: "TRAILING_TP",
        reason: `Trailing TP: peak ${pos.peak_pnl_pct.toFixed(2)}% → current ${currentPnlPct.toFixed(2)}% (dropped ${dropFromPeak.toFixed(2)}% >= ${mgmtConfig.trailingDropPct}%)`,
      };
    }
  }

  // ── Out of range too long ──────────────────────────────────────
  if (pos.out_of_range_since) {
    const minutesOOR = Math.floor((Date.now() - new Date(pos.out_of_range_since).getTime()) / 60000);
    if (minutesOOR >= mgmtConfig.outOfRangeWaitMinutes) {
      return {
        action: "OUT_OF_RANGE",
        reason: `Out of range for ${minutesOOR}m (limit: ${mgmtConfig.outOfRangeWaitMinutes}m)`,
      };
    }
  }

  // ── Low yield (only after position has had time to accumulate fees) ───
  const { age_minutes } = positionData;
  const minAgeForYieldCheck = mgmtConfig.minAgeBeforeYieldCheck ?? 60;
  if (
    fee_per_tvl_24h != null &&
    mgmtConfig.minFeePerTvl24h != null &&
    fee_per_tvl_24h < mgmtConfig.minFeePerTvl24h &&
    (age_minutes != null && age_minutes >= minAgeForYieldCheck)
  ) {
    return {
      action: "LOW_YIELD",
      reason: `Low yield: fee/TVL ${fee_per_tvl_24h.toFixed(2)}% < min ${mgmtConfig.minFeePerTvl24h}% (age: ${age_minutes ?? "?"}m)`,
    };
  }

  // ── Max hold time — close stale positions with low return ─────
  const maxHoldMinutes = mgmtConfig.maxHoldMinutes ?? null;
  if (maxHoldMinutes && age_minutes != null && age_minutes >= maxHoldMinutes) {
    const totalReturn = currentPnlPct ?? 0;
    if (totalReturn < 2) {
      return {
        action: "MAX_HOLD",
        reason: `Max hold time: ${age_minutes}m >= ${maxHoldMinutes}m with return ${totalReturn.toFixed(2)}% < 2%`,
      };
    }
  }

  return null;
}

// ─── Daily P&L Tracking ───────────────────────────────────────

function todayUtcDate() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function ensureDailyPnl(state) {
  const today = todayUtcDate();
  if (!state.dailyPnl || state.dailyPnl.date !== today) {
    state.dailyPnl = {
      date: today,
      realized: 0,
      fees_claimed: 0,
      losses: 0,
      net: 0,
      trades_opened: 0,
      trades_closed: 0,
    };
  }
  return state.dailyPnl;
}

/**
 * Record a realized P&L event (position close).
 * @param {number} pnlSol - Net P&L in SOL (positive = profit, negative = loss)
 */
export function recordDailyPnl(pnlSol) {
  mutateState((state) => {
    const daily = ensureDailyPnl(state);
    if (pnlSol >= 0) {
      daily.realized += pnlSol;
    } else {
      daily.losses += pnlSol; // negative number
    }
    daily.net = daily.realized + daily.fees_claimed + daily.losses;
    daily.trades_closed += 1;
    return { value: true };
  });
}

/**
 * Record claimed fees in daily P&L.
 * @param {number} feesSol - Fees claimed in SOL
 */
export function recordDailyFees(feesSol) {
  mutateState((state) => {
    const daily = ensureDailyPnl(state);
    daily.fees_claimed += feesSol;
    daily.net = daily.realized + daily.fees_claimed + daily.losses;
    return { value: true };
  });
}

/**
 * Record a new trade opened in daily P&L.
 */
export function recordDailyOpen() {
  mutateState((state) => {
    const daily = ensureDailyPnl(state);
    daily.trades_opened += 1;
    return { value: true };
  });
}

/**
 * Get current daily P&L summary.
 */
export function getDailyPnl() {
  const state = load();
  const today = todayUtcDate();
  if (!state.dailyPnl || state.dailyPnl.date !== today) {
    return { date: today, realized: 0, fees_claimed: 0, losses: 0, net: 0, trades_opened: 0, trades_closed: 0 };
  }
  return { ...state.dailyPnl };
}

/**
 * Check if daily loss limit has been reached.
 * @param {number} maxDailyLossSol - Maximum allowed daily loss in SOL (positive number)
 * @returns {{ exceeded: boolean, currentLoss: number, limit: number }}
 */
export function isDailyLossLimitReached(maxDailyLossSol) {
  if (!maxDailyLossSol || maxDailyLossSol <= 0) return { exceeded: false, currentLoss: 0, limit: 0 };
  const daily = getDailyPnl();
  const currentLoss = Math.abs(Math.min(0, daily.losses || 0));
  return {
    exceeded: currentLoss >= maxDailyLossSol,
    currentLoss: Math.round(currentLoss * 10000) / 10000,
    limit: maxDailyLossSol,
  };
}

// ─── Emergency Circuit Breaker ────────────────────────────────

/**
 * Activate the emergency circuit breaker. Pauses all cron for `pauseMinutes`.
 * @param {string} reason
 * @param {number} pauseMinutes - How long to pause (default 360 = 6 hours)
 */
export function activateCircuitBreaker(reason, pauseMinutes = 360) {
  mutateState((state) => {
    state.circuitBreaker = {
      active: true,
      activated_at: new Date().toISOString(),
      resume_at: new Date(Date.now() + pauseMinutes * 60_000).toISOString(),
      reason,
    };
    return { value: true };
  });
  log("circuit_breaker", `ACTIVATED: ${reason} — paused for ${pauseMinutes}m`);
}

/**
 * Check if circuit breaker is active. Auto-deactivates if resume time has passed.
 */
export function isCircuitBreakerActive() {
  const state = load();
  if (!state.circuitBreaker?.active) return false;
  if (new Date(state.circuitBreaker.resume_at) <= new Date()) {
    // Auto-resume
    mutateState((s) => {
      s.circuitBreaker.active = false;
      return { value: true };
    });
    log("circuit_breaker", "Auto-resumed after pause period");
    return false;
  }
  return true;
}

/**
 * Manually resume (deactivate) the circuit breaker.
 */
export function resumeCircuitBreaker() {
  mutateState((state) => {
    if (state.circuitBreaker) {
      state.circuitBreaker.active = false;
    }
    return { value: true };
  });
  log("circuit_breaker", "Manually resumed");
}

// ─── Briefing Tracking ─────────────────────────────────────────

/**
 * Get the date (YYYY-MM-DD UTC) when the last briefing was sent.
 */
export function getLastBriefingDate() {
  const state = load();
  return state._lastBriefingDate || null;
}

/**
 * Record that the briefing was sent today.
 */
export function setLastBriefingDate() {
  mutateState((state) => {
    state._lastBriefingDate = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
    return { value: true };
  });
}

/**
 * Reconcile local state with actual on-chain positions.
 * Marks any local open positions as closed if they are not in the on-chain list.
 */
const SYNC_GRACE_MS = 5 * 60_000; // don't auto-close positions deployed < 5 min ago

export function syncOpenPositions(active_addresses) {
  return mutateState((state) => {
    const activeSet = new Set(active_addresses);
    let changed = false;

    for (const posId in state.positions) {
      const pos = state.positions[posId];
      if (pos.closed || activeSet.has(posId)) continue;

      // Grace period: newly deployed positions may not be indexed yet
      const deployedAt = pos.deployed_at ? new Date(pos.deployed_at).getTime() : 0;
      if (Date.now() - deployedAt < SYNC_GRACE_MS) {
      log("state", `Position ${posId} not on-chain yet — within grace period, skipping auto-close`);
      continue;
    }

      pos.closed = true;
      pos.closed_at = new Date().toISOString();
      pos.closing_pending_since = null;
      pos.closing_pending_reason = null;
      pos.closing_pending_txs = [];
      pos.notes.push(`Auto-closed during state sync (not found on-chain)`);
      changed = true;
      log("state", `Position ${posId} auto-closed (missing from on-chain data)`);
      }

    return { value: changed, save: changed };
  });
}
