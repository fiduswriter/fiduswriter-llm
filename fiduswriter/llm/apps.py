from django.apps import AppConfig
from django.conf import settings


class Config(AppConfig):
    name = "llm"
    default_auto_field = "django.db.models.AutoField"

    def ready(self):
        from base.views import FRONTEND_SETTINGS

        FRONTEND_SETTINGS.update(
            {
                "LLM_URL": getattr(settings, "LLM_URL", ""),
                "LLM_MODEL": getattr(settings, "LLM_MODEL", ""),
                "LLM_API_KEY_CONFIGURED": bool(
                    getattr(settings, "LLM_API_KEY", "")
                ),
            }
        )
