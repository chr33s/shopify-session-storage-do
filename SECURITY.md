# Security policy

## Reporting a vulnerability

Report vulnerabilities privately through GitHub: on this repository's
**Security** tab, choose **Report a vulnerability**. Please don't open a public
issue, pull request or discussion about a suspected vulnerability.

Include what you found, the versions affected and how to reproduce it. Leave
real tokens, client secrets and shop data out of the report; saying where they
appear is enough.

We'll acknowledge the report, keep you updated while we work on a fix, and
credit you in the changelog unless you'd rather we didn't.

## Supported versions

This repository is shared as is. We fix vulnerabilities in the code our own
apps run and update this repository when we do. 0.2.1, the last version on npm,
won't necessarily get a new release.

## Scope

The README's [Security model](README.md#security-model) describes what the
package protects. These are by design and not vulnerabilities:

- Any Worker in the Cloudflare account that binds the Durable Object namespace
  can load any shop's access token: RPC callers aren't authenticated.
- Code that holds the encryption keyring can read every token. Encryption
  protects storage, not callers.
- With `appTokenKey` configured, code that holds the private key can get a
  token for every store that installed the app. That is how Shopify's
  application-only grant works; revoke the key in the Dev Dashboard if it
  leaks.
- `describe` returns non-secret status (scopes, expiry times, failure codes).
  Exposing it is the app's choice, and should go through an authenticated
  route.

We especially want to hear about:

- a token, refresh token or the client secret leaving the Durable Object, or
  reaching logs or reports;
- a token call, which carries the client secret or a signed client assertion,
  being sent anywhere but the shop's own `/admin/oauth/access_token`;
- an application-only token being served to `loadSession`, or minted for a
  shop without a record;
- one shop's object serving or overwriting another shop's credentials, or a
  sealed value opening under another shop or field;
- a single response from Shopify, or a single call from the library, that
  destroys a shop's credentials.
