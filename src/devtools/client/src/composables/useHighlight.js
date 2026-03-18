import { ref, onMounted } from 'vue'
import { createHighlighterCore } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import json from 'shiki/langs/json.mjs'

const highlighterRef = ref(null)
const ready = ref(false)
let initPromise = null

const theme = {
  name: 'mesh-devtools',
  type: 'dark',
  bg: 'transparent',
  fg: '#d4d4d4',
  settings: [
    { scope: ['string'], settings: { foreground: '#a5d6a7' } },
    { scope: ['constant.numeric'], settings: { foreground: '#4dd0e1' } },
    { scope: ['constant.language.boolean', 'constant.language'], settings: { foreground: '#ce93d8' } },
    { scope: ['constant.language.null'], settings: { foreground: '#666666' } },
    { scope: ['support.type.property-name'], settings: { foreground: '#b0b0b0' } },
    { scope: ['punctuation'], settings: { foreground: '#555555' } },
  ]
}

function init() {
  if (initPromise) return initPromise
  initPromise = createHighlighterCore({
    themes: [theme],
    langs: [json],
    engine: createJavaScriptRegexEngine()
  }).then(h => {
    highlighterRef.value = h
    ready.value = true
    return h
  })
  return initPromise
}

export function useHighlight() {
  onMounted(init)

  function highlight(value) {
    const json = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
    if (!json) return ''
    if (!highlighterRef.value) return escapeHtml(json)
    return highlighterRef.value.codeToHtml(json, {
      lang: 'json',
      theme: 'mesh-devtools'
    })
  }

  return { highlight, ready }
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
