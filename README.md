# AttnWall

**Your attention. Your rules.** A self-hosted attention firewall and unified inbox for **OpenAI Codex** and **DeepSeek Harness (DSH)**.

## What is implemented

- Unified inbox of Codex and DSH sessions with source, unread counts and per-session conversation view.
- Configurable **task-start batch notification interval** (20 minutes by default). The earliest outstanding task starts the clock. Release waits until both its interval threshold and at least one task completion; only replies completed by that cutoff join the batch. After a batch is released, the next batch waits at least T from that actual notification. A new task after an idle gap starts a fresh T interval. No notification is sent for an empty batch. Normal push and inbox visibility remain withheld until release; DND defers delivery. Instant replies bypass the interval after completion.
- Daily do-not-disturb with IANA time zone; **Instant** messages bypass the schedule (unless disabled), and sync live via SSE. During DND, queued normal messages are hidden from inbox cards, unread summary counts and session badges; an intentional visit to a conversation still permits reading its full history. Messages already released before DND remain available. Each session has an explicit Instant conversation toggle for immediate back-and-forth.
- Replies are queued durably, routed by **host + runtime + native session ID**, and marked sent/failed only after the connector responds. A failed reply can be retried manually.
- Multi-device responsive Web/PWA, session read-state sync and optional Web Push. iOS requires HTTPS, Add to Home Screen and explicit notification permission.
- **Home Screen / Dock unread-number badge:** When the platform supports the Badging API, AttnWall displays the total **released unread** count on its installed PWA icon; pending ordinary messages remain excluded until the configured delivery window. Open app state refreshes and marking messages read update or clear the count; background Web Push includes the current unread total (test pushes leave it unchanged). On iOS/iPadOS use an HTTPS **Add to Home Screen** app and grant notification permission (iOS 16.4+). Other devices that remain closed cannot reliably clear a badge immediately after a read elsewhere, because iOS does not provide unrestricted silent push; opening AttnWall reconciles it. Unsupported browsers ignore this feature without affecting notifications.
- **Universal image replies:** Send one PNG, JPEG or WebP (up to 3MB), with or without text, to Codex CLI, DSH SDK, ChatGPT Web, Codex Web or DeepSeek Web. Attachments remain host-bound, survive failed delivery for retry and are removed from the hub after acknowledgment. Codex uses image inputs for direct turns and `queue --image` when the desktop owns the thread; queued image files stay under the connector’s `.data/queued-images` until completion is observed. DSH uses inline SDK image blocks. Website upload controls and the selected upstream model must support images; an upstream rejection is reported as a delivery error. Live authenticated website compatibility still needs validation.
- Multi-host: one central server, a connector on each machine, running the same Codex/DSH adapter processes.
- Login key and separate connector key. No agent API key is stored by AttnWall.
- Event and message de-duplication by source ID, including safely importing old Codex messages without generating a backlog of historic notifications.
- Clicking a Codex session triggers a **bounded recent-history sync** using metadata-only reads plus one summary page (at most 3 turns and 5 user/assistant messages, excluding tool records). The conversation view initially loads 5 cached messages; 'Load older' adds 5 cached messages per click. Full original histories are not hydrated automatically. Tool execution/reasoning trace and image previews are not yet displayed. DSH SDK cannot backfill external web conversation history.
- **Mark all read** is a database-wide operation (not limited to the first 100 visible inbox items); historical imports are stored as read, and inbox unread counts include all **released** messages, even if only the newest 100 appear in the inbox. The queued-normal count separately reflects unreleased messages.
- **Per-session inbox grouping:** Each completed AI turn contributes one unread reminder using its final output. Progress remains in conversation history. Multiple completed turns in the same conversation share one inbox card; the card, sidebar and app badge all count completed replies. Approval and user-input requests remain immediate.
- **iPhone notification diagnostics:** Settings → System Notification Diagnostics shows push subscriptions (without exposing their endpoint URLs), last delivery HTTP response/status and a per-device **Send test notification** button. Apple's `201` means the push service accepted a request; actual display still depends on iOS permission/Focus settings.
- Sidebar with many sessions scrolls independently; app assets use revalidated cache headers so an updated server won't silently keep showing stale JavaScript.
- **Global sidebar search** looks through all sessions already discovered by native connectors or browser sidebar scanning, even outside the selected activity date range. Search does not fetch unseen conversations directly from a provider.
- **Create Codex sessions:** The sidebar + menu can create a real Codex thread with a name, connector host and optional working directory. The selected connector uses `thread/start` and `thread/name/set`; the conversation appears after its native thread ID is confirmed. Request IDs and retained creation receipts prevent duplicate threads when hub acknowledgments are retried. An offline connector leaves creation queued.
- **Codex completion discovery:** Startup history stays silent. After the initial scan, a newly created desktop/CLI thread or a run started while the connector is watching is treated as live even if it has already completed at first import; it enters the configured batch window or Instant channel.
- **Session activity time filter:** The sidebar defaults to **Last 7 days** and offers **Last 24 hours**, **Last 7 days**, **Last 30 days**, and **All sessions**. The selection is saved in the current browser; the visible/total count reflects the filter. Importantly, time is derived from the native Codex thread's `updatedAt`, **not** how recently AttnWall polled the thread or read its history. New DSH sessions and new live messages update activity; historical backfills do not. Old sessions remain accessible through inbox entries and deep links and are temporarily shown when selected, even if outside the filter. No message, unread status, background connection, or notification is filtered away.


