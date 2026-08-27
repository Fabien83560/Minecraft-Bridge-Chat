/**
 * Chat Queue - Serialized Outbound Chat for a Single Minecraft Bot
 *
 * This file serializes everything a single bot account sends to the server. Before it
 * existed, three independent writers called bot.chat() directly and concurrently on the
 * same account: Discord-to-Minecraft bridging (fan-out to every guild at once), the
 * inter-guild relay queue (its own 1s timer), and Discord slash commands. Because
 * bot.chat() is fire-and-forget with no acknowledgement, two writes landing in the same
 * tick both logged success while Hypixel silently discarded the second one for exceeding
 * its ~1 command/second limit.
 *
 * The queue provides:
 * - Strict serialization: exactly one outbound message per bot at a time
 * - Minimum spacing between sends, with jitter to avoid lockstep across bots
 * - Priority lanes so user-facing commands are not stuck behind relayed chat
 * - Anti-duplicate suffixing to defeat Hypixel's "same message twice" filter
 * - Length clamping so mineflayer never splits a /gc into a second public-chat packet
 * - Bounded size with explicit, accounted drops instead of unbounded growth
 * - Promises that settle when the message is actually written, not when it is queued
 *
 * Priority lanes:
 * - 'command': Slash-command driven actions (/g kick, /g promote, /g online). A Discord
 *   user is waiting on a CommandResponseListener with a timeout, so these jump ahead.
 * - 'chat': Bridged chat and event relays. Ordering among these is preserved.
 *
 * Anti-duplicate:
 * Hypixel rejects a message identical to one the account recently sent. The queue tracks
 * recently sent text within a window and appends a configurable low-visibility suffix,
 * repeated once per prior occurrence, so repeated content still reaches the guild.
 *
 * Length clamping:
 * mineflayer splits any message longer than chatLengthLimit into several chat packets.
 * For a "/gc <text>" write that means the overflow is sent as a separate message without
 * the /gc prefix - leaking guild chat into public chat. The queue truncates before the
 * limit so a split can never happen.
 *
 * @author Fabien83560
 * @version 1.0.0
 * @license ISC
 */

// Specific Imports
const logger = require("../../shared/logger");
const metrics = require("../../shared/BridgeMetrics.js");
const { sanitizeForMinecraft } = require("../../shared/sanitizeForMinecraft.js");

/**
 * ChatQueue - Serialize outbound chat for one bot account
 *
 * One instance per MinecraftConnection. Owns the pacing, deduplication and ordering of
 * everything that account writes to the server.
 *
 * @class
 */
class ChatQueue {
    /**
     * Create a queue bound to a single bot connection
     *
     * @param {object} guildConfig - Guild configuration (used for naming and limits)
     * @param {string} guildConfig.name - Guild name, used in log output
     * @param {object} guildConfig.account - Account configuration
     * @param {number} [guildConfig.account.chatLengthLimit=256] - Server chat length limit
     * @param {object} context - Callbacks into the owning connection
     * @param {function(): boolean} context.isConnected - Whether the bot can send right now
     * @param {function(string): void} context.rawSend - Perform the actual bot.chat() write
     * @param {object} [options={}] - Queue tuning options
     * @param {number} [options.minIntervalMs=1200] - Minimum delay between two sends
     * @param {number} [options.jitterMs=250] - Random extra delay added to each interval
     * @param {number} [options.maxSize=200] - Maximum queued messages before dropping
     * @param {boolean} [options.antiDuplicate=true] - Enable duplicate suffixing
     * @param {string} [options.duplicateSuffix='ᐧ'] - Suffix appended to repeated messages
     * @param {number} [options.duplicateWindowMs=60000] - How long a message counts as recent
     *
     * @example
     * const queue = new ChatQueue(guildConfig, {
     *   isConnected: () => this._isConnected,
     *   rawSend: (text) => this._bot.chat(text)
     * }, { minIntervalMs: 1200 });
     */
    constructor(guildConfig, context, options = {}) {
        this._guildConfig = guildConfig;
        this._context = context;

        this.minIntervalMs = options.minIntervalMs ?? 1200;
        this.jitterMs = options.jitterMs ?? 250;
        this.maxSize = options.maxSize ?? 200;

        this.antiDuplicate = options.antiDuplicate !== false;
        this.duplicateSuffix = options.duplicateSuffix ?? 'ᐧ';
        this.duplicateWindowMs = options.duplicateWindowMs ?? 60000;

        this.chatLengthLimit = guildConfig.account?.chatLengthLimit || 256;

        // Two lanes: commands drain before chat
        this._commandQueue = [];
        this._chatQueue = [];

        this._draining = false;
        this._stopped = false;
        this._lastSendAt = 0;

        // Recently sent text -> { timestamp, count } for duplicate suffixing
        this._recentSends = new Map();

        logger.debug(`[QUEUE] [${guildConfig.name}] ChatQueue ready (interval=${this.minIntervalMs}ms, max=${this.maxSize})`);
    }

