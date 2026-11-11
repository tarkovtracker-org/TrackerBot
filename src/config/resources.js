// Operator-controlled links, not user-supplied destinations. Validate on use so an
// invalid optional setting cannot crash startup or silently publish a wrong URL.
export function getResourceLinks(env = process.env) {
  function httpsUrl(value, label) {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.href.length > 512) {
      throw new Error(`${label} must be an HTTPS URL without embedded credentials, at most 512 characters`);
    }
    return url.href;
  }
  const site = httpsUrl(env.TT_SITE_URL?.trim() || "https://tarkovtracker.org/", "TT_SITE_URL");
  const resources = httpsUrl(env.TT_RESOURCES_URL?.trim() || new URL("/resources", site).href, "TT_RESOURCES_URL");
  return { site, resources };
}
