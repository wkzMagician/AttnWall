# AttnWall

**Your attention. Your rules.** AttnWall brings AI conversations into one private inbox, so you can follow up when you’re ready.

## Support platform / harness

| Platform / harness | Connection |
| --- | --- |
| ✅ Codex (CLI, Desktop, and Web) | Native connector and browser extension |
| ✅ DeepSeek Harness (DSH) | Native connector |
| ✅ DeepSeek Web | Browser extension |
| ✅ ChatGPT Web | Browser extension |

## What you can do

- See conversations and completed replies from supported platforms in one inbox.
- Set notification timing and quiet hours, or mark a conversation as Instant.
- Reply from the web app and send supported images.
- Get web push notifications and use AttnWall as an installable app on your phone.
- Connect more than one computer to the same self-hosted inbox.

## Get started

You’ll need Node.js 22.13 or newer. Install and start AttnWall:

```sh
npm install
npm start
```

Open [http://127.0.0.1:3360](http://127.0.0.1:3360). The Access key appears in the server terminal the first time you start AttnWall.

The local connector starts with the server. Install and sign in to the Codex CLI on that computer to connect Codex. To use DSH, install and configure the DSH SDK on a computer running the connector.

### Connect web conversations

Install the unpacked browser extension from [`extensions/browser`](extensions/browser/README.md) in Chrome or Edge, then connect it from **Settings → Browser Web Sessions**. Sign in to ChatGPT, Codex, or DeepSeek in that browser and open the conversations you want to follow. Keep a supported site tab open for continuous monitoring.

### Use on your phone

Open the AttnWall address from your phone. For remote access and push notifications, use HTTPS. On iPhone or iPad, add AttnWall to the Home Screen and open the installed app before enabling notifications.

## A few things to know

- AttnWall is self-hosted for one owner. Your conversations and settings are stored on your server.
- Web integrations read conversations shown in the supported browser pages. A conversation must be opened at least once to connect it.
- DSH sessions created outside AttnWall may need to be connected by their session ID.
- Keep your Access key and connector credentials private. For remote access, use a private network such as [Tailscale](https://tailscale.com/) and HTTPS; don’t expose the server directly to the public internet.

## More information

- [Browser extension setup](extensions/browser/README.md)
