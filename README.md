# OpenCode Plugin for Vicoa

A plugin for OpenCode that enables you to ship faster with OpenCode on your phone!

OpenCode plugin for [Vicoa](https://vicoa.ai) to vibe code anywhere.

## Features

- **Push Notifications** - Get notified when OpenCode needs approval or finishes tasks
- **Real-time Monitoring** - See all opencode progress in your phone
- **Bidirectional Messaging** - Send messages to OpenCode from your phone
- **Permission Approval** - Approve permissions on the go
- **File Fuzzy Search** - Reference project files quickly on your phone
- **Command Execution** - Execute OpenCode commands from your phone

## Installation

This plugin works with Vicoa CLI, web, and mobile app. 

## Installation vis Vicoa (Recommended)

You can install `vicoa` CLI with:

```bash
pip install vicoa
``` 

Then, run the following command to install the plugin and link Vicoa with OpenCode:

```bash
vicoa opencode
```

After authentication via the web portal, you are set to use OpenCode anywhere you go.

You can reference [Vicoa Setup Guide](https://vicoa.ai/docs/getting-started) for more details.

## Manual Installation

Add the plugin to OpenCode config (`~/.config/opencode/config.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-vicoa"]
}
```

Then, you'll still need to install Vicoa CLI and authenticate with it to set the Vicoa API key. 

You can also get the API key manually from the Vicoa dashboard, then set it with:

```bash
export VICOA_API_KEY="your-vicoa-api-key"
```


### For Development

1. Clone the repository

```bash
git clone https://github.com/vicoa-ai/opencode-vicoa.git
```

2. Install and build the package:

```bash
npm install
npm run build
```

3. Add the local plugin version to OpenCode config:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["file://<path/to/opencode-vicoa>"]
}
```

## Usage

You can either use the Vicoa CLI to start OpenCode, or run OpenCode directly.

1. After initial setup, you can run OpenCode directly and it'll sync with Vicoa automatically.

```bash
opencode
```

2. You can also use the Vicoa CLI to start OpenCode:

```bash
vicoa opencode
```

It additional prepares files for fuzzy search on Vicoa mobile and web apps. 

You can also upgrade the plugin with 

```bash
vicoa opencode --upgrade
```
