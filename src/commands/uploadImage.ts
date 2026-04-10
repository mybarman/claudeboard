import * as vscode from 'vscode';
import { ClipboardService, ImageData } from '../services/clipboard';
import { FileManagerService, ImageFile } from '../services/fileManager';
import { ProgressService, ProgressPatterns, ProgressSteps } from '../services/progress';
import { ConfigurationService } from '../services/configuration';
import { Logger } from '../services/logging';
import { Result, success, failure, ExtensionResult, ClipboardError, FileSystemError } from '../common/result';

export type InsertDestination = 'editor' | 'terminal';

export interface UploadImageCommand {
    execute(destination: InsertDestination): Promise<ExtensionResult<string>>;
}

export interface CommandDependencies {
    clipboard: ClipboardService;
    fileManager: FileManagerService;
    progress: ProgressService;
    config: ConfigurationService;
    logger: Logger;
}

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function asBracketedPaste(text: string): string {
    return `\x1b[200~${text}\x1b[201~`;
}

async function pasteTextIntoActiveTerminal(text: string, logger: Logger): Promise<ExtensionResult<void>> {
    const activeTerminal = vscode.window.activeTerminal;
    if (!activeTerminal) {
        logger.error('No active terminal available for insertion');
        return failure(new FileSystemError('No active terminal available'));
    }

    try {
        logger.info('Attempting terminal insertion', {
            textLength: text.length,
            terminalName: activeTerminal.name
        });
        activeTerminal.show(false);
        await vscode.commands.executeCommand('workbench.action.terminal.focus');
        await delay(100);
        await vscode.env.clipboard.writeText(text);
        await vscode.commands.executeCommand('workbench.action.terminal.paste');
        logger.info('VS Code terminal paste command completed', {
            textLength: text.length
        });
        vscode.window.showInformationMessage('Claudeboard Local: attempted VS Code terminal paste command');
        return success(undefined);
    } catch (pasteCommandError) {
        logger.warn('VS Code terminal paste command failed', { pasteCommandError });
        try {
            activeTerminal.sendText(asBracketedPaste(text), false);
            logger.warn('Bracketed paste sendText fallback completed', {
                textLength: text.length
            });
            vscode.window.showWarningMessage('Claudeboard Local: terminal paste command failed; used bracketed sendText fallback');
            return success(undefined);
        } catch (bracketedPasteError) {
            await vscode.env.clipboard.writeText(text);
            logger.error('Terminal paste and bracketed sendText both failed', {
                pasteCommandError,
                bracketedPasteError,
                textLength: text.length
            });
            return failure(new FileSystemError(
                'Failed to insert image URL into terminal. The path was copied to the clipboard; press Cmd+V/Ctrl+V in the terminal.',
                { pasteCommandError, bracketedPasteError, text }
            ));
        }
    }
}

class ImageUploadCommand implements UploadImageCommand {
    constructor(private readonly deps: CommandDependencies) {}

    async execute(destination: InsertDestination): Promise<ExtensionResult<string>> {
        this.deps.logger.info('Upload command started', {
            destination,
            remoteName: vscode.env.remoteName
        });
        // Validate remote connection first
        const remoteCheck = this.validateRemoteConnection();
        if (Result.isFailure(remoteCheck)) {
            this.deps.logger.error('Remote validation failed', {
                destination,
                error: remoteCheck.error
            });
            return remoteCheck;
        }

        return await this.deps.progress.withSequentialProgress(
            ProgressPatterns.IMAGE_UPLOAD_WORKFLOW,
            [
                () => this.checkClipboard(),
                (reporter) => this.uploadAndInsert(destination, reporter)
            ]
        );
    }

    private validateRemoteConnection(): ExtensionResult<void> {
        if (!vscode.env.remoteName) {
            return failure(new ClipboardError(
                'No remote connection detected. Please connect to a server using Remote-SSH to upload images.',
                { remoteName: vscode.env.remoteName }
            ));
        }
        return success(undefined);
    }

    private async checkClipboard(): Promise<ExtensionResult<ImageData>> {
        try {
            const hasImage = await this.deps.clipboard.hasImage().catch(error => {
                this.deps.logger.debug('hasImage probe failed before getImage', { error });
                return false;
            });
            this.deps.logger.info('Clipboard probe before getImage', { hasImage });
            const imageData = await this.deps.clipboard.getImage();
            
            if (!imageData) {
                this.deps.logger.warn('getImage returned null');
                return failure(new ClipboardError('No image found in clipboard'));
            }

            this.deps.logger.info('Clipboard image retrieved', {
                format: imageData.format,
                bytes: imageData.buffer.length
            });
            return success(imageData);
        } catch (error) {
            this.deps.logger.error('Clipboard access failed', { error });
            return failure(new ClipboardError(
                'Failed to access clipboard',
                { originalError: error }
            ));
        }
    }

