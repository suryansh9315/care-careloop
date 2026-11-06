from django.apps import AppConfig
from django.core import checks
from django.utils.translation import gettext_lazy as _

PLUGIN_NAME = "care_careloop"


@checks.register()
def check_sarvam_credentials(app_configs, **kwargs):
    """Warn — never error — when the Sarvam credentials are unset.

    This must stay at Warning level. An Error-level check raises
    SystemCheckError, which would fail ``manage.py migrate`` and
    ``collectstatic`` on any box without credentials (CI, and the release phase
    of a deploy). Keeping REQUIRED_SETTINGS empty and warning here is what
    avoids that; the endpoints that need a credential fail at request time with
    a clear error instead. See constraint C7 in docs/REVAMP-PLAN.md.
    """
    from care_careloop.settings import sarvam_configured, telephony_configured

    issues = []
    if not sarvam_configured():
        issues.append(
            checks.Warning(
                "CARELOOP_SARVAM_API_KEY / _ORG_ID / _WORKSPACE_ID are not configured; "
                "outbound calling is disabled and dial actions will return 503.",
                hint=(
                    "Set them in the care_careloop plugin config (PLUGIN_CONFIGS) or as "
                    "environment variables. Review and approval work without them."
                ),
                id="care_careloop.W001",
            )
        )
    elif not telephony_configured():
        issues.append(
            checks.Warning(
                "Sarvam is configured but CARELOOP_SARVAM_CONNECTION_ID / "
                "_AGENT_PHONE_NUMBER are not; there is no number to dial from.",
                hint=(
                    "Add a telephony connection in the Sarvam workspace, onboard a "
                    "number, then set both values."
                ),
                id="care_careloop.W002",
            )
        )
    return issues


class CareCareloopConfig(AppConfig):
    name = PLUGIN_NAME
    verbose_name = _("CareLoop")

    def ready(self):
        # Importing registers the permission handler and the authorization
        # controller. Registration happens at module import, not deferred into a
        # function, because core resolves its role/permission mapping from
        # whatever has registered by then. See constraint C6.
        from care_careloop.security import authorization  # noqa: F401
        from care_careloop import signals  # noqa: F401
