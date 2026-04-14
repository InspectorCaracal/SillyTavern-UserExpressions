/**
 * Streaming simulation module for User Expressions
 * Simulates streaming text rendering for user messages with expression classification
 */

import { eventSource, event_types, activateSendButtons, messageFormatting, saveChatDebounced } from "../../../../script.js";
import { getContext, extension_settings } from "../../../extensions.js";
import { getExpressionLabel } from "../../expressions/index.js";

// Module reference for logging
let logger = null;

// Streaming state
let isStreaming = false;
let streamingMessageId = null;
let streamInterval = null;
let pendingMessageText = null;
let originalStopHandler = null;

// Default settings
const DEFAULT_STREAM_SPEED = 50; // ms per character
const CLASSIFICATION_INTERVAL = 10000; // classify every N milliseconds (10 seconds, matching expressions extension)

/**
 * Initialize the streaming module
 * @param {object} loggerInstance - Logger instance from main module
 */
export function initStreaming(loggerInstance) {
    logger = loggerInstance;

    // Listen for user messages being rendered
    eventSource.on(event_types.USER_MESSAGE_RENDERED, async (messageId) => {
        const settings = extension_settings.userExpressions || {};

        if (!settings.simulateStreaming || !pendingMessageText) {
            return;
        }

        const context = getContext();
        const message = context.chat[messageId];

        // Only process if this is the last message and is a user message
        if (!message || !message.is_user || messageId !== context.chat.length - 1) {
            return;
        }

        // Don't stream short messages
        if (pendingMessageText.length < 5) {
            pendingMessageText = null;
            return;
        }

        logger.info('Starting streaming simulation for message:', pendingMessageText.substring(0, 50));

        // Start streaming on this message
        await startStreaming(messageId, pendingMessageText);

        pendingMessageText = null;
    });

    // Hook into the existing stop button
    hookStopButton();

    logger.info('Streaming module initialized');
}

/**
 * Get streaming settings
 */
function getSettings() {
    return extension_settings.userExpressions || {};
}

/**
 * Hook into the existing mes_stop button
 */
function hookStopButton() {
    const stopButton = document.getElementById('mes_stop');
    if (!stopButton) {
        logger?.warn('mes_stop button not found');
        return;
    }

    // Store the original click handler
    originalStopHandler = stopButton.onclick;

    // Override with our handler
    stopButton.onclick = (e) => {
        if (isStreaming) {
            // We're streaming, cancel it
            e.preventDefault();
            e.stopPropagation();
            cancelStreaming();
            return false;
        }
        
        // Not streaming, call original handler
        if (originalStopHandler) {
            return originalStopHandler.call(stopButton, e);
        }
    };

    logger?.debug('Stop button hooked');
}

/**
 * Update the displayed message text in the UI with markdown formatting
 */
function updateMessageDisplay(messageId, text) {
    const context = getContext();

    // Update in chat array
    if (context.chat[messageId]) {
        context.chat[messageId].mes = text;
    }

    // Update in DOM with proper markdown formatting
    const messageElement = document.querySelector(`[mesid="${messageId}"]`);
    if (messageElement) {
        const mesText = messageElement.querySelector('.mes_text');
        if (mesText) {
            const message = context.chat[messageId];
            if (message) {
                // Use messageFormatting to render markdown properly
                const formattedHtml = messageFormatting(
                    text,
                    message.name,
                    message.is_system,
                    message.is_user,
                    messageId
                );
                mesText.innerHTML = formattedHtml;
            } else {
                // Fallback for safety
                mesText.innerHTML = text.replace(/\n/g, '<br>');
            }
        }
    }
}

/**
 * Start streaming simulation for a message
 */
