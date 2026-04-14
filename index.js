import {
    eventSource,
    event_types,
    getRequestHeaders,
    saveSettingsDebounced,
} from "../../../../script.js";
import { getContext, extension_settings } from "../../../extensions.js";
import { user_avatar } from "../../../personas.js";
import { sendExpressionCall, getExpressionLabel, lastExpression } from "../../expressions/index.js";
import { debounce } from "../../../utils.js";
import { debounce_timeout } from "../../../constants.js";
import { SlashCommandParser } from "../../../slash-commands/SlashCommandParser.js";
import { SlashCommand } from "../../../slash-commands/SlashCommand.js";
import { ARGUMENT_TYPE, SlashCommandArgument } from "../../../slash-commands/SlashCommandArgument.js";
import { initStreaming, queueForStreaming, isCurrentlyStreaming, cancelStreaming } from "./streaming.js";

// Module name for logging
const MODULE_NAME = 'user-expressions';

// Extension path for templates
const extension_path = `scripts/extensions/third-party/${MODULE_NAME}`;

// Log levels
const LOG_LEVELS = {
    ERROR: 0,
    WARN: 1,
    INFO: 2,
    DEBUG: 3,
    VERBOSE: 4
};

/**
 * Debug logging utility
 * Usage: log(level, message, ...args)
 * Set extension_settings.userExpressions.logLevel to control output
 */
function log(level, message, ...args) {
    const settings = extension_settings.userExpressions || {};
    const currentLevel = settings.logLevel !== undefined ? settings.logLevel : LOG_LEVELS.INFO;
    
    if (level > currentLevel) return;
    
    const levelNames = ['ERROR', 'WARN', 'INFO', 'DEBUG', 'VERBOSE'];
    const prefix = `[${MODULE_NAME}] [${levelNames[level]}]`;
    
    switch (level) {
        case LOG_LEVELS.ERROR:
            console.error(prefix, message, ...args);
            break;
        case LOG_LEVELS.WARN:
            console.warn(prefix, message, ...args);
            break;
        case LOG_LEVELS.INFO:
        case LOG_LEVELS.DEBUG:
        case LOG_LEVELS.VERBOSE:
        default:
            console.log(prefix, message, ...args);
            break;
    }
}

// Convenience methods for logging
const logger = {
    error: (msg, ...args) => log(LOG_LEVELS.ERROR, msg, ...args),
    warn: (msg, ...args) => log(LOG_LEVELS.WARN, msg, ...args),
    info: (msg, ...args) => log(LOG_LEVELS.INFO, msg, ...args),
    debug: (msg, ...args) => log(LOG_LEVELS.DEBUG, msg, ...args),
    verbose: (msg, ...args) => log(LOG_LEVELS.VERBOSE, msg, ...args)
};

// Default settings
const DEFAULT_SETTINGS = {
    enabled: true,
    showInChat: true,
    autoUpdate: true,
    logLevel: LOG_LEVELS.INFO,
    personaFolderMap: {},
    currentExpression: {},
    simulateStreaming: false,
    streamSpeed: 50
};

// State
let spriteCache = {};
let lastUserMessage = null;
let isProcessing = false;

/**
 * Initialize extension settings
 */
function initSettings() {
    if (!extension_settings.userExpressions) {
        extension_settings.userExpressions = { ...DEFAULT_SETTINGS };
    } else {
        // Merge with defaults for any missing keys
        extension_settings.userExpressions = {
            ...DEFAULT_SETTINGS,
            ...extension_settings.userExpressions
        };
    }
    logger.info('Settings initialized:', extension_settings.userExpressions);
}

/**
 * Get the folder name for a persona
 * Uses __user__ prefix to distinguish from characters
 */
function getPersonaFolderName(personaName) {
    if (!personaName) return null;
    // Sanitize the name to be filesystem-safe
    const sanitized = personaName.replace(/[^a-zA-Z0-9_-]/g, '_');
    return `__user__${sanitized}`;
}

/**
 * Get the currently active persona name
 */
function getCurrentPersonaName() {
    const context = getContext();
    // Get persona name from the personas system
    return context.name1 || 'Default';
}

/**
 * Get the current persona's folder name
 */
function getCurrentPersonaFolder() {
    const personaName = getCurrentPersonaName();
    return getPersonaFolderName(personaName);
}

/**
 * Fetch the list of sprites for a persona
 */
