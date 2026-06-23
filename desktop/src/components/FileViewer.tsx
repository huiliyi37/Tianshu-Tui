import { useEffect, useState } from 'react'
import hljs from 'highlight.js/lib/core'

// Register only the most common languages to keep the bundle small.
import typescript from 'highlight.js/lib/languages/typescript'
import javascript from 'highlight.js/lib/languages/javascript'
import python from 'highlight.js/lib/languages/python'
import rust from 'highlight.js/lib/languages/rust'
import bash from 'highlight.js/lib/languages/bash'
import json from 'highlight.js/lib/languages/json'
import css from 'highlight.js/lib/languages/css'
import xml from 'highlight.js/lib/languages/xml'
import markdown from 'highlight.js/lib/languages/markdown'
import yaml from 'highlight.js/lib/languages/yaml'

hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('python', python)
hljs.registerLanguage('rust', rust)
hljs.registerLanguage('bash', bash)
hljs.registerLanguage('json', json)
hljs.registerLanguage('css', css)
hljs.registerLanguage('html', xml)
hljs.registerLanguage('xml', xml)
hljs.registerLanguage('markdown', markdown)
hljs.registerLanguage('yaml', yaml)

/**
 * File viewer — renders source code with syntax highlighting and line numbers.
 * Uses highlight.js (already a dependency) instead of shiki for zero extra deps.
 * Click on a line to highlight it (for diff correlation).
 */
export function FileViewer(props: {
  content: string
  language: string
  startLine?: number
  highlightLines?: number[]
}) {
  const { content, language, startLine = 1, highlightLines = [] } = props
  const lines = content.split('\n')
  const highlightSet = new Set(highlightLines)

  let highlighted = ''
  try {
    if (language !== 'plaintext' && hljs.getLanguage(language)) {
      highlighted = hljs.highlight(content, { language }).value
    } else {
      highlighted = hljs.highlightAuto(content).value
    }
  } catch {
    highlighted = content.replace(/</g, '&lt;').replace(/>/g, '&gt;')
  }

  const highlightedLines = highlighted.split('\n')

  return (
    <div className="file-viewer">
      <div className="file-viewer-code">
        {lines.map((_, i) => {
          const lineNum = startLine + i
          const isHighlighted = highlightSet.has(lineNum)
          return (
            <div key={i} className={`file-line${isHighlighted ? ' highlighted' : ''}`}>
              <span className="file-line-num">{lineNum}</span>
              <span
                className="file-line-content"
                dangerouslySetInnerHTML={{ __html: highlightedLines[i] ?? '' }}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}
