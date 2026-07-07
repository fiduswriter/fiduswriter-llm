import {Plugin, PluginKey, TextSelection} from "prosemirror-state"
import {Decoration, DecorationSet} from "prosemirror-view"

import {LLMReviewDialog} from "./review_dialog"

const key = new PluginKey("llm")

export const setProposals = function (state, newProposals) {
    const keyState = key.getState(state)
    let decos = keyState.decos
    let proposals = keyState.proposals.slice()

    newProposals.forEach(proposal => {
        const deco = Decoration.inline(
            proposal.from,
            proposal.to,
            {class: "llm-proposal"},
            {id: proposal.id}
        )
        decos = decos.add(state.doc, [deco])
    })

    proposals = proposals.concat(newProposals)

    return state.tr.setMeta(key, {decos, proposals})
}

export const removeProposal = function (state, proposalId) {
    const keyState = key.getState(state)
    let proposals = keyState.proposals
    let decos = keyState.decos

    const proposal = proposals.find(p => p.id === proposalId)
    if (!proposal) {
        return
    }

    proposals = proposals.filter(p => p.id !== proposalId)
    const deco = decos.find(proposal.from, proposal.to).find(d => d.spec.id === proposalId)
    if (deco) {
        decos = decos.remove([deco])
    }

    return state.tr.setMeta(key, {decos, proposals})
}

export const removeAllProposals = function (state) {
    const keyState = key.getState(state)
    if (keyState.proposals.length === 0) {
        return
    }
    return state.tr.setMeta(key, {decos: DecorationSet.empty, proposals: []})
}

export const hasProposals = function (state) {
    const keyState = key.getState(state)
    return keyState.proposals.length > 0
}

export const llmPlugin = function (options) {
    return new Plugin({
        key,
        state: {
            init() {
                return {
                    decos: DecorationSet.empty,
                    proposals: []
                }
            },
            apply(tr, prev, _oldState, state) {
                const meta = tr.getMeta(key)
                if (meta) {
                    return meta
                }
                let decos = prev.decos
                let proposals = prev.proposals

                decos = decos.map(tr.mapping, tr.doc)
                proposals = proposals.map(proposal => {
                    const mappedFrom = tr.mapping.map(proposal.from, -1)
                    const mappedTo = tr.mapping.map(proposal.to, 1)
                    return Object.assign({}, proposal, {
                        from: mappedFrom,
                        to: mappedTo
                    })
                })

                return {decos, proposals}
            }
        },
        props: {
            decorations(state) {
                const {decos} = this.getState(state)
                return decos
            },
            handleDOMEvents: {
                contextmenu(view, event) {
                    let pos = view.posAtCoords({
                        left: event.clientX,
                        top: event.clientY
                    })
                    if (!pos) {
                        return false
                    }
                    pos = pos.pos
                    const {decos, proposals} = this.getState(view.state)
                    const deco = decos.find(pos, pos)[0]
                    if (!deco) {
                        return false
                    }
                    const proposal = proposals[deco.spec.id]
                    if (!proposal) {
                        return false
                    }

                    const transaction = view.state.tr.setSelection(
                        TextSelection.create(view.state.doc, deco.from, deco.to)
                    )
                    view.dispatch(transaction)

                    const dialog = new LLMReviewDialog(
                        options.editor,
                        view,
                        proposal,
                        options.editorLlm
                    )
                    dialog.init()
                    event.preventDefault()
                    return true
                }
            }
        }
    })
}
