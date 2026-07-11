/**
 * Pure URL mapping between gateway-form URLs, ord: URIs, and the extension's
 * viewer page. Kept dependency-free and unit-tested (extension/test).
 */

const ID_RE = /^[0-9a-f]{64}i\d+$/i;

export interface GatewayMatch {
  /** normalized ord URI (bare = undelegated referent; /content = delegated) */
  uri: string;
  inscriptionId: string;
}

/** hosts whose /content|/preview|/r/undelegated-content paths we recognize */
export const DEFAULT_GATEWAY_HOSTS = ['ordinals.com'];

/**
 * Map a gateway URL to an ord: URI. `/content/<id>` and `/preview/<id>` are
 * delegation-applied (→ ord:<id>/content); `/r/undelegated-content/<id>` is
 * the bare referent (→ ord:<id>).
 */
export function gatewayUrlToOrdUri(
  url: string,
  hosts: readonly string[] = DEFAULT_GATEWAY_HOSTS,
): GatewayMatch | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined;
  const host = parsed.hostname.toLowerCase();
  if (!hosts.some((h) => host === h || host.endsWith(`.${h}`))) return undefined;

  const match = parsed.pathname.match(/^\/(content|preview|r\/undelegated-content)\/([^/]+)$/);
  if (!match) return undefined;
  const id = match[2].toLowerCase();
  if (!ID_RE.test(id)) return undefined;
  return {
    inscriptionId: id,
    uri: match[1] === 'r/undelegated-content' ? `ord:${id}` : `ord:${id}/content`,
  };
}

/** normalize user input (omnibox, links): ord:, ord://, bare id, optional path/fragment */
export function normalizeOrdInput(input: string): string | undefined {
  let s = input.trim();
  if (s.startsWith('ord://')) s = `ord:${s.slice('ord://'.length)}`;
  if (!s.startsWith('ord:')) {
    // bare inscription id convenience
    if (ID_RE.test(s)) return `ord:${s.toLowerCase()}`;
    return undefined;
  }
  const rest = s.slice(4);
  const idPart = rest.split(/[/#?]/, 1)[0];
  if (!ID_RE.test(idPart)) return undefined;
  return `ord:${rest}`;
}

/** viewer page URL for an ord URI (hash carries the URI verbatim) */
export function viewerUrl(extensionBaseUrl: string, uri: string): string {
  return `${extensionBaseUrl}viewer.html#${uri}`;
}

/** parse the viewer's location.hash back into an ord URI */
export function uriFromViewerHash(hash: string): string | undefined {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  return normalizeOrdInput(decodeURIComponent(raw));
}

/**
 * declarativeNetRequest regex parts for a gateway host: main-frame
 * navigations to recognized content paths get redirected to the viewer.
 */
export function dnrRuleForHost(
  host: string,
  ruleId: number,
  extensionBaseUrl: string,
): chrome.declarativeNetRequest.Rule {
  const escaped = host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return {
    id: ruleId,
    priority: 1,
    action: {
      type: 'redirect' as chrome.declarativeNetRequest.RuleActionType,
      redirect: {
        // \1 = path kind, \2 = inscription id; the viewer re-normalizes
        regexSubstitution: `${extensionBaseUrl}viewer.html#gw:\\1:\\2`,
      },
    },
    condition: {
      regexFilter: `^https?://${escaped}/(content|preview|r/undelegated-content)/([0-9a-fA-F]{64}i[0-9]+)$`,
      resourceTypes: ['main_frame' as chrome.declarativeNetRequest.ResourceType],
    },
  };
}

/** decode the dNR viewer hash form (gw:<kind>:<id>) into an ord URI */
export function uriFromDnrHash(hash: string): string | undefined {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!raw.startsWith('gw:')) return undefined;
  const [, kind, id] = raw.split(':');
  if (!kind || !id || !ID_RE.test(id)) return undefined;
  return kind === 'r/undelegated-content' ? `ord:${id.toLowerCase()}` : `ord:${id.toLowerCase()}/content`;
}