async function getSpritesList(folderName) {
    if (!folderName) return [];
    
    logger.debug('Fetching sprites for folder:', folderName);
    
    try {
        const result = await fetch(`/api/sprites/get?name=${encodeURIComponent(folderName)}`);
        if (!result.ok) {
            logger.warn('Failed to fetch sprites:', result.status);
            return [];
        }
        
        const sprites = await result.json();
        logger.verbose('Fetched sprites:', sprites);
        
        // Group sprites by label
        const grouped = sprites.reduce((acc, sprite) => {
            const fileName = sprite.path.split('/').pop().split('?')[0];
            const fileNameWithoutExtension = fileName.replace(/\.[^/.]+$/, '');
            const label = fileNameWithoutExtension.match(/^(.+?)(?:[-\\.].*?)?$/)?.[1] || fileNameWithoutExtension;
            
            if (!acc[label]) {
                acc[label] = [];
            }
            acc[label].push({
                path: sprite.path,
                fileName: fileName,
                label: label
            });
            return acc;
        }, {});
        
        return Object.entries(grouped).map(([label, files]) => ({
            label,
            files
        }));
    } catch (error) {
        logger.error('Error fetching sprites:', error);
        return [];
    }
}

/**
 * Upload a sprite for the current persona
 */
async function uploadSprite(file, label) {
    const folderName = getCurrentPersonaFolder();
    if (!folderName) {
        logger.error('No persona folder available');
        return false;
    }
    
    logger.info('Uploading sprite:', { folder: folderName, label, file: file.name });
    
    try {
        const formData = new FormData();
        formData.append('name', folderName);
        formData.append('label', label);
        formData.append('avatar', file);
        formData.append('spriteName', label);
        
        const result = await fetch('/api/sprites/upload', {
            method: 'POST',
            headers: getRequestHeaders({ omitContentType: true }),
            body: formData,
            cache: 'no-cache'
        });
        
        if (!result.ok) {
            logger.error('Upload failed:', result.status);
            return false;
        }
        
        const data = await result.json();
        logger.info('Upload successful:', data);
        
        // Clear cache for this folder
        delete spriteCache[folderName];
        
        return true;
    } catch (error) {
        logger.error('Error uploading sprite:', error);
        return false;
    }
}

/**
 * Delete a sprite
 */
async function deleteSprite(label, fileName) {
    const folderName = getCurrentPersonaFolder();
    if (!folderName) {
        logger.error('No persona folder available');
        return false;
    }
    
    logger.info('Deleting sprite:', { folder: folderName, label, fileName });
    
    try {
        const result = await fetch('/api/sprites/delete', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                name: folderName,
                label: label,
                spriteName: fileName.replace(/\.[^/.]+$/, '')
            })
        });
        
        if (!result.ok) {
            logger.error('Delete failed:', result.status);
            return false;
        }
        
        // Clear cache for this folder
        delete spriteCache[folderName];
        
        logger.info('Delete successful');
        return true;
    } catch (error) {
        logger.error('Error deleting sprite:', error);
        return false;
    }
}

/**
 * Set expression for the current user persona
 * Uses the expressions extension's sendExpressionCall
 */
async function setUserExpression(expression) {
    const folderName = getCurrentPersonaFolder();
    if (!folderName) {
        logger.warn('Cannot set expression: no persona folder');
        return;
    }
    
    logger.debug('Setting user expression:', { folder: folderName, expression });
    
    try {
        await sendExpressionCall(folderName, expression, { force: true });
        
        // Store the current expression
        const settings = extension_settings.userExpressions;
        settings.currentExpression[folderName] = expression;
        saveSettingsDebounced();
        
        logger.info('User expression set:', expression);
    } catch (error) {
        logger.error('Error setting user expression:', error);
    }
}

/**
 * Handle a new user message - classify and update expression
 */
async function handleUserMessage(messageText) {
    const settings = extension_settings.userExpressions;
    if (!settings.enabled || !settings.autoUpdate) {
        logger.verbose('Skipping expression update (disabled or auto-update off)');
        return;
    }
    
    if (isProcessing) {
        logger.debug('Already processing, skipping');
        return;
    }
    
    if (!messageText || messageText === lastUserMessage) {
        logger.debug('No new message to process');
        return;
    }
    
    isProcessing = true;
    lastUserMessage = messageText;
    
    try {
        logger.debug('Classifying user message:', messageText.substring(0, 50) + '...');
        const expression = await getExpressionLabel(messageText);
        logger.info('Classified expression:', expression);
        
        await setUserExpression(expression);
    } catch (error) {
        logger.error('Error classifying/processing message:', error);
    } finally {
        isProcessing = false;
    }
}

