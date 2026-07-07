import {Dialog, addAlert, escapeText, findTarget} from "fwtoolkit"

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
            height: 460,
            title: gettext("Improve text with LLM"),
            body: dialogTemplate({
                text: this.options.text || "",
                prompt: this.prompt
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
    }

    submit() {
        const prompt = this.dialog.dialogEl.querySelector("#llm-prompt").value
        if (!prompt.trim()) {
            addAlert("error", gettext("Please enter instructions."))
            return
        }
        this.dialog.close()
        this.options.onSubmit(prompt)
    }
}
