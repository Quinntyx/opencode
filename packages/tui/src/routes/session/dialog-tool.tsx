import { createMemo, onMount, Show } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { useTerminalDimensions, useRenderer } from "@opentui/solid"
import { useDialog } from "../../ui/dialog"
import { DialogSelect } from "../../ui/dialog-select"
import { useClipboard } from "../../context/clipboard"
import { useToast } from "../../ui/toast"
import { useTheme } from "../../context/theme"
import type { ToolPart } from "@opencode-ai/sdk/v2"

export function DialogTool(props: { part: ToolPart }) {
  const dialog = useDialog()
  const clipboard = useClipboard()
  const toast = useToast()

  const output = createMemo(() => {
    const state = props.part.state
    return "output" in state ? state.output : undefined
  })
  const input = createMemo(() => props.part.state.input)

  return (
    <DialogSelect
      title="Tool Actions"
      renderFilter={false}
      skipFilter
      options={[
        {
          title: "Copy",
          value: "tool.copy",
          description: "tool output to clipboard",
          onSelect: async (dialog) => {
            const text = output() ?? JSON.stringify(input(), null, 2)
            await clipboard.write?.(text)
            toast.show({ message: "Tool output copied to clipboard!", variant: "success" })
            dialog.clear()
          },
        },
        {
          title: "Inspect",
          value: "tool.inspect",
          description: "raw tool call + result JSON",
          onSelect: (dialog) => {
dialog.replace(() => <DialogInspect part={props.part} />)
          },
        },
      ]}
    />
  )
}

export function DialogInspect(props: { part: ToolPart }) {
  const dialog = useDialog()
  const renderer = useRenderer()
  const { theme, syntax } = useTheme()
  const dimensions = useTerminalDimensions()

  onMount(() => {
    renderer.clearSelection()
    dialog.setSize("large")
  })

  const json = createMemo(() => {
    const state = props.part.state
    return JSON.stringify(
      {
        tool: props.part.tool,
        status: state.status,
        input: state.input,
        output: "output" in state ? state.output : undefined,
        metadata: props.part.metadata,
      },
      null,
      2,
    )
  })

  const lineCount = createMemo(() => json().split("\n").length)
  const maxLines = createMemo(() => Math.floor(dimensions().height * 0.5))
  const needsScroll = createMemo(() => lineCount() + 2 > maxLines())

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          Inspect {props.part.tool}
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <Show when={needsScroll()}>
        <scrollbox height={maxLines()} scrollbarOptions={{ visible: false }}>
          <box backgroundColor={theme.backgroundElement} paddingTop={1} paddingLeft={1} paddingRight={1}>
            <line_number fg={theme.textMuted} minWidth={3} paddingRight={1}>
              <code conceal={false} fg={theme.text} filetype="json" syntaxStyle={syntax()} content={json()} wrapMode="none" />
            </line_number>
            <box height={1} />
          </box>
        </scrollbox>
      </Show>
      <Show when={!needsScroll()}>
        <box backgroundColor={theme.backgroundElement} paddingTop={1} paddingLeft={1} paddingRight={1}>
          <line_number fg={theme.textMuted} minWidth={3} paddingRight={1}>
            <code conceal={false} fg={theme.text} filetype="json" syntaxStyle={syntax()} content={json()} wrapMode="none" />
          </line_number>
          <box height={1} />
        </box>
      </Show>
    </box>
  )
}
