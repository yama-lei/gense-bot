import type { ReactNode, SVGProps } from 'react'

function Svg({ children, ...props }: SVGProps<SVGSVGElement> & { children: ReactNode }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      {children}
    </svg>
  )
}

type P = SVGProps<SVGSVGElement>

export const IconSidebar = (p: P) => <Svg {...p}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></Svg>
export const IconMenu = (p: P) => <Svg {...p}><path d="M4 7h16M4 12h16M4 17h16" /></Svg>
export const IconSearch = (p: P) => <Svg {...p}><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.2-4.2" /></Svg>
export const IconPlus = (p: P) => <Svg {...p}><path d="M12 5v14M5 12h14" /></Svg>
export const IconProject = (p: P) => <Svg {...p}><path d="M5 5h14M6 8.5h12" /><rect x="4" y="12" width="16" height="8" rx="2" /></Svg>
export const IconDoc = (p: P) => <Svg {...p}><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5M9 13h6M9 17h4" /></Svg>
export const IconClock = (p: P) => <Svg {...p}><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></Svg>
export const IconSliders = (p: P) => <Svg {...p}><path d="M4 7h10M18 7h2M4 17h4M12 17h8" /><circle cx="16" cy="7" r="2" /><circle cx="10" cy="17" r="2" /></Svg>
export const IconChevronDown = (p: P) => <Svg {...p}><path d="m7 10 5 5 5-5" /></Svg>
export const IconChevronRight = (p: P) => <Svg {...p}><path d="m10 7 5 5-5 5" /></Svg>
export const IconArrowUp = (p: P) => <Svg {...p}><path d="M12 19V5M6 11l6-6 6 6" /></Svg>
export const IconArrowDown = (p: P) => <Svg {...p}><path d="M12 5v14M6 13l6 6 6-6" /></Svg>
export const IconStop = (p: P) => <Svg {...p}><rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" /></Svg>
export const IconCopy = (p: P) => <Svg {...p}><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></Svg>
export const IconCheck = (p: P) => <Svg {...p}><path d="m5 12 5 5 9-10" /></Svg>
export const IconX = (p: P) => <Svg {...p}><path d="M6 6l12 12M18 6 6 18" /></Svg>
export const IconRetry = (p: P) => <Svg {...p}><path d="M20 11a8 8 0 1 0-2.3 5.7" /><path d="M20 4v7h-7" /></Svg>
export const IconTool = (p: P) => <Svg {...p}><path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L4 17v3h3l5.3-5.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z" /></Svg>
export const IconPin = (p: P) => <Svg {...p}><path d="M9 4h6l-1 6 3 3H7l3-3zM12 13v7" /></Svg>
export const IconAlert = (p: P) => <Svg {...p}><circle cx="12" cy="12" r="8.5" /><path d="M12 8v5M12 16h.01" /></Svg>
export const IconMail = (p: P) => <Svg {...p}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m4 7 8 6 8-6" /></Svg>
export const IconTrash = (p: P) => <Svg {...p}><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></Svg>
export const IconInfo = (p: P) => <Svg {...p}><circle cx="12" cy="12" r="8.5" /><path d="M12 11v5M12 8h.01" /></Svg>

export function Spark({ size = 34 }: { size?: number }) {
  // Project mark: an eight-point spark, deliberately not the reference product's logo.
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden="true">
      <g stroke="var(--accent)" strokeWidth="3.4" strokeLinecap="round">
        {[0, 45, 90, 135].map((a) => (
          <line key={a} x1="20" y1="5" x2="20" y2="35" transform={`rotate(${a} 20 20)`} />
        ))}
      </g>
      <circle cx="20" cy="20" r="4" fill="var(--bg)" stroke="var(--accent)" strokeWidth="2.4" />
    </svg>
  )
}
export const IconChevronLeft = (p: P) => <Svg {...p}><path d="m14 7-5 5 5 5" /></Svg>
export const IconEdit = (p: P) => <Svg {...p}><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z" /><path d="m13.5 6.5 4 4" /></Svg>
export const IconMore = (p: P) => <Svg {...p}><circle cx="6" cy="12" r="1.2" fill="currentColor" /><circle cx="12" cy="12" r="1.2" fill="currentColor" /><circle cx="18" cy="12" r="1.2" fill="currentColor" /></Svg>
export const IconBranch = (p: P) => <Svg {...p}><circle cx="6" cy="5.5" r="2" /><circle cx="6" cy="18.5" r="2" /><circle cx="18" cy="8" r="2" /><path d="M6 7.5v9M18 10c0 4-6 3.5-11 6.5" /></Svg>
export const IconSide = (p: P) => <Svg {...p}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M14 4v16M16.5 9h2M16.5 12.5h2" /></Svg>
