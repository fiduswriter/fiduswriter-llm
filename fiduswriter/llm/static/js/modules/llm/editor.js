import {addAlert, postJson} from "fwtoolkit"

import {LLMDialog} from "./dialog"

const TEXT_BLOCK_TYPES = ["paragraph", "heading1", "heading2", "heading3", "heading4", "heading5", "heading6"]

export class EditorLLM {
    constructor(editor) {
        this.editor = editor
    }

    init() {
        this.addToolsMenuItem()
        this.addSelectionMenuItem()
    }

    addToolsMenuItem() {
        const toolMenu = this.editor.menu.headerbarModel.content.find(
            menu => menu.id === "tools"
        )

        const llmConfigured =
            this.editor.app.settings.LLM_URL ||
            this.editor.user.preferences?.llm_url ||
            this.editor.user.preferences?.llm_api_key

        toolMenu.content.unshift({
            title: gettext("LLM text improvement"),
            type: "menu",
            hidden: () => !llmConfigured,
            disabled: editor =>
                editor.docInfo.access_rights !== "write" || editor.app.isOffline(),
            content: [
                {
                    title: gettext("Improve entire text"),
                    type: "action",
                    tooltip: gettext(
                        "Send the entire text to an LLM for improvement."
                    ),
                    action: _editor => {
                        this.openDialog({mode: "full"})
                    },
                    disabled: editor => editor.app.isOffline()
                }
            ]
        })
    }

    addSelectionMenuItem() {
        const llmConfigured =
            this.editor.app.settings.LLM_URL ||
            this.editor.user.preferences?.llm_url ||
            this.editor.user.preferences?.llm_api_key

        this.editor.menu.selectionMenuModel.content.push({
            type: "button",
            title: gettext("Improve with LLM"),
            icon: "wand-magic-sparkles",
            action: editor => {
                this.openDialog({mode: "selection"})
                return false
            },
            disabled: editor =>
                editor.docInfo.access_rights !== "write" ||
                editor.app.isOffline(),
            hidden: editor =>
                !llmConfigured ||
                editor.currentView.state.selection.$anchor.depth < 1,
            order: 5
        })
    }

    openDialog(options) {
        const view = this.editor.currentView
        const target = this.getTarget(options.mode, view)

        if (!target || !target.text.trim()) {
            addAlert("error", gettext("No text found to improve."))
            return
        }

        const dialog = new LLMDialog(this.editor, {
            text: target.text,
            prompt: "",
            onSubmit: prompt => {
                this.improveText({
                    text: target.text,
                    prompt,
                    view,
                    blocks: target.blocks
                })
            }
        })
        dialog.init()
    }

    getTarget(mode, view) {
        if (mode === "selection") {
            return this.getSelectedParagraph(view)
        }
        return this.getFullText(view)
    }

    getSelectedParagraph(view) {
        const {$from} = view.state.selection
        let depth = $from.depth
        while (
            depth > 0 &&
            !TEXT_BLOCK_TYPES.includes($from.node(depth).type.name)
        ) {
            depth--
        }
        if (depth === 0) {
            return null
        }
        const from = $from.before(depth)
        const to = $from.after(depth)
        const text = this.getBlockText(view.state.doc, from)
        return {
            text,
            from,
            to,
            blocks: [{from, to, text}]
        }
    }

    getFullText(view) {
        const blocks = []
        view.state.doc.descendants((node, pos) => {
            if (TEXT_BLOCK_TYPES.includes(node.type.name)) {
                const text = this.getBlockText(view.state.doc, pos)
                if (text.trim().length) {
                    blocks.push({from: pos, to: pos + node.nodeSize, text})
                }
            }
        })

        if (!blocks.length) {
            return null
        }

        const text = blocks.map(b => b.text).join("\n")
        return {
            text,
            blocks
        }
    }

    getBlockText(doc, pos) {
        const node = doc.nodeAt(pos)
        if (!node) {
            return ""
        }
        let text = ""
        node.forEach(child => {
            if (child.isText) {
                text += child.text
            }
        })
        return text
    }

    improveText({text, prompt, view, blocks}) {
        addAlert("info", gettext("Sending text to LLM..."))
        postJson("/api/llm/improve/", {
            text,
            prompt
        })
            .then(({json, status}) => {
                if (status !== 200) {
                    addAlert(
                        "error",
                        json.error || gettext("LLM request failed.")
                    )
                    return
                }
                this.applyImprovedText({
                    view,
                    blocks,
                    improvedText: json.text
                })
                addAlert(
                    "info",
                    gettext("LLM improvement applied as suggestion.")
                )
            })
            .catch(() => {
                addAlert("error", gettext("Could not contact LLM."))
            })
    }

    applyImprovedText({view, blocks, improvedText}) {
        const lines = improvedText
            .split("\n")
            .map(line => line.trim())
            .filter(line => line.length)

        if (lines.length !== blocks.length) {
            addAlert(
                "error",
                gettext(
                    "The LLM changed the number of paragraphs. Please try again with different instructions."
                )
            )
            return
        }

        const schema = view.state.schema
        // Apply replacements from last to first so positions remain valid.
        const replacements = blocks.map((block, index) => ({
            from: block.from + 1,
            to: block.to - 1,
            text: lines[index]
        }))
        replacements.sort((a, b) => b.from - a.from)

        let tr = view.state.tr

        replacements.forEach(({from, to, text}) => {
            tr = tr.replaceWith(from, to, schema.text(text))
        })

        if (!tr.steps.length) {
            return
        }

        import("../editor/track").then(({trackedTransaction}) => {
            const trackedTr = trackedTransaction(
                tr,
                view.state,
                this.editor.user,
                false,
                Date.now() - this.editor.clientTimeAdjustment
            )
            view.dispatch(trackedTr)
            view.focus()
        })
    }
}
