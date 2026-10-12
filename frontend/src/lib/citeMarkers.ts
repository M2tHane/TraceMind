/**
 * Inline citation markers: generated answers carry `[^n]` right after the sentence that
 * citation n supports (n is the 1-based index into the message's citations).
 */
export const MARKER = /\[\^(\d{1,3})\]/g

/** Answer text without markers, for copying and plain-text use. */
export function stripMarkers(text: string): string {
  return text.replace(/[ \t]*\[\^\d{1,3}\]/g, '')
}

/** Citation numbers that appear inline in the answer. */
export function markedCitations(text: string): Set<number> {
  return new Set([...text.matchAll(MARKER)].map(match => Number(match[1])))
}

type MdNode = { type: string; value?: string; children?: MdNode[]; data?: Record<string, unknown> }

const BOUNDARY = /[。！？；!?;\n]|\.(?=\s)/g

/** Index where the sentence ending at `text`'s end starts. */
function sentenceStart(text: string): number {
  let start = 0
  for (const match of text.matchAll(BOUNDARY)) if (match.index! + match[0].length < text.length) start = match.index! + match[0].length
  while (start < text.length && /\s/.test(text[start])) start += 1
  return start
}

/**
 * Split one text node: each run of markers becomes `<sup data-cite>` nodes, and the sentence
 * tail right before the run becomes `<span data-cite-span="1 2">` so it can be highlighted.
 */
function splitText(value: string): MdNode[] {
  const out: MdNode[] = []
  const runs = [...value.matchAll(/(?:\s*\[\^\d{1,3}\])+/g)]
  let cursor = 0
  for (const run of runs) {
    const before = value.slice(cursor, run.index)
    const numbers = [...run[0].matchAll(MARKER)].map(match => match[1])
    const start = sentenceStart(before)
    if (start > 0) out.push({ type: 'text', value: before.slice(0, start) })
    if (start < before.length) out.push({ type: 'citeSpan', data: { hName: 'span', hProperties: { dataCiteSpan: numbers.join(' ') } }, children: [{ type: 'text', value: before.slice(start) }] })
    for (const n of numbers) out.push({ type: 'citeMarker', data: { hName: 'sup', hProperties: { dataCite: n } }, children: [{ type: 'text', value: n }] })
    cursor = run.index! + run[0].length
  }
  if (cursor < value.length) out.push({ type: 'text', value: value.slice(cursor) })
  return out
}

function walk(node: MdNode): void {
  if (!node.children || node.type === 'code' || node.type === 'inlineCode') return
  node.children = node.children.flatMap(child => {
    if (child.type === 'text' && child.value && /\[\^\d{1,3}\]/.test(child.value)) return splitText(child.value)
    walk(child)
    return [child]
  })
}

/** remark plugin (no dependencies: mdast is plain JSON). */
export function remarkCiteMarkers() {
  return (tree: MdNode) => walk(tree)
}