/**
 * Get the last user expression for the current persona
 */
function getCurrentExpression() {
    const folderName = getCurrentPersonaFolder();
    if (!folderName) return null;
    
    // Check our stored current expression first
    const settings = extension_settings.userExpressions;
    if (settings.currentExpression[folderName]) {
        return settings.currentExpression[folderName];
    }
    
    // Fall back to the expressions extension's tracking
    // Note: sendExpressionCall stores in lastExpression[folderName.split('/')[0]]
    const baseName = folderName.split('/')[0];
    return lastExpression[baseName] || null;
}

/**
 * Update the UI to show current persona and expressions
 */
async function updateUI() {
    const settings = extension_settings.userExpressions;
    const personaName = getCurrentPersonaName();
    const folderName = getCurrentPersonaFolder();
    
    logger.debug('Updating UI for persona:', personaName);
    
    // Update persona name display
    const personaInfo = document.querySelector('#user-expressions-persona-info .persona-name');
    if (personaInfo) {
        personaInfo.textContent = personaName;
    }
    
    // Update current expression preview
    const currentExpression = getCurrentExpression();
    const previewContainer = document.getElementById('user-expressions-current-preview');
    const previewImg = previewContainer?.querySelector('img');
    
    if (previewContainer && previewImg && currentExpression && folderName) {
        // Fetch sprites to get the image path
        if (!spriteCache[folderName]) {
            spriteCache[folderName] = await getSpritesList(folderName);
        }
        
        const expressionData = spriteCache[folderName]?.find(e => e.label === currentExpression);
        if (expressionData?.files?.length > 0) {
            previewImg.src = expressionData.files[0].path;
            previewContainer.classList.remove('hidden');
        } else {
            previewContainer.classList.add('hidden');
        }
    } else if (previewContainer) {
        previewContainer.classList.add('hidden');
    }
    
    // Update sprite list
    await updateSpriteList();
}

/**
 * Update the sprite list in the UI
 */
async function updateSpriteList() {
    const folderName = getCurrentPersonaFolder();
    const container = document.getElementById('user-expressions-sprite-list');
    if (!container) return;

    if (!folderName) {
        container.innerHTML = '<div class="no-sprites-message">No persona selected.</div>';
        return;
    }

    // Fetch sprites
    if (!spriteCache[folderName]) {
        spriteCache[folderName] = await getSpritesList(folderName);
    }

    const sprites = spriteCache[folderName];
    const currentExpression = getCurrentExpression();

    if (!sprites || sprites.length === 0) {
        container.innerHTML = '<div class="no-sprites-message">No sprites uploaded yet. Upload expressions to get started!</div>';
        return;
    }

    // Build sprite list HTML using templates
    const listItemTemplate = await $.get(`${extension_path}/list-item.html`);
    const listItems = sprites.map((sprite) => {
        const isActive = sprite.label === currentExpression;
        const thumbSrc = sprite.files[0]?.path || '/img/No-Image-Placeholder.svg';
        const fileName = sprite.files[0]?.fileName || sprite.label;

        // Simple variable substitution - Handle the {{#if isActive}}active{{/if}} pattern
        return listItemTemplate
            .replace(/\{\{#if isActive\}\}active\{\{\/if\}\}/g, isActive ? 'active' : '')
            .replace(/\{\{expression\}\}/g, sprite.label)
            .replace(/\{\{fileName\}\}/g, fileName)
            .replace(/\{\{imageSrc\}\}/g, thumbSrc);
    });

    container.innerHTML = listItems.join('');

    // Add click handlers for set buttons
    container.querySelectorAll('.expression_list_set').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const item = btn.closest('.user-expression-item');
            const expression = item.dataset.expression;
            await setUserExpression(expression);
            await updateUI();
        });
    });

    // Add click handlers for delete buttons
    container.querySelectorAll('.expression_list_delete').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const item = btn.closest('.user-expression-item');
            const expression = item.dataset.expression;
            const fileName = item.dataset.filename;

            if (confirm(`Delete expression "${expression}"?`)) {
                const success = await deleteSprite(expression, fileName);
                if (success) {
                    await updateUI();
                }
            }
        });
    });

    logger.verbose('Sprite list updated with', sprites.length, 'expressions');
}

