import type { MetadataRoute } from 'next'
import { BRAND } from '@/lib/brand'

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/',
    name: BRAND.title,
    short_name: BRAND.name,
    description: BRAND.description,
    start_url: '/feed',
    scope: '/',
    display: 'standalone',
    background_color: BRAND.lightCanvas,
    theme_color: BRAND.primary,
    lang: 'en',
    categories: ['education', 'social', 'productivity'],
    icons: [
      { src: '/icons/bulla-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/bulla-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/bulla-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    shortcuts: [
      { name: 'Your feed', url: '/feed' },
      { name: 'Projects', url: '/projects' },
      { name: 'Learning goals', url: '/goals' },
      { name: 'Messages', url: '/messages' },
    ],
  }
}
