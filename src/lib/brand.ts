/** Public product identity. Operational identifiers keep compatibility separately. */
export const BRAND = {
  name: 'Bulla',
  title: 'Bulla — your campus, closer',
  description:
    'Find your people, build something together and make room for what you want to learn. A campus community for university students.',
  lightCanvas: '#f7f8fa',
  darkCanvas: '#10161e',
  primary: '#126b56',
  icon: '/icons/bulla.svg',
} as const

/** Kept in sync with the data-only 0022 brand reservation migration. */
export const RESERVED_BRAND_USERNAMES = ['bulla', 'bullaapp', 'bullasupport'] as const
