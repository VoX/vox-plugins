# vox-plugins

VoX's fork of Claude Code plugins. Small, focused, and actually maintained.

## Plugins

- **`external_plugins/discord`** — Discord messaging channel with built-in access control. Pair, allowlist, and manage policy via `/discord:access`.
- **`external_plugins/scheduler`** — Schedule messages to be delivered back into your own Claude session at a future time. One-shot or repeating, persists across restarts.

## Installation

```bash
claude plugin marketplace add vox-plugins https://github.com/bitvox/vox-plugins
claude plugin install discord@vox-plugins
claude plugin install scheduler@vox-plugins
```

Or browse via `/plugin > Discover` after adding the marketplace.

## Plugin Structure

Each plugin follows the standard Claude Code plugin layout:

```
plugin-name/
├── .claude-plugin/
│   └── plugin.json      # Plugin metadata (required)
├── .mcp.json            # MCP server configuration (optional)
├── commands/            # Slash commands (optional)
├── skills/              # Skill definitions (optional)
└── README.md            # Documentation
```

## License

See each plugin's LICENSE file.