    /**
     * Queue a message for delivery
     *
     * The returned promise settles when the message is actually written to the server,
     * not when it enters the queue. It rejects if the message is dropped (queue full,
     * connection lost, queue stopped) so callers can report a real failure instead of
     * logging an unconditional success.
     *
     * @param {string} text - Full text to send, including any leading command.
     *        Les caractères de formatage invisibles (sélecteurs de variation,
     *        liants de largeur nulle) en sont retirés : Minecraft les rend en
     *        carrés alors qu'ils sont invisibles côté Discord.
     * @param {object} [options={}] - Per-message options
     * @param {string} [options.priority='chat'] - Lane to use ('command' or 'chat')
     * @param {string} [options.direction='inter_guild'] - Metrics direction for accounting
     * @param {string} [options.label=''] - Short description used in log output
     * @returns {Promise<void>} Settles when written, rejects when dropped
     * @throws {Error} If the queue is stopped, full, or the bot disconnects first
     *
     * @example
     * await queue.enqueue('/gc D > Fabien: salut', {
     *   priority: 'chat',
     *   direction: 'discord_to_mc'
     * });
     */
    enqueue(text, options = {}) {
        // Nettoyage au point d'entrée, et pas plus bas : la déduplication, le
        // clamp de longueur et les métriques doivent tous voir le même texte
        // que celui réellement écrit sur le serveur.
        text = sanitizeForMinecraft(text);

        const priority = options.priority === 'command' ? 'command' : 'chat';
        const direction = options.direction || 'inter_guild';
        const label = options.label || '';

        if (this._stopped) {
            metrics.dropped(direction, 'queue_stopped', `${this._guildConfig.name}: ${text.substring(0, 60)}`);
            return Promise.reject(new Error(`ChatQueue stopped for ${this._guildConfig.name}`));
        }

        const lane = priority === 'command' ? this._commandQueue : this._chatQueue;

        if (this.size() >= this.maxSize) {
            // Shed the oldest chat item rather than the newest - stale relayed chat is
            // worth less than what a user just typed. Commands are never shed.
            const evicted = this._chatQueue.shift();

            if (evicted) {
                metrics.dropped(
                    evicted.direction,
                    'queue_overflow',
                    `${this._guildConfig.name}: ${evicted.text.substring(0, 60)}`
                );
                evicted.reject(new Error(`Dropped from ChatQueue overflow for ${this._guildConfig.name}`));
            } else {
                metrics.dropped(direction, 'queue_overflow', `${this._guildConfig.name}: ${text.substring(0, 60)}`);
                return Promise.reject(new Error(`ChatQueue full for ${this._guildConfig.name}`));
            }
        }

        return new Promise((resolve, reject) => {
            lane.push({
                text,
                direction,
                label,
                priority,
                queuedAt: Date.now(),
                resolve,
                reject
            });

            this._drain().catch(error => logger.logError(error, `ChatQueue drain failed for ${this._guildConfig.name}`));
        });
    }

