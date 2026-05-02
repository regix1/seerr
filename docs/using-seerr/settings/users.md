---
title: User Settings
description: Configure global and default user settings.
sidebar_position: 2
---

# Users

## Enable Local Sign-In

When enabled, users who have configured passwords will be allowed to sign in using their email address.

When disabled, your mediaserver OAuth becomes the only sign-in option, and any "local users" you have created will not be able to sign in to Seerr.

This setting is **enabled** by default.

## Enable Media Server Sign-In

When enabled for a provider, users will be able to sign in to Seerr using their Plex, Jellyfin, or Emby credentials, provided they have linked that media server account.

When disabled, users will only be able to sign in using their email address. Users without a password set will not be able to sign in to Seerr.

This setting is **enabled** by default.

## Enable New Media Server Sign-In

When enabled, users with access to your media server will be able to sign in to Seerr even if they have not yet been imported. Users will be automatically assigned the permissions configured in the [Default Permissions](#default-permissions) setting upon first sign-in.

This setting is **enabled** by default.

## Global Movie Request Limit & Global Series Request Limit

Select the request limits you would like granted to users.

Unless an override is configured, users are granted these global request limits.

Note that users with the **Manage Users** permission are exempt from request limits, since that permission also grants the ability to submit requests on behalf of other users.

## Default Permissions

Select the permissions you would like assigned to new users to have by default upon account creation.

If [Enable New Media Server Sign-In](#enable-new-media-server-sign-in) is enabled, any user with access to an enabled media server will be able to sign in to Seerr, and they will be granted the permissions you select here upon first sign-in.

This setting only affects new users, and has no impact on existing users. In order to modify permissions for existing users, you will need to edit the users.
