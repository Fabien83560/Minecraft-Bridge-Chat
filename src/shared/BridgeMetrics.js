/**
 * Bridge Metrics - Delivery Accounting for Both Bridge Directions
 *
 * This module tracks what the bridge actually delivers versus what it silently drops.
 * Before it existed every rejection path (rate limits, anti-loop filters, missing
 * templates, cooldowns) logged at debug level only, so in production - where debug is
 * disabled - a dropped message left no trace at all. The bridge reported 100% success
 * while messages never reached their destination.
 *
 * The module provides:
 * - Counters keyed by direction and outcome (sent / filtered / dropped)
 * - Per-reason breakdown so drops can be attributed to a specific filter
 * - Periodic summary logging so losses surface without enabling debug
 * - Snapshot access for status commands and panels
 *
 * Directions tracked:
 * - 'mc_to_discord': Minecraft guild/officer chat and events forwarded to Discord
 * - 'discord_to_mc': Discord channel messages forwarded to Minecraft guild chat
 * - 'inter_guild':   Messages and events relayed between the configured guilds
 *
 * Outcomes tracked:
 * - 'sent':     Handed off to the destination successfully
 * - 'filtered': Intentionally suppressed (own bot message, relay loop, cooldown)
 * - 'dropped':  Lost against intent (queue overflow, missing template, send failure)
 *
 * The distinction between 'filtered' and 'dropped' matters: filtered is the bridge
 * working as designed, dropped is the bridge losing a message. Only the latter should
 * ever be investigated.
 *
 * @author Fabien83560
 * @version 1.0.0
 * @license ISC
 */

// Specific Imports
const logger = require('./logger');

/**
 * BridgeMetrics - Track delivery outcomes across both bridge directions
 *
 * Singleton counter store. Counters are cumulative since process start; the periodic
 * summary reports the delta since the previous summary so spikes stay visible instead
 * of being diluted by long-running totals.
 *
 * @class
 */
class BridgeMetrics {
    /**
     * Create the metrics store
     *
     * Initializes empty counter maps and the delta baseline used by the periodic
     * summary. Does not start the summary timer - call startSummary() for that.
     */
    constructor() {
        // `${direction}:${outcome}` -> count
        this.counters = new Map();

        // `${direction}:${outcome}:${reason}` -> count
        this.reasons = new Map();

        // Baseline snapshot used to compute deltas between summaries
        this._lastSummary = new Map();

        this._summaryTimer = null;
        this._startedAt = Date.now();
    }

    /**
     * Record a delivery outcome
     *
     * Increments both the direction/outcome counter and the finer-grained
     * direction/outcome/reason counter.
     *
     * @param {string} direction - One of 'mc_to_discord', 'discord_to_mc', 'inter_guild'
     * @param {string} outcome - One of 'sent', 'filtered', 'dropped'
     * @param {string} [reason='-'] - Short slug explaining the outcome
     *
     * @example
     * metrics.record('discord_to_mc', 'dropped', 'queue_overflow');
     */
    record(direction, outcome, reason = '-') {
        const key = `${direction}:${outcome}`;
        this.counters.set(key, (this.counters.get(key) || 0) + 1);

        const reasonKey = `${key}:${reason}`;
        this.reasons.set(reasonKey, (this.reasons.get(reasonKey) || 0) + 1);
    }

    /**
     * Record a successful delivery
     *
     * @param {string} direction - Bridge direction
     * @param {string} [reason='-'] - Optional detail (e.g. 'webhook', 'channel')
     */
    sent(direction, reason = '-') {
        this.record(direction, 'sent', reason);
    }

    /**
     * Record an intentional suppression
     *
     * Use for messages the bridge is designed to suppress: own bot echoes, relay
     * loops, event cooldowns. These are expected and are not investigated.
     *
     * @param {string} direction - Bridge direction
     * @param {string} reason - Why the message was filtered
     */
    filtered(direction, reason) {
        this.record(direction, 'filtered', reason);
    }

    /**
     * Record an unintended loss
     *
     * Use whenever a message that should have been delivered was not. Always logs at
     * warn level so the loss is visible without enabling debug logging.
     *
     * @param {string} direction - Bridge direction
     * @param {string} reason - Why the message was lost
     * @param {string} [detail=''] - Message excerpt or context for diagnosis
     */
    dropped(direction, reason, detail = '') {
        this.record(direction, 'dropped', reason);
        logger.warn(`[METRICS] DROPPED ${direction} (${reason})${detail ? `: ${detail}` : ''}`);
    }

