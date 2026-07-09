import {diffWordsWithSpace} from "diff"
import {AddMarkStep} from "prosemirror-transform"
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

const PLACEHOLDER_TYPES = [
    "citation",
    "equation",
    "cross_reference",
    "footnote"
]

const PLACEHOLDER_PATTERN = /\[NODE:\s*(\w+)\s*:\s*(\d+)\s*\]/gi
const MARK_OPEN_PATTERN = /\[MARK:\s*(\w+)\s*:\s*(\d+)\s*\]/g
const MARK_CLOSE_PATTERN = /\[\/MARK:\s*(\w+)\s*:\s*(\d+)\s*\]/g

let proposalIdCounter = 0

export class EditorLLM {
    constructor(editor) {
        this.editor = editor
        this.currentAbortController = null
        this.highlightLLMAdditions = false
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
            .llm-highlight-additions span.insertion[data-user="-1"],
            .llm-highlight-additions span.approved-insertion[data-user="-1"] {
                background-color: rgba(144, 238, 144, 0.4);
            }
        `
        document.head.appendChild(styleEl)
    }

    toggleHighlightLLMAdditions() {
        this.highlightLLMAdditions = !this.highlightLLMAdditions
        this.updateHighlightClass()
    }

    updateHighlightClass() {
        const editorEl = this.editor.dom?.querySelector("#editor")
        if (!editorEl) {
            return
        }
        editorEl.classList.toggle(
            "llm-highlight-additions",
            this.highlightLLMAdditions
        )
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
                },
                {
                    title: gettext("Highlight LLM additions"),
                    type: "setting",
                    tooltip: gettext(
                        "Highlight text that has been added by the LLM."
                    ),
                    action: _editor => {
                        this.toggleHighlightLLMAdditions()
                    },
                    selected: _editor => this.highlightLLMAdditions,
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
            id: -1,
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
        if (
            !this.blockHasTextContent(serialized.plainText) &&
            !this.blockHasFootnoteContent(serialized.placeholders)
        ) {
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
                if (
                    this.blockHasTextContent(serialized.plainText) ||
                    this.blockHasFootnoteContent(serialized.placeholders)
                ) {
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
        let plainText = ""
        let placeholderIndex = 0
        const markRegistry = {keyMap: new Map(), marks: new Map()}

        node.forEach(child => {
            if (child.isText) {
                const marks = this.filterMarks(child.marks)
                const tagString = this.serializeMarkTags(marks, markRegistry)
                text += tagString.open + child.text + tagString.close
                plainText += child.text
            } else if (
                child.isInline &&
                PLACEHOLDER_TYPES.includes(child.type.name)
            ) {
                const id = `[NODE:${child.type.name}:${placeholderIndex}]`
                const placeholder = {
                    id,
                    type: child.type.name,
                    index: placeholderIndex,
                    node: child
                }
                if (child.type.name === "footnote") {
                    placeholder.footnoteText = this.serializeFootnoteContent(
                        child
                    )
                }
                placeholders.push(placeholder)
                const marks = this.filterMarks(child.marks)
                const tagString = this.serializeMarkTags(marks, markRegistry)
                text += tagString.open + id + tagString.close
                plainText += id
                placeholderIndex++
            }
        })
        return {node, text, plainText, placeholders, markRegistry}
    }

    serializeFootnoteContent(footnoteNode) {
        const content = footnoteNode.attrs.footnote || []
        let text = ""
        const walk = nodes => {
            nodes.forEach(node => {
                if (node.type === "text") {
                    text += node.text
                } else if (node.content) {
                    walk(node.content)
                }
            })
        }
        walk(content)
        return text
    }

    computePlaceholderPositions(block) {
        let offset = 1
        block.node.forEach(child => {
            if (
                child.isInline &&
                PLACEHOLDER_TYPES.includes(child.type.name)
            ) {
                const placeholder = block.placeholders.find(
                    p => p.node === child
                )
                if (placeholder) {
                    placeholder.absPos = block.from + offset
                }
            }
            offset += child.nodeSize
        })
    }

    filterMarks(marks) {
        return marks.filter(
            mark =>
                ![
                    "deletion",
                    "insertion",
                    "format_change"
                ].includes(mark.type.name)
        )
    }

    getMarkKey(mark) {
        return `${mark.type.name}:${JSON.stringify(mark.attrs)}`
    }

    getMarkRef(mark, registry) {
        const key = this.getMarkKey(mark)
        if (!registry.keyMap.has(key)) {
            const typeList = registry.marks.get(mark.type.name) || []
            const id = typeList.length
            typeList.push(mark)
            registry.marks.set(mark.type.name, typeList)
            registry.keyMap.set(key, {type: mark.type.name, id})
        }
        return registry.keyMap.get(key)
    }

    serializeMarkTags(marks, registry) {
        const markList = marks.slice().sort((a, b) =>
            a.type.name.localeCompare(b.type.name)
        )
        let open = ""
        let close = ""
        markList.forEach(mark => {
            const ref = this.getMarkRef(mark, registry)
            open += `[MARK:${ref.type}:${ref.id}]`
        })
        for (let i = markList.length - 1; i >= 0; i--) {
            const ref = this.getMarkRef(markList[i], registry)
            close += `[/MARK:${ref.type}:${ref.id}]`
        }
        return {open, close}
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
                        this.computePlaceholderPositions(block)
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
                        const footnoteImprovements =
                            await this.processFootnotes({
                                prompt,
                                outputMode,
                                view,
                                block,
                                signal: abortController.signal,
                                validationOptions
                            })
                        for (const placeholder of block.placeholders) {
                            if (
                                placeholder.type !== "footnote" ||
                                !placeholder.footnoteText.trim() ||
                                !footnoteImprovements.has(placeholder.index)
                            ) {
                                continue
                            }
                            const improvedFootnoteText =
                                footnoteImprovements.get(placeholder.index)
                            this.applyCommentsToRange({
                                view,
                                from: placeholder.absPos,
                                to: placeholder.absPos + placeholder.node.nodeSize,
                                commentsText: improvedFootnoteText,
                                llmUser
                            })
                        }
                    }
                } else {
                    let offset = 0
                    for (let i = 0; i < blocks.length; i++) {
                        const block = blocks[i]
                        this.computePlaceholderPositions(block)
                        progress.update(
                            Math.round((i / totalBlocks) * 100),
                            interpolate(
                                gettext("Processing block %s of %s..."),
                                [i + 1, totalBlocks]
                            )
                        )
                        const hasMainText = this.blockHasTextContent(
                            block.plainText
                        )
                        let improvedText = ""
                        let isValid = false
                        let mainTextChanged = false
                        if (hasMainText) {
                            const result = await this.processBlockWithRetries({
                                prompt,
                                outputMode,
                                view,
                                block,
                                signal: abortController.signal,
                                validationOptions
                            })
                            improvedText = result.improvedText
                            isValid = result.isValid
                            if (
                                improvedText.trim() &&
                                this.stripMarkTags(improvedText) !==
                                    block.plainText
                            ) {
                                mainTextChanged = true
                            }
                        }
                        const currentBlock = {
                            ...block,
                            from: block.from + offset,
                            to: block.to + offset
                        }
                        const docSizeBefore = view.state.doc.content.size
                        const footnoteImprovements =
                            await this.processFootnotes({
                                prompt,
                                outputMode,
                                view,
                                block: currentBlock,
                                signal: abortController.signal,
                                validationOptions
                            })
                        if (mainTextChanged || footnoteImprovements.size) {
                            if (!mainTextChanged) {
                                improvedText = block.text
                            }
                            const forceTracked =
                                outputMode === "direct" &&
                                !isValid &&
                                mainTextChanged
                            this.applyImprovedBlock({
                                view,
                                block: currentBlock,
                                improvedText,
                                asTracked:
                                    outputMode === "changes" || forceTracked,
                                llmUser,
                                footnoteImprovements
                            })
                        }
                        offset +=
                            view.state.doc.content.size - docSizeBefore
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

        if (block.text !== block.plainText) {
            instructionText += `\n\n${gettext("The text also contains formatting markers such as [MARK:strong:0]...[/MARK:strong:0] for bold, [MARK:em:0]...[/MARK:em:0] for italic, [MARK:link:0]...[/MARK:link:0] for links, and [MARK:comment:0]...[/MARK:comment:0] for comments. You MUST preserve these markers exactly. Do not modify them.")}`
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
        const improvedPlainText = this.stripMarkTags(improvedText)
        if (improvedPlainText.length === 0) {
            return false
        }

        if (outputMode === "comments" || outputMode === "global_comment") {
            return true
        }

        const inputCitations = this.countCitations(block.plainText)
        const outputCitations = this.countCitations(improvedPlainText)
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
            const originalLength = block.plainText.length
            if (originalLength === 0) {
                if (improvedPlainText.length > 0) {
                    return false
                }
            } else {
                const diffPercent =
                    (Math.abs(improvedPlainText.length - originalLength) /
                        originalLength) *
                    100
                if (diffPercent > validationOptions.maxLengthDiffPercent) {
                    return false
                }
            }
        }

        if (
            validationOptions.requireChanges &&
            improvedPlainText === block.plainText
        ) {
            return false
        }

        if (
            validationOptions.translationCheckEnabled &&
            improvedPlainText === block.plainText
        ) {
            return false
        }

        if (
            validationOptions.minWordDiffCheckEnabled &&
            this.isLengthConstrainedBlock(block)
        ) {
            const diffPercent = this.computeWordDifferenceRatio(
                block.plainText,
                improvedPlainText
            )
            if (diffPercent < validationOptions.minWordDiffPercent) {
                return false
            }
        }

        return true
    }

    stripMarkTags(text) {
        return text.replace(/\[MARK:[^\]]+\]|\[\/MARK:[^\]]+\]/g, "")
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
                if (this.blockHasTextContent(serialized.plainText)) {
                    blocks.push({
                        text: serialized.plainText,
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

    blockHasFootnoteContent(placeholders) {
        return placeholders.some(
            p => p.type === "footnote" && p.footnoteText && p.footnoteText.trim()
        )
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

    computeChangeSections(originalText, improvedText) {
        const diffs = diffWordsWithSpace(originalText, improvedText)
        const sections = []
        let originalOffset = 0
        let improvedOffset = 0
        let currentSection = null

        const finalizeSection = () => {
            if (!currentSection) {
                return
            }
            const hasRemoved = currentSection.removedLength > 0
            const hasAdded = currentSection.addedLength > 0

            const applyOriginalFrom = currentSection.originalFrom
            const applyOriginalTo = currentSection.originalTo
            let displayOriginalFrom = applyOriginalFrom
            let displayOriginalTo = applyOriginalTo
            if (!hasRemoved && hasAdded) {
                // Pure insertion: expand the zero-width original range by one
                // adjacent character so the decoration is visible/clickable.
                if (displayOriginalFrom > 0) {
                    displayOriginalFrom -= 1
                } else if (displayOriginalTo < originalText.length) {
                    displayOriginalTo += 1
                }
            }

            let displayOriginalText = originalText.slice(
                displayOriginalFrom,
                displayOriginalTo
            )
            let improvedSectionText = improvedText.slice(
                currentSection.improvedFrom,
                currentSection.improvedTo
            )

            if (!hasRemoved && hasAdded) {
                // For a pure insertion, the original preview is just the
                // expanded adjacent character.
                displayOriginalText = originalText.slice(
                    displayOriginalFrom,
                    displayOriginalTo
                )
            } else if (hasRemoved && !hasAdded) {
                // For a pure deletion, the improved preview is empty.
                improvedSectionText = ""
            }

            sections.push({
                applyOriginalFrom,
                applyOriginalTo,
                displayOriginalFrom,
                displayOriginalTo,
                improvedFrom: currentSection.improvedFrom,
                improvedTo: currentSection.improvedTo,
                originalText: displayOriginalText,
                improvedText: improvedSectionText
            })
            currentSection = null
        }

        diffs.forEach(diff => {
            if (diff.added) {
                if (!currentSection) {
                    currentSection = {
                        originalFrom: originalOffset,
                        originalTo: originalOffset,
                        improvedFrom: improvedOffset,
                        improvedTo: improvedOffset,
                        removedLength: 0,
                        addedLength: 0
                    }
                }
                currentSection.improvedTo += diff.value.length
                currentSection.addedLength += diff.value.length
                improvedOffset += diff.value.length
            } else if (diff.removed) {
                if (!currentSection) {
                    currentSection = {
                        originalFrom: originalOffset,
                        originalTo: originalOffset,
                        improvedFrom: improvedOffset,
                        improvedTo: improvedOffset,
                        removedLength: 0,
                        addedLength: 0
                    }
                }
                currentSection.originalTo += diff.value.length
                currentSection.removedLength += diff.value.length
                originalOffset += diff.value.length
            } else {
                finalizeSection()
                originalOffset += diff.value.length
                improvedOffset += diff.value.length
            }
        })
        finalizeSection()

        return sections
    }

    createProposals({view, results}) {
        const llmUser = this.getLLMUser()
        const proposals = []
        results.forEach(({block, improvedText}) => {
            const improvedPlainText = this.stripMarkTags(improvedText)
            if (!improvedPlainText.trim()) {
                return
            }
            if (improvedPlainText === block.plainText) {
                return
            }
            const sections = this.computeChangeSections(
                block.plainText,
                improvedPlainText
            )
            sections.forEach(section => {
                if (
                    section.applyOriginalFrom >= section.applyOriginalTo &&
                    section.improvedFrom >= section.improvedTo
                ) {
                    return
                }
                proposalIdCounter += 1
                proposals.push({
                    id: proposalIdCounter,
                    from: this.docPosFromTextOffset(
                        block,
                        section.displayOriginalFrom
                    ),
                    to: this.docPosFromTextOffset(
                        block,
                        section.displayOriginalTo
                    ),
                    applyFrom: this.docPosFromTextOffset(
                        block,
                        section.applyOriginalFrom
                    ),
                    applyTo: this.docPosFromTextOffset(
                        block,
                        section.applyOriginalTo
                    ),
                    originalText: section.originalText,
                    improvedText: section.improvedText,
                    improvedFrom: section.improvedFrom,
                    improvedTo: section.improvedTo,
                    fullOriginalText: block.text,
                    fullImprovedText: improvedText,
                    block,
                    llmUser,
                    username: llmUser.username
                })
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
        llmUser,
        footnoteImprovements = new Map()
    }) {
        const schema = view.state.schema
        const user = llmUser || this.getLLMUser()
        const date = Date.now() - this.editor.clientTimeAdjustment

        const parsedTree = this.parseImprovedText(
            improvedText,
            block.placeholders,
            block.markRegistry,
            schema
        )

        const originalRuns = this.flattenOriginalBlock(block)
        const improvedRuns = this.flattenParsedTree(parsedTree)
        const originalPlainText = block.plainText
        const improvedPlainText = this.extractPlainTextFromRuns(improvedRuns)

        if (!asTracked) {
            const insertionMark = schema.marks.insertion.create({
                user: user.id,
                username: user.username,
                date,
                approved: true
            })
            const newNodes = this.buildDirectDiffNodes({
                originalRuns,
                improvedRuns,
                originalPlainText,
                improvedPlainText,
                insertionMark,
                schema,
                footnoteImprovements
            })
            const tr = view.state.tr
                .replaceWith(block.from + 1, block.to - 1, newNodes)
                .setMeta("llm", true)
            view.dispatch(tr)
            view.focus()
            return
        }

        const insertionMark = schema.marks.insertion.create({
            user: user.id,
            username: user.username,
            date,
            approved: false
        })
        const deletionMark = schema.marks.deletion.create({
            user: user.id,
            username: user.username,
            date
        })

        const newNodes = this.buildTrackedDiffNodes({
            originalRuns,
            improvedRuns,
            originalPlainText,
            improvedPlainText,
            insertionMark,
            deletionMark,
            schema,
            footnoteImprovements
        })

        const tr = view.state.tr
            .replaceWith(block.from + 1, block.to - 1, newNodes)
            .setMeta("llm", true)
        view.dispatch(tr)
        view.focus()
    }

    applyProposalSection({view, proposal, asTracked = false}) {
        const schema = view.state.schema
        const user = proposal.llmUser || this.getLLMUser()
        const date = Date.now() - this.editor.clientTimeAdjustment
        const block = proposal.block

        const parsedTree = this.parseImprovedText(
            proposal.fullImprovedText,
            block.placeholders,
            block.markRegistry,
            schema
        )
        const improvedRuns = this.flattenParsedTree(parsedTree)

        const hasImproved = proposal.improvedFrom < proposal.improvedTo
        const hasOriginal = proposal.applyFrom < proposal.applyTo

        if (!hasImproved) {
            // Pure deletion.
            if (asTracked && hasOriginal) {
                const deletionMark = schema.marks.deletion.create({
                    user: user.id,
                    username: user.username,
                    date
                })
                const tr = view.state.tr
                    .step(
                        new AddMarkStep(
                            proposal.applyFrom,
                            proposal.applyTo,
                            deletionMark
                        )
                    )
                    .setMeta("llm", true)
                view.dispatch(tr)
            } else if (hasOriginal) {
                const tr = view.state.tr
                    .delete(proposal.applyFrom, proposal.applyTo)
                    .setMeta("llm", true)
                view.dispatch(tr)
            }
            view.focus()
            return
        }

        const sectionNodes = this.sliceImprovedRuns(
            improvedRuns,
            proposal.improvedFrom,
            proposal.improvedTo,
            schema,
            new Map()
        )

        if (!asTracked) {
            const insertionMark = schema.marks.insertion.create({
                user: user.id,
                username: user.username,
                date,
                approved: true
            })
            const markedNodes = sectionNodes.map(node => {
                if (node.isText) {
                    return schema.text(
                        node.text,
                        node.marks.concat(insertionMark)
                    )
                }
                return node.mark(node.marks.concat(insertionMark))
            })
            const tr = view.state.tr
                .replaceWith(proposal.applyFrom, proposal.applyTo, markedNodes)
                .setMeta("llm", true)
            view.dispatch(tr)
            view.focus()
            return
        }

        // Tracked mode: mark original range as deletion and insert the new
        // text as an unapproved insertion after it.
        const tr = view.state.tr.setMeta("llm", true)
        if (hasOriginal) {
            const deletionMark = schema.marks.deletion.create({
                user: user.id,
                username: user.username,
                date
            })
            tr.step(
                new AddMarkStep(
                    proposal.applyFrom,
                    proposal.applyTo,
                    deletionMark
                )
            )
        }
        const insertionMark = schema.marks.insertion.create({
            user: user.id,
            username: user.username,
            date,
            approved: false
        })
        const markedNodes = sectionNodes.map(node => {
            if (node.isText) {
                return schema.text(node.text, node.marks.concat(insertionMark))
            }
            return node.mark(node.marks.concat(insertionMark))
        })
        tr.insert(proposal.applyTo, markedNodes)
        view.dispatch(tr)
        view.focus()
    }

    async processFootnotes({
        prompt,
        outputMode,
        view,
        block,
        signal,
        validationOptions
    }) {
        const footnoteImprovements = new Map()
        const footnotePlaceholders = block.placeholders.filter(
            p => p.type === "footnote" && p.footnoteText.trim()
        )
        if (!footnotePlaceholders.length) {
            return footnoteImprovements
        }
        for (const placeholder of footnotePlaceholders) {
            const pseudoBlock = {
                node: placeholder.node,
                text: placeholder.footnoteText,
                plainText: placeholder.footnoteText,
                placeholders: [],
                markRegistry: {keyMap: new Map(), marks: new Map()},
                from: placeholder.absPos,
                to: placeholder.absPos + placeholder.node.nodeSize
            }
            const {improvedText} = await this.processBlockWithRetries({
                prompt,
                outputMode,
                view,
                block: pseudoBlock,
                signal,
                validationOptions
            })
            if (
                improvedText.trim() &&
                this.stripMarkTags(improvedText) !== placeholder.footnoteText
            ) {
                footnoteImprovements.set(placeholder.index, improvedText)
            }
        }
        return footnoteImprovements
    }

    parseImprovedText(text, placeholders, markRegistry, schema) {
        const placeholderMap = new Map()
        placeholders.forEach(p => {
            placeholderMap.set(`${p.type}:${p.index}`, p)
        })

        const root = {type: "root", children: [], marks: []}
        const stack = [root]
        let pos = 0

        const findNextTag = () => {
            MARK_OPEN_PATTERN.lastIndex = pos
            MARK_CLOSE_PATTERN.lastIndex = pos
            PLACEHOLDER_PATTERN.lastIndex = pos

            const openMatch = MARK_OPEN_PATTERN.exec(text)
            const closeMatch = MARK_CLOSE_PATTERN.exec(text)
            const nodeMatch = PLACEHOLDER_PATTERN.exec(text)

            let nextMatch = null
            let matchType = null
            if (
                openMatch &&
                (!nextMatch || openMatch.index < nextMatch.index)
            ) {
                nextMatch = openMatch
                matchType = "open"
            }
            if (
                closeMatch &&
                (!nextMatch || closeMatch.index < nextMatch.index)
            ) {
                nextMatch = closeMatch
                matchType = "close"
            }
            if (
                nodeMatch &&
                (!nextMatch || nodeMatch.index < nextMatch.index)
            ) {
                nextMatch = nodeMatch
                matchType = "node"
            }
            return {nextMatch, matchType}
        }

        while (pos < text.length) {
            const {nextMatch, matchType} = findNextTag()
            if (!nextMatch) {
                const current = stack[stack.length - 1]
                current.children.push({
                    type: "text",
                    text: text.slice(pos),
                    marks: current.marks.slice()
                })
                break
            }

            if (nextMatch.index > pos) {
                const current = stack[stack.length - 1]
                current.children.push({
                    type: "text",
                    text: text.slice(pos, nextMatch.index),
                    marks: current.marks.slice()
                })
            }

            if (matchType === "open") {
                const markType = nextMatch[1]
                const markId = Number.parseInt(nextMatch[2], 10)
                const mark = this.getMarkByRef(
                    markType,
                    markId,
                    markRegistry,
                    schema
                )
                const current = stack[stack.length - 1]
                const newNode = {
                    type: "mark",
                    markType,
                    markId,
                    mark,
                    children: [],
                    marks: mark ? [...current.marks, mark] : current.marks.slice()
                }
                current.children.push(newNode)
                stack.push(newNode)
                pos = nextMatch.index + nextMatch[0].length
            } else if (matchType === "close") {
                const markType = nextMatch[1]
                const markId = Number.parseInt(nextMatch[2], 10)
                let foundIndex = -1
                for (let i = stack.length - 1; i >= 0; i--) {
                    if (
                        stack[i].type === "mark" &&
                        stack[i].markType === markType &&
                        stack[i].markId === markId
                    ) {
                        foundIndex = i
                        break
                    }
                }
                if (foundIndex >= 0) {
                    stack.splice(foundIndex)
                }
                pos = nextMatch.index + nextMatch[0].length
            } else if (matchType === "node") {
                const type = nextMatch[1].toLowerCase()
                const index = Number.parseInt(nextMatch[2], 10)
                const placeholder = placeholderMap.get(`${type}:${index}`)
                if (!placeholder) {
                    throw new Error(
                        gettext(
                            "The LLM returned an unexpected placeholder. Please try again with different instructions."
                        )
                    )
                }
                const current = stack[stack.length - 1]
                current.children.push({
                    type: "placeholder",
                    placeholder,
                    marks: current.marks.slice()
                })
                pos = nextMatch.index + nextMatch[0].length
            }
        }

        return root
    }

    getMarkByRef(markType, markId, markRegistry, schema) {
        const typeList = markRegistry.marks.get(markType)
        if (typeList && typeList[markId]) {
            return typeList[markId]
        }
        if (schema.marks[markType]) {
            return schema.marks[markType].create()
        }
        return null
    }

    buildNodesFromParsedTree(tree, schema, footnoteImprovements = new Map()) {
        const nodes = []
        const walk = node => {
            node.children.forEach(child => {
                if (child.type === "text") {
                    if (child.text.length) {
                        nodes.push(schema.text(child.text, child.marks))
                    }
                } else if (child.type === "placeholder") {
                    const improvement = footnoteImprovements.get(
                        child.placeholder.index
                    )
                    if (
                        improvement &&
                        child.placeholder.type === "footnote"
                    ) {
                        nodes.push(
                            this.buildFootnoteNode(
                                child.placeholder.node,
                                improvement,
                                schema
                            ).mark(child.marks)
                        )
                    } else {
                        nodes.push(child.placeholder.node.mark(child.marks))
                    }
                } else if (child.type === "mark") {
                    walk(child)
                }
            })
        }
        walk(tree)
        return nodes
    }

    buildFootnoteNode(originalNode, improvedText, schema) {
        const parsedTree = this.parseImprovedText(
            improvedText,
            [],
            {keyMap: new Map(), marks: new Map()},
            schema
        )
        const nodes = this.buildNodesFromParsedTree(parsedTree, schema)
        const content = nodes.map(node => {
            if (node.isText) {
                return {
                    type: "text",
                    text: node.text,
                    marks: node.marks.map(mark => mark.toJSON())
                }
            }
            return node.toJSON()
        })
        return originalNode.type.create({
            footnote: [{type: "paragraph", content}]
        })
    }

    flattenOriginalBlock(block) {
        const runs = []
        let offset = 0
        let placeholderIndex = 0
        block.node.forEach(child => {
            if (child.isText) {
                runs.push({
                    type: "text",
                    node: child,
                    marks: child.marks,
                    start: offset,
                    end: offset + child.text.length
                })
                offset += child.text.length
            } else if (
                child.isInline &&
                PLACEHOLDER_TYPES.includes(child.type.name)
            ) {
                const placeholder = block.placeholders[placeholderIndex]
                const idLen = placeholder ? placeholder.id.length : 0
                runs.push({
                    type: "placeholder",
                    node: child,
                    placeholder,
                    marks: child.marks,
                    start: offset,
                    end: offset + idLen
                })
                offset += idLen
                placeholderIndex++
            }
        })
        return runs
    }

    flattenParsedTree(tree) {
        const runs = []
        let offset = 0
        const walk = node => {
            node.children.forEach(child => {
                if (child.type === "text") {
                    runs.push({
                        type: "text",
                        text: child.text,
                        marks: child.marks,
                        start: offset,
                        end: offset + child.text.length
                    })
                    offset += child.text.length
                } else if (child.type === "placeholder") {
                    const idLen = child.placeholder.id.length
                    runs.push({
                        type: "placeholder",
                        placeholder: child.placeholder,
                        marks: child.marks,
                        start: offset,
                        end: offset + idLen
                    })
                    offset += idLen
                } else if (child.type === "mark") {
                    walk(child)
                }
            })
        }
        walk(tree)
        return runs
    }

    extractPlainTextFromRuns(runs) {
        return runs
            .map(run =>
                run.type === "text" ? run.text : run.placeholder.id
            )
            .join("")
    }

    buildTrackedDiffNodes({
        originalRuns,
        improvedRuns,
        originalPlainText,
        improvedPlainText,
        insertionMark,
        deletionMark,
        schema,
        footnoteImprovements = new Map()
    }) {
        const diffs = diffWordsWithSpace(originalPlainText, improvedPlainText)
        const nodes = []
        let sourceOffset = 0
        let improvedOffset = 0

        for (const diff of diffs) {
            if (diff.added) {
                const addedNodes = this.sliceImprovedRuns(
                    improvedRuns,
                    improvedOffset,
                    improvedOffset + diff.value.length,
                    schema,
                    footnoteImprovements
                )
                addedNodes.forEach(node => {
                    if (node.isText) {
                        nodes.push(
                            schema.text(
                                node.text,
                                node.marks.concat(insertionMark)
                            )
                        )
                    } else {
                        nodes.push(
                            node.mark(node.marks.concat(insertionMark))
                        )
                    }
                })
                improvedOffset += diff.value.length
            } else if (diff.removed) {
                const removedNodes = this.sliceOriginalRuns(
                    originalRuns,
                    sourceOffset,
                    sourceOffset + diff.value.length,
                    schema,
                    footnoteImprovements
                )
                removedNodes.forEach(node => {
                    if (node.isText) {
                        nodes.push(
                            schema.text(
                                node.text,
                                node.marks.concat(deletionMark)
                            )
                        )
                    } else {
                        nodes.push(
                            node.mark(node.marks.concat(deletionMark))
                        )
                    }
                })
                sourceOffset += diff.value.length
            } else {
                const unchangedNodes = this.sliceOriginalRuns(
                    originalRuns,
                    sourceOffset,
                    sourceOffset + diff.value.length,
                    schema,
                    footnoteImprovements
                )
                nodes.push(...unchangedNodes)
                sourceOffset += diff.value.length
                improvedOffset += diff.value.length
            }
        }

        return nodes
    }

    buildDirectDiffNodes({
        originalRuns,
        improvedRuns,
        originalPlainText,
        improvedPlainText,
        insertionMark,
        schema,
        footnoteImprovements = new Map()
    }) {
        const diffs = diffWordsWithSpace(originalPlainText, improvedPlainText)
        const nodes = []
        let sourceOffset = 0
        let improvedOffset = 0

        for (const diff of diffs) {
            if (diff.added) {
                const addedNodes = this.sliceImprovedRuns(
                    improvedRuns,
                    improvedOffset,
                    improvedOffset + diff.value.length,
                    schema,
                    footnoteImprovements
                )
                addedNodes.forEach(node => {
                    if (node.isText) {
                        nodes.push(
                            schema.text(
                                node.text,
                                node.marks.concat(insertionMark)
                            )
                        )
                    } else {
                        nodes.push(
                            node.mark(node.marks.concat(insertionMark))
                        )
                    }
                })
                improvedOffset += diff.value.length
            } else if (diff.removed) {
                // In direct mode, removed text is simply omitted.
                sourceOffset += diff.value.length
            } else {
                const unchangedNodes = this.sliceOriginalRuns(
                    originalRuns,
                    sourceOffset,
                    sourceOffset + diff.value.length,
                    schema,
                    footnoteImprovements
                )
                nodes.push(...unchangedNodes)
                sourceOffset += diff.value.length
                improvedOffset += diff.value.length
            }
        }

        return nodes
    }

    sliceOriginalRuns(runs, start, end, schema, footnoteImprovements = new Map()) {
        const nodes = []
        for (const run of runs) {
            if (run.end <= start) {
                continue
            }
            if (run.start >= end) {
                break
            }
            const overlapStart = Math.max(run.start, start)
            const overlapEnd = Math.min(run.end, end)
            if (run.type === "text") {
                const sliceText = run.node.text.slice(
                    overlapStart - run.start,
                    overlapEnd - run.start
                )
                nodes.push(schema.text(sliceText, run.marks))
            } else {
                const improvement = footnoteImprovements.get(
                    run.placeholder.index
                )
                if (improvement && run.placeholder.type === "footnote") {
                    nodes.push(
                        this.buildFootnoteNode(
                            run.placeholder.node,
                            improvement,
                            schema
                        ).mark(run.marks)
                    )
                } else {
                    nodes.push(run.node.mark(run.marks))
                }
            }
        }
        return nodes
    }

    sliceImprovedRuns(runs, start, end, schema, footnoteImprovements = new Map()) {
        const nodes = []
        for (const run of runs) {
            if (run.end <= start) {
                continue
            }
            if (run.start >= end) {
                break
            }
            const overlapStart = Math.max(run.start, start)
            const overlapEnd = Math.min(run.end, end)
            if (run.type === "text") {
                const sliceText = run.text.slice(
                    overlapStart - run.start,
                    overlapEnd - run.start
                )
                nodes.push(schema.text(sliceText, run.marks))
            } else {
                const improvement = footnoteImprovements.get(
                    run.placeholder.index
                )
                if (improvement && run.placeholder.type === "footnote") {
                    nodes.push(
                        this.buildFootnoteNode(
                            run.placeholder.node,
                            improvement,
                            schema
                        ).mark(run.marks)
                    )
                } else {
                    nodes.push(run.placeholder.node.mark(run.marks))
                }
            }
        }
        return nodes
    }

    applyComments({view, block, commentsText, llmUser}) {
        this.applyCommentsToRange({
            view,
            from: block.from + 1,
            to: block.to - 1,
            commentsText,
            llmUser
        })
    }

    applyCommentsToRange({view, from, to, commentsText, llmUser}) {
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
            store.addComment(commentData, from, to, view)
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
}
