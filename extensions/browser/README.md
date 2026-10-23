# AttnWall Web Bridge · Browser Extension

Standalone Chrome / Edge **Manifest V3** extension under `extensions/browser`. Supports **only** these page types:

| Platform | Browser page | Adapter |
| --- | --- | --- |
| ChatGPT standard chat | `https://chatgpt.com/c/<conversation-id>` | `chatgpt-web` |
| ChatGPT project chat | `https://chatgpt.com/g/g-p-<project-id>-<slug>/c/<conversation-id>` | `chatgpt-web` |
| Codex Cloud tasks | `https://chatgpt.com/codex/cloud/tasks/<task-id>` (legacy `/codex/tasks/<id>` if still served) | `codex-web` |
| DeepSeek | `https://chat.deepseek.com/a/chat/s/<conversation-id>` | `deepseek-web` |

ChatGPT conversations (including project chats) are supported separately from Codex Cloud task pages. DeepSeek's local Harness Web UI is not supported. Existing Codex CLI and DSH SDK connectors keep working independently.

## Install and connect (Windows / macOS / Linux)

1. Run AttnWall: `npm start`. In the AttnWall web app open **Settings → Browser Web Sessions**.
2. Chrome: visit `chrome://extensions`. Edge: `edge://extensions`. Enable **Developer mode**.
3. Click **Load unpacked / 加载已解压的扩展程序** and select the project directory `extensions/browser`. Pin **AttnWall Web Bridge** to your toolbar.
4. Return to AttnWall **Settings** and click **Copy extension configuration / 复制扩展连接配置**. This is one JSON string containing the hub URL and a *browser-only* credential; do not share it.
5. Click the AttnWall extension icon, paste that JSON, click **Connect to AttnWall**. For a remote HTTPS hub approve the **specific host** network permission prompt.
6. Open the supported website, log in normally, and enter one **specific existing conversation/task**. Keep a supported site tab open for continuous monitoring. Your first visible history is imported silently. New visible assistant messages appear in AttnWall; replies composed on your phone/Desktop AttnWall go to the exact session by ID. If its previously discovered tab is closed, the extension can reopen the saved conversation URL in an inactive tab.

When running AttnWall locally, the hub URL is normally `http://127.0.0.1:3360`. For a remote hub, use HTTPS (e.g. Tailscale Serve).

**You do not install a browser extension on iPhone**: install the extension on the desktop browser that holds the web sessions; keep using the AttnWall PWA on your phone.

## How the integration works

`manifest.json` permits content scripts only on ChatGPT chats (including project routes), `chatgpt.com/codex/*`, and `chat.deepseek.com/*`. The adapter `dom.js` reads *rendered* message nodes only in an active task/chat tab. The content script collects messages after a short stability delay, and the extension service worker forwards them using a narrowly scoped bearer token and `/api/browser/*`. The hub stores `chatgpt-web` / `codex-web` / `deepseek-web` sessions independently from native Codex/DSH sessions.

On first visit, messages already rendered are marked historical (not notifications). Only subsequent new messages can trigger batch/Instant notifications. Reply dispatch is addressed by original runtime, conversation ID and the installation's host ID, never just by a tab title. Submission uses the site's visible text editor + Send button, and only acknowledges after the editor clears.

The token is stored in **Chrome local extension storage**. It is different from the full-access AttnWall Access key and the native connector token. Content scripts do not receive it. The extension does **not** request the browser's cookie permission, intercept private website API traffic or query undocumented endpoints. Revoke the extension through its **Disconnect** button; server credential rotation requires a restart after updating the browser token in `.data/secrets.json`.



## Version 0.3.3 · 2026-10-23

- The AttnWall sidebar **+** opens a source chooser: Codex CLI (auto-discovery), DeepSeek Harness (attach/create), or AI webpage sessions (extension setup). The DSH Session ID form is shown only after explicitly selecting DSH.
- The browser adapter now tolerates a bounded number of **React/Lexical composer replacements before any Send click**, allowing a draft to be refilled after the webpage discards/replaces a pending editor. It never overwrites a different user's existing draft, never automatically re-submits after clicking Send, and surfaces uncertain delivery results instead of claiming success.
- Reload your local **AttnWall Web Bridge 0.3.3** from `chrome://extensions`, then reload ChatGPT/DeepSeek/Codex Web tabs. Earlier failures saved in AttnWall remain in history and do not prove the new adapter still produces that error.