async function startStreaming(messageId, fullMessage) {
    const settings = getSettings();
    const streamSpeed = settings.streamSpeed || DEFAULT_STREAM_SPEED;
    const charsPerTick = Math.max(1, Math.floor(50 / streamSpeed));

    isStreaming = true;
    streamingMessageId = messageId;

    // Store the original full message text in the message's extra data
    const context = getContext();
    if (context.chat[messageId]) {
        context.chat[messageId].extra = context.chat[messageId].extra || {};
        context.chat[messageId].extra.originalFullText = fullMessage;
    }

    // Show the existing stop button (it should already be visible during generation)
    // We just need to make sure our hook is in place

    let currentText = '';
    let charIndex = 0;
    let lastClassificationTime = 0;

    return new Promise((resolve) => {
        streamInterval = setInterval(async () => {
            if (!isStreaming) {
                clearInterval(streamInterval);
                streamInterval = null;
                resolve(false);
                return;
            }

            // Add next chunk of characters
            const chunk = fullMessage.slice(charIndex, charIndex + charsPerTick);
            currentText += chunk;
            charIndex += chunk.length;

            // Update the displayed message
            updateMessageDisplay(messageId, currentText);

            // Classify expression periodically (time-based, matching expressions extension)
            const now = Date.now();
            if (now - lastClassificationTime >= CLASSIFICATION_INTERVAL && currentText.length > 10) {
                lastClassificationTime = now;
                try {
                    const expression = await getExpressionLabel(currentText);
                    if (expression && logger) {
                        logger.debug('Streaming classification:', expression);
                    }
                    // Trigger expression update
                    if (typeof window.updateUserExpression === 'function') {
                        window.updateUserExpression(expression);
                    }
                } catch (e) {
                    // Classification failures are non-fatal during streaming
                    logger?.verbose('Classification failed during stream:', e);
                }
            }

            // Check if done
            if (charIndex >= fullMessage.length) {
                clearInterval(streamInterval);
                streamInterval = null;

                // Final update with complete text
                updateMessageDisplay(messageId, fullMessage);

                isStreaming = false;

                logger.info('Streaming completed successfully');
                resolve(true);
            }
        }, streamSpeed);
    });
}

/**
 * Cancel current streaming
 * Saves the currently-visible portion of the message (like stopping generation)
 */
export function cancelStreaming() {
    if (!isStreaming) {
        return;
    }

    logger.info('Streaming cancelled by user');
    isStreaming = false;

    // Clear interval
    if (streamInterval) {
        clearInterval(streamInterval);
        streamInterval = null;
    }

    // Save the current partial message state (like stopping generation)
    const stoppedMessageId = streamingMessageId;
    if (stoppedMessageId !== null) {
        const context = getContext();
        const message = context.chat[stoppedMessageId];
        
        if (message) {
            // Mark as stopped streaming but keep the content
            message.extra = message.extra || {};
            message.extra.isStreaming = false;
            message.extra.streamingStopped = true;
            
            // The message.mes already contains the visible text
            // Just trigger a final render to ensure it's properly formatted
            const finalText = message.mes;
            updateMessageDisplay(stoppedMessageId, finalText);
            
            // Save the chat to persist the partial message
            saveChatDebounced();
            
            logger.info('Streaming stopped, saved message:', finalText.substring(0, 50));
        }

        streamingMessageId = null;
    }

    // Reset input and re-enable
    const textarea = document.getElementById('send_textarea');
    if (textarea) {
        textarea.disabled = false;
        textarea.value = '';
        textarea.focus();
    }

    pendingMessageText = null;

    // Activate send buttons to clear data-generating attribute and restore UI
    activateSendButtons();

    // Emit both events so all listeners are notified
    eventSource.emit(event_types.GENERATION_ENDED, stoppedMessageId);
    eventSource.emit(event_types.GENERATION_STOPPED);

    logger.info('Streaming stopped, message saved with partial content');
}

/**
 * Queue a message for streaming
 * Called before the message is sent
 * @param {string} messageText - The message text to stream
 */
export function queueForStreaming(messageText) {
    const settings = extension_settings.userExpressions || {};

    if (!settings.simulateStreaming) {
        return false;
    }

    if (messageText.length < 5) {
        return false;
    }

    pendingMessageText = messageText;
    logger.debug('Message queued for streaming:', messageText.substring(0, 50));
    return true;
}

/**
 * Check if currently streaming
 */
export function isCurrentlyStreaming() {
    return isStreaming;
}

/**
 * Get current streaming message ID
 */
export function getStreamingMessageId() {
    return streamingMessageId;
}