<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'

interface Heading {
  id: string
  text: string
  level: number
}

const headings = ref<Heading[]>([])
const activeId = ref<string>('')
const isVisible = ref(false)

function extractHeadings() {
  const article = document.querySelector('article.prose')
  if (!article)
    return

  const headingElements = article.querySelectorAll('h2, h3, h4')
  const extracted: Heading[] = []

  headingElements.forEach((el) => {
    const id = el.id || generateId(el.textContent || '')
    if (!el.id) {
      el.id = id
    }

    extracted.push({
      id,
      text: el.textContent || '',
      level: Number.parseInt(el.tagName.charAt(1)),
    })
  })

  headings.value = extracted
}

function generateId(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim()
}

function scrollToHeading(id: string) {
  const element = document.getElementById(id)
  if (element) {
    const offset = 100 // Account for header
    const elementPosition = element.getBoundingClientRect().top
    const offsetPosition = elementPosition + window.pageYOffset - offset

    window.scrollTo({
      top: offsetPosition,
      behavior: 'smooth',
    })

    // Update URL without triggering scroll
    history.pushState(null, '', `#${id}`)
    activeId.value = id
  }
}

function updateActiveHeading() {
  const article = document.querySelector('article.prose')
  if (!article)
    return

  const headingElements = article.querySelectorAll('h2, h3, h4')
  const scrollPosition = window.scrollY + 150 // Offset for sticky header

  let currentActive = ''

  for (let i = headingElements.length - 1; i >= 0; i--) {
    const el = headingElements[i] as HTMLElement
    if (el.offsetTop <= scrollPosition) {
      currentActive = el.id
      break
    }
  }

  activeId.value = currentActive
}

function handleScroll() {
  updateActiveHeading()

  // Show TOC after scrolling past first heading
  const firstHeading = headings.value[0]
  if (firstHeading) {
    const element = document.getElementById(firstHeading.id)
    if (element) {
      isVisible.value = window.scrollY > element.offsetTop - 200
    }
  }
}

onMounted(() => {
  extractHeadings()
  window.addEventListener('scroll', handleScroll)
  window.addEventListener('resize', handleScroll)
  handleScroll() // Initial check
})

onUnmounted(() => {
  window.removeEventListener('scroll', handleScroll)
  window.removeEventListener('resize', handleScroll)
})
</script>

<template>
  <nav
    v-if="headings.length > 0"
    class="toc-container"
    :class="{ 'toc-visible': isVisible }"
  >
    <div class="toc-header">
      <h3 class="toc-title">
        Table of Contents
      </h3>
    </div>
    <ul class="toc-list">
      <li
        v-for="heading in headings"
        :key="heading.id"
        class="toc-item" :class="[
          `toc-item-${heading.level}`,
          { 'toc-item-active': activeId === heading.id },
        ]"
      >
        <a
          :href="`#${heading.id}`"
          class="toc-link"
          @click.prevent="scrollToHeading(heading.id)"
        >
          {{ heading.text }}
        </a>
      </li>
    </ul>
  </nav>
</template>

<style scoped>
.toc-container {
  position: fixed;
  top: 120px;
  right: calc((100vw - 768px) / 2 + 800px);
  width: 240px;
  max-height: calc(100vh - 160px);
  overflow-y: auto;
  padding: 1rem;
  opacity: 0;
  visibility: hidden;
  transition:
    opacity 0.3s ease,
    visibility 0.3s ease;
  z-index: 10;
}

.toc-container.toc-visible {
  opacity: 1;
  visibility: visible;
}

.toc-header {
  margin-bottom: 0.75rem;
}

.toc-title {
  font-size: 0.875rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  opacity: 0.7;
  margin: 0;
}

.toc-list {
  list-style: none;
  padding: 0;
  margin: 0;
}

.toc-item {
  margin: 0.25rem 0;
}

.toc-item-2 {
  margin-left: 0;
}

.toc-item-3 {
  margin-left: 1rem;
}

.toc-item-4 {
  margin-left: 2rem;
}

.toc-link {
  display: block;
  font-size: 0.875rem;
  line-height: 1.5;
  color: inherit;
  text-decoration: none;
  opacity: 0.6;
  transition: opacity 0.2s ease;
  padding: 0.25rem 0;
  border-left: 2px solid transparent;
  padding-left: 0.5rem;
  margin-left: -0.5rem;
}

.toc-link:hover {
  opacity: 0.9;
}

.toc-item-active .toc-link {
  opacity: 1;
  border-left-color: currentColor;
  font-weight: 500;
}

/* Hide on smaller screens */
@media (max-width: 1280px) {
  .toc-container {
    display: none;
  }
}

/* Scrollbar styling */
.toc-container::-webkit-scrollbar {
  width: 4px;
}

.toc-container::-webkit-scrollbar-track {
  background: transparent;
}

.toc-container::-webkit-scrollbar-thumb {
  background: rgba(125, 125, 125, 0.3);
  border-radius: 2px;
}

.toc-container::-webkit-scrollbar-thumb:hover {
  background: rgba(125, 125, 125, 0.5);
}
</style>
