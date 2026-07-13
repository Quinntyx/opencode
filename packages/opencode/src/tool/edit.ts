// the approaches in this edit tool are sourced from
// https://github.com/cline/cline/blob/main/evals/diff-edits/diff-apply/diff-06-23-25.ts
// https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/utils/editCorrector.ts
// https://github.com/cline/cline/blob/main/evals/diff-edits/diff-apply/diff-06-26-25.ts

import * as path from "path"
import { Effect, Schema, Semaphore } from "effect"
import * as Tool from "./tool"
import { LSP } from "@/lsp/lsp"
import { createTwoFilesPatch, diffLines } from "diff"
import DESCRIPTION from "./edit.txt"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { Watcher } from "@opencode-ai/core/filesystem/watcher"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Format } from "../format"
import { InstanceState } from "@/effect/instance-state"
import { Snapshot } from "@/snapshot"
import { assertExternalDirectoryEffect } from "./external-directory"
import { FSUtil } from "@opencode-ai/core/fs-util"
import * as Bom from "@/util/bom"
import * as Hashline from "./hashline"

function normalizeLineEndings(text: string): string {
  return text.replaceAll("\r\n", "\n")
}

function detectLineEnding(text: string): "\n" | "\r\n" {
  return text.includes("\r\n") ? "\r\n" : "\n"
}

function convertToLineEnding(text: string, ending: "\n" | "\r\n"): string {
  if (ending === "\n") return text
  return text.replaceAll("\n", "\r\n")
}

const locks = new Map<string, Semaphore.Semaphore>()

function lock(filePath: string) {
  const resolvedFilePath = FSUtil.resolve(filePath)
  const hit = locks.get(resolvedFilePath)
  if (hit) return hit

  const next = Semaphore.makeUnsafe(1)
  locks.set(resolvedFilePath, next)
  return next
}

interface HashlineOpInput {
  ref?: string
  startRef?: string
  endRef?: string
  content?: string
}

interface ResolvedOp {
  startIndex: number
  endIndex: number
  insertLines: string[]
  label: string
}

function buildOperations(params: {
  operations?: ReadonlyArray<HashlineOpInput>
  ref?: string
  startRef?: string
  endRef?: string
  content?: string
}): HashlineOpInput[] {
  if (params.operations && params.operations.length > 0) {
    return params.operations.map((op) => ({
      ref: op.ref,
      startRef: op.startRef,
      endRef: op.endRef,
      content: op.content,
    }))
  }
  return [{ ref: params.ref, startRef: params.startRef, endRef: params.endRef, content: params.content }]
}

function resolveRefIndex(
  ref: string,
  lines: string[],
  hashLength: number,
  safeReapply: boolean,
): number {
  const parsed = Hashline.parseRef(ref)
  if (parsed.lineNumber > lines.length) {
    throw new Error(
      `Reference ${ref} points to line ${parsed.lineNumber}, but file only has ${lines.length} lines. Read the file again.`,
    )
  }

  const index = parsed.lineNumber - 1
  const actualLine = lines[index]
  const actualHash = Hashline.lineHash(actualLine, hashLength)
  const actualAnchor = Hashline.anchorHash(lines[index - 1], actualLine, lines[index + 1], hashLength)

  if (actualHash !== parsed.hash || (parsed.anchor && actualAnchor !== parsed.anchor)) {
    if (safeReapply) {
      const candidates = findRefCandidates(parsed, lines, hashLength)
      if (candidates.length === 1) return candidates[0]
      if (candidates.length > 1) {
        throw new Error(
          `Hash mismatch for line ${parsed.lineNumber}; found multiple candidates (lines ${candidates.map((c) => c + 1).join(", ")}). Read the file again.`,
        )
      }
      throw new Error(`Hash mismatch for line ${parsed.lineNumber}; no candidates found. Read the file again.`)
    }

    const expected = parsed.anchor
      ? `${parsed.lineNumber}#${parsed.hash}#${parsed.anchor}`
      : `${parsed.lineNumber}#${parsed.hash}`
    const actual = `${parsed.lineNumber}#${actualHash}#${actualAnchor}`
    throw new Error(`Hash mismatch for line ${parsed.lineNumber}. Expected ${expected}, actual ${actual}. Read the file again.`)
  }

  return index
}