## Version 0.3.2: web history, safer editor delivery and image replies

### Version 0.3.6 bounded reading and regression fixes

Reload the extension and refresh ChatGPT tabs after updating. Collection starts at the ChatGPT homepage and survives new-chat SPA navigation. All readers and delivery probes block retained DOM from the previous route, while identical text in newly rendered conversations remains readable. Each read inspects at most 5 recent messages, applying the cap before text and layout reads; hidden/excluded candidates have a 32-node scan budget. Initial imports stay silent. Send confirmation can recognize a newly rendered matching user turn; a cleared replacement editor alone cannot confirm delivery. The real MV3 test runs automatically when Playwright Chromium is installed and checks homepage navigation, tab reopening, route isolation, completion notifications and a bounded read from a large history. A 2,000-message DOM regression verifies that only 5 messages' text and geometry are read.

- Opening a discovered web session in AttnWall now queues a **history sync request** to the desktop browser extension. The extension opens the exact previously discovered URL if needed, reads only rendered conversation messages, imports them silently, and reports success or an actionable error. Messages that the original site does not render (virtualized, removed or closed) are not accessible.
- Rich-text delivery now reacquires React-replaced editors instead of assuming the same DOM node persists. An already prepared **identical** draft can be submitted; unrelated drafts are never overwritten. The original website's accepted submission is still not guaranteed by a DOM-only adapter.
- The AttnWall phone composer can select a PNG, JPEG or WebP image (maximum 3MB) for a web conversation. The image is stored on the self-hosted hub only for the pending reply. The extension attempts to use the original website's file input and requires visible attachment confirmation before pressing Send. A completed reply deletes the attachment bytes; a failed reply retains them for manual retry. Other file types, multiple images and native Codex/DSH image delivery remain unsupported.
- **Important:** after updating the files, open `chrome://extensions` and press the reload icon on the locally installed AttnWall Web Bridge extension, then refresh your ChatGPT/DeepSeek tabs. A new backend cannot automatically reload content scripts already running in Chrome.
- Live ChatGPT/DeepSeek DOM compatibility varies by website release. Simulated browser tests do not establish that your currently logged-in website accepted an image. Verify with a small test; the bridge fails closed when it cannot confirm the upload instead of silently marking it sent.

## Version 0.3.0: idle batching, completed messages and discovered conversations

- AttnWall no longer uses fixed clock-aligned 20-minute batches: it starts timing only when the first new normal message enters an empty queue. Additional messages join that same window. During DND it stays queued. Empty queue means no countdown.
- Content script waits for a stable assistant response (2.6 seconds) and does not publish the last assistant message while a recognized Stop Generating button is present. This reduces duplicate notifications for streaming responses. Completion is inferred from the rendered page, not a private API; an unfamiliar Stop button or disconnected browser can still cause missed/partial events.
- When a supported conversation is open, the extension can discover other accessible links in the **website sidebar**, storing validated conversation IDs, titles and exact URLs. AttnWall's left sidebar has a global session search that also finds older discovered conversations. A reply to a previously discovered closed conversation can reopen its exact URL in an inactive tab and route the message only after ID verification. The extension uses a background 30-second polling alarm so a closed target tab can be opened even when the MV3 worker restarts. Conversations never visited and never linked in an observed sidebar remain unknown; those must be opened once manually. Existing failed replies are never automatically retried.

### Actual Windows Chromium extension test

The optional test can be run with an unpacked MV3 extension on Playwright's Chromium (not Google Chrome Stable, which may ignore local extension flags). From the repository root in PowerShell:

```powershell
$env:ATTNWALL_TEST_EXTENSION = '1'
$env:ATTNWALL_CHROME = (node --input-type=module -e "import {chromium} from 'playwright-core'; console.log(chromium.executablePath())")
node --test test/browser-extension-e2e.test.js
```