/**
 * Handle file upload
 */
async function handleFileUpload(event) {
    const file = event.target.files[0];
    if (!file) return;
    
    // Extract expression name from filename
    const fileName = file.name.replace(/\.[^/.]+$/, '');
    const label = fileName.toLowerCase();
    
    logger.info('Uploading file:', file.name, 'as expression:', label);
    
    const success = await uploadSprite(file, label);
    if (success) {
        await updateUI();
        logger.info('Successfully uploaded:', label);
    } else {
        logger.error('Failed to upload:', label);
    }
    
    // Reset input
    event.target.value = '';
}

/**
 * Initialize settings panel
 */
async function initSettingsPanel() {
    const settingsHtml = await $.get(`${extension_path}/settings.html`);
    const container = document.getElementById('extensions_settings');
    if (!container) {
        logger.error('Settings container not found');
        return;
    }
    
    container.insertAdjacentHTML('beforeend', settingsHtml);
    
    const settings = extension_settings.userExpressions;
    
    // Set checkbox states
    document.getElementById('user-expressions-enabled').checked = settings.enabled;
    document.getElementById('user-expressions-show-in-chat').checked = settings.showInChat;
    document.getElementById('user-expressions-auto-update').checked = settings.autoUpdate;
    
    // Add event listeners
    document.getElementById('user-expressions-enabled').addEventListener('change', (e) => {
        settings.enabled = e.target.checked;
        saveSettingsDebounced();
        logger.info('Extension enabled:', settings.enabled);
    });
    
    document.getElementById('user-expressions-show-in-chat').addEventListener('change', (e) => {
        settings.showInChat = e.target.checked;
        saveSettingsDebounced();
        logger.info('Show in chat:', settings.showInChat);
    });
    
    document.getElementById('user-expressions-auto-update').addEventListener('change', (e) => {
        settings.autoUpdate = e.target.checked;
        saveSettingsDebounced();
        logger.info('Auto-update:', settings.autoUpdate);
    });

    // Streaming settings
    const streamingCheckbox = document.getElementById('user-expressions-simulate-streaming');
    const streamSpeedControl = document.getElementById('stream-speed-control');
    const streamSpeedSelect = document.getElementById('user-expressions-stream-speed');

    if (streamingCheckbox) {
        streamingCheckbox.checked = settings.simulateStreaming || false;
        streamingCheckbox.addEventListener('change', (e) => {
            settings.simulateStreaming = e.target.checked;
            saveSettingsDebounced();
            logger.info('Simulate streaming:', settings.simulateStreaming);
            // Show/hide stream speed control
            if (streamSpeedControl) {
                streamSpeedControl.classList.toggle('hidden', !e.target.checked);
            }
        });
    }

    if (streamSpeedSelect) {
        streamSpeedSelect.value = String(settings.streamSpeed || 50);
        streamSpeedSelect.addEventListener('change', (e) => {
            settings.streamSpeed = parseInt(e.target.value);
            saveSettingsDebounced();
            logger.info('Stream speed:', settings.streamSpeed);
        });
        // Show/hide based on current setting
        if (streamSpeedControl) {
            streamSpeedControl.classList.toggle('hidden', !settings.simulateStreaming);
        }
    }

    // Upload button
    document.getElementById('user-expressions-upload-btn').addEventListener('click', () => {
        document.getElementById('user-expressions-file-input').click();
    });
    
    document.getElementById('user-expressions-file-input').addEventListener('change', handleFileUpload);
    
    // Refresh button
    document.getElementById('user-expressions-refresh-btn').addEventListener('click', async () => {
        const folderName = getCurrentPersonaFolder();
        if (folderName) {
            delete spriteCache[folderName];
        }
        await updateUI();
        logger.info('Sprite list refreshed');
    });
    
    logger.info('Settings panel initialized');
}

/**
 * Main initialization
 */
