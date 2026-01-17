import winston from "winston";
import path from "path";

const { combine, timestamp, printf, colorize, errors } = winston.format;

// Custom log format
const logFormat = printf(({ level, message, timestamp, stack, ...meta }) => {
	const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : "";
	if (stack) {
		return `${timestamp} [${level}] ${message}\n${stack}${metaStr}`;
	}
	return `${timestamp} [${level}] ${message}${metaStr}`;
});

// Console format with colors
const consoleFormat = combine(
	colorize({ all: true }),
	timestamp({ format: "HH:mm:ss" }),
	errors({ stack: true }),
	logFormat
);

// File format (no colors, full timestamp)
const fileFormat = combine(
	timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
	errors({ stack: true }),
	logFormat
);

// Log directory
const LOG_DIR = path.join(process.cwd(), "logs");

// Create logger instance
export const logger = winston.createLogger({
	level: process.env.LOG_LEVEL || "info",
	transports: [
		// Console output
		new winston.transports.Console({
			format: consoleFormat,
		}),
		// Combined log file
		new winston.transports.File({
			filename: path.join(LOG_DIR, "combined.log"),
			format: fileFormat,
			maxsize: 5 * 1024 * 1024, // 5MB
			maxFiles: 5,
		}),
		// Error log file
		new winston.transports.File({
			filename: path.join(LOG_DIR, "error.log"),
			level: "error",
			format: fileFormat,
			maxsize: 5 * 1024 * 1024, // 5MB
			maxFiles: 5,
		}),
	],
});

export function createLogger(module: string) {
	return logger.child({ module });
}

export type LogLevel = "error" | "warn" | "info" | "http" | "verbose" | "debug" | "silly";
