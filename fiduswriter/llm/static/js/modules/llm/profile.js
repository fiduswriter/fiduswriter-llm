import {addAlert, escapeText, post, postJson} from "fwtoolkit"

import {profileTemplate} from "./templates"

export class LLMProfile {
    constructor(profile) {
        this.profile = profile
    }

    init() {
        const preferences = this.profile.user.preferences || {}
        const settings = this.profile.app.settings
        const serverKey = Boolean(settings.LLM_URL && settings.LLM_MODEL)
        this.profile.pluginTemplates.push(
            profileTemplate({
                url: preferences.llm_url || settings.LLM_URL || "",
                model: preferences.llm_model || settings.LLM_MODEL || "",
                apiKey: preferences.llm_api_key || "",
                serverKey
            })
        )

        const originalSave = this.profile.save.bind(this.profile)
        this.profile.save = () => originalSave().then(() => this.saveLLMPreferences())

        this.profile.postRenderHandlers.push(() => this.bind())
    }

    bind() {
        const fetchButton = this.profile.dom.querySelector("#llm-fetch-models")
        if (!fetchButton) {
            return
        }
        fetchButton.addEventListener("click", () => this.fetchModels())

        const modelSelect = this.profile.dom.querySelector("#llm-model")
        const modelManual = this.profile.dom.querySelector("#llm-model-manual")
        modelSelect.addEventListener("change", () => {
            if (modelSelect.value) {
                modelManual.value = modelSelect.value
            }
        })

        // If a model is already set, try to populate the dropdown.
        if (modelManual.value) {
            this.fetchModels()
        }
    }

    getEffectiveUrl() {
        const urlInput = this.profile.dom.querySelector("#llm-url")
        return urlInput.value.trim() || urlInput.placeholder || ""
    }

    fetchModels() {
        const url = this.getEffectiveUrl()
        const apiKey = this.profile.dom.querySelector("#llm-api-key").value
        const statusEl = this.profile.dom.querySelector("#llm-model-status")
        const selectEl = this.profile.dom.querySelector("#llm-model")
        const modelManual = this.profile.dom.querySelector("#llm-model-manual")

        if (!url || !apiKey) {
            statusEl.textContent = gettext("Please enter both URL and API key.")
            return
        }

        statusEl.textContent = gettext("Fetching models...")
        postJson("/api/llm/models/", {url, api_key: apiKey})
            .then(({json, status}) => {
                if (status !== 200) {
                    statusEl.textContent =
                        json.error || gettext("Could not fetch models.")
                    return
                }
                const models = json.models || []
                if (!models.length) {
                    statusEl.textContent = gettext("No models found.")
                    return
                }
                selectEl.innerHTML = models
                    .map(
                        model =>
                            `<option value="${escapeText(model)}" ${model === modelManual.value ? "selected" : ""}>${escapeText(model)}</option>`
                    )
                    .join("")
                selectEl.disabled = false
                statusEl.textContent = gettext("Models loaded.")
            })
            .catch(() => {
                statusEl.textContent = gettext("Could not fetch models.")
            })
    }

    saveLLMPreferences() {
        const url = this.getEffectiveUrl()
        const apiKey = this.profile.dom.querySelector("#llm-api-key").value
        const model = this.profile.dom.querySelector("#llm-model-manual").value.trim()

        return post("/api/llm/preferences/", {
            url,
            api_key: apiKey,
            model
        }).catch(() => {
            addAlert("error", gettext("Could not save LLM preferences"))
        })
    }
}
