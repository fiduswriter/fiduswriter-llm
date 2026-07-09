import {Dialog, addAlert, findTarget, gettext} from "fwtoolkit"

import {dialogTemplate} from "./templates"

export class LLMDialog {
    constructor(editor, options = {}) {
        this.editor = editor
        this.options = options
        this.prompt = options.prompt || ""
    }

    init() {
        this.dialog = new Dialog({
            width: 500,
            height: 580,
            title: gettext("Improve text with LLM"),
            body: dialogTemplate({
                text: this.options.text || "",
                prompt: this.prompt,
                mode: this.options.mode || "proposals"
            }),
            buttons: [
                {
                    text: gettext("Improve"),
                    classes: "fw-dark",
                    click: () => this.submit()
                },
                {
                    type: "cancel"
                }
            ]
        })
        this.dialog.open()
        this.bind()
        this.updateQualityChecksVisibility()
    }

    bind() {
        this.dialog.dialogEl.addEventListener("click", event => {
            const el = {}
            switch (true) {
                case findTarget(event, "#llm-prompt", el):
                    el.target.focus()
                    break
                default:
                    break
            }
        })
        const outputModeRadios = this.dialog.dialogEl.querySelectorAll(
            'input[name="llm-output-mode"]'
        )
        outputModeRadios.forEach(radio => {
            radio.addEventListener("change", () =>
                this.updateQualityChecksVisibility()
            )
        })
        const translationCheckEl = this.dialog.dialogEl.querySelector(
            "#llm-translation-check"
        )
        translationCheckEl?.addEventListener("change", () =>
            this.onTranslationCheckChanged()
        )
    }

    onTranslationCheckChanged() {
        const translationCheckEl = this.dialog.dialogEl.querySelector(
            "#llm-translation-check"
        )
        const requireChangesEl = this.dialog.dialogEl.querySelector(
            "#llm-require-changes"
        )
        const minWordDiffCheckEl = this.dialog.dialogEl.querySelector(
            "#llm-min-word-diff-check"
        )
        const minWordDiffPercentEl = this.dialog.dialogEl.querySelector(
            "#llm-min-word-diff-percent"
        )
        if (
            !translationCheckEl ||
            !requireChangesEl ||
            !minWordDiffCheckEl ||
            !minWordDiffPercentEl
        ) {
            return
        }
        if (translationCheckEl.checked) {
            requireChangesEl.checked = true
            if (!minWordDiffCheckEl.checked) {
                minWordDiffCheckEl.checked = true
                minWordDiffPercentEl.value = 70
            }
        }
    }

    updateQualityChecksVisibility() {
        const outputMode =
            this.dialog.dialogEl.querySelector(
                'input[name="llm-output-mode"]:checked'
            )?.value || "proposals"
        const checksEl = this.dialog.dialogEl.querySelector(
            ".llm-quality-checks"
        )
        if (!checksEl) {
            return
        }
        const hideChecks =
            outputMode === "comments" || outputMode === "global_comment"
        checksEl.style.display = hideChecks ? "none" : ""
    }

    submit() {
        const prompt = this.dialog.dialogEl.querySelector("#llm-prompt").value
        if (!prompt.trim()) {
            addAlert("error", gettext("Please enter instructions."))
            return
        }
        const outputMode =
            this.dialog.dialogEl.querySelector(
                'input[name="llm-output-mode"]:checked'
            )?.value || "proposals"
        const lengthCheckEl =
            this.dialog.dialogEl.querySelector("#llm-length-check")
        const lengthCheckEnabled = lengthCheckEl?.checked || false
        const lengthPercentEl = this.dialog.dialogEl.querySelector(
            "#llm-length-percent"
        )
        const maxLengthDiffPercent = lengthPercentEl
            ? Number.parseFloat(lengthPercentEl.value)
            : 25
        if (
            lengthCheckEnabled &&
            (Number.isNaN(maxLengthDiffPercent) || maxLengthDiffPercent <= 0)
        ) {
            addAlert(
                "error",
                gettext(
                    "Please enter a valid maximum length difference percentage."
                )
            )
            return
        }
        const requireChangesEl = this.dialog.dialogEl.querySelector(
            "#llm-require-changes"
        )
        const requireChanges = requireChangesEl?.checked || false
        const minWordDiffCheckEl = this.dialog.dialogEl.querySelector(
            "#llm-min-word-diff-check"
        )
        const minWordDiffCheckEnabled = minWordDiffCheckEl?.checked || false
        const minWordDiffPercentEl = this.dialog.dialogEl.querySelector(
            "#llm-min-word-diff-percent"
        )
        const minWordDiffPercent = minWordDiffPercentEl
            ? Number.parseFloat(minWordDiffPercentEl.value)
            : 50
        if (
            minWordDiffCheckEnabled &&
            (Number.isNaN(minWordDiffPercent) ||
                minWordDiffPercent < 0 ||
                minWordDiffPercent > 100)
        ) {
            addAlert(
                "error",
                gettext(
                    "Please enter a valid minimum word difference percentage."
                )
            )
            return
        }
        const translationCheckEl = this.dialog.dialogEl.querySelector(
            "#llm-translation-check"
        )
        const translationCheckEnabled = translationCheckEl?.checked || false
        this.dialog.close()
        this.options.onSubmit(prompt, outputMode, {
            translationCheckEnabled,
            lengthCheckEnabled,
            maxLengthDiffPercent,
            requireChanges,
            minWordDiffCheckEnabled,
            minWordDiffPercent
        })
    }
}
