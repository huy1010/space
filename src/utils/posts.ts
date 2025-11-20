import type { CollectionPosts, PostKey } from '@/types'
import { getCollection } from 'astro:content'

function getPostDateValue(post: CollectionPosts) {
  const rawDate = post.data.date
  if (!rawDate)
    return 0
  const time = new Date(rawDate).getTime()
  return Number.isNaN(time) ? 0 : time
}

export function sortPostsByDate(itemA: CollectionPosts, itemB: CollectionPosts) {
  return getPostDateValue(itemB) - getPostDateValue(itemA)
}

export async function getPosts(path?: string, collection: PostKey = 'blog') {
  const posts = await getCollection(collection, (post) => {
    const draftFlag = 'draft' in post.data ? post.data.draft === true : false
    const isDraft = import.meta.env.PROD ? draftFlag : false
    const matchesPath = path ? post.slug.includes(path) : true
    return !isDraft && matchesPath
  })

  return posts.sort(sortPostsByDate)
}
