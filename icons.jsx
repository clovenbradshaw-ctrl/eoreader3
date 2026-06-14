/* ============================================================
   Icon set — simple stroked line icons (Lucide-style geometry).
   <Icon name="send" size={16} /> . Stroke inherits currentColor.
   ============================================================ */
const ICON_PATHS = {
  plus:      '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  search:    '<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.5" y2="16.5"/>',
  sidebar:   '<rect x="3" y="4" width="18" height="16" rx="2"/><line x1="9" y1="4" x2="9" y2="20"/>',
  doc:       '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><line x1="8.5" y1="13" x2="15.5" y2="13"/><line x1="8.5" y1="16.5" x2="13" y2="16.5"/>',
  table:     '<rect x="3" y="4" width="18" height="16" rx="2"/><line x1="3" y1="9.5" x2="21" y2="9.5"/><line x1="9" y1="9.5" x2="9" y2="20"/><line x1="15" y1="9.5" x2="15" y2="20"/>',
  book:      '<path d="M4 5a2 2 0 0 1 2-2h12v18H6a2 2 0 0 1-2-2z"/><line x1="8" y1="3" x2="8" y2="21"/>',
  send:      '<path d="M5 12h13"/><path d="M12 5l7 7-7 7"/>',
  paperclip: '<path d="M21 11.5l-8.5 8.5a5 5 0 0 1-7-7l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.6 8.5a1.6 1.6 0 0 1-2.3-2.3l7.8-7.8"/>',
  upload:    '<path d="M12 16V4"/><path d="M7 9l5-5 5 5"/><path d="M4 18v1a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-1"/>',
  expand:    '<path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3l-7 7"/><path d="M3 21l7-7"/>',
  collapse:  '<path d="M4 14h6v6"/><path d="M20 10h-6V4"/><path d="M14 10l7-7"/><path d="M3 21l7-7"/>',
  settings:  '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>',
  chevron:   '<path d="M6 9l6 6 6-6"/>',
  'chevron-down':  '<path d="M6 9l6 6 6-6"/>',
  'chevron-right': '<path d="M9 6l6 6-6 6"/>',
  alert:     '<path d="M12 3l9 16H3z"/><line x1="12" y1="10" x2="12" y2="14.5"/><line x1="12" y1="17.5" x2="12" y2="17.5"/>',
  info:      '<circle cx="12" cy="12" r="9"/><line x1="12" y1="11" x2="12" y2="16"/><line x1="12" y1="8" x2="12" y2="8"/>',
  x:         '<line x1="6" y1="6" x2="18" y2="18"/><line x1="6" y1="18" x2="18" y2="6"/>',
  sparkle:   '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>',
  compare:   '<path d="M12 3v18"/><path d="M5 8l-3 4 3 4"/><path d="M19 8l3 4-3 4"/>',
  copy:      '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  refresh:   '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
  thumbsup:  '<path d="M7 11v9H4a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1z"/><path d="M7 11l4-8a2 2 0 0 1 3 2l-1 4h5a2 2 0 0 1 2 2.4l-1.5 6A2 2 0 0 1 20 20H7"/>',
  check:     '<path d="M5 12.5l4.5 4.5L19 6.5"/>',
  layers:    '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>',
  folder:    '<path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  grid:      '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  read:      '<path d="M2 5h8a3 3 0 0 1 3 3v11a2.5 2.5 0 0 0-2.5-2.5H2z"/><path d="M22 5h-8a3 3 0 0 0-3 3v11a2.5 2.5 0 0 1 2.5-2.5H22z"/>',
  arrowleft: '<path d="M19 12H5"/><path d="M12 19l-7-7 7-7"/>',
  edit:      '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  activity:  '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  stop:      '<rect x="6" y="6" width="12" height="12" rx="2.5"/>',
  calculator:'<rect x="4" y="3" width="16" height="18" rx="2"/><line x1="8" y1="7" x2="16" y2="7"/><line x1="8" y1="11" x2="8" y2="11"/><line x1="12" y1="11" x2="12" y2="11"/><line x1="16" y1="11" x2="16" y2="11"/><line x1="8" y1="15" x2="8" y2="15"/><line x1="12" y1="15" x2="12" y2="15"/><line x1="16" y1="15" x2="16" y2="15"/>',
  // The EO cube — three faces meeting at a vertex (Act · Site · Resolution).
  cube:      '<path d="M21 8l-9-5-9 5v8l9 5 9-5z"/><path d="M3 8l9 5 9-5"/><path d="M12 13v8"/>',
};
function Icon({ name, size = 18, style, className, strokeWidth = 1.7 }) {
  const p = ICON_PATHS[name];
  return React.createElement('svg', {
    width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
    stroke: 'currentColor', strokeWidth, strokeLinecap: 'round', strokeLinejoin: 'round',
    style, className, dangerouslySetInnerHTML: { __html: p },
  });
}
window.Icon = Icon;

/* Shared dialog behaviour (§4 a11y): focus the panel on open, trap Tab inside
   it, close on Escape, and restore focus to the trigger on close. Returns a ref
   to put on the dialog panel (which should be tabIndex={-1}). */
function useDialog(onClose) {
  const ref = React.useRef(null);
  React.useEffect(() => {
    const prev = document.activeElement;
    const panel = ref.current;
    const focusables = () => panel
      ? [...panel.querySelectorAll('a[href],button:not([disabled]),textarea,input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])')]
          .filter(el => el.offsetParent !== null || el === document.activeElement)
      : [];
    const first = focusables()[0];
    try { (first || panel) && (first || panel).focus(); } catch (e) {}
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose && onClose(); return; }
      if (e.key === 'Tab' && panel) {
        const f = focusables(); if (!f.length) { e.preventDefault(); return; }
        const a = f[0], b = f[f.length - 1];
        if (e.shiftKey && document.activeElement === a) { e.preventDefault(); b.focus(); }
        else if (!e.shiftKey && document.activeElement === b) { e.preventDefault(); a.focus(); }
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      try { prev && prev.focus && prev.focus(); } catch (e) {}
    };
  }, []);
  return ref;
}
window.useDialog = useDialog;