function findRefCandidates(parsed: Hashline.ParsedRef, lines: string[], hashLength: number): number[] {
  const candidates: number[] = []
  for (let idx = 0; idx < lines.length; idx++) {
    if (Hashline.lineHash(lines[idx], hashLength) !== parsed.hash) continue
    if (parsed.anchor && Hashline.anchorHash(lines[idx - 1], lines[idx], lines[idx + 1], hashLength) !== parsed.anchor)
      continue
    candidates.push(idx)
  }
  return candidates
}

function resolveOperation(
  op: HashlineOpInput,
  lines: string[],
  hashLength: number,
  safeReapply: boolean,
): ResolvedOp {
  if (op.ref && op.startRef) {
    throw new Error("Use either ref or startRef/endRef, not both")
  }

  const baseRef = op.startRef ?? op.ref
  if (!baseRef) throw new Error("Operation requires ref or startRef")
  if (op.content === undefined) throw new Error("Operation requires content")

  const startIndex = resolveRefIndex(baseRef, lines, hashLength, safeReapply)
  const endIndex = op.endRef ? resolveRefIndex(op.endRef, lines, hashLength, safeReapply) : startIndex

  const start = Math.min(startIndex, endIndex)
  const end = Math.max(startIndex, endIndex)

  return {
    startIndex: start,
    endIndex: end,
    insertLines: Hashline.splitContentToLines(Hashline.stripHashlineContent(op.content)),
    label: `${baseRef}..${op.endRef ?? baseRef}`,
  }
}

function validateNoOverlap(ops: ResolvedOp[]): void {
  const consumed = new Set<number>()
  for (const op of ops) {
    for (let i = op.startIndex; i <= op.endIndex; i++) {
      if (consumed.has(i)) {
        throw new Error(`Overlapping operations: ${op.label} conflicts with a previous operation`)
      }
      consumed.add(i)
    }
  }
}

function applyHashlineChanges(
  lines: string[],
  ops: ResolvedOp[],
): { lines: string[]; additions: number; deletions: number } {
  const sorted = [...ops].sort((a, b) => b.startIndex - a.startIndex)
  const nextLines = [...lines]
  let additions = 0
  let deletions = 0
  for (const op of sorted) {
    additions += op.insertLines.length
    deletions += op.endIndex - op.startIndex + 1
    nextLines.splice(op.startIndex, op.endIndex - op.startIndex + 1, ...op.insertLines)
  }
  return { lines: nextLines, additions, deletions }
}

const Operation = Schema.Struct({
  op: Schema.optional(Schema.Literals(["replace", "replace_range"])).annotate({
    description: "Operation type. 'replace' replaces the line(s) identified by ref or startRef/endRef with content.",
  }),
  ref: Schema.optional(Schema.String).annotate({
    description: "Single-line ref from Read output, e.g. '3#A0C#393'. Replaces just that line.",
  }),
  startRef: Schema.optional(Schema.String).annotate({
    description: "Start ref for a multi-line range. Must be used with endRef.",
  }),
  endRef: Schema.optional(Schema.String).annotate({
    description: "End ref for a multi-line range. Must be used with startRef.",
  }),
  content: Schema.optional(Schema.String).annotate({
    description: "Replacement text for this operation.",
  }),
})

export const Parameters = Schema.Struct({
  filePath: Schema.String.annotate({ description: "The absolute path to the file to modify" }),
  content: Schema.optional(Schema.String).annotate({
    description: "Replacement text when using ref or startRef-based edits.",
  }),
  ref: Schema.optional(Schema.String).annotate({
    description:
      "Single-line ref from Read output, e.g. '3#A0C#393'. Validates target line content before replacing.",
  }),
  startRef: Schema.optional(Schema.String).annotate({
    description: "Start ref from Read output. Validates target line content before replacing.",
  }),
  endRef: Schema.optional(Schema.String).annotate({
    description: "End ref for multi-line range replacement. Only used with startRef.",
  }),
  fileRev: Schema.optional(Schema.String).annotate({
    description: "REV token from Read output, e.g. '2ED9E6A9'. When set, edit fails if file hash mismatch.",
  }),
  safeReapply: Schema.optional(Schema.Boolean).annotate({
    description: "If true and hash mismatch, reapplies with refs adjusted to new context.",
  }),
  operations: Schema.optional(Schema.Array(Operation)).annotate({
    description: "Batch multiple same-file edits. Each entry has op, ref/startRef/endRef, and content.",
  }),
  oldString: Schema.optional(Schema.String).annotate({
    description: "The text to replace (legacy path). Prefer ref/startRef with content when possible.",
  }),
  newString: Schema.optional(Schema.String).annotate({
    description: "The text to replace it with (must be different from oldString).",
  }),
  replaceAll: Schema.optional(Schema.Boolean).annotate({
    description: "Replace all occurrences of oldString (default false, legacy path).",
  }),
})

