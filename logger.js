/**
 * logger.js
 *
 * Central winston logger. Logs to console (colorized, human-readable) and
 * to rotating-by-run files under logDir (logs/combined.log, logs/error.log)
 * for post-mortem debugging when running unattended (e.g. as a Windows
 * background process).
 */
const fs = require('fs');
const path = require('path');
const winston = require('winston');
const config = require('./config');

if (!fs.existsSync(config.logDir)) {
  fs.mkdirSync(config.logDir, { recursive: true });
}

const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.printf(({ timestamp, level, message, stack, ...meta }) => {
    const metaString = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    return `${timestamp} [${level.toUpperCase()}] ${stack || message}${metaString}`;
  }),
);

const logger = winston.createLogger({
  level: config.logLevel,
  format: logFormat,
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(winston.format.colorize(), logFormat),
    }),
    new winston.transports.File({
      filename: path.join(config.logDir, 'error.log'),
      level: 'error',
    }),
    new winston.transports.File({
      filename: path.join(config.logDir, 'combined.log'),
    }),
  ],
  exitOnError: false,
});

module.exports = logger;
