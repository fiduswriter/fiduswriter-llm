import {addAlert, postJson} from "fwtoolkit"

import {LLMDialog} from "./dialog"

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
            this.editor.app.settings.LLM_API_KEY_CONFIGURED ||
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
            this.editor.app.settings.LLM_API_KEY_CONFIGURED ||
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

        if (!target || !target.blocks.length) {
            addAlert("error", gettext("No text found to improve."))
            return
        }

        const dialog = new LLMDialog(this.editor, {
            text: target.blocks.map(b => b.text).join("\n\n"),
            prompt: "",
            mode: "changes",
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
            // Process from last block to first so positions stay valid.
            const sortedBlocks = blocks.slice().sort((a, b) => b.from - a.from)
            for (const block of sortedBlocks) {
                await this.improveBlock({prompt, outputMode, view, block})
            }
            const doneMessage =
                outputMode === "comments"
                    ? gettext("LLM comments added.")
                    : gettext("LLM improvement applied as suggestion.")
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

        const fullPrompt = `${instructionText}\n\n---\n\n${gettext("Return ONLY the improved version of the provided text. Do not include these instructions, the context, or any explanations in your response. Do not quote the text. Preserve all placeholders exactly.")}`

        const {json, status} = await postJson("/api/llm/improve/", {
            text: block.text,
            prompt: fullPrompt
        })

        if (status !== 200) {
            throw new Error(json.error || gettext("LLM request failed."))
        }

        if (outputMode === "comments") {
            this.applyComments({view, block, commentsText: json.text})
        } else {
            this.applyImprovedBlock({view, block, improvedText: json.text})
        }
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

    applyImprovedBlock({view, block, improvedText}) {
        const schema = view.state.schema
        const user = this.editor.user
        const date = Date.now() - this.editor.clientTimeAdjustment

        const normalizedText = this.normalizePlaceholders(improvedText)

        const insertionMark = schema.marks.insertion.create({
            user: user.id || 0,
            username: user.username || user.name || "",
            date,
            approved: false
        })
        const deletionMark = schema.marks.deletion.create({
            user: user.id || 0,
            username: user.username || user.name || "",
            date
        })

        const newNodes = this.deserializeImprovedText(
            normalizedText,
            block.placeholders,
            schema,
            insertionMark
        )

        const oldNodes = []
        block.node.forEach(child => {
            if (child.isText) {
                oldNodes.push(schema.text(child.text, [...child.marks, deletionMark]))
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

    applyComments({view, block, commentsText}) {
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

        const user = this.editor.user
        const username = user.username || user.name || ""
        const date = Date.now() - this.editor.clientTimeAdjustment

        comments.forEach(commentText => {
            const commentData = {
                user: user.id || 0,
                username,
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
                    nodes.push(schema.text(part.value, [insertionMark]))
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
                nodes.push(placeholder.node.mark(placeholder.node.marks.concat(insertionMark)))
            }
        })

        const missing = placeholders.filter(p => !seenPlaceholders.has(`${p.type}:${p.index}`))
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
