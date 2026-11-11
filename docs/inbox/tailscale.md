https://tailscale.com/docs/features/oauth-apps
I need to add this support, in one day, we will enable to use this to connect with user's desktop.
# OAuth apps

Last validated Oct 16, 2026

OAuth apps let internal tools act upon a tailnet on behalf of individual users through a standard OAuth 2.0 authorization code flow ([RFC 6749 section 4.1][xt-rfc-6749]). A user completes a Tailscale-hosted consent screen, and the resulting authorization carries that user's identity. Access control rules, audit log entries, and quotas apply to the user who granted consent, not to a shared service identity.

Each OAuth authorization flow follows the same pattern, so the topics below share a common structure. An [Owner](/docs/reference/user-roles/) or [Admin](/docs/reference/user-roles/) creates an OAuth app through the [Tailscale API][docs-api], and a developer implements the authorization code flow in their tool.

> **Note:**
>
> OAuth apps and [OAuth clients][docs-oauth-clients] are different mechanisms. OAuth clients use the client credentials flow to create tag-owned resources tied to a service identity. OAuth apps use the authorization code flow to act on behalf of an individual user. For an overview of all OAuth-related documentation, refer to the [OAuth hub][docs-oauth-hub].

## Requirements

Before you create an OAuth app, confirm you meet the following requirements.

* [Owner](/docs/reference/user-roles/) or [Admin](/docs/reference/user-roles/) role in the tailnet.
* An API access token with admin scope for creating OAuth apps through the API.
* The OAuth app and every user who authorizes through it must belong to the same tailnet. This flow does not support users from other tailnets.
* For developers implementing the flow: working knowledge of OAuth 2.0 authorization code grants and the ability to handle HTTP redirects and token exchanges.

## Guides

The following guides cover specific tasks you can perform with OAuth apps.

[**Device provisioning with OAuth apps**](/docs/features/oauth-apps/device-provisioning) — Build internal tools that provision tailnet devices on behalf of individual users with a standard OAuth authorization code flow, so each device carries the consenting user's identity.

## Limitations

* Authorization is restricted to a single tailnet. Only users in the same tailnet as the OAuth app can authorize through it.
* The Tailscale-hosted consent screen cannot be customized.

[docs-api]: /docs/reference/tailscale-api

[docs-oauth-clients]: /docs/features/oauth-clients

[docs-oauth-hub]: /docs/oauth

[xt-rfc-6749]: https://www.rfc-editor.org/rfc/rfc6749.html#section-4.1
