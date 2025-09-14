const fs = require('fs');
const path = require('path');
const FileLogger = require('./file-logger');

class Logger {
    constructor(config = {}) {
        this.config = {
            level: config.level || 'info',
            console: config.console !== false, // true by default
            file: config.file || false,
            ...config
        };
        
        // Log levels with priorities
        this.levels = {
            debug: 0,
            info: 1,
            perf: 1,
            warn: 2,
            error: 3,
        };
        
        this.currentLevel = this.levels[this.config.level] || 1;
        
        // Colors for console
        this.colors = {
            debug: '\x1b[36m',          // Cyan
            info: '\x1b[32m',           // Green
            warn: '\x1b[33m',           // Yellow
            error: '\x1b[31m',          // Red
            minecraft: '\x1b[35m',      // Magenta
            discord: '\x1b[34m',        // Blue
            bridge: '\x1b[96m',         // Light cyan
            perf: '\x1b[95;1m',  // Violet électrique (unique)
            reset: '\x1b[0m'
        };
        
        // Emojis for types
        this.emojis = {
            debug: '🔍',
            info: 'ℹ️',
            warn: '⚠️',
            error: '❌',
            minecraft: '🎮',
            discord: '💬',
            bridge: '🌉',
            perf: '⚡'
        };
        
        // Initialize file logger if needed
        this.fileLogger = null;
        if (this.config.file) {
            this.fileLogger = new FileLogger();
        }
    }
    
    // ========== Main methods ==========
    
    info(...args) {
        this.log('info', ...args);
    }
    
    warn(...args) {
        this.log('warn', ...args);
    }
    
    error(...args) {
        this.log('error', ...args);
    }
    
    debug(...args) {
        this.log('debug', ...args);
    }
    
    // ========== Specialized methods ==========
    
    minecraft(...args) {
        this.log('minecraft', ...args);
    }
    
    discord(...args) {
        this.log('discord', ...args);
    }
    
    bridge(...args) {
        this.log('bridge', ...args);
    }
    
    // ========== Main logging method ==========
    
    log(level, ...args) {
        // Check if level should be displayed
        const levelPriority = this.levels[level] !== undefined ? this.levels[level] : 1;
        if (levelPriority < this.currentLevel) {
            return;
        }
        
        const timestamp = this.getTimestamp();
        const levelString = level.toUpperCase().padEnd(13);
        const emoji = this.emojis[level] || '';
        
        // Build message
        let message = this.formatMessage(timestamp, levelString, emoji, ...args);
        let plainMessage = this.formatMessage(timestamp, levelString, '', ...args); // No colors for file
        
        // Console log
        if (this.config.console) {
            this.logToConsole(level, message);
        }
        
        // File log
        if (this.config.file && this.fileLogger) {
            this.fileLogger.write(level, plainMessage);
        }
    }
    
    // ========== Formatting ==========
    
    formatMessage(timestamp, level, emoji, ...args) {
        // Process arguments
        const formattedArgs = args.map(arg => {
            if (typeof arg === 'object') {
                return JSON.stringify(arg, null, 2);
            }
            return String(arg);
        }).join(' ');
        
        return `[${timestamp}] ${emoji}  ${level} ${formattedArgs}`;
    }
    
    logToConsole(level, message) {
        const color = this.colors[level] || this.colors.info;
        const coloredMessage = `${color}${message}${this.colors.reset}`;
        
        // Use console.error for errors and warnings
        if (level === 'error' || level === 'warn') {
            console.error(coloredMessage);
        } else {
            console.log(coloredMessage);
        }
    }
    
    getTimestamp() {
        const now = new Date();
        return now.toISOString().replace('T', ' ').substring(0, 19);
    }
    
    // ========== Level management ==========
    
    setLevel(level) {
        if (this.levels[level] !== undefined) {
            this.config.level = level;
            this.currentLevel = this.levels[level];
            this.info('Log level changed to:', level);
        } else {
            this.warn('Invalid log level:', level);
        }
    }
    
    getLevel() {
        return this.config.level;
    }
    
    // ========== Utility methods ==========
    
    logError(error, context = '') {
        const errorInfo = {
            message: error.message,
            stack: error.stack,
            context: context
        };
        
        this.error('Error occurred:', errorInfo);
    }
    
    logPerformance(label, startTime) {
        const duration = Date.now() - startTime;
        const message = `${label}: ${duration}ms`;

        // Appel direct au log principal avec le type 'perf'
        this.log('perf', message);
    }

    // Method for Minecraft connections
    logMinecraftConnection(guildId, username, status, details = {}) {
        const message = `[${guildId}] ${username} - ${status}`;
        
        if (status.includes('connected') || status.includes('success')) {
            this.minecraft('✅', message, details);
        } else if (status.includes('disconnected') || status.includes('error') || status.includes('failed')) {
            this.minecraft('❌', message, details);
        } else {
            this.minecraft('🔄', message, details);
        }
    }
    
    // Method for bridge messages
    logBridgeMessage(from, to, username, message) {
        this.bridge(`${from} → ${to} : `, `${username} : `, message);
    }
    
    // Method for Discord commands
    logDiscordCommand(userId, command, guildId = null) {
        const context = guildId ? `[Guild: ${guildId}]` : '';
        this.discord('Command executed:', `${command} by ${userId}`, context);
    }
}

module.exports = Logger;