    /**
     * Drain the queue, one message at a time
     *
     * Runs as a single async loop guarded by the _draining flag, so concurrent enqueue()
     * calls never start a second loop. Waits out the remaining interval before each send
     * and stops cleanly when both lanes are empty.
     *
     * @private
     * @async
     */
    async _drain() {
        if (this._draining || this._stopped) {
            return;
        }

        this._draining = true;

        try {
            while (!this._stopped) {
                if (this.size() === 0) {
                    break;
                }

                // Respect minimum spacing since the previous write. Waiting happens
                // before an item is picked, not after: a command enqueued during this
                // wait must still be able to overtake queued chat, which it cannot do
                // if the loop has already committed to the next chat item.
                const waitMs = this._timeUntilNextSlot();
                if (waitMs > 0) {
                    await this._wait(waitMs);
                }

                if (this._stopped) {
                    break;
                }

                const item = this._commandQueue.shift() || this._chatQueue.shift();
                if (!item) {
                    break;
                }

                if (!this._context.isConnected()) {
                    metrics.dropped(
                        item.direction,
                        'not_connected',
                        `${this._guildConfig.name}: ${item.text.substring(0, 60)}`
                    );
                    item.reject(new Error(`Cannot send: ${this._guildConfig.name} is not connected`));
                    continue;
                }

                try {
                    const finalText = this._prepare(item.text);

                    this._context.rawSend(finalText);
                    this._lastSendAt = Date.now();
                    this._noteSent(item.text);

                    metrics.sent(item.direction, 'minecraft');
                    logger.debug(
                        `[QUEUE] [${this._guildConfig.name}] Sent${item.label ? ` (${item.label})` : ''} ` +
                        `after ${Date.now() - item.queuedAt}ms wait: "${finalText.substring(0, 80)}"`
                    );

                    item.resolve();

                } catch (error) {
                    metrics.dropped(
                        item.direction,
                        'send_error',
                        `${this._guildConfig.name}: ${error.message}`
                    );
                    item.reject(error);
                }
            }
        } finally {
            this._draining = false;
        }

        // An enqueue() that arrived while the loop was winding down would have seen
        // _draining still true, so re-check before giving up.
        if (!this._stopped && this.size() > 0) {
            this._drain().catch(error => logger.logError(error, `ChatQueue drain failed for ${this._guildConfig.name}`));
        }
    }

    /**
     * Compute how long to wait before the next send is allowed
     *
     * Combines the configured minimum interval with random jitter. Jitter keeps the
     * three guild bots from settling into lockstep, which would otherwise concentrate
     * their writes into the same instants.
     *
     * @private
     * @returns {number} Milliseconds to wait (0 if a slot is available now)
     */
    _timeUntilNextSlot() {
        if (this._lastSendAt === 0) {
            return 0;
        }

        const jitter = Math.random() * this.jitterMs;
        const elapsed = Date.now() - this._lastSendAt;

        return Math.max(0, this.minIntervalMs + jitter - elapsed);
    }

    /**
     * Prepare the final text written to the server
     *
     * Clamps length so mineflayer cannot split the message, then applies duplicate
     * suffixing if the same text was sent recently.
     *
     * @private
     * @param {string} text - Raw queued text
     * @returns {string} Text safe to hand to bot.chat()
     */
    _prepare(text) {
        let finalText = text;

        if (this.antiDuplicate) {
            const recent = this._recentSends.get(text);

            if (recent && (Date.now() - recent.timestamp) < this.duplicateWindowMs) {
                const suffix = ` ${this.duplicateSuffix.repeat(Math.min(recent.count, 3))}`;
                finalText = this._clamp(text, this.chatLengthLimit - suffix.length) + suffix;

                logger.debug(`[QUEUE] [${this._guildConfig.name}] Duplicate detected, suffixing (x${recent.count})`);
            }
        }

        return this._clamp(finalText, this.chatLengthLimit);
    }

