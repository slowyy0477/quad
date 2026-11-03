/** Original decorative vector, not a map of an institution or invented app data. */
export function CampusArtwork({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 480 280" className={`campus-artwork ${className}`} aria-hidden="true" focusable="false">
      <path d="M28 230h424" className="campus-line" opacity=".35" />
      <path d="M60 229V117l82-29 83 29v112" className="campus-building" />
      <path d="M80 109V85l62-22 64 22v24" className="campus-building" />
      <path d="M229 229V99l66-23 67 23v130" className="campus-building" />
      <path d="M360 229V142l54-19 35 14v92" className="campus-building" />
      {[88, 130, 172].map(x => [132, 174].map(y => <rect key={`${x}-${y}`} x={x} y={y} width="20" height="24" rx="3" className="campus-window" />))}
      {[249, 289, 329].map(x => [118, 160].map(y => <rect key={`${x}-${y}`} x={x} y={y} width="16" height="24" rx="3" className="campus-window" />))}
      <rect x="128" y="208" width="30" height="22" rx="5" className="campus-window" />
      <rect x="282" y="202" width="24" height="28" rx="5" className="campus-window" />
      <path d="M38 248c21 24 91 24 117 5s37-11 62-8 47 11 72-4 96-13 143 5" className="campus-route" />
      <path d="M36 229v-47m0 16c-29-15-27-48-6-45 20-26 39 11 25 34-6 10-19 11-19 11m382 31v-51m0 19c-23-7-25-31-14-37 9-30 37-23 34 0 20 15 4 39-20 37" className="campus-line" />
      <circle cx="362" cy="49" r="20" className="campus-window" />
      <path d="m354 50 6 6 12-14" className="campus-line" />
      <path d="M188 47h36m-28-14h20M276 45h24" className="campus-line" opacity=".45" />
    </svg>
  )
}
