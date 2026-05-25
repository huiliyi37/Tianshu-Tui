export interface ToolCallItem {
  id: string
  name: string
  label: string
  done: boolean
  error: boolean
}

export { statusPhaseText, toolLabel } from './tool-label.js'
