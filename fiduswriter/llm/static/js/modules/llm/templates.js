import {escapeText, gettext} from "fwtoolkit"

const PREVIEW_PLACEHOLDER_LABELS = {
    citation: gettext("citation"),
    equation: gettext("equation"),
    cross_reference: gettext("cross-reference"),
    footnote: gettext("footnote")
}

const PREVIEW_PLACEHOLDER_PATTERN = /\[NODE:\s*(\w+)\s*:\s*(\d+)\s*\]/gi

export const formatPreviewText = text =>
    escapeText(text).replace(
        PREVIEW_PLACEHOLDER_PATTERN,
        (_match, type) =>
            `[${PREVIEW_PLACEHOLDER_LABELS[type.toLowerCase()] || gettext("non-text element")}]`
    )

export const dialogTemplate = ({text, prompt, mode = "proposals"}) =>
    `<style>
        .llm-dialog-table .llm-output-mode-options label {
            display: block;
            margin-bottom: 4px;
        }
        .llm-dialog-table .llm-quality-checks td {
            padding-top: 12px;
            border-top: 1px solid var(--cs-light-border);
        }
        .llm-dialog-table .llm-quality-header {
            font-weight: bold;
            margin-bottom: 8px;
        }
        .llm-dialog-table .llm-check-label {
            display: flex;
            align-items: baseline;
            gap: 6px;
            flex-wrap: wrap;
            margin-bottom: 6px;
        }
        .llm-dialog-table .llm-check-label input[type="number"] {
            width: 50px;
            text-align: right;
        }
        .llm-dialog-table .llm-check-label input[type="checkbox"] {
            margin-right: 2px;
            flex-shrink: 0;
        }
    </style>
    <table class="fw-dialog-table llm-dialog-table">
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
                <div class="llm-output-mode-options">
                    <label>
                        <input type="radio" name="llm-output-mode" value="proposals" ${mode === "proposals" ? "checked" : ""} />
                        ${gettext("Review proposed changed before applying (right-click)")}
                    </label>
                    <label>
                        <input type="radio" name="llm-output-mode" value="direct" ${mode === "direct" ? "checked" : ""} />
                        ${gettext("Apply proposals directly to the document")}
                    </label>
                    <label>
                        <input type="radio" name="llm-output-mode" value="changes" ${mode === "changes" ? "checked" : ""} />
                        ${gettext("Apply proposals as tracked changes")}
                    </label>
                    <label>
                        <input type="radio" name="llm-output-mode" value="comments" ${mode === "comments" ? "checked" : ""} />
                        ${gettext("Add LLM suggestions as comments on the text")}
                    </label>
                    <label>
                        <input type="radio" name="llm-output-mode" value="global_comment" ${mode === "global_comment" ? "checked" : ""} />
                        ${gettext("Add a single comment on the entire document")}
                    </label>
                </div>
            </td>
        </tr>
        <tr class="llm-quality-checks">
            <td>
                <div class="llm-quality-header">${gettext("Quality checks")}</div>
                <div class="llm-check-label">
                    <input type="checkbox" id="llm-translation-check" />
                    ${gettext("LLM is expected to translate the text to another language")}
                </div>
                <div class="llm-check-label">
                    <input type="checkbox" id="llm-length-check" />
                    ${gettext("Expect each modified paragraph or heading to differ by at most")}
                    <input type="number" id="llm-length-percent" value="25" size="3" class="fw-inline" />
                    %
                </div>
                <div class="llm-check-label">
                    <input type="checkbox" id="llm-accept-unchanged" />
                    ${gettext("Accept that some paragraphs or headings may remain unchanged")}
                </div>
                <div class="llm-check-label">
                    <input type="checkbox" id="llm-min-word-diff-check" />
                    ${gettext("Expect each modified paragraph or heading to differ by at least")}
                    <input type="number" id="llm-min-word-diff-percent" value="50" size="3" class="fw-inline" />
                    % ${gettext("of words from the original")}
                </div>
            </td>
        </tr>
        <tr>
            <td>
                <label>${gettext("Text to improve")}</label>
            </td>
        </tr>
        <tr>
            <td>
                <div id="llm-text-preview" style="max-height: 200px; overflow-y: auto; border: 1px solid #ccc; padding: 8px; background: #f9f9f9; white-space: pre-wrap;">
                    ${formatPreviewText(text)}
                </div>
            </td>
        </tr>
    </table>`

export const reviewDialogTemplate = ({original, improved, username}) =>
    `<table class="fw-dialog-table">
        <tr>
            <td>
                <label>${gettext("Original text")}</label>
            </td>
        </tr>
        <tr>
            <td>
                <div style="max-height: 120px; overflow-y: auto; border: 1px solid #ccc; padding: 8px; background: #f9f9f9; white-space: pre-wrap;">
                    ${formatPreviewText(original)}
                </div>
            </td>
        </tr>
        <tr>
            <td>
                <label>${gettext("Proposed text by")} ${escapeText(username)}</label>
            </td>
        </tr>
        <tr>
            <td>
                <div style="max-height: 120px; overflow-y: auto; border: 1px solid #ccc; padding: 8px; background: #f9f9f9; white-space: pre-wrap;">
                    ${formatPreviewText(improved)}
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