This starts an isolated AttnWall server, loads the real extension into a fresh Chromium profile, captures a newly completed simulated web reply, sends a response from AttnWall, closes the site tab, and verifies that a second response reopens the correct saved conversation URL and submits safely. **It does not exercise the real logged-in ChatGPT/DeepSeek pages or your iPhone's actual notification display.**

## Version 0.3.1: ChatGPT cross-conversation isolation

ChatGPT's SPA can retain the previous conversation's DOM during route transitions. Earlier collector versions also included search-result message nodes. These could insert another conversation's texts under the wrong session ID, including misleading history in AttnWall. Version 0.3.1 restricts extraction to visible chat content under the active main area, excludes sidebar/search result nodes, and blocks collection while old-route message fingerprints remain after navigation. The AttnWall server rejects ChatGPT collector payloads without the new capture protocol (`captureVersion: 2`) to prevent old extensions re-polluting the database.

A one-time repair tool, `node scripts/quarantine-chatgpt-dom.mjs`, first backs up the SQLite database and preserves *all* legacy ChatGPT DOM records in `quarantined_chatgpt_dom_20261023` before removing them from the live timeline. Native Codex/DSH/DeepSeek messages and AttnWall outgoing replies are not removed. **To restore correct ChatGPT history, reload the extension at `chrome://extensions` and refresh each original ChatGPT conversation; initial re-import is silent.** Quarantine rows remain in the local database and backup for recovery or audit. Do not use an old extension build after repairing the database.

## Reply fails with "Cannot safely identify Send button"

Version **0.2.1** includes a safer ChatGPT Web composer resolver. Some ChatGPT layouts show a voice/dictation button until text is inserted, and others use an icon-only `#composer-submit-button` or a localized label. AttnWall now fills the **empty** original conversation editor, waits for the correctly scoped Send button, then verifies that the editor clears. It never intentionally clicks voice, Stop, or a different form's controls, and does not overwrite existing drafts.

To apply this extension-only update: open `chrome://extensions` (or `edge://extensions`), click **Reload / 重新加载** on AttnWall Web Bridge, then refresh the original ChatGPT conversation tab. You do **not** need to reconnect AttnWall or restart its server. The previously failed reply stays **failed**; after checking the original chat that it was not actually sent, click **Retry / 重试** once in AttnWall. Do not automatically retry a message if the original site already has it or if the new error says it was staged as a draft; that could duplicate a message. Real authenticated site compatibility must still be checked after installation.

## Limitations (important)

- **Live-page compatibility is not yet proven**: selectors and composer flows were tested against simulated DOM fixtures. ChatGPT, Codex Cloud and DeepSeek sometimes change their UI. After installing the extension, check that a real session appears and that a controlled, harmless test reply reaches the right tab. Failure to find a safe Send button is reported, not guessed.
- Requires a **currently open tab** at the exact task/chat route. It does not fetch *all* closed historical conversations from the provider. Opening multiple tabs/sessions can register each currently visited session.
- Browser extensions cannot reliably keep monitoring or submitting through tabs that are closed, suspended or inaccessible. This does not interfere with the agents running in their own cloud services; it only affects AttnWall's view and reply bridge.
- Text-only DOM capture; not images, attachments, full code tool traces or hidden reasoning. Virtualized/scrolled-away messages may not be captured. UI changes or streaming text can cause duplicates/omissions; source event IDs are derived from visible message role/order/text on page.
- The extension cannot bypass websites that require CAPTCHA, browser reauthentication, subscription access, confirmation dialogs or manual approvals. It respects the website's normal session and its own terms/rate controls.
- Dispatch is **best-effort**: an accepted DOM form submission does not prove the model has replied. A browser crash between website submit and hub ACK can lead to a duplicate when manually retried. AttnWall marks uncertain/failed jobs; check the original site before retrying.
- The extension currently has a single connection profile per browser. Chrome/Edge user profiles each have their own extension storage and browser host ID.
- Chrome Dev Mode is required for local installation; no store publication required for private use.
