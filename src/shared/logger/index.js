const Logger = require('./logger');
const Config = require('../../../config');

let loggerInstance = null;

function getLogger() {
	if (!loggerInstance) {
		let config = new Config();
		const loggingConfig = config.get("features.logging");
		loggerInstance = new Logger(loggingConfig);
	}
	return loggerInstance;
}

// Direct export of methods for simple usage
const logger = getLogger();

module.exports = {
	// Main methods
	info: (...args) => logger.info(...args),
	warn: (...args) => logger.warn(...args),
	error: (...args) => logger.error(...args),
	debug: (...args) => logger.debug(...args),
	
	// Specialized methods for bridge
	minecraft: (...args) => logger.minecraft(...args),
	discord: (...args) => logger.discord(...args),
	bridge: (...args) => logger.bridge(...args),
	
	// Utility methods
	logError: (error, context) => logger.logError(error, context),
	logPerformance: (label, startTime) => logger.logPerformance(label, startTime),
	logMinecraftConnection: (guildId, username, status, details) => logger.logMinecraftConnection(guildId, username, status, details),
	logBridgeMessage: (from, to, username, message) => logger.logBridgeMessage(from, to, username, message),
	logDiscordCommand: (userId, command, guildId) => logger.logDiscordCommand(userId, command, guildId),
	
	// Access to full instance if needed
	getInstance: () => logger,
	
	// Configuration methods
	setLevel: (level) => logger.setLevel(level),
	getLevel: () => logger.getLevel()
};