    private async uploadAndInsert(
        destination: InsertDestination,
        reporter: any
    ): Promise<ExtensionResult<string>> {
        reporter.report(ProgressSteps.preparing());
        this.deps.logger.debug('Upload and insert start', { destination });

        try {
            // Get image from previous step's result - this is a simplified approach
            // In a more complex implementation, we'd pass results between steps
            const imageData = await this.deps.clipboard.getImage();
            if (!imageData) {
                this.deps.logger.warn('Image disappeared between clipboard check and upload');
                return failure(new ClipboardError('Image no longer available in clipboard'));
            }

            // Cleanup old images based on user configuration
            const retentionDays = this.deps.config.getRetentionDays();
            this.deps.logger.debug('Cleaning old images', { retentionDays });
            await this.deps.fileManager.cleanupOldImages(retentionDays);

            reporter.report(ProgressSteps.uploading());

            // Create image file
            const imageFile = await this.deps.fileManager.createImageFile(
                imageData.buffer,
                imageData.format
            );
            this.deps.logger.info('Image file created', {
                imagePath: imageFile.getPath(),
                format: imageData.format,
                bytes: imageData.buffer.length
            });

            reporter.report(ProgressSteps.inserting());

            // Insert URL into editor/terminal
            const insertResult = await this.insertImageUrl(imageFile.getPath(), destination);
            if (Result.isFailure(insertResult)) {
                this.deps.logger.error('Insertion failed after file creation', {
                    destination,
                    imagePath: imageFile.getPath(),
                    error: insertResult.error
                });
                imageFile.dispose();
                return insertResult;
            }

            reporter.report(ProgressSteps.cleaning());

            // Clear clipboard if configured to do so
            if (this.deps.config.getClearClipboardAfterUpload()) {
                await this.deps.clipboard.clear();
                this.deps.logger.debug('Clipboard cleared after upload');
            }

            const imageUrl = imageFile.getPath();
            
            // Show success message
            vscode.window.showInformationMessage(`Image uploaded: ${imageUrl}`);
            this.deps.logger.info('Upload command completed successfully', {
                destination,
                imageUrl
            });

            return success(imageUrl);

        } catch (error) {
            this.deps.logger.error('Upload and insert threw', { error, destination });
            return failure(new FileSystemError(
                'Failed to upload image',
                { originalError: error, destination }
            ));
        }
    }

    private async insertImageUrl(url: string, destination: InsertDestination): Promise<ExtensionResult<void>> {
        try {
            if (destination === 'editor') {
                const activeEditor = vscode.window.activeTextEditor;
                if (!activeEditor) {
                    return failure(new FileSystemError('No active editor available'));
                }

                const position = activeEditor.selection.active;
                await activeEditor.edit(editBuilder => {
                    editBuilder.insert(position, url);
                });
                this.deps.logger.info('Inserted image path into editor', { url });
            } else if (destination === 'terminal') {
                return await pasteTextIntoActiveTerminal(url, this.deps.logger);
            }

            return success(undefined);
        } catch (error) {
            return failure(new FileSystemError(
                `Failed to insert image URL into ${destination}`,
                { originalError: error, destination, url }
            ));
        }
    }
}

// Optimized version that passes results between steps
class OptimizedImageUploadCommand implements UploadImageCommand {
    constructor(private readonly deps: CommandDependencies) {}

    async execute(destination: InsertDestination): Promise<ExtensionResult<string>> {
        this.deps.logger.info('Optimized upload command started', {
            destination,
            remoteName: vscode.env.remoteName
        });
        // Validate remote connection first
        const remoteCheck = this.validateRemoteConnection();
        if (Result.isFailure(remoteCheck)) {
            this.deps.logger.error('Remote validation failed', {
                destination,
                error: remoteCheck.error
            });
            return remoteCheck;
        }

        // Step 1: Check clipboard
        const clipboardResult = await this.deps.progress.withProgress(
            "Checking clipboard...",
            () => this.checkClipboard()
        );

        if (Result.isFailure(clipboardResult)) {
            this.deps.logger.warn('Clipboard check failed in optimized command', {
                destination,
                error: clipboardResult.error
            });
            vscode.window.showWarningMessage(clipboardResult.error.message);
            return clipboardResult;
        }

        // Step 2: Upload and insert
        return await this.deps.progress.withProgress(
            `Uploading image to Server...`,
            (reporter) => this.uploadAndInsert(clipboardResult.data, destination, reporter)
        );
    }

    private validateRemoteConnection(): ExtensionResult<void> {
        if (!vscode.env.remoteName) {
            return failure(new ClipboardError(
                'No remote connection detected. Please connect to a server using Remote-SSH to upload images.',
                { remoteName: vscode.env.remoteName }
            ));
        }
        return success(undefined);
    }

