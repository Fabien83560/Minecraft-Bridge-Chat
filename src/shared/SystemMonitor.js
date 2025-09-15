// Specific Imports
const logger = require('./logger');
const BridgeLocator = require('../bridgeLocator.js');

class SystemMonitor {
    constructor() {
        const mainBridge = BridgeLocator.getInstance();
        this.config = mainBridge.config;

        this.monitoringConfig = this.config.get('advanced.performance');
        this.isMonitoring = false;
        this.monitoringInterval = null;

        // Statistics storage
        this.stats = {
            system: {
                startTime: Date.now(),
                uptime: 0,
                memoryUsage: {},
                cpuUsage: 0
            },
            minecraft: {
                connectionsTotal: 0,
                connectionsActive: 0,
                messagesProcessed: 0,
                eventsProcessed: 0,
                reconnections: 0,
                errors: 0
            },
            interGuild: {
                messagesTransferred: 0,
                eventsTransferred: 0,
                rateLimitHits: 0,
                queueSize: 0,
                droppedMessages: 0,
                errors: 0
            },
            performance: {
                slowOperations: 0,
                averageProcessingTime: 0,
                peakMemoryUsage: 0,
                totalOperations: 0
            }
        };

        // Performance tracking
        this.operationTimes = [];
        this.slowOperationThreshold = this.monitoringConfig.slowOperationThreshold || 1000;

        if (this.monitoringConfig.enablePerformanceMonitoring) {
            this.startMonitoring();
        }
    }

    /**
     * Start system monitoring
     */
    startMonitoring() {
        if (this.isMonitoring) {
            return;
        }

        const interval = this.monitoringConfig.statisticsInterval || 300000; // 5 minutes
        
        this.monitoringInterval = setInterval(() => {
            this.collectStatistics();
            this.logStatistics();
        }, interval);

        this.isMonitoring = true;
        logger.info('✅ System monitoring started');
    }

    /**
     * Stop system monitoring
     */
    stopMonitoring() {
        if (this.monitoringInterval) {
            clearInterval(this.monitoringInterval);
            this.monitoringInterval = null;
        }

        this.isMonitoring = false;
        logger.info('🛑 System monitoring stopped');
    }

    /**
     * Collect current system statistics
     */
    collectStatistics() {
        try {
            // System stats
            this.stats.system.uptime = Date.now() - this.stats.system.startTime;
            this.stats.system.memoryUsage = process.memoryUsage();

            // Update peak memory usage
            const currentMemory = this.stats.system.memoryUsage.heapUsed;
            if (currentMemory > this.stats.performance.peakMemoryUsage) {
                this.stats.performance.peakMemoryUsage = currentMemory;
            }

            // Collect Minecraft statistics
            this.collectMinecraftStats();

            // Collect inter-guild statistics
            this.collectInterGuildStats();

            // Calculate performance metrics
            this.calculatePerformanceMetrics();

        } catch (error) {
            logger.logError(error, 'Error collecting statistics');
        }
    }

    /**
     * Collect Minecraft connection statistics
     */
    collectMinecraftStats() {
        const mainBridge = BridgeLocator.getInstance();
        if (!mainBridge._minecraftManager) {
            return;
        }

        const connectionStatus = mainBridge._minecraftManager.getConnectionStatus();
        const connectedGuilds = mainBridge._minecraftManager.getConnectedGuilds();

        this.stats.minecraft.connectionsTotal = Object.keys(connectionStatus).length;
        this.stats.minecraft.connectionsActive = connectedGuilds.length;

        // Additional stats would be collected from bot manager if available
        if (mainBridge._minecraftManager._botManager) {
            const botStats = this.getBotManagerStats(mainBridge._minecraftManager._botManager);
            this.stats.minecraft = { ...this.stats.minecraft, ...botStats };
        }
    }

    /**
     * Collect inter-guild statistics
     */
    collectInterGuildStats() {
        const mainBridge = BridgeLocator.getInstance();
        if (!mainBridge._minecraftManager || !mainBridge._minecraftManager._botManager) {
            return;
        }

        const interGuildStats = mainBridge._minecraftManager.getInterGuildStats();
        if (interGuildStats) {
            this.stats.interGuild.messagesTransferred = interGuildStats.messagesProcessed || 0;
            this.stats.interGuild.eventsTransferred = interGuildStats.eventsProcessed || 0;
            this.stats.interGuild.rateLimitHits = interGuildStats.rateLimitHits || 0;
            this.stats.interGuild.queueSize = interGuildStats.queueSize || 0;
            this.stats.interGuild.droppedMessages = interGuildStats.messagesDropped || 0;
            this.stats.interGuild.errors = interGuildStats.errors || 0;
        }
    }

    /**
     * Get statistics from bot manager
     * @param {object} botManager - Bot manager instance
     * @returns {object} Bot manager statistics
     */
    getBotManagerStats(botManager) {
        // This would need to be implemented in the bot manager
        // For now, return empty stats
        return {
            messagesProcessed: 0,
            eventsProcessed: 0,
            reconnections: 0,
            errors: 0
        };
    }

    /**
     * Calculate performance metrics
     */
    calculatePerformanceMetrics() {
        if (this.operationTimes.length > 0) {
            const total = this.operationTimes.reduce((sum, time) => sum + time, 0);
            this.stats.performance.averageProcessingTime = total / this.operationTimes.length;
            this.stats.performance.totalOperations = this.operationTimes.length;

            // Count slow operations
            this.stats.performance.slowOperations = this.operationTimes.filter(
                time => time > this.slowOperationThreshold
            ).length;

            // Keep only recent operation times (last 100)
            if (this.operationTimes.length > 100) {
                this.operationTimes = this.operationTimes.slice(-100);
            }
        }
    }

