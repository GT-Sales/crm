/**
 * Hands a file the page already holds to the browser's download, under
 * `fileName`: a temporary object URL on a link that is clicked and removed.
 * The URL is released a moment later; the browser has taken the bytes by then.
 */
export function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.rel = 'noopener';
  link.style.display = 'none';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
