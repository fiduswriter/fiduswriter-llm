import {Dialog, gettext} from "fwtoolkit"

import {reviewDialogTemplate} from "./templates"

export class LLMReviewDialog {
    constructor(editor, view, proposal, editorLlm) {
        this.editor = editor
        this.view = view
        this.proposal = proposal
        this.editorLlm = editorLlm
    }

    init() {
        this.dialog = new Dialog({
            width: 500,
            height: 480,
            title: gettext("Review LLM proposal"),
            body: reviewDialogTemplate({
                original: this.proposal.originalText,
                improved: this.proposal.improvedText,
                username: this.proposal.username
            }),
            buttons: [
                {
                    text: gettext("Apply directly"),
                    classes: "fw-light",
                    click: () => this.applyDirect()
                },
                {
                    text: gettext("Apply as tracked change"),
                    classes: "fw-light",
                    click: () => this.applyTracked()
                },
                {
                    text: gettext("Ignore"),
                    classes: "fw-light",
                    click: () => this.ignore()
                },
                {
                    type: "close"
                }
            ]
        })
        this.dialog.open()
    }

    applyDirect() {
        this.editorLlm.applyImprovedBlock({
            view: this.view,
            block: this.proposal.block,
            improvedText: this.proposal.improvedText,
            asTracked: false,
            llmUser: this.proposal.llmUser
        })
        this.editorLlm.removeProposal(this.view, this.proposal.id)
        this.dialog.close()
        this.view.focus()
    }

    applyTracked() {
        this.editorLlm.applyImprovedBlock({
            view: this.view,
            block: this.proposal.block,
            improvedText: this.proposal.improvedText,
            asTracked: true,
            llmUser: this.proposal.llmUser
        })
        this.editorLlm.removeProposal(this.view, this.proposal.id)
        this.dialog.close()
        this.view.focus()
    }

    ignore() {
        this.editorLlm.removeProposal(this.view, this.proposal.id)
        this.dialog.close()
        this.view.focus()
    }
}
