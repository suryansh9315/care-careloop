"""URL routes.

Core mounts this module at /api/care_careloop/ via the PLUGIN_APPS loop in
config/urls.py. Do not repeat that prefix here.

The webhook is deliberately outside any router and carries no CARE auth: Sarvam
has no CARE session, so it authenticates with a per-call nonce instead (C8).
Give Sarvam this exact path when configuring an agent:

    POST /api/care_careloop/sarvam/webhook/?n=<nonce>
"""

from django.urls import path
from rest_framework.routers import DefaultRouter

from care_careloop.viewsets.calls import StartCallView
from care_careloop.viewsets.config import ConfigView
from care_careloop.viewsets.review import CheckInDraftViewSet
from care_careloop.viewsets.hooks import (
    OnEndView,
    OnStartView,
    RaiseCrisisFlagView,
)
from care_careloop.viewsets.webhook import SarvamWebhookView

router = DefaultRouter()
router.register("drafts", CheckInDraftViewSet, basename="careloop-draft")

urlpatterns = [
    *router.urls,
    path("config/", ConfigView.as_view(), name="care_careloop-config"),
    path("calls/", StartCallView.as_view(), name="care_careloop-start-call"),
    path(
        "sarvam/on_start/", OnStartView.as_view(), name="care_careloop-sarvam-on-start"
    ),
    path("sarvam/on_end/", OnEndView.as_view(), name="care_careloop-sarvam-on-end"),
    path(
        "sarvam/crisis/",
        RaiseCrisisFlagView.as_view(),
        name="care_careloop-sarvam-crisis",
    ),
    path(
        "sarvam/webhook/",
        SarvamWebhookView.as_view(),
        name="care_careloop-sarvam-webhook",
    ),
]