async function init() {
    logger.info('Initializing User Expressions extension...');
    
    // Initialize settings
    initSettings();
    
    // Initialize settings panel
    await initSettingsPanel();
    
    // Listen for persona changes
    eventSource.on(event_types.PERSONA_CHANGED, async () => {
        logger.info('Persona changed, updating...');
        await updateUI();
    });
    
    // Listen for user message rendered
    eventSource.on(event_types.USER_MESSAGE_RENDERED, async (messageId) => {
        const context = getContext();
        const lastMessageId = context.chat.length - 1;
        
        // Only process if this is the last message (new message, not an edit)
        if (messageId !== lastMessageId) {
            logger.verbose('Skipping non-last message:', messageId, '!=', lastMessageId);
            return;
        }
        
        const message = context.chat[messageId];
        if (message && message.mes && message.is_user) {
            logger.debug('Processing last user message:', message.mes.substring(0, 50));
            await handleUserMessage(message.mes);
        }
    });
    
    // Listen for chat changes
    eventSource.on(event_types.CHAT_CHANGED, () => {
        logger.info('Chat changed, clearing state');
        lastUserMessage = null;
        isProcessing = false;
    });
    
    // Initial UI update
    await updateUI();
    
    // Register slash commands
    registerSlashCommands();
    
    // Initialize streaming module
    initStreaming(logger);

    // Expose function globally for streaming module
    window.updateUserExpression = async (expression) => {
        await setUserExpression(expression);
    };

    // Set up send interception for streaming simulation
    setupSendInterception();

    logger.info('User Expressions extension initialized successfully');
}

/**
 * Set up send button interception for streaming
 */
function setupSendInterception() {
    const sendButton = document.getElementById('send_but');
    const textarea = document.getElementById('send_textarea');

    if (!sendButton || !textarea) {
        logger.warn('Send button or textarea not found, streaming interception disabled');
        return;
    }

    // Store original click handler
    const originalOnClick = sendButton.onclick;

    // Override send button click
    sendButton.onclick = async (e) => {
        const settings = extension_settings.userExpressions;
        const messageText = textarea.value.trim();

        // Check if streaming is enabled and queue the message
        if (settings.simulateStreaming && messageText.length >= 5) {
            logger.info('Queueing message for streaming simulation');
            queueForStreaming(messageText);
        }

        // Always proceed with normal flow
        if (originalOnClick) {
            return originalOnClick.call(sendButton, e);
        }
    };

    // Also intercept Enter key in textarea
    textarea.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            const settings = extension_settings.userExpressions;
            const messageText = textarea.value.trim();

            // Check if streaming is enabled and queue the message
            if (settings.simulateStreaming && messageText.length >= 5) {
                logger.info('Queueing message for streaming simulation (Enter key)');
                queueForStreaming(messageText);
            }

            // Let normal flow continue
        }
    });

    logger.info('Send interception set up for streaming');
}

/**
 * Register slash commands
 */
function registerSlashCommands() {
    // Set user expression command
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'user-expression-set',
        aliases: ['usersprite', 'useremote'],
        callback: async (args, expression) => {
            if (!expression) {
                logger.warn('No expression provided');
                return '';
            }
            
            const trimmed = expression.trim().toLowerCase();
            logger.info('Setting user expression via slash command:', trimmed);
            
            await setUserExpression(trimmed);
            return trimmed;
        },
        unnamedArgumentList: [
            new SlashCommandArgument(
                'expression label to set', 
                [ARGUMENT_TYPE.STRING], 
                true
            ),
        ],
        helpString: 'Manually set the expression for the current user persona.',
        returns: 'The expression that was set'
    }));
    
    // Get current user expression command
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'user-expression-get',
        aliases: ['getuserexpression'],
        callback: async () => {
            const expression = getCurrentExpression();
            logger.info('Getting user expression via slash command:', expression);
            return expression || '';
        },
        helpString: 'Get the current expression for the user persona.',
        returns: 'The current expression label or empty string'
    }));
    
    // Refresh user expressions command
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'user-expression-refresh',
        aliases: ['refreshuserexpressions'],
        callback: async () => {
            logger.info('Refreshing user expressions via slash command');
            const folderName = getCurrentPersonaFolder();
            if (folderName) {
                delete spriteCache[folderName];
            }
            await updateUI();
            return 'User expressions refreshed';
        },
        helpString: 'Refresh the user expressions list.',
        returns: 'Success message'
    }));

    // Stop streaming command
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'stop-streaming',
        aliases: ['stopuserstream', 'cancelstream'],
        callback: async () => {
            if (isCurrentlyStreaming()) {
                cancelStreaming();
                return 'Streaming cancelled';
            }
            return 'No active streaming to cancel';
        },
        helpString: 'Stop/cancel the current user message streaming.',
        returns: 'Status message'
    }));

    logger.info('Slash commands registered');
}

// Initialize when DOM is ready
jQuery(async () => {
    try {
        await init();
    } catch (error) {
        logger.error('Failed to initialize extension:', error);
    }
});
