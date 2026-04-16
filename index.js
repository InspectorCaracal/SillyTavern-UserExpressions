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

/**
 * Check if we're in Visual Novel mode
 * Matches the logic in expressions extension
 */
function isVisualNovelMode() {
    const context = getContext();
    return Boolean(!context.isMobile() && context.powerUserSettings?.waifuMode);
}

// Log levels
const LOG_LEVELS = {
    ERROR: 0,
    WARN: 1,
    INFO: 2,
    DEBUG: 3,
    VERBOSE: 4
};

const CURRENT_LOG_LEVEL = LOG_LEVELS.DEBUG;

/**
 * Debug logging utility
 * Usage: log(level, message, ...args)
 */
function log(level, message, ...args) {
    const settings = extension_settings.userExpressions || {};
    
    if (level > CURRENT_LOG_LEVEL) return;
    
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
    streamSpeed: 50,
    streamDelay: 0
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
 * Toggle between user and character expression based on last message
 */
function toggleExpressionVisibility() {
    const context = getContext();
    const lastMessage = context.chat[context.chat.length - 1];
    
    if (!lastMessage) return;
    
    const charHolder = document.getElementById('expression-holder');
    const regularUserHolder = document.querySelector('#user-expression-wrapper .user-expression-holder');
    const vnUserHolder = document.querySelector('#user-expression-vn-wrapper .user-expression-holder');
    
    if (isVisualNovelMode()) {
        // In VN mode, show VN holder, hide regular holder
        if (regularUserHolder) regularUserHolder.classList.add('hidden');
        if (vnUserHolder) {
            vnUserHolder.classList.remove('hidden');
            if (charHolder) charHolder.classList.remove('hidden');
            updateVNUserPosition();
        }
    } else {
        // In non-VN mode, show regular holder, hide VN holder
        if (vnUserHolder) vnUserHolder.classList.add('hidden');
        
        if (lastMessage.is_user) {
            // Last message is from user
            if (charHolder) charHolder.classList.add('hidden');
            if (regularUserHolder) regularUserHolder.classList.remove('hidden');
        } else {
            // Last message is from character
            if (charHolder) charHolder.classList.remove('hidden');
            if (regularUserHolder) regularUserHolder.classList.add('hidden');
        }
    }
}

/**
 * VN Mode positioning and management
 */
let vnObserver = null;

/**
 * Get z-index for user expression based on message recency (matching core logic)
 */
function calculateUserZIndex() {
    const context = getContext();
    const group = context.groups.find(x => x.id == context.groupId);
    if (!group) return 0;
    
    const filteredMembers = group.members.filter(x => !group.disabled_members.includes(x));
    const recentMessages = context.chat.map(x => x.original_avatar).filter(x => x).reverse().filter((v, i, a) => a.indexOf(v) === i);
    
    // Find user's position in recency
    const userAvatar = 'user-persona';
    const userRecentIndex = recentMessages.indexOf(userAvatar);
    
    // Build layer indices same as core
    const layerIndices = filteredMembers.slice().sort((a, b) => {
        const aRecentIndex = recentMessages.indexOf(a);
        const bRecentIndex = recentMessages.indexOf(b);
        const aFilteredIndex = filteredMembers.indexOf(a);
        const bFilteredIndex = filteredMembers.indexOf(b);
        
        if (aRecentIndex !== -1 && bRecentIndex !== -1) {
            return bRecentIndex - aRecentIndex;
        } else if (aRecentIndex !== -1) {
            return 1;
        } else if (bRecentIndex !== -1) {
            return -1;
        } else {
            return aFilteredIndex - bFilteredIndex;
        }
    });
    
    // User is treated as "most recent" if last message is from user
    const lastMessage = context.chat[context.chat.length - 1];
    if (lastMessage && lastMessage.is_user) {
        return layerIndices.length; // Put user on top
    }
    
    return layerIndices.indexOf(userAvatar);
}

/**
 * Calculate and set widths for VN mode containers
 * User sprite container gets width based on sprite size
 * VN wrapper gets remaining viewport space
 * Overlap is handled via negative margins, not container shrinking
 */
async function resizeVNContainers() {
    const userWrapper = $('#user-expression-vn-wrapper');
    const userHolder = $('#user-expression-vn-wrapper .user-expression-holder');
    const vnWrapper = $('#visual-novel-wrapper');

    if (!userWrapper.length || !userHolder.length || !vnWrapper.length) return;

    const viewportWidth = $(window).width();

    // Wait for user sprite image to load
    const userImg = userHolder.find('.user-expression-image')[0];
    if (userImg instanceof HTMLImageElement && !userImg.complete) {
        await new Promise(resolve => userImg.addEventListener('load', resolve, { once: true }));
    }

    // Get user sprite width after image is loaded
    const userWidth = userHolder.width();

    // Get character sprites and wait for their images to load
    const charSprites = vnWrapper.find('.expression-holder:not([data-user-expression="true"])');
    const charImages = charSprites.find('img.expression');

    // Wait for all character images to load
    await Promise.all(Array.from(charImages).map(img => {
        if (img instanceof HTMLImageElement && !img.complete) {
            return new Promise(resolve => img.addEventListener('load', resolve, { once: true }));
        }
        return Promise.resolve();
    }));

    // Wait for core extension's layout animation to complete (500ms + buffer)
    await new Promise(resolve => setTimeout(resolve, 600));

    // Get character sprite widths after images are loaded and positioned
    let totalCharWidth = 0;
    charSprites.each(function () {
        totalCharWidth += $(this).width();
        logger.debug(`Adding ${$(this).width()}, total character width so far is ${totalCharWidth}`);
    });

    // Calculate total needed width
    const totalNeeded = userWidth + totalCharWidth;

    // Set container widths to full sprite sizes
    let userContainerWidth = userWidth;
    let vnContainerWidth;

    // Calculate overlap for positioning
    let overlapOffset = 0;
    if (totalNeeded > viewportWidth) {
        const totalOverlap = totalNeeded - viewportWidth;
        // User sprite overlap amount
        const userOverlap = (userWidth / totalNeeded) * totalOverlap;
        overlapOffset = userOverlap; // Negative margin for overlap
    }
    logger.debug(`Offset is ${overlapOffset}, viewport is ${viewportWidth}, user width is ${userWidth}`);

    vnContainerWidth = (viewportWidth - userWidth) + overlapOffset;
    // Set container widths
    userWrapper.css('width', userContainerWidth + 'px');
    vnWrapper.css({
        'width': vnContainerWidth + 'px',
        'right': '0px',
        'position': 'fixed'
    });

    // Center user sprite in its container
    const userSprite = userHolder.find('.user-expression-image');
    const spriteWidth = userSprite.width() || userWidth;
    const centeredPosition = (userContainerWidth - spriteWidth) / 2;

    return {
        userWidth: userContainerWidth,
        vnWidth: vnContainerWidth,
        userPosition: centeredPosition,
        overlap: overlapOffset
    };
}

/**
 * Calculate position for user expression in VN mode
 */
function calculateVNUserPosition() {
    const userWrapper = $('#user-expression-vn-wrapper');
    const userHolder = $('#user-expression-vn-wrapper .user-expression-holder');
    
    if (!userWrapper.length || !userHolder.length) return null;
    
    // Get current dimensions
    const wrapperWidth = userWrapper.width();
    const userSprite = userHolder.find('.user-expression-image');
    const spriteWidth = userSprite.width() || userHolder.width();
    
    // Center the sprite in its container
    const userPosition = (wrapperWidth - spriteWidth) / 2;
    
    // Calculate z-index
    const zIndex = calculateUserZIndex();
    
    return {
        position: userPosition,
        zIndex: zIndex,
        width: spriteWidth
    };
}

/**
 * Update VN mode user expression position and styling
 */
async function updateVNUserPosition() {
    if (!isVisualNovelMode()) return;
    
    const userHolder = $('#user-expression-vn-wrapper .user-expression-holder');
    if (!userHolder.length) return;
    
    // Check if user has dragged the element manually
    if (userHolder.data('dragged')) return;
    
    // First resize containers based on sprite dimensions
    const containerData = await resizeVNContainers();
    if (!containerData) return;
    
    // Then calculate and apply position
    const positionData = calculateVNUserPosition();
    if (!positionData) return;
    
    // Apply position with animation (matching core: 500ms)
    const context = getContext();
    const reducedMotion = context.powerUserSettings?.reduced_motion;
    
    if (reducedMotion) {
        userHolder.css({
            'left': positionData.position + 'px',
            'z-index': positionData.zIndex
        });
    } else {
        userHolder.animate({
            'left': positionData.position + 'px'
        }, 500);
        userHolder.css('z-index', positionData.zIndex);
    }
    
    userHolder.show();
}

/**
 * Setup MutationObserver for VN mode
 */
async function setupVNObserver() {
    if (vnObserver) {
        vnObserver.disconnect();
        vnObserver = null;
    }
    
    if (!isVisualNovelMode()) return;
    
    const vnWrapper = document.getElementById('visual-novel-wrapper');
    if (!vnWrapper) return;
    
    vnObserver = new MutationObserver((mutations) => {
        let shouldUpdate = false;
        
        for (const mutation of mutations) {
            // Check if expression holders were added/removed
            if (mutation.type === 'childList') {
                const addedNodes = Array.from(mutation.addedNodes);
                const removedNodes = Array.from(mutation.removedNodes);
                
                // Check if any expression holders were affected
                const hasExpressionHolderChanges = 
                    addedNodes.some(node => node.classList?.contains('expression-holder')) ||
                    removedNodes.some(node => node.classList?.contains('expression-holder'));
                
                if (hasExpressionHolderChanges) {
                    shouldUpdate = true;
                    break;
                }
            }
            
            // Check if style/position changed on character sprites
            if (mutation.type === 'attributes' && 
                mutation.attributeName === 'style' &&
                mutation.target.classList?.contains('expression-holder') &&
                !mutation.target.hasAttribute('data-user-expression')) {
                shouldUpdate = true;
                break;
            }
        }
        
        if (shouldUpdate) {
            // Small delay to let core extension finish its updates
            setTimeout(() => updateVNUserPosition(), 50);
        }
    });
    
    vnObserver.observe(vnWrapper, {
        childList: true,
        attributes: true,
        attributeFilter: ['style', 'class'],
        subtree: false
    });
    
    // Initial position update
    await updateVNUserPosition();
}

/**
 * Cleanup VN mode observer
 */
function cleanupVNObserver() {
    if (vnObserver) {
        vnObserver.disconnect();
        vnObserver = null;
    }
}

/**
 * Create or get the user expression holder with completely unique structure
 */
function createUserExpressionHolders() {
    const context = getContext();
    
    // Create non-VN mode wrapper and holder
    let regularWrapper = document.getElementById('user-expression-wrapper');
    if (!regularWrapper) {
        regularWrapper = document.createElement('div');
        regularWrapper.id = 'user-expression-wrapper';
        document.body.appendChild(regularWrapper);
        
        const regularHolder = document.createElement('div');
        regularHolder.className = 'user-expression-holder';
        regularHolder.setAttribute('data-avatar', 'user-persona');
        regularHolder.setAttribute('data-user-expression', 'true');
        
        const dragHandle = document.createElement('div');
        dragHandle.className = 'drag-grabber fa-solid fa-grip';
        
        const img = document.createElement('img');
        img.className = 'user-expression-image';
        
        regularHolder.appendChild(dragHandle);
        regularHolder.appendChild(img);
        regularWrapper.appendChild(regularHolder);
        
        if (typeof dragElement === 'function') {
            dragElement($(regularHolder));
        }
        
        logger.debug('Created regular mode user expression wrapper and holder');
    }
    
    // Create VN mode wrapper and holder
    let vnWrapper = document.getElementById('user-expression-vn-wrapper');
    if (!vnWrapper) {
        vnWrapper = document.createElement('div');
        vnWrapper.id = 'user-expression-vn-wrapper';
        document.body.appendChild(vnWrapper);
        
        const vnHolder = document.createElement('div');
        vnHolder.className = 'user-expression-holder';
        vnHolder.setAttribute('data-avatar', 'user-persona');
        vnHolder.setAttribute('data-user-expression', 'true');
        
        const dragHandle = document.createElement('div');
        dragHandle.className = 'drag-grabber fa-solid fa-grip';
        
        const img = document.createElement('img');
        img.className = 'user-expression-image';
        
        vnHolder.appendChild(dragHandle);
        vnHolder.appendChild(img);
        vnWrapper.appendChild(vnHolder);
        
        if (typeof dragElement === 'function') {
            dragElement($(vnHolder));
        }
        
        logger.debug('Created VN mode user expression wrapper and holder');
    }
    
    // Return the holder for the current mode
    return isVisualNovelMode() 
        ? document.querySelector('#user-expression-vn-wrapper .user-expression-holder')
        : document.querySelector('#user-expression-wrapper .user-expression-holder');
}
/**
 * Initialize user expression display with default expression
 */
async function initUserExpressionDisplay() {
    const folderName = getCurrentPersonaFolder();
    if (!folderName) {
        return;
    }
    
    // Check if user has any sprites
    const sprites = await getSpritesList(folderName);
    if (!sprites || sprites.length === 0) {
        logger.debug('No user sprites found, skipping expression display initialization');
        return;
    }
    
    // Get default fallback expression (use 'joy' as default, matching expressions extension)
    const defaultExpression = 'joy';
    
    // Try to find the default expression sprite
    const defaultSprite = sprites.find(s => s.label.toLowerCase() === defaultExpression.toLowerCase());
    
    if (defaultSprite && defaultSprite.files.length > 0) {
        // Create/populate ALL user expression holders (both regular and VN mode)
        createUserExpressionHolders(); // This creates both if they don't exist
        
        const allHolders = document.querySelectorAll('.user-expression-holder');
        const isVNMode = isVisualNovelMode();
        const context = getContext();
        const lastMessage = context.chat[context.chat.length - 1];
        
        allHolders.forEach(holder => {
            const img = holder.querySelector('.user-expression-image');
            if (img) {
                img.src = defaultSprite.files[0].path;
                img.setAttribute('data-expression', defaultExpression);
                img.setAttribute('data-sprite-folder-name', folderName);
            }
            
            // Set visibility based on mode and last message
            const isVNHolder = holder.closest('#user-expression-vn-wrapper') !== null;
            
            if (isVNMode && isVNHolder) {
                // In VN mode, show VN holder
                holder.classList.remove('hidden');
            } else if (!isVNMode && !isVNHolder) {
                // In non-VN mode, toggle regular holder based on last message
                if (lastMessage && lastMessage.is_user) {
                    holder.classList.remove('hidden');
                } else {
                    holder.classList.add('hidden');
                }
            } else {
                // Hide holders not for current mode
                holder.classList.add('hidden');
            }
        });
        
        // Trigger position update for VN mode
        if (isVNMode) {
            setTimeout(updateVNUserPosition, 10);
        }
        
        // Store the current expression
        const settings = extension_settings.userExpressions;
        settings.currentExpression[folderName] = defaultExpression;
        saveSettingsDebounced();
        
        logger.info('User expression initialized with default:', defaultExpression);
    }
}

/**
 * Set expression for the current user persona
 * Updates the user expression holder
 */
async function setUserExpression(expression) {
    const folderName = getCurrentPersonaFolder();
    if (!folderName) {
        logger.warn('Cannot set expression: no persona folder');
        return;
    }
    
    logger.debug('Setting user expression:', { folder: folderName, expression });
    
    try {
        // Get sprites list for the user persona
        const sprites = await getSpritesList(folderName);
        
        // Find matching sprite
        let matchingSprite = sprites.find(s => s.label.toLowerCase() === expression.toLowerCase());
        
        // If no matching sprite found, try fallback to 'joy'
        if (!matchingSprite) {
            matchingSprite = sprites.find(s => s.label.toLowerCase() === 'joy');
            if (matchingSprite) {
                logger.debug('Expression not found, using fallback: joy');
            }
        }
        
        if (matchingSprite && matchingSprite.files.length > 0) {
            // Update ALL user expression holders (both regular and VN mode)
            const allHolders = document.querySelectorAll('.user-expression-holder');
            allHolders.forEach(holder => {
                const img = holder.querySelector('.user-expression-image');
                if (img) {
                    // Update the image
                    img.src = matchingSprite.files[0].path;
                    img.setAttribute('data-expression', expression);
                    img.setAttribute('data-sprite-folder-name', folderName);
                }
                
                // Only show if this is the holder for the current mode
                const isVNHolder = holder.closest('#user-expression-vn-wrapper') !== null;
                const isVNMode = isVisualNovelMode();
                
                if ((isVNMode && isVNHolder) || (!isVNMode && !isVNHolder)) {
                    $(holder).removeClass('hidden');
                    $(holder).show();
                }
            });
            
            // Update position if in VN mode
            if (isVisualNovelMode()) {
                await updateVNUserPosition();
            }
            
            logger.info('User expression set:', expression);
        } else {
            logger.warn('No sprite found for expression:', expression);
        }
        
        // Store the current expression
        const settings = extension_settings.userExpressions;
        settings.currentExpression[folderName] = expression;
        saveSettingsDebounced();
        
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
    
    // Update persona name display in the sprite header
    const personaNameSpan = document.getElementById('user-expressions-persona-name');
    if (personaNameSpan) {
        personaNameSpan.textContent = personaName;
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

    // Add click handlers for expression items (to set the expression)
    container.querySelectorAll('.expression_list_item').forEach(item => {
        item.addEventListener('click', async (e) => {
            // Don't trigger if clicking on buttons
            if (e.target.closest('.expression_list_buttons')) return;
            
            const expression = item.dataset.expression;
            await setUserExpression(expression);
            await updateUI();
        });
    });

    // Add click handlers for upload buttons
    container.querySelectorAll('.expression_list_upload').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const item = btn.closest('.expression_list_item');
            const expression = item.dataset.expression;
            
            // Create a temporary file input for this expression
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = 'image/*';
            input.onchange = async (e) => {
                const file = e.target.files[0];
                if (!file) return;
                
                logger.info('Uploading file for expression:', expression);
                const success = await uploadSprite(file, expression);
                if (success) {
                    await updateUI();
                    logger.info('Successfully uploaded:', expression);
                }
            };
            input.click();
        });
    });

    // Add click handlers for delete buttons
    container.querySelectorAll('.expression_list_delete').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const item = btn.closest('.expression_list_item');
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
    const streamControls = document.getElementById('stream-controls');
    const streamSpeedSelect = document.getElementById('user-expressions-stream-speed');
    const streamDelayInput = document.getElementById('user-expressions-stream-delay');

    if (streamingCheckbox) {
        streamingCheckbox.checked = settings.simulateStreaming || false;
        streamingCheckbox.addEventListener('change', (e) => {
            settings.simulateStreaming = e.target.checked;
            saveSettingsDebounced();
            logger.info('Simulate streaming:', settings.simulateStreaming);
            // Show/hide stream controls
            if (streamControls) {
                streamControls.classList.toggle('hidden', !e.target.checked);
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
    }

    if (streamDelayInput) {
        streamDelayInput.value = String(settings.streamDelay || 0);
        streamDelayInput.addEventListener('change', (e) => {
            settings.streamDelay = parseInt(e.target.value) || 0;
            saveSettingsDebounced();
            logger.info('Stream delay:', settings.streamDelay);
        });
    }

    // Show/hide stream controls based on current setting
    if (streamControls) {
        streamControls.classList.toggle('hidden', !settings.simulateStreaming);
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
        // Reinitialize user expression display for new persona
        await initUserExpressionDisplay();
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
            // Toggle visibility after processing user message
            toggleExpressionVisibility();
        }
    });
    
    // Listen for chat changes
    eventSource.on(event_types.CHAT_CHANGED, async () => {
        logger.info('Chat changed, clearing state');
        lastUserMessage = null;
        isProcessing = false;
        // Initialize user expression display when entering a chat
        await initUserExpressionDisplay();
        // Set initial visibility based on last message
        toggleExpressionVisibility();
        // Setup or cleanup VN observer based on mode
        if (isVisualNovelMode()) {
            setupVNObserver();
        } else {
            cleanupVNObserver();
        }
    });
    
    // Listen for character message rendered events to toggle expression visibility
    // Only toggle if the rendered message is the last one
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, (messageId) => {
        const context = getContext();
        if (messageId === context.chat.length - 1) {
            toggleExpressionVisibility();
        }
    });

    // Listen for message deleted events
    eventSource.on(event_types.MESSAGE_DELETED, (messageId) => {
        const context = getContext();
        // Toggle if we deleted the last message or if the new last message is different
        if (messageId >= context.chat.length - 1) {
            toggleExpressionVisibility();
        }
    });

    // Listen for message updated events (includes edits)
    eventSource.on(event_types.MESSAGE_UPDATED, (messageId) => {
        const context = getContext();
        // Only toggle if this is the last message
        if (messageId === context.chat.length - 1) {
            toggleExpressionVisibility();
        }
    });

    // Listen for swipe events to toggle expression visibility
    eventSource.on(event_types.MESSAGE_SWIPED, (messageId) => {
        const context = getContext();
        // Only toggle if the swiped message is the last one
        if (messageId === context.chat.length - 1) {
            toggleExpressionVisibility();
        }
    });
    
    // Listen for settings updates to detect VN mode toggle
    eventSource.on(event_types.SETTINGS_UPDATED, () => {
        const context = getContext();
        const isVNMode = context.powerUserSettings?.waifuMode;
        logger.debug("Settings updated, VN mode:", isVNMode);
        
        if (isVNMode) {
            setupVNObserver();
        } else {
            cleanupVNObserver();
        }
        toggleExpressionVisibility();
    });
    
    // Listen for group updates (VN mode member changes)
    eventSource.on(event_types.GROUP_UPDATED, async () => {
        if (isVisualNovelMode()) {
            await updateVNUserPosition();
        }
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

    // Setup VN observer if already in VN mode
    if (isVisualNovelMode()) {
        setupVNObserver();
    }

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
