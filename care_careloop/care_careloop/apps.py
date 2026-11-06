from django.apps import AppConfig

PLUGIN_NAME = "care_careloop"


class CareCareloopConfig(AppConfig):
    name = PLUGIN_NAME
    verbose_name = "CareLoop"

    def ready(self):
        from care_careloop import signals  # noqa: F401
