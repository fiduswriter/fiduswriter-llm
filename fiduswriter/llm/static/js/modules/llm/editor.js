import {addAlert, postJson, gettext} from "fwtoolkit"

import {LLMDialog} from "./dialog"
import {
    llmPlugin,
    removeAllProposals,
    removeProposal,
    setProposals
} from "./state_plugin"

const TEXT_BLOCK_TYPES = [
    "title",
    "paragraph",
    "heading1",
    "heading2",
    "heading3",
    "heading4",
    "heading5",
    "heading6",
    "figure_caption",
    "table_caption",
    "code_block"
]

const BLOCK_TYPE_LABELS = {
    title: gettext("title"),
    paragraph: gettext("paragraph"),
    heading1: gettext("heading"),
    heading2: gettext("heading"),
    heading3: gettext("heading"),
    heading4: gettext("heading"),
    heading5: gettext("heading"),
    heading6: gettext("heading"),
    figure_caption: gettext("figure caption"),
    table_caption: gettext("table caption"),
    code_block: gettext("code block")
}

const PLACEHOLDER_TYPES = ["citation", "equation", "cross_reference"]

const PLACEHOLDER_PATTERN = /\[NODE:\s*(\w+)\s*:\s*(\d+)\s*\]/gi

let proposalIdCounter = 0

export class EditorLLM {
    constructor(editor) {
        this.editor = editor
    }

    init() {
        this.addToolsMenuItem()
        this.addSelectionMenuItem()
        this.addStatePlugin()
        this.addStyles()
    }

    addStyles() {
        const styleEl = document.createElement("style")
        styleEl.innerHTML = `
            .llm-proposal {
                background-color: rgba(255, 235, 59, 0.4);
                border-bottom: 2px wavy #f57f17;
                cursor: pointer;
            }
        `
        document.head.appendChild(styleEl)
    }

    addStatePlugin() {
        this.editor.statePlugins.push([
            llmPlugin,
            () => ({editor: this.editor, editorLlm: this})
        ])
    }