## 0.3.12 · Batch timing from task start

Ordinary notifications use `max(max(earliest outstanding task start, previous actual batch notification) + T, earliest completed reply time)`. Each batch includes only tasks completed by that cutoff; unfinished tasks roll into a new window anchored no earlier than the previous actual notification. For T=20 minutes, a task started at minute 0 and completed at minute 5 is released at minute 20. A second task started at minute 3 and completed at minute 30 is released at minute 40. If it completes at minute 50, it is released at minute 50. A delayed scheduler tick does not mix later completions into the earlier batch. Task starts survive hub restarts. Native adapters use run-start events and recorded Codex turn timestamps; the browser reports when it first observes a new task. Older clients without a start event fall back to the first live output or completion time. Restart the hub and native connectors, reload **AttnWall Web Bridge 0.3.12**, and refresh the original conversation tabs.

## 0.3.11 · Completed-reply counts and multiline draft delivery

Inbox and app badges count only the final output of each completed run, including previously released runs already in the database. Progress messages remain available in history. Web reply comparison normalizes Windows line endings and reads logical rich-text paragraphs, preventing the outgoing message from being mistaken for another draft. Restart the hub, reload **AttnWall Web Bridge 0.3.11**, and refresh the original conversation tabs.

## 0.3.10 · Codex writer release and web completion recovery

Codex replies now use a dedicated App Server process for each thread. After a turn finishes, the connector closes that process so it no longer holds the thread writer; background collection uses a separate read-only connection. Session creation also closes its writer after naming the thread. Existing Desktop/CLI owners still receive replies through the official queue. Restart the connector to release writers held by its previous process.

The browser collector also accepts ChatGPT's explicit `complete` turn state for newly observed turns, covering fast replies whose generation controls were never visible. Old history stays silent. Reload **AttnWall Web Bridge 0.3.10** and refresh conversation tabs to apply this change.

## 0.3.4 · Completion-only notifications

