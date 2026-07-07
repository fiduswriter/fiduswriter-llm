import {escapeText} from "fwtoolkit"

export const dialogTemplate = ({text, prompt, mode = "changes"}) =>
    `<table class="fw-dialog-table">
        <tr>
            <td>
                <label for="llm-prompt">${gettext("Instructions")}</label>
            </td>
        </tr>
        <tr>
            <td>
                <textarea id="llm-prompt" rows="4" style="width: 100%;" placeholder="${gettext("e.g. Fix the grammar in this text")}">${escapeText(prompt)}</textarea>
            </td>
        </tr>
        <tr>
            <td>
                <label>${gettext("Output mode")}</label>
            </td>
        </tr>
        <tr>
            <td>
                <label>
                    <input type="radio" name="llm-output-mode" value="changes" ${mode === "changes" ? "checked" : ""} />
                    ${gettext("Apply as tracked changes")}
                </label>
                <br />
                <label>
                    <input type="radio" name="llm-output-mode" value="comments" ${mode === "comments" ? "checked" : ""} />
                    ${gettext("Add as comments")}
                </label>
            </td>
        </tr>
        <tr>
            <td>
                <label>${gettext("Text to improve")}</label>
            </td>
        </tr>
        <tr>
            <td>
                <div id="llm-text-preview" style="max-height: 200px; overflow-y: auto; border: 1px solid #ccc; padding: 8px; background: #f9f9f9;">
                    ${escapeText(text)}
                </div>
            </td>
        </tr>
    </table>`

export const profileTemplate = ({url, model, apiKey, serverKey}) =>
    `<div class="profile-data-row">
        <label class="form-label">${gettext("LLM settings")}</label>
        <div class="profile-llm-settings">
            <p class="inline-editor-hint">${gettext("Configure the API key, URL and model for your preferred LLM service. The URL should point to an OpenAI-compatible chat completions endpoint.")}</p>
            <div class="profile-data-row">
                <label class="form-label">${gettext("API URL")}</label>
                <input type="url" id="llm-url" value="${escapeText(url)}" placeholder="https://openrouter.ai/api/v1/chat/completions" />
            </div>
            <div class="profile-data-row">
                <label class="form-label">${gettext("API key")}</label>
                <input type="password" id="llm-api-key" value="${escapeText(apiKey)}" placeholder="${serverKey ? gettext("Using server-provided API key") : gettext("Your API key")}" />
                ${serverKey ? `<p class="inline-editor-hint">${gettext("Leave empty to use the API key provided by the server operator.")}</p>` : ""}
            </div>
            <div class="profile-data-row">
                <span id="llm-fetch-models" class="fw-button fw-light fw-small">
                    <i class="fa fa-sync"></i> ${gettext("Fetch models")}
                </span>
                <span id="llm-model-status" class="fw-warning"></span>
            </div>
            <div class="profile-data-row">
                <label class="form-label">${gettext("Model")}</label>
                <select id="llm-model" disabled>
                    <option value="">${gettext("Fetch models first")}</option>
                </select>
                <input type="text" id="llm-model-manual" value="${escapeText(model)}" placeholder="${gettext("Or enter model name manually")}" />
            </div>
        </div>
    </div>`
