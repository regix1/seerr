# Installation

Refer to the [Getting Started](./getting-started/index.mdx) section for platform-specific installation instructions (Docker, Kubernetes, build-from-source, etc.).

After installing Seerr, open the web UI at `http://[address]:5055` and complete the first-time setup wizard.

## Configuring multiple media servers

Seerr supports Plex, Jellyfin, and Emby simultaneously. The **Settings** page contains three independent tabs — **Plex**, **Jellyfin**, and **Emby** — so you can configure any subset (one, two, or all three) without affecting the others.

### Enabling providers

1. Navigate to **Settings** in the Seerr web UI.
2. Open the tab for the provider you want to enable (**Plex**, **Jellyfin**, or **Emby**).
3. Enter the server details and click the **Sign In** (or **Test Connection**) button for that tab.
4. Repeat for any additional providers you wish to enable.

Each enabled provider gets its own **Login** button on the public login page, so users can authenticate with whichever provider their account belongs to.

### Multi-provider user accounts

A single Seerr user account can be simultaneously linked to all three providers. When a user signs in via a second or third provider and the email address matches an existing account, Seerr silently merges the identity — no duplicate accounts are created and no user action is required.

### Environment variable: TRUST_PROXY

If you run Seerr behind a reverse proxy, set the `TRUST_PROXY` environment variable so that Express correctly reads `X-Forwarded-*` headers. See [`.env.example`](../.env.example) for accepted values and security notes.