    addToolsMenuItem() {
        if (!this.isLLMConfigured()) {
            return
        }
        const toolMenu = this.editor.menu.headerbarModel.content.find(
            menu => menu.id === "tools"
        )

        toolMenu.content.unshift({
            title: gettext("LLM text improvement"),
            type: "menu",
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
                },
                {
                    title: gettext("Clear LLM proposals"),
                    type: "action",
                    tooltip: gettext(
                        "Remove any LLM change proposals from the document."
                    ),
                    action: _editor => {
                        this.clearProposals()
                    },
                    disabled: editor => editor.app.isOffline()
                }
            ]
        })
    }

    addSelectionMenuItem() {
        if (!this.isLLMConfigured()) {
            return
        }

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
                editor.currentView.state.selection.$anchor.depth < 1,
            order: 5
        })
    }

    openDialog(options) {
        const view = this.editor.currentView
        const target = this.getTarget(options.mode, view)

        if (!target || !target.blocks.length) {
            addAlert("error", gettext("No text found to improve."))
            return
        }

        const dialog = new LLMDialog(this.editor, {
            text: target.blocks.map(b => b.text).join("\n\n"),
            prompt: "",
            mode: "proposals",
            onSubmit: (prompt, outputMode) => {
                this.improveText({
                    prompt,
                    outputMode,
                    view,
                    blocks: target.blocks
                })
            }
        })
        dialog.init()
    }

    clearProposals() {
        const view = this.editor.currentView
        const tr = removeAllProposals(view.state)
        if (tr) {
            view.dispatch(tr)
        }
    }

    getLLMUser() {
        const settings = this.editor.app.settings
        const prefs = this.editor.user.preferences || {}
        const model = prefs.llm_model || settings.LLM_MODEL || gettext("unknown model")
        return {
            id: 0,
            username: `LLM (${model})`
        }
    }

    isLLMConfigured() {
        const settings = this.editor.app.settings
        const prefs = this.editor.user.preferences || {}
        return Boolean(
            settings.LLM_API_KEY_CONFIGURED ||
                prefs.llm_api_key
        )
    }

    getTarget(mode, view) {
        if (mode === "selection") {
            return this.getSelectedBlock(view)
        }
        return this.getFullText(view)
    }

    getSelectedBlock(view) {
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
        const serialized = this.serializeBlock(view.state.doc.nodeAt(from))
        if (!serialized.text.trim()) {
            return null
        }
        return {
            blocks: [{...serialized, from, to}]
        }
    }

    getFullText(view) {
        const blocks = []
        view.state.doc.descendants((node, pos) => {
            if (TEXT_BLOCK_TYPES.includes(node.type.name)) {
                const serialized = this.serializeBlock(node)
                if (serialized.text.trim().length) {
                    blocks.push({
                        ...serialized,
                        from: pos,
                        to: pos + node.nodeSize
                    })
                }
            }
        })

        if (!blocks.length) {
            return null
        }

        return {blocks}
    }

    serializeBlock(node) {
        const placeholders = []
        let text = ""
        let index = 0
        node.forEach(child => {
            if (child.isText) {
                text += child.text
            } else if (child.isInline && PLACEHOLDER_TYPES.includes(child.type.name)) {
                const id = `[NODE:${child.type.name}:${index}]`
                placeholders.push({id, type: child.type.name, index, node: child})
                text += id
                index++
            }
        })
        return {node, text, placeholders}
    }

    async improveText({prompt, outputMode, view, blocks}) {
        const message =
            outputMode === "comments"
                ? gettext("Asking LLM for comments...")
                : gettext("Sending text to LLM...")
        addAlert("info", message)

        try {
            if (outputMode === "proposals") {
                const results = []
                for (const block of blocks) {
                    const improvedText = await this.improveBlock({
                        prompt,
                        outputMode,
                        view,
                        block
                    })
                    results.push({block, improvedText})
                }
                this.createProposals({view, results})
            } else {
                // Apply each block's result as soon as it arrives so the user
                // sees progress, especially for comments.
                const llmUser = this.getLLMUser()
                const results = []
                for (const block of blocks) {
                    const improvedText = await this.improveBlock({
                        prompt,
                        outputMode,
                        view,
                        block
                    })
                    if (outputMode === "comments") {
                        this.applyComments({view, block, commentsText: improvedText, llmUser})
                    } else {
                        // For direct/changes modes processing in document order
                        // would invalidate later positions, so collect and apply
                        // from last to first.
                        results.push({block, improvedText})
                    }
                }
                if (outputMode !== "comments") {
                    const sortedResults = results.slice().sort((a, b) => b.block.from - a.block.from)
                    for (const {block, improvedText} of sortedResults) {
                        this.applyImprovedBlock({
                            view,
                            block,
                            improvedText,
                            asTracked: outputMode === "changes",
                            llmUser
                        })
                    }
                }
            }

            const doneMessage =
                outputMode === "comments"
                    ? gettext("LLM comments added.")
                    : outputMode === "proposals"
                      ? gettext("LLM proposals created. Right-click a highlighted passage to review.")
                      : gettext("LLM improvement applied.")
            addAlert("info", doneMessage)
        } catch (error) {
            addAlert("error", error.message || gettext("Could not apply LLM improvement."))
        }
    }

    async improveBlock({prompt, outputMode, view, block}) {
        const blockTypeName = BLOCK_TYPE_LABELS[block.node.type.name] || gettext("text passage")
        const allBlocks = this.getAllTextBlocks(view)
        const context = this.getBlockContext(allBlocks, block)

        let instructionText = prompt
        instructionText += `\n\n${gettext("You are editing a")} ${blockTypeName}.`
        if (block.node.type.name.startsWith("heading")) {
            instructionText += ` ${gettext("Keep it as a heading: concise, preferably not a full sentence, and suitable as a section title.")}`
        }
        if (block.node.type.name === "title") {
            instructionText += ` ${gettext("Keep it as a document title: concise and not a full sentence.")}`
        }
        if (block.node.type.name === "code_block") {
            instructionText += ` ${gettext("Only fix obvious typos or formatting issues in the code; do not change the logic.")}`
        }
        if (context.before) {
            instructionText += `\n\n${gettext("Context before this passage:")}\n${context.before}`
        }
        if (context.after) {
            instructionText += `\n\n${gettext("Context after this passage:")}\n${context.after}`
        }
        if (block.placeholders.length) {
            const example = block.placeholders[0].id
            instructionText += `\n\n${gettext("The text contains placeholders such as")} ${example} ${gettext("representing non-text elements (citations, equations, cross-references). You MUST preserve these placeholders exactly and in the same order. Do not modify them. Only improve the surrounding text.")}`
        }

        if (outputMode === "comments") {
            instructionText += `\n\n${gettext("Do not rewrite the text. Instead, briefly explain what could be improved about it. Respond with one or more short comments, one per line.")}`
        }

        let finalInstruction
        if (outputMode === "comments") {
            finalInstruction = gettext(
                "Return ONLY one or more short comments, one per line. Do not include these instructions, the context, or any explanations. Do not rewrite the text."
            )
        } else {
            finalInstruction = gettext(
                "Return ONLY the improved version of the text below. Do not include these instructions, the context, or any explanations in your response. Do not quote the text. Preserve all placeholders exactly."
            )
        }

        const fullPrompt = `${instructionText}\n\n---\n\n${finalInstruction}\n\n${gettext("TEXT TO IMPROVE:")}\n${block.text}`

        const {json, status} = await postJson("/api/llm/improve/", {
            text: block.text,
            prompt: fullPrompt
        })

        if (status !== 200) {
            throw new Error(json.error || gettext("LLM request failed."))
        }

        return this.normalizePlaceholders(json.text)
    }

    getAllTextBlocks(view) {
        const blocks = []
        view.state.doc.descendants((node, pos) => {
            if (TEXT_BLOCK_TYPES.includes(node.type.name)) {
                const serialized = this.serializeBlock(node)
                blocks.push({
                    text: serialized.text,
                    from: pos,
                    to: pos + node.nodeSize
                })
            }
        })
        return blocks
    }

    getBlockContext(allBlocks, targetBlock) {
        const index = allBlocks.findIndex(b => b.from === targetBlock.from)
        const result = {before: "", after: ""}
        if (index < 0) {
            return result
        }
        const beforeBlock = allBlocks[index - 1]
        const afterBlock = allBlocks[index + 1]
        const maxContextLength = 500
        if (beforeBlock) {
            result.before = beforeBlock.text.slice(-maxContextLength)
        }
        if (afterBlock) {
            result.after = afterBlock.text.slice(0, maxContextLength)
        }
        return result
    }

    normalizePlaceholders(text) {
        return text.replace(PLACEHOLDER_PATTERN, "[NODE:$1:$2]")
    }

    createProposals({view, results}) {
        const llmUser = this.getLLMUser()
        const proposals = results.map(({block, improvedText}) => {
            proposalIdCounter += 1
            return {
                id: proposalIdCounter,
                from: block.from + 1,
                to: block.to - 1,
                originalText: block.text,
                improvedText,
                block,
                llmUser,
                username: llmUser.username
            }
        })

        const tr = setProposals(view.state, proposals)
        if (tr) {
            view.dispatch(tr)
        }
    }

    removeProposal(view, proposalId) {
        const tr = removeProposal(view.state, proposalId)
        if (tr) {
            view.dispatch(tr)
        }
    }

    applyImprovedBlock({view, block, improvedText, asTracked = false, llmUser}) {
        const schema = view.state.schema
        const user = llmUser || this.getLLMUser()
        const date = Date.now() - this.editor.clientTimeAdjustment

        const insertionMark = asTracked
            ? schema.marks.insertion.create({
                  user: user.id,
                  username: user.username,
                  date,
                  approved: false
              })
            : null

        const newNodes = this.deserializeImprovedText(
            improvedText,
            block.placeholders,
            schema,
            insertionMark
        )

        if (!asTracked) {
            const tr = view.state.tr
                .replaceWith(block.from + 1, block.to - 1, newNodes)
                .setMeta("llm", true)
            view.dispatch(tr)
            view.focus()
            return
        }

        const deletionMark = schema.marks.deletion.create({
            user: user.id,
            username: user.username,
            date
        })

        const oldNodes = []
        block.node.forEach(child => {
            if (child.isText) {
                oldNodes.push(
                    schema.text(child.text, [...child.marks, deletionMark])
                )
            } else {
                oldNodes.push(child.mark(child.marks.concat(deletionMark)))
            }
        })

        const tr = view.state.tr
            .replaceWith(block.from + 1, block.to - 1, [...oldNodes, ...newNodes])
            .setMeta("llm", true)
        view.dispatch(tr)
        view.focus()
    }

    applyComments({view, block, commentsText, llmUser}) {
        const store = this.editor.mod?.comments?.store
        if (!store) {
            throw new Error(gettext("Comments are not available."))
        }

        const comments = commentsText
            .split("\n")
            .map(line => line.trim())
            .filter(line => line.length)

        if (!comments.length) {
            return
        }

        const user = llmUser || this.getLLMUser()
        const date = Date.now() - this.editor.clientTimeAdjustment

        comments.forEach(commentText => {
            const commentData = {
                user: user.id,
                username: user.username,
                date,
                comment: [{type: "paragraph", content: [{type: "text", text: commentText}]}],
                isMajor: false
            }
            store.addComment(commentData, block.from + 1, block.to - 1, view)
        })
    }

    deserializeImprovedText(text, placeholders, schema, insertionMark) {
        const placeholderMap = new Map()
        placeholders.forEach(p => {
            const key = `${p.type}:${p.index}`
            placeholderMap.set(key, p)
        })

        const parts = []
        let lastIndex = 0
        let match
        PLACEHOLDER_PATTERN.lastIndex = 0
        while ((match = PLACEHOLDER_PATTERN.exec(text)) !== null) {
            const [fullMatch, type, indexStr] = match
            const before = text.slice(lastIndex, match.index)
            if (before.length) {
                parts.push({kind: "text", value: before})
            }
            parts.push({kind: "placeholder", type, index: Number.parseInt(indexStr, 10)})
            lastIndex = match.index + fullMatch.length
        }
        if (lastIndex < text.length) {
            parts.push({kind: "text", value: text.slice(lastIndex)})
        }

        const nodes = []
        const seenPlaceholders = new Set()
        parts.forEach(part => {
            if (part.kind === "text") {
                if (part.value.length) {
                    nodes.push(
                        schema.text(
                            part.value,
                            insertionMark ? [insertionMark] : []
                        )
                    )
                }
            } else {
                const type = part.type.toLowerCase()
                const key = `${type}:${part.index}`
                const placeholder = placeholderMap.get(key)
                if (!placeholder) {
                    throw new Error(
                        gettext(
                            "The LLM returned an unexpected placeholder. Please try again with different instructions."
                        )
                    )
                }
                seenPlaceholders.add(key)
                const marks = insertionMark
                    ? placeholder.node.marks.concat(insertionMark)
                    : placeholder.node.marks
                nodes.push(placeholder.node.mark(marks))
            }
        })

        const missing = placeholders.filter(
            p => !seenPlaceholders.has(`${p.type}:${p.index}`)
        )
        if (missing.length) {
            throw new Error(
                gettext(
                    "The LLM did not preserve all non-text elements. Please try again with different instructions."
                )
            )
        }

        return nodes
    }
}