    /**
     * Log current statistics
     */
    logStatistics() {
        if (!this.monitoringConfig.logSlowOperations && !this.monitoringConfig.memoryMonitoring) {
            return;
        }

        const memoryMB = Math.round(this.stats.system.memoryUsage.heapUsed / 1024 / 1024);
        const uptimeHours = Math.round(this.stats.system.uptime / (1000 * 60 * 60) * 100) / 100;

        logger.info(`📊 System Stats - Uptime: ${uptimeHours}h, Memory: ${memoryMB}MB, Connections: ${this.stats.minecraft.connectionsActive}/${this.stats.minecraft.connectionsTotal}`);

        if (this.stats.interGuild.messagesTransferred > 0) {
            logger.info(`🌉 Inter-Guild - Messages: ${this.stats.interGuild.messagesTransferred}, Events: ${this.stats.interGuild.eventsTransferred}, Queue: ${this.stats.interGuild.queueSize}, Dropped: ${this.stats.interGuild.droppedMessages}`);
        }

        if (this.stats.performance.slowOperations > 0 && this.monitoringConfig.logSlowOperations) {
            logger.warn(`⚠️ Performance - Slow operations: ${this.stats.performance.slowOperations}, Avg time: ${Math.round(this.stats.performance.averageProcessingTime)}ms`);
        }
    }

    /**
     * Track operation performance
     * @param {string} operationName - Name of the operation
     * @param {number} startTime - Operation start time
     */
    trackOperation(operationName, startTime) {
        const duration = Date.now() - startTime;
        this.operationTimes.push(duration);

        if (duration > this.slowOperationThreshold && this.monitoringConfig.logSlowOperations) {
            logger.warn(`🐌 Slow operation detected: ${operationName} took ${duration}ms`);
        }
    }

    /**
     * Get current statistics
     * @returns {object} Current statistics
     */
    getStatistics() {
        return JSON.parse(JSON.stringify(this.stats));
    }

    /**
     * Get system health status
     * @returns {object} System health status
     */
    getHealthStatus() {
        const health = {
            overall: 'healthy',
            issues: [],
            warnings: []
        };

        // Check memory usage
        const memoryMB = this.stats.system.memoryUsage.heapUsed / 1024 / 1024;
        if (memoryMB > 512) { // Above 512MB
            health.warnings.push(`High memory usage: ${Math.round(memoryMB)}MB`);
        }
        if (memoryMB > 1024) { // Above 1GB
            health.issues.push(`Very high memory usage: ${Math.round(memoryMB)}MB`);
            health.overall = 'warning';
        }

        // Check connection health
        const connectionRatio = this.stats.minecraft.connectionsActive / Math.max(this.stats.minecraft.connectionsTotal, 1);
        if (connectionRatio < 0.5) {
            health.issues.push(`Many connections down: ${this.stats.minecraft.connectionsActive}/${this.stats.minecraft.connectionsTotal}`);
            health.overall = 'warning';
        }

        // Check inter-guild health
        if (this.stats.interGuild.queueSize > 100) {
            health.warnings.push(`Large inter-guild queue: ${this.stats.interGuild.queueSize} messages`);
        }
        if (this.stats.interGuild.droppedMessages > 10) {
            health.issues.push(`Messages being dropped: ${this.stats.interGuild.droppedMessages}`);
            health.overall = 'warning';
        }

        // Check performance
        if (this.stats.performance.slowOperations > this.stats.performance.totalOperations * 0.1) {
            health.warnings.push(`Many slow operations: ${this.stats.performance.slowOperations}/${this.stats.performance.totalOperations}`);
        }

        if (health.issues.length > 2) {
            health.overall = 'critical';
        }

        return health;
    }

    /**
     * Reset statistics
     */
    resetStatistics() {
        const startTime = this.stats.system.startTime;
        
        this.stats = {
            system: {
                startTime: startTime,
                uptime: 0,
                memoryUsage: {},
                cpuUsage: 0
            },
            minecraft: {
                connectionsTotal: 0,
                connectionsActive: 0,
                messagesProcessed: 0,
                eventsProcessed: 0,
                reconnections: 0,
                errors: 0
            },
            interGuild: {
                messagesTransferred: 0,
                eventsTransferred: 0,
                rateLimitHits: 0,
                queueSize: 0,
                droppedMessages: 0,
                errors: 0
            },
            performance: {
                slowOperations: 0,
                averageProcessingTime: 0,
                peakMemoryUsage: 0,
                totalOperations: 0
            }
        };

        this.operationTimes = [];
        logger.info('📊 System statistics reset');
    }

    /**
     * Get monitoring configuration
     * @returns {object} Current monitoring configuration
     */
    getConfig() {
        return { ...this.monitoringConfig };
    }

    /**
     * Update monitoring configuration
     * @param {object} newConfig - New configuration
     */
    updateConfig(newConfig) {
        const wasMonitoring = this.isMonitoring;
        
        if (wasMonitoring) {
            this.stopMonitoring();
        }

        this.monitoringConfig = { ...this.monitoringConfig, ...newConfig };
        this.slowOperationThreshold = this.monitoringConfig.slowOperationThreshold || 1000;

        if (this.monitoringConfig.enablePerformanceMonitoring && wasMonitoring) {
            this.startMonitoring();
        }

        logger.debug('System monitor configuration updated');
    }
}

module.exports = SystemMonitor;