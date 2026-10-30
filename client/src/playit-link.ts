/** Navigate in the current tab so account linking also works with popups blocked. */
export function openPlayitClaim(claimUrl: string): void {
  const url = new URL(claimUrl);
  if (url.origin !== 'https://playit.gg' || !/^\/claim\/[A-Za-z0-9]+\/?$/.test(url.pathname) || url.search || url.hash || url.username || url.password) {
    throw new Error('Playit returned an invalid account link. Refresh the page and try linking again.');
  }
  window.location.assign(url.href);
}
