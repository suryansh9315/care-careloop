from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from care_careloop.clinical import list_modules
from care_careloop.settings import (
    plugin_settings,
    sarvam_configured,
    telephony_configured,
)


class ConfigView(APIView):
    """Client-safe configuration, so the frontend hardcodes nothing.

    Only values that are safe in a browser. The Sarvam API key, org and
    workspace ids and the public base URL are server-side concerns and are
    reported here only as booleans, never as values (constraint C8 / the
    credential-broker pattern).
    """

    permission_classes = [IsAuthenticated]

    def get(self, request):
        return Response(
            {
                "enabled": plugin_settings.CARELOOP_ENABLED,
                # Capability flags, not credentials: the UI can explain *why*
                # dialling is unavailable instead of failing opaquely.
                "calling_available": sarvam_configured() and telephony_configured(),
                "sarvam_configured": sarvam_configured(),
                "telephony_configured": telephony_configured(),
                "gap_stale_days_default": plugin_settings.CARELOOP_GAP_STALE_DAYS,
                "max_call_attempts": plugin_settings.CARELOOP_MAX_CALL_ATTEMPTS,
                "modules": [
                    {
                        "id": m.id,
                        "display": m.display,
                        "instrument": m.instrument.name,
                        "min_total": m.instrument.min_total,
                        "max_total": m.instrument.max_total,
                        "direction": m.instrument.direction,
                        "bands": [
                            {"id": b.id, "label": b.label, "min": b.min, "max": b.max}
                            for b in m.bands
                        ],
                    }
                    for m in list_modules()
                ],
            }
        )