export const EditTool = Tool.define(
  "edit",
  Effect.gen(function* () {
    const lsp = yield* LSP.Service
    const afs = yield* FSUtil.Service
    const format = yield* Format.Service
    const events = yield* EventV2Bridge.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          if (!params.filePath) {
            throw new Error("filePath is required")
          }

          const isHashline = Boolean(params.ref || params.startRef || params.operations)
          if (!isHashline && params.oldString === params.newString) {
            throw new Error("No changes to apply: oldString and newString are identical.")
          }

          const instance = yield* InstanceState.context
          const filePath = path.isAbsolute(params.filePath)
            ? params.filePath
            : path.join(instance.directory, params.filePath)
          yield* assertExternalDirectoryEffect(ctx, filePath)

          let diff = ""
          let contentOld = ""
          let contentNew = ""
          let isNewFile = false

          yield* lock(filePath).withPermits(1)(
            Effect.gen(function* () {
              let sourceBom = false

              if (isHashline) {
                const info = yield* afs.stat(filePath).pipe(Effect.catch(() => Effect.succeed(undefined)))
                if (!info) throw new Error(`File ${filePath} not found`)
                if (info.type === "Directory") throw new Error(`Path is a directory, not a file: ${filePath}`)

                const source = yield* Bom.readFile(afs, filePath)
                sourceBom = source.bom
                contentOld = source.text

                const parsed = Hashline.parseFile(contentOld)
                const hashLength = Hashline.adaptiveHashLength(parsed.lines.length)

                if (params.fileRev) {
                  const actualRev = Hashline.computeFileRev(contentOld)
                  if (actualRev !== params.fileRev.toUpperCase()) {
                    throw new Error(
                      `File revision mismatch for ${filePath}. Expected ${params.fileRev.toUpperCase()}, actual ${actualRev}. Read the file again before editing.`,
                    )
                  }
                }

                const ops = buildOperations(params)
                const resolved = ops.map((op) =>
                  resolveOperation(op, parsed.lines, hashLength, Boolean(params.safeReapply)),
                )
                validateNoOverlap(resolved)

                const result = applyHashlineChanges(parsed.lines, resolved)
                contentNew = Hashline.stringifyLines({
                  lines: result.lines,
                  eol: parsed.eol,
                  endsWithNewline: parsed.endsWithNewline,
                })
              } else if (params.oldString === "") {
                isNewFile = true
                const existed = yield* afs.existsSafe(filePath)
                if (existed) {
                  throw new Error(
                    "oldString cannot be empty when editing an existing file. Provide the exact text to replace, or use write for an intentional full-file replacement.",
                  )
                }
                contentOld = ""
                contentNew = params.newString ?? ""
              } else {
                const info = yield* afs.stat(filePath).pipe(Effect.catch(() => Effect.succeed(undefined)))
                if (!info) throw new Error(`File ${filePath} not found`)
                if (info.type === "Directory") throw new Error(`Path is a directory, not a file: ${filePath}`)

                const source = yield* Bom.readFile(afs, filePath)
                sourceBom = source.bom
                contentOld = source.text

                const ending = detectLineEnding(contentOld)
                const old = convertToLineEnding(normalizeLineEndings(params.oldString ?? ""), ending)
                const replacement = convertToLineEnding(normalizeLineEndings(params.newString ?? ""), ending)

                contentNew = replace(contentOld, old, replacement, params.replaceAll)
              }

              const next = Bom.split(contentNew)
              const desiredBom = sourceBom || next.bom
              contentNew = next.text

              diff = trimDiff(
                createTwoFilesPatch(
                  filePath,
                  filePath,
                  normalizeLineEndings(contentOld),
                  normalizeLineEndings(contentNew),
                ),
              )
              yield* ctx.ask({
                permission: "edit",
                patterns: [path.relative(instance.worktree, filePath)],
                always: ["*"],
                metadata: {
                  filepath: filePath,
                  diff,
                },
              })

              yield* afs.writeWithDirs(filePath, Bom.join(contentNew, desiredBom))
              if (yield* format.file(filePath)) {
                contentNew = yield* Bom.syncFile(afs, filePath, desiredBom)
              }
              yield* events.publish(FileSystem.Event.Edited, { file: filePath })
              yield* events.publish(Watcher.Event.Updated, {
                file: filePath,
                event: isNewFile ? "add" : "change",
              })
              diff = trimDiff(
                createTwoFilesPatch(
                  filePath,
                  filePath,
                  normalizeLineEndings(contentOld),
                  normalizeLineEndings(contentNew),
                ),
              )
            }).pipe(Effect.orDie),
          )

          let additions = 0
          let deletions = 0
          for (const change of diffLines(contentOld, contentNew)) {
            if (change.added) additions += change.count || 0
            if (change.removed) deletions += change.count || 0
          }
          const filediff: Snapshot.FileDiff = {
            file: filePath,
            patch: diff,
            additions,
            deletions,
          }

          yield* ctx.metadata({
            metadata: {
              diff,
              filediff,
              diagnostics: {},
            },
          })

          let output = "Edit applied successfully."
          yield* lsp.touchFile(filePath, "document")
          const diagnostics = yield* lsp.diagnostics()
          const normalizedFilePath = FSUtil.normalizePath(filePath)
          const block = LSP.Diagnostic.report(filePath, diagnostics[normalizedFilePath] ?? [])
          if (block) output += `\n\nLSP errors detected in this file, please fix:\n${block}`

          return {
            metadata: {
              diagnostics,
              diff,
              filediff,
            },
            title: `${path.relative(instance.worktree, filePath)}`,
            output,
          }
        }),
    }
  }),
)

