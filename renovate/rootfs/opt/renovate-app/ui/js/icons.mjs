// Line icons in the 24px grid (stroke style, drawn for this app). Each export builds a fresh element.
import { svg } from './dom.mjs';

const make = (markup) => () => svg(markup);

export const iconPlay = make('<path d="M7 5l12 7-12 7z"/>');
export const iconEye = make('<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>');
export const iconPlus = make('<path d="M12 5v14M5 12h14"/>');
export const iconRefresh = make('<path d="M20 11a8 8 0 00-14.5-4M4 4v4h4"/><path d="M4 13a8 8 0 0014.5 4M20 20v-4h-4"/>');
export const iconCheck = make('<path d="M5 12.5l4.5 4.5L19 7.5"/>');
export const iconWarning = make('<path d="M12 4l9.5 16.5h-19z"/><path d="M12 10v4.5M12 17.5v.01"/>');
export const iconInfo = make('<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8v.01"/>');
export const iconLock = make('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/>');
export const iconExternal = make('<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5"/>');
export const iconTrash = make('<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>');
export const iconStop = make('<rect x="6" y="6" width="12" height="12" rx="2"/>');
export const iconCopy = make('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 012-2h9"/>');
export const iconDownload = make('<path d="M12 4v11M7 11l5 5 5-5M5 20h14"/>');
export const iconBranch = make('<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="8" r="2"/><path d="M6 7v10M18 10c0 4-6 3-12 7"/>');
export const iconServer = make('<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5v.01M7 16.5v.01"/>');
