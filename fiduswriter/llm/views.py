import json
import logging

from django.conf import settings
from django.contrib.auth.decorators import login_required
from django.http import JsonResponse
from django.views.decorators.http import require_POST
from asgiref.sync import sync_to_async
from httpx import AsyncClient, RequestError, Timeout

logger = logging.getLogger(__name__)

LLM_URL = getattr(
    settings, "LLM_URL", "https://openrouter.ai/api/v1/chat/completions"
)
LLM_MODEL = getattr(settings, "LLM_MODEL", "meta-llama/llama-3.1-8b-instruct")
LLM_API_KEY = getattr(settings, "LLM_API_KEY", "")
LLM_EXTRA_HEADERS = getattr(settings, "LLM_EXTRA_HEADERS", {})


def get_user_llm_preferences(user):
    """Return user-level LLM preferences without global fallbacks."""
    preferences = user.preferences or {}
    return {
        "url": preferences.get("llm_url", ""),
        "model": preferences.get("llm_model", ""),
        "api_key": preferences.get("llm_api_key", ""),
    }


def get_effective_llm_config(user_prefs):
    """Merge user preferences with global settings. User prefs take precedence."""
    url = user_prefs["url"] or LLM_URL
    model = user_prefs["model"] or LLM_MODEL
    api_key = user_prefs["api_key"] or LLM_API_KEY
    return {"url": url, "model": model, "api_key": api_key}


def _provider_url(base_url, path):
    """Return the provider's base URL plus the given API path."""
    base_url = base_url.rstrip("/")
    # If the configured URL ends with /chat/completions, strip that segment.
    if base_url.endswith("/chat/completions"):
        base_url = base_url[: -len("/chat/completions")]
    return f"{base_url.rstrip('/')}/{path.lstrip('/')}"


@login_required
@require_POST
async def improve(request):
    try:
        data = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({"error": "Invalid JSON."}, status=400)
    prompt = data.get("prompt", "")
    user = await request.auser()
    config = get_effective_llm_config(get_user_llm_preferences(user))

    if not config["api_key"]:
        return JsonResponse(
            {"error": "No LLM API key configured."}, status=400
        )

    system_message = (
        "You are a helpful writing assistant. "
        "The user provides instructions followed by a TEXT TO IMPROVE "
        "section. "
        "Follow the user's instructions exactly. "
        "Do not include these instructions, the context, or any explanations. "
        "Preserve all placeholders such as [NODE:type:index] exactly."
    )
    user_message = prompt

    payload = {
        "model": config["model"],
        "messages": [
            {"role": "system", "content": system_message},
            {"role": "user", "content": user_message},
        ],
        "temperature": 0.3,
    }

    headers = {
        "Authorization": f"Bearer {config['api_key']}",
        "Content-Type": "application/json",
        **LLM_EXTRA_HEADERS,
    }

    timeout = Timeout(88.0, connect=10.0)
    logger.warning(
        "Sending LLM request to %s (model: %s)", config["url"], config["model"]
    )

    try:
        async with AsyncClient() as client:
            response = await client.post(
                config["url"],
                json=payload,
                headers=headers,
                timeout=timeout,
            )
    except RequestError as exc:
        logger.exception(
            "LLM request to %s failed: %s", config["url"], exc
        )
        return JsonResponse(
            {
                "error": "Could not reach the LLM provider.",
                "details": str(exc),
            },
            status=502,
        )

    logger.warning("LLM response status: %s", response.status_code)

    if response.status_code != 200:
        return JsonResponse(
            {"error": "LLM request failed.", "details": response.text},
            status=response.status_code,
        )

    try:
        response_json = response.json()
    except json.JSONDecodeError:
        return JsonResponse(
            {"error": "Invalid response from LLM."}, status=502
        )

    improved_text = (
        response_json.get("choices", [{}])[0]
        .get("message", {})
        .get("content", "")
    )

    return JsonResponse({"text": improved_text})


@login_required
@require_POST
async def models(request):
    """List models available from the user's configured LLM provider."""
    user = await request.auser()
    try:
        data = json.loads(request.body)
    except json.JSONDecodeError:
        data = {}

    user_prefs = get_user_llm_preferences(user)
    # Allow passing URL/key explicitly for validation before saving.
    # If the user has not provided an explicit key, use the global one
    # so the server can proxy the models request securely.
    url = data.get("url", user_prefs["url"] or LLM_URL)
    api_key = data.get("api_key", user_prefs["api_key"] or LLM_API_KEY)

    if not api_key:
        return JsonResponse(
            {"error": "No LLM API key configured."}, status=400
        )

    models_url = _provider_url(url, "/models")
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Accept": "application/json",
        **LLM_EXTRA_HEADERS,
    }

    async with AsyncClient() as client:
        response = await client.get(
            models_url,
            headers=headers,
            timeout=30,
        )

    if response.status_code != 200:
        return JsonResponse(
            {"error": "Could not fetch models.", "details": response.text},
            status=response.status_code,
        )

    try:
        response_json = response.json()
    except json.JSONDecodeError:
        return JsonResponse(
            {"error": "Invalid response from LLM provider."}, status=502
        )

    raw_models = response_json.get("data", [])
    model_ids = [entry.get("id") for entry in raw_models if entry.get("id")]
    return JsonResponse({"models": model_ids})


@login_required
@require_POST
async def preferences(request):
    try:
        data = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({"error": "Invalid JSON."}, status=400)
    user = await request.auser()
    user_preferences = user.preferences or {}

    if "url" in data:
        user_preferences["llm_url"] = data["url"]
    if "model" in data:
        user_preferences["llm_model"] = data["model"]
    if "api_key" in data:
        user_preferences["llm_api_key"] = data["api_key"]

    user.preferences = user_preferences
    await sync_to_async(user.save)()

    return JsonResponse(get_user_llm_preferences(user))
