# User Expressions Extension

A SillyTavern extension that adds expression sprites for user personas, parallel to the existing Character Expressions extension.

## Features

- **Per-Persona Expression Sets**: Each persona gets its own expression folder
- **Automatic Expression Classification**: Messages are automatically classified and expressions updated
- **Manual Expression Control**: Set expressions manually via UI or slash commands
- **Debug Logging**: Configurable log levels for troubleshooting
- **Full Upload Support**: Upload expressions directly through the UI
- **Integration with Expressions Extension**: Uses the same display mechanism as character expressions

## Installation

1. Copy the `user-expressions` folder to `public/scripts/extensions/`
2. Restart SillyTavern
3. Enable the extension in the Extensions panel

## Usage

### Setting Up Expressions

1. **Create a Persona**: Use the existing Persona Management system in SillyTavern
2. **Upload Expressions**: 
   - Go to Extensions → User Expressions settings
   - Click "Upload Expression" and select an image
   - The filename becomes the expression label (e.g., `joy.png` → expression "joy")
   - Sprites are stored in `characters/__user__{PersonaName}/`

### Settings

- **Enable User Expressions**: Turn the extension on/off
- **Show expressions on user messages**: Display expressions in the chat interface
- **Auto-update expression on new messages**: Automatically classify and update expressions when you send messages
- **Debug Log Level**: Control the verbosity of console output (Error → Verbose)

### Slash Commands

- `/user-expression-set <expression>` or `/usersprite <expression>` - Manually set your expression
- `/user-expression-get` or `/getuserexpression` - Get your current expression
- `/user-expression-refresh` or `/refreshuserexpressions` - Refresh the expression list

### How It Works

1. When you send a message, the extension classifies it using the same method as character expressions (LLM/Extras/Local)
2. The expression is set using `sendExpressionCall()` from the expressions extension
3. Expressions appear in the regular expressions panel alongside character expressions
4. Each persona has isolated expression folders using the naming pattern: `__user__{PersonaName}`

### File Storage

Expression sprites are stored in the characters directory:
```
data/default-user/characters/
├── __user__MyPersona/
│   ├── joy.png
│   ├── sadness.png
│   ├── anger.png
│   └── neutral.png
└── __user__AnotherPersona/
    ├── happy.png
    └── serious.png
```

## Debug Logging

The extension includes a configurable logging system to help with debugging:

```javascript
// Log levels (0-4)
0 = ERROR   // Only errors
1 = WARN    // Errors and warnings
2 = INFO    // General info (default)
3 = DEBUG   // Detailed debug info
4 = VERBOSE // Everything including low-level operations
```

Set via the settings panel or programmatically:
```javascript
extension_settings.userExpressions.logLevel = 3; // DEBUG
```

## Integration with Expressions Extension

This extension relies on the built-in Expressions extension and uses:
- `sendExpressionCall()` - To set expressions
- `getExpressionLabel()` - To classify messages
- `lastExpression` - To track current expressions
- The same sprite endpoints: `/api/sprites/get`, `/api/sprites/upload`, `/api/sprites/delete`

## Troubleshooting

**No expressions showing up:**
- Check that you've uploaded sprites for the current persona
- Verify the extension is enabled
- Check the debug logs (increase log level if needed)

**Upload failing:**
- Ensure the file is an image (png, jpg, etc.)
- Check browser console for errors
- Verify you have the correct persona selected

**Expression not changing:**
- Check that "Auto-update expression on new messages" is enabled
- Verify the classification API is configured (same as character expressions)
- Try manually setting an expression with `/user-expression-set joy`

## Technical Notes

- Persona folders are prefixed with `__user__` to avoid collisions with real characters
- The extension automatically creates folders on first upload
- Expression classification uses the same settings as character expressions
- State is persisted in `extension_settings.userExpressions`