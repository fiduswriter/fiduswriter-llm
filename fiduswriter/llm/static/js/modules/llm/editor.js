import {diffWordsWithSpace} from "diff"
import {ProgressTask, addAlert, gettext, interpolate, postJson} from "fwtoolkit"

import {LLMDialog} from "./dialog"
import {
    llmPlugin,
    removeAllProposals,
    removeProposal,
    setProcessing,
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
        this.currentAbortController = null
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
                editor.docInfo.access_rights !== "write" ||
                editor.app.isOffline(),
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
            action: _editor => {
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
            onSubmit: (prompt, outputMode, validationOptions) => {
                this.improveText({
                    prompt,
                    outputMode,
                    validationOptions,
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

    setProcessing(view, processing) {
        if (processing) {
            if (this.originalEditable === undefined) {
                this.originalEditable = view.props.editable
            }
            view.setProps({editable: () => false})
        } else {
            view.setProps({editable: this.originalEditable})
            this.originalEditable = undefined
        }
        const tr = setProcessing(view.state, processing)
        if (tr) {
            view.dispatch(tr)
        }
    }

    cancelCurrentImprovement() {
        if (this.currentAbortController) {
            this.currentAbortController.abort()
        }
    }

    getLLMUser() {
        const settings = this.editor.app.settings
        const prefs = this.editor.user.preferences || {}
        const model =
            prefs.llm_model || settings.LLM_MODEL || gettext("unknown model")
        return {
            id: 0,
            username: `LLM (${model})`
        }
    }

    isLLMConfigured() {
        const settings = this.editor.app.settings
        const prefs = this.editor.user.preferences || {}
        return Boolean(settings.LLM_API_KEY_CONFIGURED || prefs.llm_api_key)
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
        if (!this.blockHasTextContent(serialized.text)) {
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
                if (this.blockHasTextContent(serialized.text)) {
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
            } else if (
                child.isInline &&
                PLACEHOLDER_TYPES.includes(child.type.name)
            ) {
                const id = `[NODE:${child.type.name}:${index}]`
                placeholders.push({
                    id,
                    type: child.type.name,
                    index,
                    node: child
                })
                text += id
                index++
            }
        })
        return {node, text, placeholders}
    }

    async improveText({
        prompt,
        outputMode,
        view,
        blocks,
        validationOptions = {}
    }) {
        const isCommentMode =
            outputMode === "comments" || outputMode === "global_comment"
        const title = isCommentMode
            ? gettext("Asking LLM for comments...")
            : gettext("Sending text to LLM...")
        const abortController = new AbortController()
        this.currentAbortController = abortController
        const totalBlocks = blocks.length
        const progress = new ProgressTask("info", {
            title,
            message: gettext("Preparing..."),
            percentage: 0,
            cancelable: true,
            onCancel: () => abortController.abort()
        })
        progress.open()
        this.setProcessing(view, true)

        try {
            if (outputMode === "global_comment") {
                await this.improveAsGlobalComment({
                    prompt,
                    view,
                    signal: abortController.signal,
                    progress
                })
                return
            }
            let proposalCount = 0
            if (outputMode === "proposals") {
                const results = []
                for (let i = 0; i < blocks.length; i++) {
                    const block = blocks[i]
                    progress.update(
                        Math.round((i / totalBlocks) * 100),
                        interpolate(gettext("Processing block %s of %s..."), [
                            i + 1,
                            totalBlocks
                        ])
                    )
                    const {improvedText} = await this.processBlockWithRetries({
                        prompt,
                        outputMode,
                        view,
                        block,
                        signal: abortController.signal,
                        validationOptions
                    })
                    results.push({block, improvedText})
                }
                proposalCount = this.createProposals({view, results})
            } else {
                const llmUser = this.getLLMUser()
                if (outputMode === "comments") {
                    for (let i = 0; i < blocks.length; i++) {
                        const block = blocks[i]
                        progress.update(
                            Math.round((i / totalBlocks) * 100),
                            interpolate(
                                gettext("Processing block %s of %s..."),
                                [i + 1, totalBlocks]
                            )
                        )
                        const {improvedText} =
                            await this.processBlockWithRetries({
                                prompt,
                                outputMode,
                                view,
                                block,
                                signal: abortController.signal,
                                validationOptions
                            })
                        this.applyComments({
                            view,
                            block,
                            commentsText: improvedText,
                            llmUser
                        })
                    }
                } else {
                    let offset = 0
                    for (let i = 0; i < blocks.length; i++) {
                        const block = blocks[i]
                        progress.update(
                            Math.round((i / totalBlocks) * 100),
                            interpolate(
                                gettext("Processing block %s of %s..."),
                                [i + 1, totalBlocks]
                            )
                        )
                        const {improvedText, isValid} =
                            await this.processBlockWithRetries({
                                prompt,
                                outputMode,
                                view,
                                block,
                                signal: abortController.signal,
                                validationOptions
                            })
                        if (!improvedText.trim()) {
                            continue
                        }
                        if (improvedText === block.text) {
                            continue
                        }
                        const currentBlock = {
                            ...block,
                            from: block.from + offset,
                            to: block.to + offset
                        }
                        const docSizeBefore = view.state.doc.content.size
                        const forceTracked = outputMode === "direct" && !isValid
                        this.applyImprovedBlock({
                            view,
                            block: currentBlock,
                            improvedText,
                            asTracked: outputMode === "changes" || forceTracked,
                            llmUser
                        })
                        offset += view.state.doc.content.size - docSizeBefore
                    }
                }
            }

            progress.update(100, gettext("Done"))
            progress.close()

            const doneMessage =
                outputMode === "comments"
                    ? gettext("LLM comments added.")
                    : outputMode === "proposals"
                      ? proposalCount
                          ? gettext(
                                "LLM proposals created. Right-click a highlighted passage to review."
                            )
                          : gettext("No LLM change proposals were necessary.")
                      : gettext("LLM improvement applied.")
            addAlert("info", doneMessage)
        } catch (error) {
            progress.close()
            if (error.name === "AbortError") {
                addAlert("info", gettext("LLM improvement cancelled."))
            } else {
                addAlert(
                    "error",
                    error.message || gettext("Could not apply LLM improvement.")
                )
            }
        } finally {
            this.currentAbortController = null
            this.setProcessing(view, false)
        }
    }

    async improveBlock({
        prompt,
        outputMode,
        view,
        block,
        signal,
        translationExpected = false
    }) {
        const blockTypeName =
            BLOCK_TYPE_LABELS[block.node.type.name] || gettext("text passage")
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

        const translationLanguageMatch = prompt.match(/\bto\s+([A-Za-z]+)\b/)
        const language = translationLanguageMatch
            ? translationLanguageMatch[1]
            : ""

        if (outputMode === "comments") {
            instructionText += `\n\n${gettext("Do not rewrite the text. Instead, briefly explain what could be improved about it. Respond with one or more short comments, one per line.")}`
        } else if (translationExpected && language) {
            instructionText += `\n\n${interpolate(gettext("Translate every sentence to %s. Do not improve or rewrite the text in the original language."), [language])}`
        }

        let finalInstruction
        if (outputMode === "comments") {
            finalInstruction = gettext(
                "Return ONLY one or more short comments, one per line. Do not include these instructions, the context, or any explanations. Do not rewrite the text."
            )
        } else if (translationExpected) {
            if (language) {
                finalInstruction = interpolate(
                    gettext(
                        "Return ONLY the %s translation of the text below. Do not return any part of it in the original language or any other language. Do not include these instructions, the context, or any explanations. Do not quote the text. Preserve all placeholders exactly."
                    ),
                    [language]
                )
            } else {
                finalInstruction = gettext(
                    "Return ONLY the translation of the text below in the language requested above. Do not return any part of it in the original language or any other language. Do not include these instructions, the context, or any explanations. Do not quote the text. Preserve all placeholders exactly."
                )
            }
        } else {
            finalInstruction = gettext(
                "Return ONLY the improved version of the text below. If the text is already correct and needs no changes, return it exactly as provided. Do not include these instructions, the context, or any explanations in your response. Do not quote the text. Preserve all placeholders exactly."
            )
        }

        const fullPrompt = `${instructionText}\n\n---\n\n${finalInstruction}\n\n${gettext("TEXT TO IMPROVE:")}\n${block.text}`

        const {json, status} = await postJson(
            "/api/llm/improve/",
            {
                prompt: fullPrompt
            },
            {},
            {signal}
        )

        if (status !== 200) {
            throw new Error(json.error || gettext("LLM request failed."))
        }

        return this.normalizePlaceholders(json.text)
    }

    async processBlockWithRetries({
        prompt,
        outputMode,
        view,
        block,
        signal,
        validationOptions
    }) {
        let improvedText = ""
        let isValid = false
        for (let attempt = 1; attempt <= 3; attempt++) {
            improvedText = await this.improveBlock({
                prompt,
                outputMode,
                view,
                block,
                signal,
                translationExpected: validationOptions.translationCheckEnabled
            })
            isValid = this.isImprovedTextValid({
                block,
                improvedText,
                outputMode,
                validationOptions
            })
            if (isValid) {
                break
            }
        }
        return {improvedText, isValid}
    }

    isImprovedTextValid({block, improvedText, outputMode, validationOptions}) {
        if (improvedText.length === 0) {
            return false
        }

        if (outputMode === "comments" || outputMode === "global_comment") {
            return true
        }

        const inputCitations = this.countCitations(block.text)
        const outputCitations = this.countCitations(improvedText)
        if (inputCitations.size !== outputCitations.size) {
            return false
        }
        for (const [index, count] of inputCitations) {
            if (outputCitations.get(index) !== count) {
                return false
            }
        }

        if (
            validationOptions.lengthCheckEnabled &&
            this.isLengthConstrainedBlock(block)
        ) {
            const originalLength = block.text.length
            if (originalLength === 0) {
                if (improvedText.length > 0) {
                    return false
                }
            } else {
                const diffPercent =
                    (Math.abs(improvedText.length - originalLength) /
                        originalLength) *
                    100
                if (diffPercent > validationOptions.maxLengthDiffPercent) {
                    return false
                }
            }
        }

        if (!validationOptions.acceptUnchanged && improvedText === block.text) {
            return false
        }

        if (
            validationOptions.translationCheckEnabled &&
            improvedText === block.text
        ) {
            return false
        }

        if (
            validationOptions.minWordDiffCheckEnabled &&
            this.isLengthConstrainedBlock(block)
        ) {
            const diffPercent = this.computeWordDifferenceRatio(
                block.text,
                improvedText
            )
            if (diffPercent < validationOptions.minWordDiffPercent) {
                return false
            }
        }

        return true
    }

    computeWordDifferenceRatio(originalText, improvedText) {
        const diffs = diffWordsWithSpace(originalText, improvedText)
        let unchangedWords = 0
        let inputWords = 0
        diffs.forEach(diff => {
            const words = diff.value.split(/\s+/).filter(word => word.length)
            const count = words.length
            if (!diff.added && !diff.removed) {
                unchangedWords += count
                inputWords += count
            } else if (diff.removed) {
                inputWords += count
            }
        })
        if (inputWords === 0) {
            return 100
        }
        return ((inputWords - unchangedWords) / inputWords) * 100
    }

    countCitations(text) {
        const counts = new Map()
        const pattern = /\[NODE:\s*citation\s*:\s*(\d+)\s*\]/gi
        let match
        while ((match = pattern.exec(text)) !== null) {
            const index = Number.parseInt(match[1], 10)
            counts.set(index, (counts.get(index) || 0) + 1)
        }
        return counts
    }

    isLengthConstrainedBlock(block) {
        const typeName = block.node.type.name
        return (
            typeName === "paragraph" ||
            typeName === "title" ||
            typeName.startsWith("heading")
        )
    }

    getAllTextBlocks(view) {
        const blocks = []
        view.state.doc.descendants((node, pos) => {
            if (TEXT_BLOCK_TYPES.includes(node.type.name)) {
                const serialized = this.serializeBlock(node)
                if (this.blockHasTextContent(serialized.text)) {
                    blocks.push({
                        text: serialized.text,
                        from: pos,
                        to: pos + node.nodeSize
                    })
                }
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

    blockHasTextContent(text) {
        return text.replace(PLACEHOLDER_PATTERN, "").trim().length > 0
    }

    docPosFromTextOffset(block, textOffset) {
        let offset = 0
        let pos = block.from + 1
        let placeholderIndex = 0
        let found = null

        block.node.forEach(child => {
            if (found !== null || offset > textOffset) {
                return
            }
            if (child.isText) {
                const len = child.text.length
                if (offset + len >= textOffset) {
                    found = pos + (textOffset - offset)
                    return
                }
                offset += len
                pos += len
            } else if (
                child.isInline &&
                PLACEHOLDER_TYPES.includes(child.type.name)
            ) {
                const placeholder = block.placeholders[placeholderIndex]
                const idLen = placeholder ? placeholder.id.length : 0
                if (offset + idLen >= textOffset) {
                    found = pos
                    return
                }
                offset += idLen
                pos += child.nodeSize
                placeholderIndex += 1
            } else {
                pos += child.nodeSize
            }
        })

        return found !== null ? found : block.to - 1
    }

    computeChangeRange(originalText, improvedText) {
        const diffs = diffWordsWithSpace(originalText, improvedText)
        let firstChange = -1
        let lastChange = -1
        let originalOffset = 0

        for (let i = 0; i < diffs.length; i++) {
            const diff = diffs[i]
            const prevDiff = i > 0 ? diffs[i - 1] : null
            if (diff.added) {
                if (!prevDiff || !prevDiff.removed) {
                    // Pure insertion: it has no corresponding original text.
                    if (firstChange < 0) {
                        firstChange = originalOffset
                    }
                    lastChange = originalOffset
                }
            } else if (diff.removed) {
                if (firstChange < 0) {
                    firstChange = originalOffset
                }
                lastChange = originalOffset + diff.value.length
                originalOffset += diff.value.length
            } else {
                originalOffset += diff.value.length
            }
        }

        if (firstChange < 0) {
            return {from: 0, to: 0}
        }

        // A zero-width inline decoration would be invisible and unclickable.
        // Expand a pure insertion by one adjacent character if possible.
        if (firstChange === lastChange) {
            if (firstChange > 0) {
                firstChange -= 1
            } else if (lastChange < originalText.length) {
                lastChange += 1
            }
        }

        return {from: firstChange, to: lastChange}
    }

    createProposals({view, results}) {
        const llmUser = this.getLLMUser()
        const proposals = []
        results.forEach(({block, improvedText}) => {
            if (!improvedText.trim()) {
                return
            }
            if (improvedText === block.text) {
                return
            }
            const changeRange = this.computeChangeRange(
                block.text,
                improvedText
            )
            if (changeRange.from >= changeRange.to) {
                return
            }
            proposalIdCounter += 1
            proposals.push({
                id: proposalIdCounter,
                from: this.docPosFromTextOffset(block, changeRange.from),
                to: this.docPosFromTextOffset(block, changeRange.to),
                originalText: block.text,
                improvedText,
                block,
                llmUser,
                username: llmUser.username
            })
        })

        if (!proposals.length) {
            return 0
        }

        const tr = setProposals(view.state, proposals)
        if (tr) {
            view.dispatch(tr)
        }
        return proposals.length
    }

    removeProposal(view, proposalId) {
        const tr = removeProposal(view.state, proposalId)
        if (tr) {
            view.dispatch(tr)
        }
    }

    applyImprovedBlock({
        view,
        block,
        improvedText,
        asTracked = false,
        llmUser
    }) {
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
            .replaceWith(block.from + 1, block.to - 1, [
                ...oldNodes,
                ...newNodes
            ])
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
                comment: [
                    {
                        type: "paragraph",
                        content: [{type: "text", text: commentText}]
                    }
                ],
                isMajor: false
            }
            store.addComment(commentData, block.from + 1, block.to - 1, view)
        })
    }

    getFullDocumentText(view) {
        const sections = []

        const mainBlocks = this.getFullText(view)?.blocks || []
        if (mainBlocks.length) {
            sections.push(
                `${gettext("DOCUMENT:")}\n${mainBlocks.map(block => block.text).join("\n\n")}`
            )
        }

        const fnView = this.editor.mod.footnotes?.fnEditor?.view
        if (fnView) {
            const fnBlocks = this.getFullText(fnView)?.blocks || []
            if (fnBlocks.length) {
                sections.push(
                    `${gettext("FOOTNOTES:")}\n${fnBlocks.map(block => block.text).join("\n\n")}`
                )
            }
        }

        const bibliographyEl = document.querySelector(".doc-bibliography")
        if (bibliographyEl?.textContent.trim()) {
            sections.push(
                `${gettext("BIBLIOGRAPHY:")}\n${bibliographyEl.textContent.trim()}`
            )
        }

        return sections.join("\n\n")
    }

    async improveAsGlobalComment({prompt, view, signal, progress}) {
        progress.update(10, gettext("Reading document..."))
        const documentText = this.getFullDocumentText(view)

        progress.update(30, gettext("Sending document to LLM..."))
        const commentText = await this.improveDocument({
            prompt,
            documentText,
            signal
        })

        progress.update(80, gettext("Adding comment..."))
        if (commentText) {
            this.applyGlobalComment({commentText})
        }

        progress.update(100, gettext("Done"))
        progress.close()
        addAlert("info", gettext("LLM document comment added."))
    }

    async improveDocument({prompt, documentText, signal}) {
        const instructionText = `${prompt}\n\n${gettext("You are reviewing an entire document. Provide a comment about the document as a whole.")}`

        const finalInstruction = gettext(
            "Return ONLY your comment about the entire document. Do not include these instructions, the context, or any explanations. Do not rewrite the text."
        )

        const fullPrompt = `${instructionText}\n\n---\n\n${finalInstruction}\n\n${gettext("DOCUMENT TO REVIEW:")}\n${documentText}`

        const {json, status} = await postJson(
            "/api/llm/improve/",
            {
                prompt: fullPrompt
            },
            {},
            {signal}
        )

        if (status !== 200) {
            throw new Error(json.error || gettext("LLM request failed."))
        }

        return this.normalizePlaceholders(json.text).trim()
    }

    applyGlobalComment({commentText}) {
        const store = this.editor.mod?.comments?.store
        if (!store) {
            throw new Error(gettext("Comments are not available."))
        }

        const paragraphs = commentText
            .split("\n")
            .map(line => line.trim())
            .filter(line => line.length)
            .map(line => ({
                type: "paragraph",
                content: [{type: "text", text: line}]
            }))

        if (!paragraphs.length) {
            return
        }

        const user = this.getLLMUser()
        const date = Date.now() - this.editor.clientTimeAdjustment

        store.addGlobalComment({
            user: user.id,
            username: user.username,
            date,
            comment: paragraphs,
            isMajor: false
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
            parts.push({
                kind: "placeholder",
                type,
                index: Number.parseInt(indexStr, 10)
            })
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
