"""Plugin settings.

Resolution order for every key:
    settings.PLUGIN_CONFIGS["care_careloop"][key]  →  environment variable  →  DEFAULTS[key]

The environment cast is inferred from the *type of the default*, so every default must be
correctly typed (use "" / 0 / False, never None).
"""

from typing import Any

import environ
from django.conf import settings
from django.core.exceptions import ImproperlyConfigured
from django.core.signals import setting_changed
from django.dispatch import receiver
from rest_framework.settings import perform_import

from care_careloop.apps import PLUGIN_NAME

env = environ.Env()


class PluginSettings:  # pragma: no cover
    """Access plugin settings as attributes.

    >>> from care_careloop.settings import plugin_settings
    >>> plugin_settings.CARELOOP_ENABLED
    """

    def __init__(
        self,
        plugin_name: str = None,
        defaults: dict | None = None,
        import_strings: set | None = None,
        required_settings: set | None = None,
    ) -> None:
        if not plugin_name:
            raise ValueError("Plugin name must be provided")
        self.plugin_name = plugin_name
        self.defaults = defaults or {}
        self.import_strings = import_strings or set()
        self.required_settings = required_settings or set()
        self._cached_attrs = set()
        self.validate()

    def __getattr__(self, attr) -> Any:
        if attr not in self.defaults:
            raise AttributeError("Invalid setting: '%s'" % attr)

        val = self.defaults[attr]
        try:
            val = self.user_settings[attr]
        except KeyError:
            try:
                val = env(attr, cast=type(val))
            except environ.ImproperlyConfigured:
                pass

        if attr in self.import_strings:
            val = perform_import(val, attr)

        self._cached_attrs.add(attr)
        setattr(self, attr, val)
        return val

    @property
    def user_settings(self) -> dict:
        if not hasattr(self, "_user_settings"):
            self._user_settings = getattr(settings, "PLUGIN_CONFIGS", {}).get(
                self.plugin_name, {}
            )
        return self._user_settings

    def validate(self) -> None:
        for setting in self.required_settings:
            if not getattr(self, setting):
                raise ImproperlyConfigured(
                    f'The "{setting}" setting is required. '
                    f'Set it in the environment or in the {PLUGIN_NAME} plugin config.'
                )

    def reload(self) -> None:
        for attr in self._cached_attrs:
            delattr(self, attr)
        self._cached_attrs.clear()
        if hasattr(self, "_user_settings"):
            delattr(self, "_user_settings")


# Deliberately EMPTY. A non-empty REQUIRED_SETTINGS raises ImproperlyConfigured at
# import time, which breaks `manage.py migrate` and `collectstatic` on any box without
# credentials — CI, and the release phase of a deploy. Missing credentials are reported
# by the Django system check in apps.py at Warning level instead, and the endpoints that
# need them fail at request time with a clear error. See constraint C7.
REQUIRED_SETTINGS: set[str] = set()

DEFAULTS = {
    "CARELOOP_ENABLED": True,
    # --- Sarvam Voice Agents: server-side only. Never surface these through
    # --- config/, never log them, never let them reach the browser bundle.
    "CARELOOP_SARVAM_API_KEY": "",
    "CARELOOP_SARVAM_ORG_ID": "",
    "CARELOOP_SARVAM_WORKSPACE_ID": "",
    "CARELOOP_SARVAM_BASE_URL": "https://apps.sarvam.ai",
    # The committed agent version is pinned per campaign, but these are the
    # workspace defaults a new campaign starts from.
    "CARELOOP_SARVAM_APP_ID": "",
    "CARELOOP_SARVAM_APP_VERSION": 0,
    # Telephony: which connection and which number the agent dials from.
    "CARELOOP_SARVAM_CONNECTION_ID": "",
    "CARELOOP_SARVAM_AGENT_PHONE_NUMBER": "",
    # Public base URL Sarvam can reach, used to build on_start / on_end / webhook
    # URLs. In local development this is a cloudflared or ngrok tunnel, so it is
    # NOT the same as the URL the browser uses — keep them separate (C9).
    # A tunnel hostname changes on restart; re-apply the agent config rather than
    # hardcoding one anywhere.
    "CARELOOP_PUBLIC_BASE_URL": "",
    # Sarvam caps a mid-call API tool at 30s, and every second is dead air on the
    # line. Keep our own budget well inside that.
    "CARELOOP_TOOL_TIMEOUT_SECONDS": 8,
    # Outbound calls to Sarvam must never hang a request thread.
    "CARELOOP_HTTP_TIMEOUT_SECONDS": 15,
    # The non-human principal that collected answers are attributed to, so the
    # record never implies a clinician asked the questions (C5).
    "CARELOOP_SERVICE_ACCOUNT_USERNAME": "careloop-agent",
    # Care-gap cohort defaults: how stale an instrument result has to be to count
    # as a gap, and how many dial attempts a candidate gets.
    "CARELOOP_GAP_STALE_DAYS": 180,
    "CARELOOP_MAX_CALL_ATTEMPTS": 3,
}


plugin_settings = PluginSettings(
    PLUGIN_NAME, defaults=DEFAULTS, required_settings=REQUIRED_SETTINGS
)


def sarvam_configured() -> bool:
    """Whether outbound calling can actually be attempted.

    Read by the system check and by `config/`, so a misconfigured deploy is
    visible in the UI rather than failing at the first clinician's click.
    """
    return bool(
        plugin_settings.CARELOOP_SARVAM_API_KEY
        and plugin_settings.CARELOOP_SARVAM_ORG_ID
        and plugin_settings.CARELOOP_SARVAM_WORKSPACE_ID
    )


def telephony_configured() -> bool:
    """Whether a connection and a number are available to dial from."""
    return bool(
        plugin_settings.CARELOOP_SARVAM_CONNECTION_ID
        and plugin_settings.CARELOOP_SARVAM_AGENT_PHONE_NUMBER
    )



@receiver(setting_changed)
def reload_plugin_settings(*args, **kwargs) -> None:
    if kwargs["setting"] == "PLUGIN_CONFIGS":
        plugin_settings.reload()