- Agent messages are stored immediately, but no push/inbox alert occurs while the run is active. Codex CLI uses `turn/completed`; DeepSeek Harness uses `turn/end`. One completed run produces **one notification event**, even when there are many intermediate messages. Retries reuse that event ID. Approval and user-input requests remain immediate even when fast notifications are disabled.
- Ordinary notification timing follows the task-start rule above. Instant replies notify on run completion. Approval and user-input requests remain immediate.
- For ChatGPT / Codex Web / DeepSeek Web, the extension signals completion only after seeing the website transition from **generating → stopped**, then a stable final assistant message. Silence/idle alone is deliberately not treated as completion. If the extension did not witness that transition (for example a closed tab), it cannot guarantee a completion notification, though available messages can still be captured.
- Old, already-unread messages remain intact. Upgrade suppresses pending **old per-message** notifications instead of delivering them again. Reload AttnWall Web Bridge 0.3.6 in `chrome://extensions` and refresh web tabs; native connector requires server restart.

## Browser Web Bridge (optional)

### 0.3.6 · Bounded history and message delivery

ChatGPT's collector loads on the homepage so creating a conversation through SPA navigation keeps the bridge connected. Live polling, history reads and delivery probes share the same route guard and inspect at most 5 recent messages. The cap applies before text extraction and visibility/layout checks, with a 32-candidate scan budget for hidden or excluded nodes. Initial imports remain silent. Conversation pages start with 5 cached messages and expand only after an explicit 'Load older' click. Send confirmation accepts a new matching user turn and rejects an empty replacement editor as ambiguous. A sent reply is reconciled with its native/web history echo, including echoes arriving before the delivery ACK.

Native reply pickup runs independently from session discovery and history backfills. Slow or large thread reads therefore no longer hold the delivery loop. Background syncs share one RPC initialization and serialize buffer flushes; repeated session metadata is coalesced while updates arriving during a flush remain pending. The test runner limits browser-test concurrency to two workers to keep full-suite runs within local machine capacity.

When Codex Desktop retains the original thread's writer, AttnWall uses the official [`codex queue`](https://learn.chatgpt.com/docs/developer-commands#codex-queue) command. The connector observes the resulting turn and imports the finished answer and completion. A queue receipt means Codex accepted the prompt; an active conversation can process it after its current turn. Keep the owning Desktop/CLI process running. `CODEX_QUEUE_BIN` can select a native `codex.exe` or official `codex.js` entry point if your normal command is a custom wrapper. Reload AttnWall Web Bridge **0.3.6** at `chrome://extensions`, then refresh the ChatGPT tabs to apply the bounded collector update.

A **separate, locally installable Manifest V3 Chrome/Edge extension** is available under [`extensions/browser`](extensions/browser/README.md). It connects ChatGPT Web chats (including project chats), Codex Cloud tasks and DeepSeek Web; native Codex CLI/DSH adapters remain independent. AttnWall Settings has guided installation and a browser-scoped connection configuration. Keeping a site tab open is necessary for continuous monitoring; replies can reopen a *previously discovered* closed conversation in a background tab. Tests include a real Chromium MV3 extension with a synthetic logged-in page, including reply after automatic tab reopening; compatibility with live authenticated provider pages still needs validation. No Chrome Web Store publication is required for personal installation.

Web Push uses `ATTNWALL_PUSH_PROXY`, then `HTTPS_PROXY` / `HTTP_PROXY` (including lowercase forms), then the enabled Windows system HTTP/HTTPS proxy. `NO_PROXY` exclusions are honored. Set `ATTNWALL_PUSH_PROXY=direct` to disable proxy use for push requests. Windows proxy discovery reads configuration only; it does not change system settings. Requests have a 15-second socket timeout, and network errors show their underlying codes (for example `ETIMEDOUT`) in logs and notification diagnostics.

## iOS push setup and VAPID contact

A previous development default used a nonpublic VAPID `mailto:` contact domain, which Apple Push rejects with HTTP `403 BadJwtToken`. The fallback is now a syntactically valid HTTPS URI; for production and shared deployments set `ATTNWALL_VAPID_SUBJECT` to **your own real public HTTPS site URL** or reachable `mailto:` address (for example the same origin used to access AttnWall remotely). This changes only the JWT contact claim; **do not regenerate `.data/vapid.json`**, because existing browser subscriptions depend on those keys.

