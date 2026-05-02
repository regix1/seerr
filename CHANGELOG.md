# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

### Added
- Triple-provider support: Plex, Jellyfin, and Emby can now be configured simultaneously
- New `embyLoginEnabled` flag, `settings.emby` block, and `/api/v1/auth/emby` route
- New `emby_user_id`, `emby_username`, `emby_auth_token`, `emby_device_id` columns on User entity
- New `emby_media_id`, `emby_media_id_4k` columns on Media entity
- New `emby-recently-added-scan` and `emby-full-scan` jobs
- True triple-link: a single user may now hold Plex, Jellyfin, and Emby identities simultaneously via the Linked Accounts settings page
- New EmbyLoginButton (green) on the login page
- Documented `TRUST_PROXY` environment variable for reverse-proxy deployments

### Changed
- `availabilitySync` now builds three independent provider clients
- Settings tabs are now three independent tabs (Plex / Jellyfin / Emby) regardless of legacy `mediaServerType`
- `MainSettings.mediaServerType` is now @deprecated; use the per-provider flags instead
- `JellyfinAPI` gained static factories: `forJellyfin(settings)` and `forEmby(settings)`
- Login button layout: stacks vertically on mobile, horizontal at lg+ breakpoints

### Migrations
- Settings JSON `0010_split_emby_block.ts` — splits old shared jellyfin block into separate jellyfin + emby blocks
- TypeORM `AddEmbyUserParams` (postgres + sqlite) — adds emby* user columns; copies data from jellyfin* on EMBY-origin installs
- TypeORM `AddEmbyMediaIdColumns` (postgres + sqlite) — adds emby* media columns; copies data on EMBY-origin installs
- All migrations are idempotent and safe to run multiple times; no manual admin action required
