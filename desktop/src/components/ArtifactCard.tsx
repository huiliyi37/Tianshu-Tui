import { memo } from 'react'
import type { ConvoBlock } from '../state/event-reducer'
import { FileText, CheckCircle2, BookOpen } from 'lucide-react'

function ArtifactCardImpl({ block }: { block: ConvoBlock }) {
  let title = 'Artifact'
  let summary = 'Generated or updated file'
  let icon = <FileText size={16} />
  let isTask = false
  let isPlan = false
  let isWalkthrough = false

  try {
    const payloadStr = block.kind === 'tool' ? block.text : ''
    const matchTarget = payloadStr.match(/TargetFile['":\s]+([^'",\n}]+)/i)
    if (matchTarget && matchTarget[1]) {
      const fileName = matchTarget[1].split(/[/\\]/).pop() || ''
      title = fileName

      if (fileName.toLowerCase().includes('task')) {
        isTask = true
        icon = <CheckCircle2 size={16} />
        title = 'Task'
      } else if (fileName.toLowerCase().includes('plan')) {
        isPlan = true
        icon = <FileText size={16} />
        title = 'Implementation Plan'
      } else if (fileName.toLowerCase().includes('walkthrough')) {
        isWalkthrough = true
        icon = <BookOpen size={16} />
        title = 'Walkthrough'
      }
    }
    
    // Attempt to extract Summary from ArtifactMetadata if present
    const matchSummary = payloadStr.match(/Summary['":\s]+([^'",\n}]+)/i)
    if (matchSummary && matchSummary[1]) {
      summary = matchSummary[1]
    }
  } catch (e) {}

  return (
    <div className={`artifact-card ${isPlan ? 'is-plan' : isTask ? 'is-task' : isWalkthrough ? 'is-walkthrough' : ''}`}>
      <div className="ac-header">
        <span className="ac-icon">{icon}</span>
        <span className="ac-title">{title}</span>
      </div>
      <div className="ac-body">
        <p className="ac-summary">{summary}</p>
      </div>
      <div className="ac-footer">
        <button className="ac-btn review-btn">Review</button>
      </div>
    </div>
  )
}

export const ArtifactCard = memo(ArtifactCardImpl, (a, b) => a.block === b.block)
