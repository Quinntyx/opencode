import { createHash } from "node:crypto"

// Hashline refs use a 3-char hash for files <= 4096 lines and 4-char otherwise.
// The diff metadata does not carry the file's total line count, so we render the
// common (3-char) form. Rare edits on >4096-line files will show truncated hashes.
const HASH_LEN = 3

export interface EditHashlineSign {
  before?: string
  beforeColor?: string
  after?: string
  afterColor?: string
}

export interface EditHashlines {
  // row index -> displayed new-file line number
  lineNumbers: Map<number, number>
  // rows whose line number should be hidden (headers, hunks, removals)
  hideRows: Set<number>
  // row index -> hashline sign rendered beside the line number
  lineSigns: Map<number, EditHashlineSign>
}

function shortHash(input: string): string {
  return createHash("sha1").update(input, "utf8").digest("hex").slice(0, HASH_LEN).toUpperCase()
}

export function lineHashRef(line: string): string {
  return shortHash(line)
}

export function anchorHashRef(prev: string | undefined, line: string, next: string | undefined): string {
  return shortHash(`${prev ?? ""}\u241E${line}\u241E${next ?? ""}`)
}

// Parses a unified diff (as produced by the edit tool) into per-row line numbers
// and hashline signs so the gutter can show the same `<line>#<hash>#<anchor>`
// refs the model sees. Removals and metadata rows are hidden.
export function parseEditHashlines(diff: string): EditHashlines {
  const lines = diff.split("\n")
  const lineNumbers = new Map<number, number>()
  const hideRows = new Set<number>()
  const lineSigns = new Map<number, EditHashlineSign>()

  interface NewRow {
    row: number
    content: string
    newLine: number
  }
  const newRows: NewRow[] = []
  let newLine = 0

  for (let row = 0; row < lines.length; row++) {
    const line = lines[row]
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
    if (hunk) {
      hideRows.add(row)
      newLine = Number.parseInt(hunk[1], 10)
      continue
    }
    if (/^(---|\+\+\+) /.test(line) || line === "---" || line === "+++" || line.startsWith("\\")) {
      hideRows.add(row)
      continue
    }
    if (line.startsWith("+") || line.startsWith(" ")) {
      newRows.push({ row, content: line.slice(1), newLine })
      newLine++
      continue
    }
    // removals ("-...") and anything else (Index:, ===, blanks)
    hideRows.add(row)
  }

  for (let i = 0; i < newRows.length; i++) {
    const { row, content, newLine: ln } = newRows[i]
    const prev = i > 0 ? newRows[i - 1].content : undefined
    const next = i < newRows.length - 1 ? newRows[i + 1].content : undefined
    lineNumbers.set(row, ln)
    lineSigns.set(row, { after: `#${lineHashRef(content)}#${anchorHashRef(prev, content, next)}` })
  }

  return { lineNumbers, hideRows, lineSigns }
}
