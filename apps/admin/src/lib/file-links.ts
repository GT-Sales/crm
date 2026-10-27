/** A tab opened to view a file, pointed at its signed link once issued. */
export interface ViewTab {
  show(url: string): void;
  close(): void;
}

/** Where a signed file link is opened; tests replace these. */
export const downloadNavigation = {
  /** A download: its attachment disposition keeps this page where it is. */
  open(url: string): void {
    window.location.assign(url);
  },
  /**
   * A tab for viewing, opened inside the click so a popup blocker allows it
   * (the link is issued only after it), cut off from this page before it
   * shows anything. Undefined when the browser blocked it anyway.
   */
  openTab(): ViewTab | undefined {
    const tab = window.open('', '_blank');
    if (!tab) return undefined;
    tab.opener = null;
    return {
      show: (url) => tab.location.replace(url),
      close: () => tab.close(),
    };
  },
};