export type Replacer = (content: string, find: string) => Generator<string, void, unknown>

// Similarity thresholds for block anchor fallback matching
const SINGLE_CANDIDATE_SIMILARITY_THRESHOLD = 0.65
const MULTIPLE_CANDIDATES_SIMILARITY_THRESHOLD = 0.65

/**
 * Levenshtein distance algorithm implementation
 */
function levenshtein(a: string, b: string): number {
  // Handle empty strings
  if (a === "" || b === "") {
    return Math.max(a.length, b.length)
  }
  const matrix = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  )

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      matrix[i][j] = Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j - 1] + cost)
    }
  }
  return matrix[a.length][b.length]
}

export const SimpleReplacer: Replacer = function* (_content, find) {
  yield find
}

export const LineTrimmedReplacer: Replacer = function* (content, find) {
  const originalLines = content.split("\n")
  const searchLines = find.split("\n")

  if (searchLines[searchLines.length - 1] === "") {
    searchLines.pop()
  }

  for (let i = 0; i <= originalLines.length - searchLines.length; i++) {
    let matches = true

    for (let j = 0; j < searchLines.length; j++) {
      const originalTrimmed = originalLines[i + j].trim()
      const searchTrimmed = searchLines[j].trim()

      if (originalTrimmed !== searchTrimmed) {
        matches = false
        break
      }
    }

    if (matches) {
      let matchStartIndex = 0
      for (let k = 0; k < i; k++) {
        matchStartIndex += originalLines[k].length + 1
      }

      let matchEndIndex = matchStartIndex
      for (let k = 0; k < searchLines.length; k++) {
        matchEndIndex += originalLines[i + k].length
        if (k < searchLines.length - 1) {
          matchEndIndex += 1 // Add newline character except for the last line
        }
      }

      yield content.substring(matchStartIndex, matchEndIndex)
    }
  }
}

