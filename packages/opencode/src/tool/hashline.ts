import { createHash } from "node:crypto"

const SMALL_HASH_LEN = 3
const LARGE_HASH_LEN = 4
const HASH_THRESHOLD = 4096
const FILE_REV_LEN = 8

export const PREFIX = "#HL"

function hashText(text: string, length: number): string {
  return createHash("sha1").update(text, "utf8").digest("hex").slice(0, length).toUpperCase()
}

export function adaptiveHashLength(totalLines: number): number {
  return totalLines > HASH_THRESHOLD ? LARGE_HASH_LEN : SMALL_HASH_LEN
}

export function lineHash(line: string, length: number): string {
  return hashText(line, length)
}

export function anchorHash(
  prev: string | undefined,
  line: string,
  next: string | undefined,
  length: number,
): string {
  return hashText(`${prev ?? ""}\u241E${line}\u241E${next ?? ""}`, length)
}

export function computeFileRev(raw: string): string {
  const normalized = raw.includes("\r\n") ? raw.replace(/\r\n/g, "\n") : raw
  return hashText(normalized, FILE_REV_LEN)
}

export interface ParsedRef {
  lineNumber: number
  hash: string
  anchor?: string
}

export function parseRef(ref: string): ParsedRef {
  const text = ref.trim().replace(/^(?:#HL|;;;)\s*/i, "").split("|")[0].trim()
  const match = text.match(/^(\d+)\s*[#: ]\s*([A-Za-z0-9]+)(?:\s*[#: ]\s*([A-Za-z0-9]+))?$/)
  if (!match) {
    throw new Error(
      `Invalid line reference "${ref}". Expected format: <line>#<hash> or <line>#<hash>#<anchor> (example: 22#A3F or 22#A3F#9BC)`,
    )
  }
  const lineNumber = Number.parseInt(match[1], 10)
  if (!Number.isFinite(lineNumber) || lineNumber < 1) {
    throw new Error(`Invalid line number in reference "${ref}"`)
  }
  return { lineNumber, hash: match[2].toUpperCase(), anchor: match[3]?.toUpperCase() }
}

export interface ParsedFile {
  lines: string[]
  eol: "\n" | "\r\n"
  endsWithNewline: boolean
}

export function parseFile(raw: string): ParsedFile {
  const eol: "\n" | "\r\n" = raw.includes("\r\n") ? "\r\n" : "\n"
  const normalized = eol === "\r\n" ? raw.replace(/\r\n/g, "\n") : raw
  const endsWithNewline = normalized.endsWith("\n")
  let lines: string[] = []
  if (normalized.length > 0) {
    lines = normalized.split("\n")
    if (endsWithNewline) lines.pop()
  }
  return { lines, eol, endsWithNewline }
}

export function stringifyLines(parsed: ParsedFile): string {
  if (parsed.lines.length === 0) return ""
  const body = parsed.lines.join(parsed.eol)
  return parsed.endsWithNewline ? `${body}${parsed.eol}` : body
}

export function splitContentToLines(content: string): string[] {
  const normalized = content.replace(/\r\n/g, "\n")
  const parts = normalized.split("\n")
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop()
  return parts
}

export function stripHashlineContent(text: string): string {
  const refPattern = /^#HL\s+\d+\s*#\s*[A-Fa-f0-9]+(?:\s*#\s*[A-Fa-f0-9]+)?\|/
  const revPattern = /^#HL\s+REV:[A-Fa-f0-9]{8}$/i
  return text
    .split("\n")
    .filter((line) => !revPattern.test(line))
    .map((line) => {
      const match = line.match(refPattern)
      return match ? line.slice(match[0].length) : line
    })
    .join("\n")
}
