<template>
  <div class="json-view" v-html="html"></div>
</template>

<script setup>
import { computed } from 'vue'
import { useHighlight } from '../composables/useHighlight.js'

const props = defineProps({ data: { default: null } })
const { highlight } = useHighlight()

const html = computed(() => {
  if (props.data === null || props.data === undefined) {
    return '<span style="color: var(--syn-null)">null</span>'
  }
  return highlight(props.data)
})
</script>
