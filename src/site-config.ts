import { REPO_PREFIX } from '@/constants'

export const siteConfig = {
  author: 'Huy Bui',
  title: 'Huy\'s Space',
  subtitle: 'Space for my thoughts and notes',
  description: 'A minimal portfolio and blog theme for Astro.',
  image: {
    src: `/${REPO_PREFIX}/hero.jpg`,
    alt: 'Website Main Image',
  },
  email: 'buiminhhuy.work@gmail.com',
  socialLinks: [
    {
      text: 'GitHub',
      href: 'https://github.com/huy1010',
      icon: 'i-simple-icons-github',
      header: 'i-ri-github-line',
    },
    {
      text: 'Linkedin',
      href: 'https://www.linkedin.com/in/huy1010/',
      icon: 'i-simple-icons-linkedin',
    },
  ],
  header: {
    logo: {
      src: `/${REPO_PREFIX}/favicon.svg`,
      alt: 'Logo Image',
    },
    navLinks: [
      {
        text: 'Blog',
        href: `/${REPO_PREFIX}/blog`,
      },
      {
        text: 'Notes',
        href: `/${REPO_PREFIX}/blog/notes`,
      },
      // {
      //   text: 'Projects',
      //   href: `/${REPO_PREFIX}/projects`,
      // },
    ],
  },
  page: {
    blogLinks: [
      {
        text: 'Blog',
        href: `/${REPO_PREFIX}/blog`,
      },
      {
        text: 'Notes',
        href: `/${REPO_PREFIX}/blog/notes`,
      },
    ],
  },
  footer: {
    navLinks: [
      {
        text: 'Posts Props',
        href: `/${REPO_PREFIX}/posts-props`,
      },
      {
        text: 'Markdown Style',
        href: `/${REPO_PREFIX}/md-style`,
      },
      {
        text: 'GitHub Repository',
        href: 'https://github.com/huy1010/blog',
      },
    ],
  },
}

export default siteConfig
