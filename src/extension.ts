import * as vscode from 'vscode';
import { createClipboardService } from './services/clipboard';
import { createFileManager } from './services/fileManager';
import { createProgressService } from './services/progress';
import { createConfigurationService } from './services/configuration';
import { createLogger } from './services/logging';
import { handleUploadCommand, CommandDependencies, InsertDestination } from './commands/uploadImage';

// Main extension entry point
export function activate(context: vscode.ExtensionContext): void {
    // Initialize services
    const logger = createLogger();
    const clipboard = createClipboardService(logger);
    const fileManager = createFileManager();
    const progress = createProgressService();
    const config = createConfigurationService();

    const dependencies: CommandDependencies = {
        clipboard,
        fileManager,
        progress,
        config,
        logger
    };

    // Register commands
    const commands = [
        {
            id: 'imageUploader.uploadFromClipboard.editor',
            destination: 'editor' as InsertDestination
        },
        {
            id: 'imageUploader.uploadFromClipboard.terminal',
            destination: 'terminal' as InsertDestination
        }
    ];

    const disposables = commands.map(({ id, destination }) =>
        vscode.commands.registerCommand(id, () => 
            handleUploadCommand(destination, dependencies)
        )
    );

    // Register configuration change handler
    const configDisposable = config.onConfigurationChanged((newConfig) => {
        logger.info('Extension configuration updated', { newConfig });
        // Here you could update services that depend on configuration
    });

    // Add all disposables to context
    context.subscriptions.push(...disposables, configDisposable);

    // Warm up clipboard service for better first-use experience
    clipboard.warmUp().catch(() => {
        // Silently fail - warming up is best effort
    });

    logger.info('Claudeboard extension activated', {
        extensionVersion: context.extension.packageJSON.version,
        processPlatform: process.platform,
        remoteName: vscode.env.remoteName
    });
}

export function deactivate(): void {
    console.log('Claudeboard extension deactivated');
}