    private async checkClipboard(): Promise<ExtensionResult<ImageData>> {
        try {
            const hasImage = await this.deps.clipboard.hasImage().catch(error => {
                this.deps.logger.debug('hasImage probe failed before getImage', { error });
                return false;
            });
            this.deps.logger.info('Clipboard probe before getImage', { hasImage });
            const imageData = await this.deps.clipboard.getImage();
            
            if (!imageData) {
                this.deps.logger.warn('getImage returned null');
                return failure(new ClipboardError('No image found in clipboard'));
            }

            this.deps.logger.info('Clipboard image retrieved', {
                format: imageData.format,
                bytes: imageData.buffer.length
            });
            return success(imageData);
        } catch (error) {
            this.deps.logger.error('Clipboard access failed', { error });
            return failure(new ClipboardError(
                'Failed to access clipboard',
                { originalError: error }
            ));
        }
    }

    private async uploadAndInsert(
        imageData: ImageData,
        destination: InsertDestination,
        reporter: any
    ): Promise<ExtensionResult<string>> {
        try {
            reporter.report(ProgressSteps.preparing());
            this.deps.logger.debug('Optimized upload and insert start', {
                destination,
                format: imageData.format,
                bytes: imageData.buffer.length
            });

            // Cleanup old images first based on user configuration
            const retentionDays = this.deps.config.getRetentionDays();
            this.deps.logger.debug('Cleaning old images', { retentionDays });
            await this.deps.fileManager.cleanupOldImages(retentionDays);

            reporter.report(ProgressSteps.uploading());

            // Create image file
            const imageFile = await this.deps.fileManager.createImageFile(
                imageData.buffer,
                imageData.format
            );
            this.deps.logger.info('Image file created', {
                imagePath: imageFile.getPath(),
                format: imageData.format,
                bytes: imageData.buffer.length
            });

            reporter.report(ProgressSteps.inserting());

            // Insert URL into editor/terminal
            const insertResult = await this.insertImageUrl(imageFile.getPath(), destination);
            if (Result.isFailure(insertResult)) {
                this.deps.logger.error('Insertion failed after file creation', {
                    destination,
                    imagePath: imageFile.getPath(),
                    error: insertResult.error
                });
                imageFile.dispose();
                return insertResult;
            }

            reporter.report(ProgressSteps.cleaning());

            // Clear clipboard if configured to do so
            if (this.deps.config.getClearClipboardAfterUpload()) {
                await this.deps.clipboard.clear();
                this.deps.logger.debug('Clipboard cleared after upload');
            }

            const imageUrl = imageFile.getPath();
            
            // Show success message
            vscode.window.showInformationMessage(`Image uploaded: ${imageUrl}`);
            this.deps.logger.info('Optimized upload command completed successfully', {
                destination,
                imageUrl
            });

            return success(imageUrl);

        } catch (error) {
            this.deps.logger.error('Optimized upload and insert threw', { error, destination });
            return failure(new FileSystemError(
                'Failed to upload image',
                { originalError: error, destination }
            ));
        }
    }

    private async insertImageUrl(url: string, destination: InsertDestination): Promise<ExtensionResult<void>> {
        try {
            if (destination === 'editor') {
                const activeEditor = vscode.window.activeTextEditor;
                if (!activeEditor) {
                    return failure(new FileSystemError('No active editor available'));
                }

                const position = activeEditor.selection.active;
                await activeEditor.edit(editBuilder => {
                    editBuilder.insert(position, url);
                });
                this.deps.logger.info('Inserted image path into editor', { url });
            } else if (destination === 'terminal') {
                return await pasteTextIntoActiveTerminal(url, this.deps.logger);
            }

            return success(undefined);
        } catch (error) {
            return failure(new FileSystemError(
                `Failed to insert image URL into ${destination}`,
                { originalError: error, destination, url }
            ));
        }
    }
}

// Factory function
export function createUploadImageCommand(deps: CommandDependencies): UploadImageCommand {
    return new OptimizedImageUploadCommand(deps);
}

// Command handler for VS Code commands
export async function handleUploadCommand(
    destination: InsertDestination,
    deps: CommandDependencies
): Promise<void> {
    const command = createUploadImageCommand(deps);
    const result = await command.execute(destination);

    if (Result.isFailure(result)) {
        deps.logger.error('Command handler returning failure', {
            destination,
            error: result.error
        });
        deps.logger.show(true);
        vscode.window.showErrorMessage(`Upload error: ${result.error.message}`);
        return;
    }

    deps.logger.info('Command handler returning success', {
        destination,
        imageUrl: result.data
    });
}
