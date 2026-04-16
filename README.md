# User Expressions Extension

A SillyTavern extension that adds expression sprites for user personas, parallel to the existing Character Expressions extension.

## DEV NOTE

I made this with Kimi and didn't bother to code review the result so who knows right. Didn't look too bad when I poked at it for a couple last fixes but enter at your own risk.

## Features

- **Per-Persona Expression Sets**: Each persona gets its own expression folder
- **Automatic Expression Classification**: Messages are automatically classified and expressions updated
- **Manual Expression Control**: Set expressions manually via UI or slash commands
- **Full Upload Support**: Upload expressions directly through the UI
- **Integration with Expressions Extension**: Uses equivalent display mechanisms as the core extension.
- **"Streamed" user messages**: Simulates the streaming effect on your own user messages so you can enjoy the shifting expressions!

## Installation

Copy the git repo URL here and add it in the Extensions panel, as usual.

## Usage

### Setting Up Expressions

1. **Create a Persona**: Use the existing Persona Management system in SillyTavern
2. **Upload Expressions**: 
   - Go to Extensions → User Expressions settings
   - Click "Upload Expression" and select an image
   - The filename becomes the expression label (e.g., `joy.png` → expression "joy")
   - Sprites are stored in `characters/__persona__{PersonaName}/`

### Settings

- **Enable User Expressions**: Turn the extension on/off
- **Show expressions on user messages**: Display expressions in the chat interface
- **Auto-update expression on new messages**: Automatically classify and update expressions when you send messages
- **Simulate streaming on user messages**: Render the message you sent as if it's an incoming stream. Toggling on exposes two additional settings:
  - *Stream Speed*: Determines how quickly the message appears.
  - *Generation delay*: Adds a brief delay after the user "stream" finishes before kicking off the reply generation.

### Slash Commands

- `/user-expression-set <expression>` or `/usersprite <expression>` - Manually set your expression
- `/user-expression-get` or `/getuserexpression` - Get your current expression
- `/user-expression-refresh` or `/refreshuserexpressions` - Refresh the expression list

### How It Works

1. When you send a message, the extension classifies it using the same method as character expressions (LLM/Extras/Local)
2. The expression is set using `sendExpressionCall()` from the expressions extension
3. Expressions appear in the regular expressions panel alongside character expressions
4. Each persona has isolated expression folders using the naming pattern: `__persona__{PersonaName}`

### File Storage

Expression sprites are stored in the characters directory:
```
data/default-user/characters/
├── __persona__MyPersona/
│   ├── joy.png
│   ├── sadness.png
│   ├── anger.png
│   └── neutral.png
└── __persona__AnotherPersona/
    ├── happy.png
    └── serious.png
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

- Persona folders are prefixed with `__persona__` to avoid collisions with real characters
- The extension automatically creates folders on first upload
- Expression classification uses the same settings as character expressions
