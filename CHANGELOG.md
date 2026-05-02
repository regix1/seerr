# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

### Added
- Triple-provider support: Plex, Jellyfin, and Emby can now be configured simultaneously; any subset (one, two, or all three) can be enabled independently.
- New `settings.emby` block split out from `settings.jellyfin`; existing Emby installs migrated automatically (settings backup written to `settings.json.bak.0010`).
- New `embyLoginEnabled` flag and `/auth/emby` route; green Emby login button on the public Login page.
- New `emby-full-scan` and `emby-recently-added-scan` job families on the Settings → Jobs page.
- New `emby_user_id`, `emby_username`, `emby_auth_token`, `emby_device_id` columns on User entity.
- New `emby_media_id`, `emby_media_id_4k` columns on Media entity.
- True triple-link: one user account may simultaneously hold Plex, Jellyfin, and Emby identities (silent email-merge).
- `TRUST_PROXY` env var added (see `.env.example`); fixes the `ERR_ERL_PERMISSIVE_TRUST_PROXY` startup warning.

### Changed
- Three independent settings tabs: Plex, Jellyfin, Emby. Any subset can be enabled.
- `availabilitySync` now builds three independent provider clients.
- `MainSettings.mediaServerType` is now `@deprecated`; use `plexLoginEnabled` / `jellyfinLoginEnabled` / `embyLoginEnabled` instead.
- `JellyfinAPI` gained static factories: `forJellyfin(settings)` and `forEmby(settings)`.
- Login button layout: stacks vertically on mobile, horizontal at lg+ breakpoints.

### Migrations
- `0010_split_emby_block.ts` (settings) — splits old shared jellyfin block into separate jellyfin + emby blocks; backup written to `settings.json.bak.0010`.
- `AddEmbyUserParams` (TypeORM, postgres + sqlite) — adds emby* user columns; copies data from jellyfin* on EMBY-origin installs.
- `AddEmbyMediaIdColumns` (TypeORM, postgres + sqlite) — adds emby* media columns; copies data on EMBY-origin installs.
- All migrations are zero-downtime, idempotent, and safe to run multiple times. No manual action required.
