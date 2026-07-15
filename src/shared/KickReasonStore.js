/**
 * Kick Reason Store - Short-lived Kick Reason Correlation
 *
 * Hypixel guild kicks do not carry a reason. The reason only exists at the moment
 * a moderator runs the Discord `/guild kick <guild> <player> <reason>` command.
 * A few milliseconds later, Hypixel rebroadcasts the kick in guild chat, which the
 * bridge parses into a kick event and forwards to the detection channel.
 *
 * This store bridges that gap: the kick command records the reason here (keyed by
 * guild id + player name) right before sending `/g kick`, and the detection
 * notification looks it up so the reason can be attached to the `[GUILD KICK]`
 * message consumed by FrenchLegacy-Discord (which sends the DM to the kicked player).
 *
 * Entries auto-expire after a short TTL so a failed kick (no event ever parsed)
 * does not leak a stale reason onto an unrelated later kick of the same player.
 *
 * @author Fabien83560
 * @version 1.0.0
 * @license ISC
 */

const logger = require('./logger');

/**
 * Time-to-live for a stored reason, in milliseconds.
 * Generous enough to survive the delay between sending `/g kick` and the parsed
 * kick event, short enough to avoid leaking onto a later unrelated kick.
 * @type {number}
 */
const REASON_TTL_MS = 30_000;

/**
 * In-memory reason map. Key: `${guildId}:${lowercasedUsername}` → { reason, expiresAt }.
 * @type {Map<string, { reason: string, expiresAt: number }>}
 */
const store = new Map();

/**
 * Build the lookup key for a guild/player pair.
 *
 * @param {string|number} guildId - Guild identifier
 * @param {string} username - Minecraft username (case-insensitive)
 * @returns {string} Store key
 */
function buildKey(guildId, username) {
    return `${guildId}:${String(username).toLowerCase()}`;
}

/**
 * Remove any expired entries. Called opportunistically on each access to keep the
 * map small without a background timer.
 */
function prune() {
    const now = Date.now();
    for (const [key, entry] of store.entries()) {
        if (entry.expiresAt <= now) {
            store.delete(key);
        }
    }
}

module.exports = {
    /**
     * Record the reason for an imminent guild kick.
     * Should be called right before sending `/g kick` to Minecraft.
     *
     * @param {string|number} guildId - Guild identifier
     * @param {string} username - Minecraft username being kicked
     * @param {string} reason - Kick reason provided by the moderator
     */
    set(guildId, username, reason) {
        if (!guildId || !username || !reason) return;
        prune();
        store.set(buildKey(guildId, username), {
            reason,
            expiresAt: Date.now() + REASON_TTL_MS,
        });
        logger.debug?.(`[KickReasonStore] Stored reason for ${guildId}:${username}`);
    },

    /**
     * Retrieve and consume the reason for a kicked player.
     * Returns null if none was stored or it has expired. The entry is removed on read.
     *
     * @param {string|number} guildId - Guild identifier
     * @param {string} username - Minecraft username being kicked
     * @returns {string|null} The reason, or null if not found
     */
    take(guildId, username) {
        prune();
        const key = buildKey(guildId, username);
        const entry = store.get(key);
        if (!entry) return null;
        store.delete(key);
        return entry.reason;
    },
};
