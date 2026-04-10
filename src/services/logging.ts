import * as vscode from 'vscode';

export interface Logger {
    debug(message: string, context?: Record<string, unknown>): void;
    info(message: string, context?: Record<string, unknown>): void;
    warn(message: string, context?: Record<string, unknown>): void;
    error(message: string, context?: Record<string, unknown>): void;
    show(preserveFocus?: boolean): void;
}

class OutputChannelLogger implements Logger {
    constructor(private readonly channel: vscode.OutputChannel) {}

    debug(message: string, context?: Record<string, unknown>): void {
        this.append('DEBUG', message, context);
    }

    info(message: string, context?: Record<string, unknown>): void {
        this.append('INFO', message, context);
    }

    warn(message: string, context?: Record<string, unknown>): void {
        this.append('WARN', message, context);
    }

    error(message: string, context?: Record<string, unknown>): void {
        this.append('ERROR', message, context);
    }

    show(preserveFocus?: boolean): void {
        this.channel.show(preserveFocus);
    }

    private append(level: string, message: string, context?: Record<string, unknown>): void {
        const timestamp = new Date().toISOString();
        const suffix = context ? ` ${safeStringify(context)}` : '';
        this.channel.appendLine(`[${timestamp}] [${level}] ${message}${suffix}`);
    }
}

function safeStringify(value: unknown): string {
    try {
        return JSON.stringify(value, replacer);
    } catch (error) {
        return JSON.stringify({
            stringifyError: error instanceof Error ? error.message : String(error)
        });
    }
}

function replacer(_key: string, value: unknown): unknown {
    if (value instanceof Error) {
        return {
            name: value.name,
            message: value.message,
            stack: value.stack
        };
    }

    if (typeof value === 'bigint') {
        return value.toString();
    }

    return value;
}

export function createLogger(): Logger {
    const channel = vscode.window.createOutputChannel('Claudeboard Local');
    return new OutputChannelLogger(channel);
}
