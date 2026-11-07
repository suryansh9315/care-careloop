"""Place an outbound call through Sarvam Voice Agents.

The credential-broker boundary: the Sarvam API key lives only here and in
plugin settings. It never reaches `config/`, the browser bundle, a log line, or
an error message returned to a client.

Shape of the call, from Sarvam's API reference:

    POST {base}/api/outbounds/v1/orgs/{org}/workspaces/{workspace}/outbounds
    X-API-Key: <workspace key>
    {
      "app_config":  {"app_id", "app_version", "connection_config": {...},
                      "agent_variables": {...}},
      "user_config": {"user_phone_number"},
      "webhook_config": {"url", "metadata"}
    }
    -> {"attempt_id": "..."}

Two rules that matter more than the shape:

* **The destination host comes from settings, never from a caller.** Building a
  request to a client-supplied host is SSRF.
* **Always time out.** An external service hanging must not hang a CARE request
  thread. There is no retry here: a retried dial is a *second phone call to a
  patient*, which is a clinical decision, not a transport concern.
"""

from __future__ import annotations

import logging

from care_careloop.settings import plugin_settings, sarvam_configured, telephony_configured

logger = logging.getLogger(__name__)


class SarvamNotConfigured(RuntimeError):
    """Credentials or telephony are missing. A deploy problem, not a bug."""


class SarvamCallFailed(RuntimeError):
    """Sarvam refused or could not be reached."""


def outbound_url() -> str:
    """The instant-outbound endpoint, built entirely from settings."""
    base = plugin_settings.CARELOOP_SARVAM_BASE_URL.rstrip("/")
    org = plugin_settings.CARELOOP_SARVAM_ORG_ID
    workspace = plugin_settings.CARELOOP_SARVAM_WORKSPACE_ID
    return f"{base}/api/outbounds/v1/orgs/{org}/workspaces/{workspace}/outbounds"


def webhook_url(nonce: str, path: str = "webhook") -> str:
    """A nonce-bearing callback URL Sarvam can reach.

    Built from ``CARELOOP_PUBLIC_BASE_URL``, which is a tunnel in development
    and is deliberately a *separate* setting from whatever the browser uses —
    conflating client-facing and externally-reachable URLs works in exactly one
    of the two environments.
    """
    base = plugin_settings.CARELOOP_PUBLIC_BASE_URL.rstrip("/")
    if not base:
        raise SarvamNotConfigured(
            "CARELOOP_PUBLIC_BASE_URL is not set, so Sarvam has no address to "
            "call back on. In development this is a cloudflared or ngrok tunnel."
        )
    return f"{base}/api/care_careloop/sarvam/{path}/?n={nonce}"


def place_call(
    *,
    phone_number: str,
    nonce: str,
    agent_variables: dict | None = None,
    app_id: str = "",
    app_version: int = 0,
    connection_id: str = "",
    agent_phone_number: str = "",
) -> str:
    """Dial one patient. Returns Sarvam's ``attempt_id``.

    The agent id and version are passed in rather than read from settings, so a
    call is placed against the version the *campaign* pinned. A workspace
    default that moved on mid-campaign must not silently change what patients
    hear.
    """
    if not sarvam_configured():
        raise SarvamNotConfigured(
            "Sarvam credentials are not configured; outbound calling is disabled."
        )
    if not (connection_id or telephony_configured()):
        raise SarvamNotConfigured(
            "No Sarvam telephony connection is configured, so there is no number "
            "to dial from."
        )

    # Imported here, not at module import, so an optional dependency or a slow
    # import can never block Django startup.
    import requests

    payload = {
        "app_config": {
            "app_id": app_id or plugin_settings.CARELOOP_SARVAM_APP_ID,
            "app_version": app_version or plugin_settings.CARELOOP_SARVAM_APP_VERSION,
            "connection_config": {
                "connection_id": connection_id
                or plugin_settings.CARELOOP_SARVAM_CONNECTION_ID,
                "agent_phone_number": agent_phone_number
                or plugin_settings.CARELOOP_SARVAM_AGENT_PHONE_NUMBER,
            },
            "agent_variables": agent_variables or {},
        },
        "user_config": {"user_phone_number": phone_number},
        "webhook_config": {
            "url": webhook_url(nonce),
            # Echoed back in every delivery, so the nonce survives even if the
            # query string is stripped somewhere in transit.
            "metadata": {"nonce": nonce},
        },
    }

    try:
        response = requests.post(
            outbound_url(),
            json=payload,
            headers={
                "X-API-Key": plugin_settings.CARELOOP_SARVAM_API_KEY,
                "Content-Type": "application/json",
            },
            timeout=plugin_settings.CARELOOP_HTTP_TIMEOUT_SECONDS,
        )
    except requests.RequestException as exc:
        # Deliberately does not include the exception's repr in the message a
        # client sees: a requests error can echo the URL, and the URL is built
        # from org and workspace ids.
        logger.exception("careloop.sarvam.unreachable")
        raise SarvamCallFailed("Could not reach Sarvam to place the call.") from exc

    if response.status_code >= 400:
        # Log the body for operators; do not hand it to the caller, since a
        # provider error can quote back parts of the request.
        logger.error(
            "careloop.sarvam.rejected status=%s body=%s",
            response.status_code,
            response.text[:500],
        )
        raise SarvamCallFailed(
            f"Sarvam refused the call (HTTP {response.status_code})."
        )

    try:
        attempt_id = response.json()["attempt_id"]
    except (ValueError, KeyError) as exc:
        logger.error("careloop.sarvam.bad_response body=%s", response.text[:500])
        raise SarvamCallFailed("Sarvam returned no attempt_id.") from exc

    logger.info("careloop.sarvam.call_placed attempt_id=%s", attempt_id)
    return str(attempt_id)