    /**
     * Truncate text to a maximum length
     *
     * @private
     * @param {string} text - Text to clamp
     * @param {number} maxLength - Maximum allowed length
     * @returns {string} Text no longer than maxLength
     */
    _clamp(text, maxLength) {
        if (text.length <= maxLength) {
            return text;
        }

        return text.substring(0, Math.max(0, maxLength - 3)) + '...';
    }

    /**
     * Record that a message was sent, for duplicate detection
     *
     * Stores the pre-suffix text so a third identical message is recognised as a
     * duplicate of the first two. Prunes entries outside the detection window.
     *
     * @private
     * @param {string} text - Original queued text, before suffixing
     */
    _noteSent(text) {
        if (!this.antiDuplicate) {
            return;
        }

        const now = Date.now();
        const existing = this._recentSends.get(text);

        if (existing && (now - existing.timestamp) < this.duplicateWindowMs) {
            existing.count++;
            existing.timestamp = now;
        } else {
            this._recentSends.set(text, { timestamp: now, count: 1 });
        }

        // Prune stale entries so the map cannot grow without bound
        if (this._recentSends.size > 200) {
            for (const [key, data] of this._recentSends.entries()) {
                if (now - data.timestamp > this.duplicateWindowMs) {
                    this._recentSends.delete(key);
                }
            }
        }
    }

    /**
     * Get the number of messages waiting in both lanes
     *
     * @returns {number} Combined queue depth
     *
     * @example
     * if (queue.size() > 50) logger.warn('Bot is falling behind');
     */
    size() {
        return this._commandQueue.length + this._chatQueue.length;
    }

    /**
     * Get queue statistics for monitoring
     *
     * @returns {object} Depth per lane, drain state, and time since last send
     */
    getStats() {
        return {
            guildName: this._guildConfig.name,
            commandDepth: this._commandQueue.length,
            chatDepth: this._chatQueue.length,
            draining: this._draining,
            stopped: this._stopped,
            msSinceLastSend: this._lastSendAt === 0 ? null : Date.now() - this._lastSendAt
        };
    }

    /**
     * Reset pacing state after a reconnection
     *
     * Clears the last-send timestamp and duplicate history. A reconnected bot starts
     * with a fresh server-side rate limit, so the queue should not keep waiting out an
     * interval measured against the previous session.
     *
     * @example
     * // After connection.reconnect() succeeds
     * queue.resetPacing();
     */
    resetPacing() {
        this._lastSendAt = 0;
        this._recentSends.clear();
        this._stopped = false;

        if (this.size() > 0) {
            this._drain();
        }
    }

    /**
     * Stop the queue and reject everything still pending
     *
     * Called during disconnect and shutdown. Pending messages are rejected rather than
     * silently discarded so callers surface the loss, and each one is accounted in the
     * metrics.
     *
     * @param {string} [reason='shutdown'] - Reason recorded against the dropped messages
     *
     * @example
     * queue.stop('disconnect');
     */
    stop(reason = 'shutdown') {
        this._stopped = true;

        const pending = [...this._commandQueue, ...this._chatQueue];
        this._commandQueue = [];
        this._chatQueue = [];

        for (const item of pending) {
            metrics.dropped(item.direction, reason, `${this._guildConfig.name}: ${item.text.substring(0, 60)}`);
            item.reject(new Error(`ChatQueue ${reason} for ${this._guildConfig.name}`));
        }

        if (pending.length > 0) {
            logger.warn(`[QUEUE] [${this._guildConfig.name}] Dropped ${pending.length} pending message(s) on ${reason}`);
        }
    }

    /**
     * Wait for a number of milliseconds
     *
     * @private
     * @param {number} ms - Milliseconds to wait
     * @returns {Promise<void>}
     */
    _wait(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

module.exports = ChatQueue;