export const BlockAnchorReplacer: Replacer = function* (content, find) {
  const originalLines = content.split("\n")
  const searchLines = find.split("\n")

  if (searchLines.length < 3) {
    return
  }

  if (searchLines[searchLines.length - 1] === "") {
    searchLines.pop()
  }

  const firstLineSearch = searchLines[0].trim()
  const lastLineSearch = searchLines[searchLines.length - 1].trim()
  const searchBlockSize = searchLines.length
  const maxLineDelta = Math.max(1, Math.floor(searchBlockSize * 0.25))

  // Collect all candidate positions where both anchors match
  const candidates: Array<{ startLine: number; endLine: number }> = []
  for (let i = 0; i < originalLines.length; i++) {
    if (originalLines[i].trim() !== firstLineSearch) {
      continue
    }

    // Look for the matching last line after this first line
    for (let j = i + 2; j < originalLines.length; j++) {
      if (originalLines[j].trim() === lastLineSearch) {
        const actualBlockSize = j - i + 1
        if (Math.abs(actualBlockSize - searchBlockSize) <= maxLineDelta) {
          candidates.push({ startLine: i, endLine: j })
        }
        break // Only match the first occurrence of the last line
      }
    }
  }

  // Return immediately if no candidates
  if (candidates.length === 0) {
    return
  }

  // Handle single candidate scenario (using relaxed threshold)
  if (candidates.length === 1) {
    const { startLine, endLine } = candidates[0]
    const actualBlockSize = endLine - startLine + 1

    let similarity = 0
    const linesToCheck = Math.min(searchBlockSize - 2, actualBlockSize - 2) // Middle lines only

    if (linesToCheck > 0) {
      for (let j = 1; j < searchBlockSize - 1 && j < actualBlockSize - 1; j++) {
        const originalLine = originalLines[startLine + j].trim()
        const searchLine = searchLines[j].trim()
        const maxLen = Math.max(originalLine.length, searchLine.length)
        if (maxLen === 0) {
          continue
        }
        const distance = levenshtein(originalLine, searchLine)
        similarity += (1 - distance / maxLen) / linesToCheck

        // Exit early when threshold is reached
        if (similarity >= SINGLE_CANDIDATE_SIMILARITY_THRESHOLD) {
          break
        }
      }
    } else {
      // No middle lines to compare, just accept based on anchors
      similarity = 1.0
    }

    if (similarity >= SINGLE_CANDIDATE_SIMILARITY_THRESHOLD) {
      let matchStartIndex = 0
      for (let k = 0; k < startLine; k++) {
        matchStartIndex += originalLines[k].length + 1
      }
      let matchEndIndex = matchStartIndex
      for (let k = startLine; k <= endLine; k++) {
        matchEndIndex += originalLines[k].length
        if (k < endLine) {
          matchEndIndex += 1 // Add newline character except for the last line
        }
      }
      yield content.substring(matchStartIndex, matchEndIndex)
    }
    return
  }

  // Calculate similarity for multiple candidates
  let bestMatch: { startLine: number; endLine: number } | null = null
  let maxSimilarity = -1

  for (const candidate of candidates) {
    const { startLine, endLine } = candidate
    const actualBlockSize = endLine - startLine + 1

    let similarity = 0
    const linesToCheck = Math.min(searchBlockSize - 2, actualBlockSize - 2) // Middle lines only

    if (linesToCheck > 0) {
      for (let j = 1; j < searchBlockSize - 1 && j < actualBlockSize - 1; j++) {
        const originalLine = originalLines[startLine + j].trim()
        const searchLine = searchLines[j].trim()
        const maxLen = Math.max(originalLine.length, searchLine.length)
        if (maxLen === 0) {
          continue
        }
        const distance = levenshtein(originalLine, searchLine)
        similarity += 1 - distance / maxLen
      }
      similarity /= linesToCheck // Average similarity
    } else {
      // No middle lines to compare, just accept based on anchors
      similarity = 1.0
    }

    if (similarity > maxSimilarity) {
      maxSimilarity = similarity
      bestMatch = candidate
    }
  }

  // Threshold judgment
  if (maxSimilarity >= MULTIPLE_CANDIDATES_SIMILARITY_THRESHOLD && bestMatch) {
    const { startLine, endLine } = bestMatch
    let matchStartIndex = 0
    for (let k = 0; k < startLine; k++) {
      matchStartIndex += originalLines[k].length + 1
    }
    let matchEndIndex = matchStartIndex
    for (let k = startLine; k <= endLine; k++) {
      matchEndIndex += originalLines[k].length
      if (k < endLine) {
        matchEndIndex += 1
      }
    }
    yield content.substring(matchStartIndex, matchEndIndex)
  }
}

