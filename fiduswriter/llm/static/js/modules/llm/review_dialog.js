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
            width: 680,
            height: 600,
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
        this.editorLlm.applyProposalSection({
            view: this.view,
            proposal: this.proposal,
            asTracked: false
        })
        this.editorLlm.removeProposal(this.view, this.proposal.id)
        this.dialog.close()
        this.view.focus()
    }

    applyTracked() {
        this.editorLlm.applyProposalSection({
            view: this.view,
            proposal: this.proposal,
            asTracked: true
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