On iPhone, open AttnWall over HTTPS, install it on the Home Screen, enable notifications, then visit Settings → System Notification Diagnostics to send a test push to that device. Apple's HTTP `201` verifies server acceptance; it does not prove iOS displayed a banner. Normal messages obey the configured interval and quiet hours; Instant bypasses AttnWall delays but not iOS Focus settings.

## Quick start

Requires **Node.js 22.13+** (recommended Node 24) and Codex CLI installed/authenticated. DSH support also requires the preview `@deepseek-ai/dsh` package and provider configuration.
DSH SDK defaults to the official `deepseek-official` provider and `deepseek-v4-flash` model, unless overridden with `DSH_PROVIDER` and `DSH_MODEL`. The DSH API key must be configured through DSH's credentials or environment; AttnWall never records it.

    npm install
    npm start

Open **http://127.0.0.1:3360**. Enter the **Access key** printed in the console. The key is also in `.data/secrets.json`; never commit that directory.

By default, the server also runs an **in-process local connector**. Disable it to manage connectors separately:

    # PowerShell
    $env:ATTNWALL_LOCAL_CONNECTOR="0"
    npm start

In a second terminal:

    npm run connector

The local connector automatically imports Codex threads via the official App Server (`thread/list`, `thread/read`), polls for changes, and continues the **same thread** via `thread/resume` and `turn/start` (or `turn/steer` when the active turn ID is exposed). DSH uses the supported SDK profile JSON-RPC `initialize` and `session/prompt`: attach a known existing session ID from the `+` button, or create a DSH session in AttnWall. The DSH SDK does **not** provide a native session listing API, so DSH sessions created outside AttnWall are **not automatically discovered** in V1; attachments require an exact ID. DSH is in developer preview and protocol changes are possible.

## Multi-host and mobile devices