export const WhitespaceNormalizedReplacer: Replacer = function* (content, find) {
  const normalizeWhitespace = (text: string) => text.replace(/\s+/g, " ").trim()
  const normalizedFind = normalizeWhitespace(find)

  // Handle single line matches
  const lines = content.split("\n")
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (normalizeWhitespace(line) === normalizedFind) {
      yield line
    } else {
      // Only check for substring matches if the full line doesn't match
      const normalizedLine = normalizeWhitespace(line)
      if (normalizedLine.includes(normalizedFind)) {
        // Find the actual substring in the original line that matches
        const words = find.trim().split(/\s+/)
        if (words.length > 0) {
          const pattern = words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+")
          try {
            const regex = new RegExp(pattern)
            const match = line.match(regex)
            if (match) {
              yield match[0]
            }
          } catch {
            // Invalid regex pattern, skip
          }
        }
      }
    }
  }

  // Handle multi-line matches
  const findLines = find.split("\n")
  if (findLines.length > 1) {
    for (let i = 0; i <= lines.length - findLines.length; i++) {
      const block = lines.slice(i, i + findLines.length)
      if (normalizeWhitespace(block.join("\n")) === normalizedFind) {
        yield block.join("\n")
      }
    }
  }
}

export const IndentationFlexibleReplacer: Replacer = function* (content, find) {
  const removeIndentation = (text: string) => {
    const lines = text.split("\n")
    const nonEmptyLines = lines.filter((line) => line.trim().length > 0)
    if (nonEmptyLines.length === 0) return text

    const minIndent = Math.min(
      ...nonEmptyLines.map((line) => {
        const match = line.match(/^(\s*)/)
        return match ? match[1].length : 0
      }),
    )

    return lines.map((line) => (line.trim().length === 0 ? line : line.slice(minIndent))).join("\n")
  }

  const normalizedFind = removeIndentation(find)
  const contentLines = content.split("\n")
  const findLines = find.split("\n")

  for (let i = 0; i <= contentLines.length - findLines.length; i++) {
    const block = contentLines.slice(i, i + findLines.length).join("\n")
    if (removeIndentation(block) === normalizedFind) {
      yield block
    }
  }
}

export const EscapeNormalizedReplacer: Replacer = function* (content, find) {
  const unescapeString = (str: string): string => {
    return str.replace(/\\(n|t|r|'|"|`|\\|\n|\$)/g, (match, capturedChar) => {
      switch (capturedChar) {
        case "n":
          return "\n"
        case "t":
          return "\t"
        case "r":
          return "\r"
        case "'":
          return "'"
        case '"':
          return '"'
        case "`":
          return "`"
        case "\\":
          return "\\"
        case "\n":
          return "\n"
        case "$":
          return "$"
        default:
          return match
      }
    })
  }

  const unescapedFind = unescapeString(find)

  // Try direct match with unescaped find string
  if (content.includes(unescapedFind)) {
    yield unescapedFind
  }

  // Also try finding escaped versions in content that match unescaped find
  const lines = content.split("\n")
  const findLines = unescapedFind.split("\n")

  for (let i = 0; i <= lines.length - findLines.length; i++) {
    const block = lines.slice(i, i + findLines.length).join("\n")
    const unescapedBlock = unescapeString(block)

    if (unescapedBlock === unescapedFind) {
      yield block
    }
  }
}

export const MultiOccurrenceReplacer: Replacer = function* (content, find) {
  // This replacer yields all exact matches, allowing the replace function
  // to handle multiple occurrences based on replaceAll parameter
  let startIndex = 0

  while (true) {
    const index = content.indexOf(find, startIndex)
    if (index === -1) break

    yield find
    startIndex = index + find.length
  }
}

export const TrimmedBoundaryReplacer: Replacer = function* (content, find) {
  const trimmedFind = find.trim()

  if (trimmedFind === find) {
    // Already trimmed, no point in trying
    return
  }

  // Try to find the trimmed version
  if (content.includes(trimmedFind)) {
    yield trimmedFind
  }

  // Also try finding blocks where trimmed content matches
  const lines = content.split("\n")
  const findLines = find.split("\n")

  for (let i = 0; i <= lines.length - findLines.length; i++) {
    const block = lines.slice(i, i + findLines.length).join("\n")

    if (block.trim() === trimmedFind) {
      yield block
    }
  }
}