    /**
     * Get a snapshot of all counters
     *
     * Returns a plain object suitable for logging, status embeds, or serialization.
     *
     * @returns {object} Snapshot with uptime, totals per direction, and reason breakdown
     *
     * @example
     * const snap = metrics.snapshot();
     * console.log(snap.directions.discord_to_mc.dropped);
     */
    snapshot() {
        const directions = {};

        for (const [key, count] of this.counters.entries()) {
            const [direction, outcome] = key.split(':');
            if (!directions[direction]) {
                directions[direction] = { sent: 0, filtered: 0, dropped: 0 };
            }
            directions[direction][outcome] = count;
        }

        const reasons = {};
        for (const [key, count] of this.reasons.entries()) {
            reasons[key] = count;
        }

        return {
            uptimeMs: Date.now() - this._startedAt,
            directions,
            reasons
        };
    }

    /**
     * Start periodic summary logging
     *
     * Logs a compact summary at a fixed interval, reporting the delta since the
     * previous summary. Summaries with no activity are skipped so quiet periods do
     * not add noise. Safe to call multiple times - only one timer is ever active.
     *
     * @param {number} [intervalMs=900000] - Summary interval (default 15 minutes)
     *
     * @example
     * metrics.startSummary(900000);
     */
    startSummary(intervalMs = 15 * 60 * 1000) {
        if (this._summaryTimer) {
            return;
        }

        this._summaryTimer = setInterval(() => {
            try {
                this.logSummary();
            } catch (error) {
                logger.logError(error, 'Failed to log bridge metrics summary');
            }
        }, intervalMs);

        // Never hold the process open just for metrics
        if (typeof this._summaryTimer.unref === 'function') {
            this._summaryTimer.unref();
        }
    }

    /**
     * Log a summary of activity since the previous summary
     *
     * Reports per-direction sent/filtered/dropped deltas. Any non-zero drop count is
     * expanded into its per-reason breakdown so the cause is immediately visible.
     * Silent when nothing happened since the last call.
     */
    logSummary() {
        const lines = [];
        let hasActivity = false;
        let hasDrops = false;

        for (const [key, total] of this.counters.entries()) {
            const previous = this._lastSummary.get(key) || 0;
            if (total !== previous) {
                hasActivity = true;
            }
        }

        if (!hasActivity) {
            return;
        }

        const snap = this.snapshot();

        for (const [direction, outcomes] of Object.entries(snap.directions)) {
            const delta = {};
            for (const outcome of ['sent', 'filtered', 'dropped']) {
                const key = `${direction}:${outcome}`;
                delta[outcome] = (this.counters.get(key) || 0) - (this._lastSummary.get(key) || 0);
            }

            if (delta.sent === 0 && delta.filtered === 0 && delta.dropped === 0) {
                continue;
            }

            lines.push(`   • ${direction}: sent=${delta.sent} filtered=${delta.filtered} dropped=${delta.dropped}`);

            if (delta.dropped > 0) {
                hasDrops = true;
                for (const [reasonKey, count] of this.reasons.entries()) {
                    if (!reasonKey.startsWith(`${direction}:dropped:`)) {
                        continue;
                    }
                    const previous = this._lastSummary.get(reasonKey) || 0;
                    if (count > previous) {
                        const reason = reasonKey.split(':')[2];
                        lines.push(`       ↳ ${reason}: ${count - previous}`);
                    }
                }
            }
        }

        if (lines.length > 0) {
            logger.info('📊 Bridge delivery summary (since last report):');
            lines.forEach(line => logger.info(line));

            if (hasDrops) {
                logger.warn('⚠️  Messages were dropped - see the breakdown above');
            }
        }

        // Refresh the baseline for the next delta
        this._lastSummary = new Map([...this.counters, ...this.reasons]);
    }

    /**
     * Stop periodic summary logging
     *
     * Clears the summary timer. Counters are preserved and can still be read via
     * snapshot(). Called during shutdown.
     */
    stopSummary() {
        if (this._summaryTimer) {
            clearInterval(this._summaryTimer);
            this._summaryTimer = null;
        }
    }

    /**
     * Reset all counters
     *
     * Clears every counter and the delta baseline. Intended for tests and manual
     * administrative resets.
     */
    reset() {
        this.counters.clear();
        this.reasons.clear();
        this._lastSummary.clear();
        this._startedAt = Date.now();
    }
}

// Single shared instance across the whole bridge
module.exports = new BridgeMetrics();