1. Run `npm start` on one always-on machine (the hub).
2. Use [Tailscale](https://tailscale.com/) to connect your devices; expose the local web service securely with **Tailscale Serve**, so browsers use an HTTPS URL. Do **not** expose port 3360 or your connector key directly to the public internet.
3. On each other machine with Codex/DSH installed, run the connector with a unique `--host` value:

    $env:ATTNWALL_HUB="https://your-tailnet-host.example.ts.net"
    $env:ATTNWALL_CONNECTOR_TOKEN="connector key printed by hub"
    npm run connector -- --host workstation-b

4. Visit the same HTTPS web app from your phone/tablet/desktop, sign in, and enable push notifications from the top-right notification button. On iOS: first **Share → Add to Home Screen**, launch the installed PWA, then enable notifications.

The hub listens on **127.0.0.1** by default, which is intentional. Set `ATTNWALL_HOST` only for explicitly secured networks. Use `ATTNWALL_PORT` to change the port.

## Architecture

- `src/server.js`: authenticated HTTP API, same-origin UI, SSE, local connector bootstrap.
- `src/core.js`: SQLite store, per-session routing, message de-duplication, settings and reply queue.
- `src/notify.js`: batching/DND rules, durable device retries and browser push using VAPID.
- `src/push-transport.js`: environment/Windows proxy support and network error diagnostics.
- `src/connector.js`: outbound-only host connector; polling + reply forwarding.
- `src/adapters.js`, `src/rpc.js`: native Codex and DSH JSON-RPC transports.
- `public/`: dependency-free Web/PWA front end.

## Limitations and safety

- **Codex GUI/CLI sessions running in a different process**: a writer conflict uses the official durable CLI queue for that same thread. Directly connected active turns can be steered when their turn ID is verified. CLI versions without `codex queue` report an actionable failure. Queue acceptance does not guarantee the owning process is online to consume it. After a connector restart, use history sync to recover responses whose completion was missed while offline.
- **Codex version compatibility**: older Codex CLI versions (the test machine had 0.144.1) cannot read some paginated threads and return `paginated_threads is not supported yet`. AttnWall marks them incompatible. Upgrade Codex CLI to a recent release, then restart AttnWall; do not assume upgrading the Desktop app updates a separately installed CLI.
- **DSH**: known session IDs can be sent through the SDK profile but existing DSH Web conversations are not streamed by the SDK; they may not be writable concurrently from two runtimes. Do not attach an actively controlled DSH session without ensuring the runtime permits it.
- **DSH provider errors**: A successful `session/prompt` receipt means the prompt was queued, **not** that the model answered successfully. A `turn/end` error (e.g. `QUOTA 402` for insufficient provider balance) is shown as an Instant diagnostic in AttnWall. Verify your provider API credit/quota before retrying.
- **DSH credential precedence**: SDK operations inherit `DEEPSEEK_API_KEY` from the AttnWall connector environment, which can override a different key saved in the DSH Web UI. On the tested Windows machine, this environment route returned `QUOTA 402`; temporarily omitting the variable from an isolated child caused `MISSING_CREDENTIAL`. Do not change or publish keys to debug this. Ensure the selected provider (`DSH_PROVIDER`) and model (`DSH_MODEL`) refer to an accessible credential with available quota.
- **Human approvals**: Codex tool approval requests received through AttnWall's own App Server connection surface as Instant messages with explicit Approve/Decline actions. Nothing is auto-approved; approvals from other clients/processes are not intercepted. Pending approvals tied to an exited App Server process cannot be resolved after that process is gone.
- **At-least-once connector delivery**: the hub stores replies and uses stable IDs, but if a connector crashes after submitting to a runtime and before acknowledging the hub, a retry may replay the prompt. Review failed messages before manual retry. True end-to-end exactly-once delivery requires a runtime-side deduplication acknowledgment.
- Notification release and device delivery are stored in a **transactional SQLite outbox**. Network failures, HTTP 408/429 and server errors retry per device (30 seconds initially, exponential backoff up to 5 minutes, respecting Retry-After; at most 7 attempts within 1 hour). Successful devices are not retried. Restarted workers recover pending deliveries after their 2-minute lease; ordinary retries still respect DND. Reading a message cancels its pending reminder. HTTP 404/410 retires expired subscriptions; other permanent rejections appear in diagnostics. The same notification ID is reused on retries to collapse duplicate system alerts. A push-service receipt still does not guarantee OS display. Old delivery failures from before the outbox migration are not replayed.
- Web Push requires HTTPS (or browser localhost), service worker support and user permission. Device-level Focus/DND rules may override Instant notifications.
- The hub and remote connectors share a single connector bearer token in V1. Keep it inside your private Tailscale network and restrict filesystem access to `.data/`.
- No unsupported claim of remote multi-user hosting. This is a **single-owner, self-hosted** V1.

## Development

    npm test
    npm run check
On a machine with Google Chrome, `npm test` also runs headless browser tests against isolated temporary servers and databases. When Playwright's Chromium bundle is installed, the real MV3 extension test runs automatically. Install it with `npx playwright-core install chromium` and run `npm run test:extension`; Chrome Stable can ignore unpacked extension flags. Set `ATTNWALL_CHROME` to a compatible Chromium executable when needed, or `ATTNWALL_TEST_EXTENSION=0` to skip that test explicitly. These tests do not mutate your live AttnWall sessions.

For an explicitly created, disposable Codex test conversation, set `ATTNWALL_LIVE_CODEX_THREAD` to its UUID and run `npm run test:live:codex`. This opt-in test uses the running local hub and its existing credentials, sends one real prompt requesting a harmless receipt, and checks delivery, the actual assistant response and history reconciliation. It registers only that selected test session because Desktop chats created by tools may be excluded from the CLI's default list. `ATTNWALL_LIVE_HUB` and `ATTNWALL_LIVE_CODEX_HOST` select a different hub/connector when their credentials match `.data/secrets.json`. Credentials are never printed. This live test is skipped during normal `npm test`.

Settings and data are stored in `.data/` and intentionally excluded from Git. If you rotate keys in `.data/secrets.json`, restart the server and update remote connector secrets.