export const ContextAwareReplacer: Replacer = function* (content, find) {
  const findLines = find.split("\n")
  if (findLines.length < 3) {
    // Need at least 3 lines to have meaningful context
    return
  }

  // Remove trailing empty line if present
  if (findLines[findLines.length - 1] === "") {
    findLines.pop()
  }

  const contentLines = content.split("\n")

  // Extract first and last lines as context anchors
  const firstLine = findLines[0].trim()
  const lastLine = findLines[findLines.length - 1].trim()

  // Find blocks that start and end with the context anchors
  for (let i = 0; i < contentLines.length; i++) {
    if (contentLines[i].trim() !== firstLine) continue

    // Look for the matching last line
    for (let j = i + 2; j < contentLines.length; j++) {
      if (contentLines[j].trim() === lastLine) {
        // Found a potential context block
        const blockLines = contentLines.slice(i, j + 1)
        const block = blockLines.join("\n")

        // Check if the middle content has reasonable similarity
        // (simple heuristic: at least 50% of non-empty lines should match when trimmed)
        if (blockLines.length === findLines.length) {
          let matchingLines = 0
          let totalNonEmptyLines = 0

          for (let k = 1; k < blockLines.length - 1; k++) {
            const blockLine = blockLines[k].trim()
            const findLine = findLines[k].trim()

            if (blockLine.length > 0 || findLine.length > 0) {
              totalNonEmptyLines++
              if (blockLine === findLine) {
                matchingLines++
              }
            }
          }

          if (totalNonEmptyLines === 0 || matchingLines / totalNonEmptyLines >= 0.5) {
            yield block
            break // Only match the first occurrence
          }
        }
        break
      }
    }
  }
}

export function trimDiff(diff: string): string {
  const lines = diff.split("\n")
  const contentLines = lines.filter(
    (line) =>
      (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) &&
      !line.startsWith("---") &&
      !line.startsWith("+++"),
  )

  if (contentLines.length === 0) return diff

  let min = Infinity
  for (const line of contentLines) {
    const content = line.slice(1)
    if (content.trim().length > 0) {
      const match = content.match(/^(\s*)/)
      if (match) min = Math.min(min, match[1].length)
    }
  }
  if (min === Infinity || min === 0) return diff
  const trimmedLines = lines.map((line) => {
    if (
      (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) &&
      !line.startsWith("---") &&
      !line.startsWith("+++")
    ) {
      const prefix = line[0]
      const content = line.slice(1)
      return prefix + content.slice(min)
    }
    return line
  })

  return trimmedLines.join("\n")
}

export function replace(content: string, oldString: string, newString: string, replaceAll = false): string {
  if (oldString === newString) {
    throw new Error("No changes to apply: oldString and newString are identical.")
  }
  if (oldString === "") {
    throw new Error(
      "oldString cannot be empty when editing an existing file. Provide the exact text to replace, or use write for an intentional full-file replacement.",
    )
  }

  let notFound = true

  for (const replacer of [
    SimpleReplacer,
    LineTrimmedReplacer,
    BlockAnchorReplacer,
    WhitespaceNormalizedReplacer,
    IndentationFlexibleReplacer,
    EscapeNormalizedReplacer,
    TrimmedBoundaryReplacer,
    ContextAwareReplacer,
    MultiOccurrenceReplacer,
  ]) {
    for (const search of replacer(content, oldString)) {
      const index = content.indexOf(search)
      if (index === -1) continue
      notFound = false
      if (isDisproportionateMatch(search, oldString)) {
        throw new Error(
          "Refusing replacement because the matched span is much larger than oldString. Re-read the file and provide the full exact oldString for the intended replacement.",
        )
      }
      if (replaceAll) {
        return content.replaceAll(search, newString)
      }
      const lastIndex = content.lastIndexOf(search)
      if (index !== lastIndex) continue
      return content.substring(0, index) + newString + content.substring(index + search.length)
    }
  }

  if (notFound) {
    throw new Error(
      "Could not find oldString in the file. It must match exactly, including whitespace, indentation, and line endings.",
    )
  }
  throw new Error("Found multiple matches for oldString. Provide more surrounding context to make the match unique.")
}

function isDisproportionateMatch(search: string, oldString: string) {
  const oldLines = oldString.split("\n").length
  const searchLines = search.split("\n").length
  if (searchLines >= Math.max(oldLines + 3, oldLines * 2)) return true
  if (oldLines === 1) return false
  return search.trim().length > Math.max(oldString.trim().length + 500, oldString.trim().length * 4)
}
