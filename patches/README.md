# Patches
Contains monkey patches for certain packages, applied using `patch-package`.

## `http-proxy+1.18.1.patch`
Modifies the `http-proxy` package to work around an incompatibility with
body-parser and SOCKS5 proxies due to some esoteric stream handling behavior
when `socks-proxy-agent` is used instead of a generic http.Agent.

Modification involves adjusting the `buffer` property on ProxyServer's `options`
object to be a function that returns a stream instead of a stream itself. This
allows us to give it a function which produces a new Readable from the already-
parsed request body.

With the old implementation we would need to create an entirely new ProxyServer
instance for each request, which is not ideal under heavy load.

`http-proxy` hasn't been updated in six years so it's unlikely that this patch
will be broken by future updates, but it's stil pinned to 1.18.1 for now.

### See also
https://github.com/chimurai/http-proxy-middleware/issues/40
https://github.com/chimurai/http-proxy-middleware/issues/299
https://github.com/http-party/node-http-proxy/pull/1027
